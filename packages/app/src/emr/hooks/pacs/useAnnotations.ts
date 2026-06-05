// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useAnnotations Hook
// ============================================================================
// React hook that manages the annotation (measurement) lifecycle for the PACS
// viewer. Think of it like Google Docs auto-save for annotations — it loads
// annotations when a study opens, auto-saves every 2 seconds after changes,
// and flushes unsaved data when you leave.
//
// Each user's annotations are stored separately. The hook also provides a
// per-author visibility toggle so radiologists can show/hide other users'
// annotations.
//
// Features:
//   T031 — Undo/redo with memo stack (like Ctrl+Z in a drawing app)
//   T032 — Jump to annotation by UID (scroll & pan to its location)
//   T033 — Tracked/untracked mode with dashed line styles
//
// Dependencies:
//   - annotationService (T041): CRUD operations for annotation FHIR resources
//   - cornerstoneInit: Annotation state access and rendering engine
//
// Ported from MediMind. `useMedplum()` → `useLiverraFhir()` (stub-backed for
// Phase 2). `getProfile()` is not exposed by the FHIR shim yet, so identity
// resolves via a fixed `LOCAL_PROFILE` — Phase 4 swaps to the real session.
// ============================================================================

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from '../../contexts/TranslationContext';
import { useLiverraFhir } from '../useLiverraFhir';
import type { LiverRaFhirClient } from '../../services/fhirClient';
import type { StoredAnnotations } from '../../services/pacs/annotationService';
import {
  saveAnnotations,
  loadAnnotations,
  deleteAnnotations,
} from '../../services/pacs/annotationService';
import { restoreAnnotationsFromJson } from '../../services/pacs/cornerstoneInit';
// Types from pacs.ts (AnnotationHistoryEntry, TrackingState) define the
// architecture for these features — we implement them here in the hook.

// Minimal type for Cornerstone3D annotation objects returned by annotationState
interface CS3DAnnotation {
  annotationUID?: string;
  data?: {
    style?: {
      color?: string;
      lineWidth?: number;
      lineDash?: number[];
    };
    handles?: {
      points?: [number, number, number][];
    };
    [key: string]: unknown;
  };
  metadata?: {
    referencedImageId?: string;
    [key: string]: unknown;
  };
}

interface PendingAnnotationSave {
  studyId: string;
  data: string;
}

// ============================================================================
// Constants
// ============================================================================

/** How long to wait after the last edit before auto-saving (ms) */
const AUTO_SAVE_DELAY = 2000;

/** Maximum number of undo/redo steps to keep in memory */
const MAX_HISTORY_SIZE = 50;

// TODO(phase-4): replace with real profile from the session context. Using a
// fixed id keeps "my annotations" stable in the stub phase. Mirrors
// annotationService.getCurrentProfile() so author keys line up.
const LOCAL_PROFILE = { id: 'local-user' };

function collectAnnotationUids(annotationJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(annotationJson);
    const uids: string[] = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && typeof item === 'object' && 'annotationUID' in item && typeof item.annotationUID === 'string') {
          uids.push(item.annotationUID);
        }
      }
    }
    return uids;
  } catch {
    return [];
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Metadata for a single annotation — tracks whether it's "tracked" (saved
 * permanently to DICOM SR) or "untracked" (ephemeral, dashed line style).
 * Think of tracked annotations like bookmarked pages vs. sticky notes.
 */
export interface AnnotationMeta {
  /** Whether this annotation is tracked for persistence */
  isTracked: boolean;
  /** Human-readable label (e.g., "Lesion 1") — assigned when promoted */
  trackingId: string;
  /** Globally unique ID for DICOM SR — assigned when promoted */
  trackingUniqueId: string;
}

/** Return value of the useAnnotations hook */
export interface UseAnnotationsReturn {
  /** All loaded annotations for the study (from all authors) */
  annotations: StoredAnnotations[];
  /** Set of author IDs whose annotations are currently visible */
  visibleAuthors: Set<string>;
  /** Whether a save operation is in progress */
  isSaving: boolean;
  /** ISO timestamp of the last successful save, or null if never saved */
  lastSaved: string | null;
  /** Whether annotations are currently being loaded */
  isLoading: boolean;
  /** Error message from the most recent failed save, or null if none */
  saveError: string | null;
  /** Clear the saveError state (e.g., after user dismisses an error banner) */
  clearSaveError: () => void;
  /** Toggle visibility of a specific author's annotations */
  toggleAuthorVisibility: (authorId: string) => void;
  /** Queue annotation data for debounced auto-save */
  queueSave: (annotationJson: string) => void;
  /** Force an immediate save (e.g., before navigating away) */
  flushSave: () => Promise<void>;
  /** Delete the current user's annotations for this study */
  deleteMyAnnotations: () => Promise<boolean>;
  /** Reload all annotations from the server */
  reload: () => Promise<void>;

  // T031 — Undo/Redo
  /** Undo the last annotation change (restores previous snapshot) */
  undo: () => void;
  /** Redo the last undone annotation change */
  redo: () => void;
  /** Whether undo is available (undo stack has entries) */
  canUndo: boolean;
  /** Whether redo is available (redo stack has entries) */
  canRedo: boolean;

  // T032 — Jump to annotation
  /** Scroll viewport to the annotation's slice and pan to center on it */
  jumpToAnnotation: (annotationUID: string) => void;

  // T033 — Tracking mode
  /** Current tracking mode: 'tracked' saves to DICOM SR, 'untracked' is ephemeral */
  trackingMode: 'tracked' | 'untracked';
  /** Switch tracking mode for new annotations */
  setTrackingMode: (mode: 'tracked' | 'untracked') => void;
  /** Metadata map for each annotation UID — tracks isTracked, trackingId, etc. */
  annotationMeta: Map<string, AnnotationMeta>;
  /** Promote an untracked annotation to tracked (assigns tracking ID, changes to solid line) */
  promoteToTracked: (annotationUID: string) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a UUID v4 for tracking unique IDs.
 *
 * CROSS-M20 (2026-05-06 audit): replaced Math.random() fallback with
 * crypto.getRandomValues — addresses iOS Safari low-entropy-on-first-call.
 *
 * @returns UUID v4 string.
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Cryptographically-secure fallback.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Check whether a parsed value looks like a Cornerstone annotation snapshot.
 *
 * @param value - Parsed JSON value.
 * @returns True when the value can be restored as an annotation.
 */
function isAnnotationSnapshot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('annotationUID' in value || 'metadata' in value || 'data' in value);
}

/**
 * Recursively collect annotation arrays from supported snapshot shapes.
 *
 * @param value - Parsed annotation snapshot.
 * @param out - Mutable collection for annotation objects.
 * @returns True when at least one annotation was found.
 */
function collectSnapshotAnnotations(value: unknown, out: unknown[]): boolean {
  if (Array.isArray(value)) {
    let found = false;
    for (const ann of value) {
      if (isAnnotationSnapshot(ann)) {
        out.push(ann);
        found = true;
      }
    }
    return found;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  let found = false;
  for (const child of Object.values(value)) {
    found = collectSnapshotAnnotations(child, out) || found;
  }
  return found;
}

/**
 * Flatten one author's saved annotation JSON and tag each annotation with that author.
 *
 * @param dataJson - Saved annotation JSON.
 * @param authorId - Stored annotation author id.
 * @returns Restorable annotation snapshots for one author.
 */
function flattenStoredAnnotationData(dataJson: string, authorId: string): unknown[] {
  if (!dataJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(dataJson);
    const annotations: unknown[] = [];
    collectSnapshotAnnotations(parsed, annotations);
    return annotations.map((ann) => {
      const cloned = JSON.parse(JSON.stringify(ann)) as CS3DAnnotation;
      cloned.metadata = { ...cloned.metadata, authorId };
      cloned.data = { ...cloned.data, authorId };
      return cloned;
    });
  } catch (err) {
    console.warn('[useAnnotations] Unable to parse PACS author annotations:', err);
    return [];
  }
}

/**
 * Build a merged restore payload for the currently visible authors.
 *
 * @param all - All loaded annotation records for the study.
 * @param visibleAuthorIds - Author ids currently visible in the viewer.
 * @returns JSON array of annotations to restore into Cornerstone.
 */
function buildVisibleAnnotationsJson(all: StoredAnnotations[], visibleAuthorIds: Set<string>): string {
  const merged = all
    .filter((ann) => visibleAuthorIds.has(ann.authorId))
    .flatMap((ann) => flattenStoredAnnotationData(ann.data, ann.authorId));
  return JSON.stringify(merged);
}

/**
 * Lazy references to CS3D modules.
 * These are set once after Cornerstone3D is initialized. We can't import
 * CS3D statically because it requires WebGL and breaks in SSR/test contexts.
 * Instead, consumer code calls setCS3DModules() after initialization.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _csToolsAnnotationState: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _getRenderingEngine: (() => any) | null = null;

/**
 * Register CS3D modules so the annotation hook can access them.
 * Call this once after Cornerstone3D is initialized (e.g., in PACSViewer).
 *
 * @param annotationState - cornerstoneTools.annotation.state
 * @param getRenderingEngine - function that returns the active RenderingEngine
 */
export function setCS3DModules(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotationState: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRenderingEngine: () => any,
): void {
  _csToolsAnnotationState = annotationState;
  _getRenderingEngine = getRenderingEngine;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manage the full annotation lifecycle for an imaging study.
 *
 * @param studyId - FHIR ImagingStudy resource ID (pass empty string to disable)
 * @returns Annotation state and actions
 */
export function useAnnotations(studyId: string): UseAnnotationsReturn {
  const fhirClient = useLiverraFhir();
  const { t } = useTranslation();

  // State
  const [annotations, setAnnotations] = useState<StoredAnnotations[]>([]);
  const [visibleAuthors, setVisibleAuthors] = useState<Set<string>>(new Set());
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const clearSaveError = useCallback(() => setSaveError(null), []);

  // Refs for debounce and cleanup
  const mountedRef = useRef(true);
  const pendingDataRef = useRef<PendingAnnotationSave | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const activeStudyIdRef = useRef(studyId);
  const latestFhirRef = useRef<LiverRaFhirClient>(fhirClient);
  const latestPreparePersistedAnnotationJsonRef = useRef<(annotationJson: string) => string>(
    (annotationJson) => annotationJson
  );

  useEffect(() => {
    activeStudyIdRef.current = studyId;
    saveRequestIdRef.current += 1;
    setIsSaving(false);
  }, [studyId]);

  // --------------------------------------------------------------------------
  // T031 — Undo/Redo state
  // --------------------------------------------------------------------------
  // Think of this like a photo album: the undo stack holds "before" snapshots,
  // and the redo stack holds "after" snapshots that were undone. When you make
  // a new change, the redo album gets thrown away (can't redo after new edits).

  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  /** Update the boolean state flags to match the actual stack sizes */
  const syncUndoRedoFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  // --------------------------------------------------------------------------
  // T033 — Tracking mode state
  // --------------------------------------------------------------------------
  // "Tracked" annotations get saved permanently to DICOM Structured Reports.
  // "Untracked" ones are temporary — drawn with dashed lines so the user can
  // tell them apart. Like the difference between writing with pen vs. pencil.

  const [trackingMode, setTrackingMode] = useState<'tracked' | 'untracked'>('tracked');
  const [annotationMeta, setAnnotationMeta] = useState<Map<string, AnnotationMeta>>(new Map());
  const trackedCountRef = useRef(0); // Counter for auto-naming (e.g., "Lesion 1", "Lesion 2")
  const lastSnapshotRef = useRef<string | null>(null);
  const queuedTrackedAnnotationUidsRef = useRef<Set<string>>(new Set());

  const preparePersistedAnnotationJson = useCallback((annotationJson: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(annotationJson);
    } catch (err) {
      console.warn('[useAnnotations] best-effort PACS operation failed:', err);
      return annotationJson;
    }

    if (!Array.isArray(parsed)) {
      return annotationJson;
    }

    const currentAuthorId = LOCAL_PROFILE.id;
    const nextMeta = new Map(annotationMeta);
    let metaChanged = false;
    const persisted: unknown[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        persisted.push(item);
        continue;
      }

      const annotation = item as CS3DAnnotation;
      const annotationAuthorId =
        typeof annotation.metadata?.authorId === 'string'
          ? annotation.metadata.authorId
          : typeof annotation.data?.authorId === 'string'
            ? annotation.data.authorId
            : '';
      if (currentAuthorId && annotationAuthorId && annotationAuthorId !== currentAuthorId) {
        continue;
      }
      const uid = annotation.annotationUID;
      if (!uid) {
        persisted.push(item);
        continue;
      }

      let meta = nextMeta.get(uid);
      if (!meta && trackingMode === 'untracked' && queuedTrackedAnnotationUidsRef.current.has(uid)) {
        persisted.push(annotation);
        continue;
      }
      if (!meta) {
        const embeddedTrackingId =
          typeof annotation.metadata?.trackingId === 'string'
            ? annotation.metadata.trackingId
            : typeof annotation.data?.trackingId === 'string'
              ? annotation.data.trackingId
              : '';
        const embeddedTrackingUniqueId =
          typeof annotation.metadata?.trackingUniqueId === 'string'
            ? annotation.metadata.trackingUniqueId
            : typeof annotation.data?.trackingUniqueId === 'string'
              ? annotation.data.trackingUniqueId
              : '';
        if (embeddedTrackingId && embeddedTrackingUniqueId) {
          meta = { isTracked: true, trackingId: embeddedTrackingId, trackingUniqueId: embeddedTrackingUniqueId };
          const lesionNumber = /^Lesion (\d+)$/.exec(embeddedTrackingId)?.[1];
          if (lesionNumber) {
            trackedCountRef.current = Math.max(trackedCountRef.current, Number(lesionNumber));
          }
        } else if (trackingMode === 'untracked') {
          meta = { isTracked: false, trackingId: '', trackingUniqueId: '' };
          if (annotation.data) {
            annotation.data.style = annotation.data.style ?? {};
            annotation.data.style.lineDash = annotation.data.style.lineDash ?? [4, 4];
          }
        } else {
          trackedCountRef.current += 1;
          meta = {
            isTracked: true,
            trackingId: `Lesion ${trackedCountRef.current}`,
            trackingUniqueId: generateUUID(),
          };
          if (annotation.data?.style?.lineDash) {
            delete annotation.data.style.lineDash;
          }
        }
        nextMeta.set(uid, meta);
        metaChanged = true;
      }

      if (meta.isTracked) {
        if (annotation.data?.style?.lineDash) {
          delete annotation.data.style.lineDash;
        }
        annotation.metadata = {
          ...annotation.metadata,
          isTracked: true,
          trackingId: meta.trackingId,
          trackingUniqueId: meta.trackingUniqueId,
        };
        annotation.data = annotation.data ?? {};
        annotation.data.isTracked = true;
        annotation.data.trackingId = meta.trackingId;
        annotation.data.trackingUniqueId = meta.trackingUniqueId;
        persisted.push(annotation);
      }
    }

    if (metaChanged) {
      setAnnotationMeta(nextMeta);
    }

    return JSON.stringify(persisted);
  }, [annotationMeta, trackingMode]);

  latestFhirRef.current = fhirClient;
  latestPreparePersistedAnnotationJsonRef.current = preparePersistedAnnotationJson;

  // --------------------------------------------------------------------------
  // Load annotations when studyId changes
  // --------------------------------------------------------------------------
  const reload = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!studyId) {
      setAnnotations([]);
      setVisibleAuthors(new Set());
      setIsLoading(false);
      restoreAnnotationsFromJson('[]');
      lastSnapshotRef.current = '[]';
      return;
    }

    setIsLoading(true);
    try {
      const all = await loadAnnotations(fhirClient, studyId);
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setAnnotations(all);

      // Make all authors visible by default
      const authorIds = new Set(all.map((a) => a.authorId));
      setVisibleAuthors(authorIds);
      restoreAnnotationsFromJson(buildVisibleAnnotationsJson(all, authorIds));

      // Set lastSaved from current user's annotations (filtered in-memory
      // instead of a redundant FHIR search — "my annotations" is a subset
      // of "all annotations")
      // TODO(phase-4): resolve identity via the real session, not LOCAL_PROFILE.
      const mine = all.find((a) => a.authorId === LOCAL_PROFILE.id);
      if (mine?.lastSaved) {
        setLastSaved(mine.lastSaved);
      }
      lastSnapshotRef.current = mine?.data ?? '[]';
    } catch (err) {
      console.warn('[useAnnotations] PACS fallback path failed:', err);
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      const msg = err instanceof Error ? err.message : t('pacs.annotations.loadFailed');
      notifications.show({ title: t('common.error'), message: msg, color: 'red' });
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [fhirClient, studyId, t]);

  // --------------------------------------------------------------------------
  // T038 — Migrate existing annotations on load
  // --------------------------------------------------------------------------
  // Pre-existing annotations (created before tracking metadata was introduced)
  // won't have entries in annotationMeta. This function assigns defaults so
  // they render with solid line styles (tracked) and have proper metadata.
  const migrateExistingAnnotations = useCallback(() => {
    const annotationState = _csToolsAnnotationState;
    if (!annotationState) {
      return;
    }

    // Get all annotation UIDs currently in the CS3D state
    let allAnnotations: { annotationUID?: string }[] = [];
    try {
      allAnnotations = annotationState.getAllAnnotations?.() ?? [];
    } catch (err) {
      console.warn('[useAnnotations] Unable to read PACS annotations for migration:', err);
      // CS3D may not be ready yet — skip migration
      return;
    }

    if (allAnnotations.length === 0) {
      return;
    }

    let migratedCount = 0;
    const newMeta = new Map<string, AnnotationMeta>();

    for (const ann of allAnnotations) {
      const uid = ann.annotationUID;
      if (!uid) {
        continue;
      }

      let annData: CS3DAnnotation | undefined;
      try {
        annData = annotationState.getAnnotation(uid) as CS3DAnnotation | undefined;
        if (annData?.data?.style?.lineDash) {
          delete annData.data.style.lineDash;
        }
      } catch (err) {
        console.warn('[useAnnotations] Unable to normalize PACS annotation style during migration:', err);
        // Ignore — style will be correct on next render
      }

      const embeddedTrackingId =
        typeof annData?.metadata?.trackingId === 'string'
          ? annData.metadata.trackingId
          : typeof annData?.data?.trackingId === 'string'
            ? annData.data.trackingId
            : '';
      const embeddedTrackingUniqueId =
        typeof annData?.metadata?.trackingUniqueId === 'string'
          ? annData.metadata.trackingUniqueId
          : typeof annData?.data?.trackingUniqueId === 'string'
            ? annData.data.trackingUniqueId
            : '';

      if (embeddedTrackingId && embeddedTrackingUniqueId) {
        newMeta.set(uid, {
          isTracked: true,
          trackingId: embeddedTrackingId,
          trackingUniqueId: embeddedTrackingUniqueId,
        });
        const lesionNumber = /^Lesion (\d+)$/.exec(embeddedTrackingId)?.[1];
        if (lesionNumber) {
          trackedCountRef.current = Math.max(trackedCountRef.current, Number(lesionNumber));
        }
      } else {
        trackedCountRef.current += 1;
        newMeta.set(uid, {
          isTracked: true,
          trackingId: `Lesion ${trackedCountRef.current}`,
          trackingUniqueId: generateUUID(),
        });
      }

      migratedCount++;
    }

    if (migratedCount > 0) {
      setAnnotationMeta(newMeta);
      console.debug(`[useAnnotations] Migrated ${migratedCount} existing annotations with default metadata`);
    }
  }, []);

  // Auto-load when studyId changes
  useEffect(() => {
    let cancelled = false;
    const loadAndMigrate = async (): Promise<void> => {
      await reload();
      if (cancelled) return;
      // T038: After loading, assign default metadata to any pre-existing annotations
      migrateExistingAnnotations();
    };
    loadAndMigrate();

    // Reset undo/redo stacks and tracking meta when study changes
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastSnapshotRef.current = null;
    syncUndoRedoFlags();
    setAnnotationMeta(new Map());
    trackedCountRef.current = 0;
    queuedTrackedAnnotationUidsRef.current = new Set();

    return () => {
      cancelled = true;
    };
  }, [reload, syncUndoRedoFlags, migrateExistingAnnotations]);

  useEffect(() => {
    if (!studyId) {
      return;
    }
    restoreAnnotationsFromJson(buildVisibleAnnotationsJson(annotations, visibleAuthors));
  }, [annotations, studyId, visibleAuthors]);

  // --------------------------------------------------------------------------
  // Toggle author visibility
  // --------------------------------------------------------------------------
  const toggleAuthorVisibility = useCallback((authorId: string) => {
    setVisibleAuthors((prev) => {
      const next = new Set(prev);
      if (next.has(authorId)) {
        next.delete(authorId);
      } else {
        next.add(authorId);
      }
      return next;
    });
  }, []);

  // --------------------------------------------------------------------------
  // Internal save — performs the actual FHIR save
  // --------------------------------------------------------------------------
  const performSave = useCallback(async (data: string, targetStudyId = studyId) => {
    if (!targetStudyId) {
      return;
    }
    // If a save is already in progress, re-queue the data so it's not lost
    if (savingRef.current) {
      pendingDataRef.current = { studyId: targetStudyId, data };
      return;
    }

    const requestId = ++saveRequestIdRef.current;
    savingRef.current = true;
    setIsSaving(true);

    try {
      const result = await saveAnnotations(fhirClient, targetStudyId, preparePersistedAnnotationJson(data));
      if (
        !mountedRef.current ||
        requestId !== saveRequestIdRef.current ||
        activeStudyIdRef.current !== targetStudyId
      ) {
        return;
      }
      setLastSaved(result.lastSaved);
      setSaveError(null); // Clear any previous error on success

      // Update local annotation list with the saved data
      setAnnotations((prev) => {
        const idx = prev.findIndex((a) => a.authorId === result.authorId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = result;
          return next;
        }
        return [...prev, result];
      });

      // Ensure author is visible
      setVisibleAuthors((prev) => {
        if (prev.has(result.authorId)) {
          return prev;
        }
        const next = new Set(prev);
        next.add(result.authorId);
        return next;
      });
    } catch (err) {
      console.warn('[useAnnotations] PACS annotation save failed:', err);
      const msg = err instanceof Error ? err.message : t('pacs.annotations.saveFailed');
      if (
        mountedRef.current &&
        requestId === saveRequestIdRef.current &&
        activeStudyIdRef.current === targetStudyId
      ) {
        setSaveError(msg);
        notifications.show({ title: t('common.error'), message: msg, color: 'red' });
      }
    } finally {
      savingRef.current = false;
      if (
        mountedRef.current &&
        requestId === saveRequestIdRef.current &&
        activeStudyIdRef.current === targetStudyId
      ) {
        setIsSaving(false);
      }
      // If new data was queued while we were saving, save it now
      // Guard against post-unmount recursive calls (prevents React state
      // update warnings and stale data saves)
      const queued = pendingDataRef.current;
      if (queued !== null && mountedRef.current) {
        pendingDataRef.current = null;
        performSave(queued.data, queued.studyId);
      }
    }
  }, [fhirClient, studyId, t, preparePersistedAnnotationJson]);

  // --------------------------------------------------------------------------
  // Debounced auto-save — queue tracked changes after 2 seconds of quiet
  // --------------------------------------------------------------------------
  // T031: Also pushes the previous state onto the undo stack so we can revert.
  const queueSave = useCallback((annotationJson: string) => {
    // T031: Push previous snapshot onto undo stack before recording the new one
    const previousSnapshot = lastSnapshotRef.current;
    if (previousSnapshot !== null && previousSnapshot !== annotationJson) {
      undoStackRef.current.push(previousSnapshot);
      // Cap the undo stack so it doesn't grow forever
      if (undoStackRef.current.length > MAX_HISTORY_SIZE) {
        undoStackRef.current.shift();
      }
      // New edit invalidates the redo stack (like in any text editor)
      redoStackRef.current = [];
      syncUndoRedoFlags();
    }
    lastSnapshotRef.current = annotationJson;
    if (trackingMode === 'tracked') {
      for (const uid of collectAnnotationUids(annotationJson)) {
        queuedTrackedAnnotationUidsRef.current.add(uid);
      }
    }

    pendingDataRef.current = studyId ? { studyId, data: annotationJson } : null;

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Set a new timer — save after 2 seconds of no changes
    timerRef.current = setTimeout(() => {
      const data = pendingDataRef.current;
      if (data !== null) {
        pendingDataRef.current = null;
        performSave(data.data, data.studyId);
      }
    }, AUTO_SAVE_DELAY);
  }, [performSave, syncUndoRedoFlags, studyId, trackingMode]);

  // --------------------------------------------------------------------------
  // T031: Undo — pop from undo stack, push current to redo, restore previous
  // --------------------------------------------------------------------------
  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) {
      return;
    }

    const previousState = undoStackRef.current.pop()!;
    const currentState = lastSnapshotRef.current;

    // Push current state to redo stack so we can redo later
    if (currentState !== null) {
      redoStackRef.current.push(currentState);
    }

    // Restore the previous snapshot
    lastSnapshotRef.current = previousState;
    pendingDataRef.current = studyId ? { studyId, data: previousState } : null;

    // Restore annotations in the Cornerstone3D viewport so they're visible
    restoreAnnotationsFromJson(previousState);

    // Clear existing debounce and save immediately
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    performSave(previousState, studyId);
    syncUndoRedoFlags();
  }, [performSave, syncUndoRedoFlags, studyId]);

  // --------------------------------------------------------------------------
  // T031: Redo — pop from redo stack, push current to undo, restore next
  // --------------------------------------------------------------------------
  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) {
      return;
    }

    const nextState = redoStackRef.current.pop()!;
    const currentState = lastSnapshotRef.current;

    // Push current state to undo stack
    if (currentState !== null) {
      undoStackRef.current.push(currentState);
    }

    // Restore the next snapshot
    lastSnapshotRef.current = nextState;
    pendingDataRef.current = studyId ? { studyId, data: nextState } : null;

    // Restore annotations in the Cornerstone3D viewport so they're visible
    restoreAnnotationsFromJson(nextState);

    // Save immediately
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    performSave(nextState, studyId);
    syncUndoRedoFlags();
  }, [performSave, syncUndoRedoFlags, studyId]);

  // --------------------------------------------------------------------------
  // T032: Jump to annotation — scroll viewport to annotation's slice & pan
  // --------------------------------------------------------------------------
  // Like clicking a search result — the viewer jumps to show exactly where
  // that annotation lives in the image stack.
  const jumpToAnnotation = useCallback((annotationUID: string) => {
    const annotationState = _csToolsAnnotationState;
    if (!annotationState) {
      return;
    }

    const ann = annotationState.getAnnotation(annotationUID) as CS3DAnnotation | undefined;
    if (!ann) {
      return;
    }

    const re = _getRenderingEngine?.() ?? null;
    if (!re) {
      return;
    }

    // Find the annotation's handles — these are the control points (endpoints
    // of a length measurement, corners of an ROI, etc.)
    const handles = ann.data?.handles?.points;
    if (!Array.isArray(handles) || handles.length === 0) {
      return;
    }

    // Compute centroid (average of all handle positions)
    // Each handle is a [x, y, z] world coordinate
    let cx = 0, cy = 0, cz = 0;
    for (const pt of handles) {
      if (Array.isArray(pt) && pt.length >= 3) {
        cx += pt[0];
        cy += pt[1];
        cz += pt[2];
      }
    }
    cx /= handles.length;
    cy /= handles.length;
    cz /= handles.length;

    // Find the viewport this annotation belongs to (or use the first one)
    const viewports = re.getViewports();
    if (viewports.length === 0) {
      return;
    }
    const viewport = viewports[0];

    // For stack viewports: find the image closest to the annotation's z-position
    // and scroll to it. For volume viewports, the camera focal point handles this.
    try {
      if (viewport.getImageIds && viewport.setImageIdIndex) {
        const imageIds = viewport.getImageIds();
        if (imageIds.length > 0) {
          // We use the annotation's reference image ID if available
          const refImageId = ann.metadata?.referencedImageId;
          if (refImageId) {
            const idx = imageIds.indexOf(refImageId);
            if (idx >= 0) {
              viewport.setImageIdIndex(idx);
            }
          }
        }
      }

      // Pan the camera to center on the annotation's centroid
      if (viewport.setCamera && viewport.getCamera) {
        const camera = viewport.getCamera();
        viewport.setCamera({
          ...camera,
          focalPoint: [cx, cy, cz],
        });
      }

      viewport.render();
    } catch (err) {
      console.warn('[useAnnotations] Unable to jump to PACS annotation viewport:', err);
      // Viewport may not support these operations (e.g., 3D viewport)
    }
  }, []);

  // --------------------------------------------------------------------------
  // T033: Promote an untracked annotation to tracked
  // --------------------------------------------------------------------------
  // Changes the annotation from dashed line (temporary) to solid line (permanent).
  // Assigns a human-readable name like "Lesion 1" and a UUID for DICOM SR.
  const promoteToTracked = useCallback((annotationUID: string) => {
    trackedCountRef.current += 1;
    const trackingId = `Lesion ${trackedCountRef.current}`;
    const trackingUniqueId = generateUUID();

    const meta: AnnotationMeta = {
      isTracked: true,
      trackingId,
      trackingUniqueId,
    };

    setAnnotationMeta((prev) => {
      const next = new Map(prev);
      next.set(annotationUID, meta);
      return next;
    });

    // Update the annotation's visual style in CS3D — remove dashed line
    try {
      const annotationState = _csToolsAnnotationState;
      if (annotationState) {
        const ann = annotationState.getAnnotation(annotationUID) as CS3DAnnotation | undefined;
        if (ann) {
          // Remove lineDash to make it solid (tracked)
          if (ann.data?.style) {
            delete ann.data.style.lineDash;
          }

          // Re-render viewports to reflect the style change
          const re = _getRenderingEngine?.() ?? null;
          if (re) {
            const viewports = re.getViewports();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            viewports.forEach((vp: any) => vp.render());
          }
        }
      }
    } catch (err) {
      console.warn('[useAnnotations] Unable to promote PACS annotation style:', err);
      // CS3D may not be initialized — style will be applied on next render
    }
  }, []);

  // --------------------------------------------------------------------------
  // Flush — force immediate save of any pending data
  // --------------------------------------------------------------------------
  const flushSave = useCallback(async () => {
    // Clear the debounce timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const data = pendingDataRef.current;
    if (data !== null) {
      pendingDataRef.current = null;
      await performSave(data.data, data.studyId);
    }
  }, [performSave]);

  // --------------------------------------------------------------------------
  // Delete current user's annotations
  // --------------------------------------------------------------------------
  const deleteMyAnnotations = useCallback(async (): Promise<boolean> => {
    if (!studyId) {
      return false;
    }

    const deleted = await deleteAnnotations(fhirClient, studyId);
    if (deleted && mountedRef.current) {
      // Remove from local state
      // TODO(phase-4): filter by real session identity once available.
      setAnnotations((prev) => prev.filter((a) => a.authorId !== LOCAL_PROFILE.id));
      setLastSaved(null);
    }
    return deleted;
  }, [fhirClient, studyId]);

  // --------------------------------------------------------------------------
  // Cleanup: flush pending saves on study change or actual unmount
  // --------------------------------------------------------------------------
  const flushPendingSaveForCleanup = useCallback(() => {
    // Clear debounce timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Flush any pending save (fire-and-forget — route/study is changing)
    const data = pendingDataRef.current;
    if (data !== null && data.studyId) {
      pendingDataRef.current = null;
      const currentFhir = latestFhirRef.current;
      saveAnnotations(
        currentFhir,
        data.studyId,
        latestPreparePersistedAnnotationJsonRef.current(data.data)
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[useAnnotations] Save failed:', msg);
        // TODO(phase-4): surface 401 / session-expired once the real Cognito
        // session + refresh are wired through LiverRaFhirClient.
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      flushPendingSaveForCleanup();
    };
  }, [studyId, flushPendingSaveForCleanup]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushPendingSaveForCleanup();
    };
  }, [flushPendingSaveForCleanup]);

  // --------------------------------------------------------------------------
  // Return — memoized to prevent unnecessary re-renders in consumers
  // --------------------------------------------------------------------------
  return useMemo(() => ({
    annotations,
    visibleAuthors,
    isSaving,
    lastSaved,
    isLoading,
    saveError,
    clearSaveError,
    toggleAuthorVisibility,
    queueSave,
    flushSave,
    deleteMyAnnotations,
    reload,
    // T031 — Undo/Redo
    undo,
    redo,
    canUndo,
    canRedo,
    // T032 — Jump to annotation
    jumpToAnnotation,
    // T033 — Tracking mode
    trackingMode,
    setTrackingMode,
    annotationMeta,
    promoteToTracked,
  }), [
    annotations,
    visibleAuthors,
    isSaving,
    lastSaved,
    isLoading,
    saveError,
    clearSaveError,
    toggleAuthorVisibility,
    queueSave,
    flushSave,
    deleteMyAnnotations,
    reload,
    undo,
    redo,
    canUndo,
    canRedo,
    jumpToAnnotation,
    trackingMode,
    setTrackingMode,
    annotationMeta,
    promoteToTracked,
  ]);
}
