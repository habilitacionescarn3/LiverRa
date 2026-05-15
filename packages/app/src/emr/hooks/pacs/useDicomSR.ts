// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useDicomSR Hook
// ============================================================================
// React hook for saving/loading annotations as DICOM Structured Reports (SR).
// Think of it like a "Google Docs save to PDF" — it packages the annotations
// you drew on an image into a standard DICOM format that any PACS system can
// understand. Loading is the reverse: it reads an SR and re-creates the
// annotations on screen.
//
// Integrates with dicomSRService which stores SRs as FHIR Basic resources
// via the LiverRa FHIR shim. The hook manages React lifecycle: loading states,
// error handling, toasts, and concurrency guards.
//
// Features:
//   T101 — Save to PACS button (saveToSR)
//   T102 — Auto-load SR on study open (autoLoadSR)
//   T103 — Color-code annotations by author (authorColorMap)
//
// Ported from MediMind. `useMedplum()` + `useMedplumProfile()` →
// `useLiverraFhir()`. `profile.id` is resolved from a local stub today;
// Phase 4 wires the real session identity.
// ============================================================================

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from '../../contexts/TranslationContext';
import { useLiverraFhir } from '../useLiverraFhir';
import {
  exportAnnotationsToSR,
  importAnnotationsFromSR,
} from '../../services/pacs/dicomSRService';
import type { SRImportResult as ServiceSRImportResult } from '../../services/pacs/dicomSRService';

// ============================================================================
// Minimal types for Cornerstone3D runtime globals (injected by cornerstoneInit.ts)
// ============================================================================

interface CS3DAnnotationStyle {
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
}

interface CS3DAnnotationData {
  style?: CS3DAnnotationStyle;
  [key: string]: unknown;
}

interface CS3DAnnotation {
  annotationUID?: string;
  data?: CS3DAnnotationData;
  metadata?: Record<string, unknown>;
}

interface CS3DAnnotationState {
  getAnnotation: (uid: string) => CS3DAnnotation | undefined;
  getAllAnnotations: () => CS3DAnnotation[];
  addAnnotation: (annotation: unknown) => void;
}

interface CS3DViewport {
  render: () => void;
}

interface CS3DRenderingEngine {
  getViewports: () => CS3DViewport[];
}

interface CS3DToolsGlobal {
  annotation: {
    state: CS3DAnnotationState;
  };
}

interface CS3DCoreGlobal {
  getRenderingEngines: () => CS3DRenderingEngine[];
}

// ============================================================================
// Types
// ============================================================================

/** Result from importing annotations from a DICOM SR */
export interface SRImportResult {
  /** Number of annotations loaded */
  annotationCount: number;
  /** Names of authors who created annotations in the SR */
  authorNames: string[];
}

/** Return value of the useDicomSR hook */
export interface UseDicomSRReturn {
  /** Save current annotations as a DICOM SR to PACS */
  saveToSR: () => Promise<void>;
  /** Load the latest SR for the current study from PACS */
  loadFromSR: () => Promise<void>;
  /** Auto-load SR on mount — runs once when studyInstanceUID changes */
  autoLoadSR: () => Promise<SRImportResult | null>;
  /** Whether a save operation is currently in progress */
  isSaving: boolean;
  /** Whether a load operation is currently in progress */
  isLoading: boolean;
  /** ISO timestamp of the last successful save, or null */
  lastSavedAt: string | null;
  /** SOP Instance UIDs of known SR instances for this study */
  srInstances: string[];
  /** Last error message, cleared at the start of each operation */
  error: string | null;
  /** Number of annotations in the current viewport (for enabling/disabling save) */
  annotationCount: number;
  /** Map of author name → assigned color for loaded annotations */
  authorColorMap: Map<string, string>;
}

// ============================================================================
// Constants
// ============================================================================

import { THEME_COLORS } from '../../constants/theme-colors';

/**
 * Color palette for distinguishing different authors' annotations.
 *
 * First slot uses the brand-aware THEME_COLORS.secondary so the palette
 * tracks the brand-ramp swap (T464). Remaining slots are domain-specific
 * categorical colors that don't need to swap (chart palette).
 */
export const AUTHOR_COLORS = [
  THEME_COLORS.secondary, // brand secondary (tracks T464)
  '#ef4444', // red
  '#22c55e', // green
  '#a855f7', // purple
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#14b8a6', // teal
];

/** Default color for annotations with no author info — uses neutral text-secondary token. */
const UNKNOWN_AUTHOR_COLOR = THEME_COLORS.textSecondary;

// TODO(phase-4): replace with real authenticated Practitioner id from the
// session. Using a fixed stub keeps the shim deterministic during Phase 2.
const LOCAL_PRACTITIONER_ID = 'local-user';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a color map assigning a distinct color to each author.
 * If there are more than 8 authors, colors cycle through the palette.
 * Authors with empty/missing names get "Unknown" as their key.
 */
export function buildAuthorColorMap(authorNames: string[]): Map<string, string> {
  const colorMap = new Map<string, string>();
  const uniqueAuthors = [...new Set(
    authorNames.map((name) => (name?.trim() || 'Unknown'))
  )];

  for (let i = 0; i < uniqueAuthors.length; i++) {
    const author = uniqueAuthors[i];
    if (author === 'Unknown') {
      colorMap.set(author, UNKNOWN_AUTHOR_COLOR);
    } else {
      colorMap.set(author, AUTHOR_COLORS[i % AUTHOR_COLORS.length]);
    }
  }

  return colorMap;
}

/**
 * Apply author-based colors to loaded annotations via Cornerstone3D API.
 * Each annotation gets its style.color set based on who created it.
 * Current session annotations (not from SR) keep the default color.
 */
export function applyAuthorColorsToAnnotations(
  annotationAuthorMap: Map<string, string>,
  colorMap: Map<string, string>
): void {
  try {
    const csTools = (window as { __cornerstoneTools?: CS3DToolsGlobal }).__cornerstoneTools;
    if (!csTools?.annotation?.state) return;

    for (const [annotationUID, authorName] of annotationAuthorMap) {
      const color = colorMap.get(authorName) ?? UNKNOWN_AUTHOR_COLOR;
      try {
        const annotation = csTools.annotation.state.getAnnotation(annotationUID);
        if (annotation) {
          // Set the annotation's style — CS3D uses this for rendering
          if (!annotation.data) {
            annotation.data = {};
          }
          if (!annotation.data.style) {
            annotation.data.style = {};
          }
          annotation.data.style.color = color;
          annotation.data.style.lineWidth = 2;
        }
      } catch {
        // Individual annotation may not exist — skip
      }
    }

    // Trigger viewport re-render to show updated colors
    const csCore = (window as { __cornerstoneCore?: CS3DCoreGlobal }).__cornerstoneCore;
    if (csCore?.getRenderingEngines) {
      const engines = csCore.getRenderingEngines();
      for (const engine of engines) {
        const viewports = engine.getViewports();
        for (const vp of viewports) {
          vp.render();
        }
      }
    }
  } catch {
    // CS3D may not be initialized — colors will be applied on next render
  }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Manage DICOM Structured Report (SR) save/load for annotations.
 *
 * @param studyInstanceUID - The DICOM StudyInstanceUID to associate SRs with
 * @param patientId - Patient FHIR id (required for SR's Patient.reference)
 */
export function useDicomSR(studyInstanceUID: string, patientId: string): UseDicomSRReturn {
  const { t } = useTranslation();
  const fhirClient = useLiverraFhir();
  // TODO(phase-4): pull the authenticated Practitioner id from session instead
  // of the LOCAL_PRACTITIONER_ID stub.
  const practitionerId = LOCAL_PRACTITIONER_ID;

  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [srInstances, setSrInstances] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [annotationCount, setAnnotationCount] = useState(0);
  const [authorColorMap, setAuthorColorMap] = useState<Map<string, string>>(new Map());

  const mountedRef = useRef(true);
  const studyRef = useRef(studyInstanceUID);
  studyRef.current = studyInstanceUID;

  // Reset state when study changes
  useEffect(() => {
    setLastSavedAt(null);
    setSrInstances([]);
    setError(null);
    setAnnotationCount(0);
    setAuthorColorMap(new Map());
  }, [studyInstanceUID]);

  // Track annotation count — poll CS3D annotation state every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      try {
        const csTools = (window as { __cornerstoneTools?: CS3DToolsGlobal }).__cornerstoneTools;
        if (csTools?.annotation?.state) {
          const allAnnotations = csTools.annotation.state.getAllAnnotations?.() ?? [];
          if (mountedRef.current) {
            setAnnotationCount(allAnnotations.length);
          }
        }
      } catch {
        // CS3D may not be initialized
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [studyInstanceUID]);

  // --------------------------------------------------------------------------
  // Helper: get the CS3D annotation add function
  // --------------------------------------------------------------------------
  const getAddAnnotationFn = useCallback(() => {
    const csTools = (window as { __cornerstoneTools?: CS3DToolsGlobal }).__cornerstoneTools;
    if (csTools?.annotation?.state?.addAnnotation) {
      return (annotation: unknown) => csTools.annotation.state.addAnnotation(annotation);
    }
    return null;
  }, []);

  // --------------------------------------------------------------------------
  // Helper: get all current annotations from CS3D
  // --------------------------------------------------------------------------
  const getCurrentAnnotations = useCallback(() => {
    try {
      const csTools = (window as { __cornerstoneTools?: CS3DToolsGlobal }).__cornerstoneTools;
      if (csTools?.annotation?.state) {
        return csTools.annotation.state.getAllAnnotations?.() ?? [];
      }
    } catch {
      // CS3D not ready
    }
    return [];
  }, []);

  // --------------------------------------------------------------------------
  // Save to SR — packages current annotations into a DICOM SR
  // --------------------------------------------------------------------------
  const saveToSR = useCallback(async () => {
    if (isSaving || isLoading) return;
    setIsSaving(true);
    setError(null);

    try {
      const annotations = getCurrentAnnotations();
      if (annotations.length === 0) {
        notifications.show({
          title: t('pacs.sr.noMeasurements'),
          message: t('pacs.sr.noAnnotationsToSave'),
          color: 'yellow',
        });
        return;
      }

      const result = await exportAnnotationsToSR(
        fhirClient,
        studyRef.current,
        JSON.stringify(annotations),
        practitionerId,
        patientId
      );

      if (mountedRef.current && result.success) {
        setLastSavedAt(new Date().toISOString());
        if (result.sopInstanceUID) {
          setSrInstances((prev) =>
            prev.includes(result.sopInstanceUID!) ? prev : [...prev, result.sopInstanceUID!]
          );
        }
        notifications.show({
          title: t('pacs.sr.measurementsSaved'),
          message: t('pacs.sr.measurementsSavedMessage', { count: result.annotationCount }),
          color: 'green',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('pacs.sr.saveFailed');
      if (mountedRef.current) {
        setError(msg);
        notifications.show({
          title: t('pacs.sr.saveFailed'),
          message: msg,
          color: 'red',
        });
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [isSaving, isLoading, getCurrentAnnotations, fhirClient, practitionerId, patientId, t]);

  // --------------------------------------------------------------------------
  // Load from SR — retrieves latest SR and imports annotations
  // --------------------------------------------------------------------------
  const loadFromSR = useCallback(async () => {
    if (isLoading || isSaving) return;
    setIsLoading(true);
    setError(null);

    try {
      const addFn = getAddAnnotationFn();
      if (!addFn) {
        throw new Error(t('pacs.sr.annotationManagerNotReady'));
      }

      const result: ServiceSRImportResult = await importAnnotationsFromSR(
        fhirClient,
        studyRef.current,
        practitionerId,
        patientId
      );

      if (mountedRef.current && result.success) {
        // Derive srInstanceUIDs and authorNames from the annotations array
        const srInstanceUIDs = [...new Set(result.annotations.map((a) => a.srInstanceUID))];
        const authorNames = [...new Set(result.annotations.map((a) => a.authorName).filter(Boolean))];

        setSrInstances(srInstanceUIDs);

        // Inject each annotation into Cornerstone3D
        for (const ann of result.annotations) {
          try {
            const parsed = JSON.parse(ann.data);
            addFn(parsed);
          } catch {
            // Skip malformed annotation data
          }
        }

        // Build author color map and apply to imported annotations (T103)
        if (authorNames.length > 0) {
          const colorMap = buildAuthorColorMap(authorNames);
          setAuthorColorMap(colorMap);

          // Map each annotation UID to its author so we can color-code them
          const annotationAuthorMap = new Map<string, string>();
          for (const ann of result.annotations) {
            try {
              const parsed = JSON.parse(ann.data);
              if (parsed.annotationUID) {
                annotationAuthorMap.set(parsed.annotationUID, ann.authorName || 'Unknown');
              }
            } catch {
              // Skip malformed
            }
          }
          applyAuthorColorsToAnnotations(annotationAuthorMap, colorMap);
        }

        if (result.annotationCount > 0) {
          notifications.show({
            title: t('pacs.sr.measurementsLoaded'),
            message: t('pacs.sr.measurementsLoadedMessage', { count: result.annotationCount }),
            color: 'green',
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('pacs.sr.loadFailed');
      if (mountedRef.current) {
        setError(msg);
        notifications.show({
          title: t('pacs.sr.loadFailed'),
          message: msg,
          color: 'red',
        });
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [isLoading, isSaving, getAddAnnotationFn, fhirClient, practitionerId, patientId, t]);

  // --------------------------------------------------------------------------
  // Auto-load SR — called once when a study opens to check for existing SRs
  // --------------------------------------------------------------------------
  const autoLoadSR = useCallback(async (): Promise<SRImportResult | null> => {
    if (!studyInstanceUID) return null;
    setIsLoading(true);
    setError(null);

    try {
      const addFn = getAddAnnotationFn();
      if (!addFn) {
        // CS3D not ready yet — caller can retry later
        return null;
      }

      const result: ServiceSRImportResult = await importAnnotationsFromSR(
        fhirClient,
        studyInstanceUID,
        practitionerId,
        patientId
      );

      if (mountedRef.current && result.success) {
        // Derive srInstanceUIDs and authorNames from the annotations array
        const srInstanceUIDs = [...new Set(result.annotations.map((a) => a.srInstanceUID))];
        const authorNames = [...new Set(result.annotations.map((a) => a.authorName).filter(Boolean))];

        setSrInstances(srInstanceUIDs);

        // Inject each annotation into Cornerstone3D
        for (const ann of result.annotations) {
          try {
            const parsed = JSON.parse(ann.data);
            addFn(parsed);
          } catch {
            // Skip malformed annotation data
          }
        }

        // Apply author colors for loaded annotations (T103)
        if (authorNames.length > 0) {
          const colorMap = buildAuthorColorMap(authorNames);
          setAuthorColorMap(colorMap);

          // Map each annotation UID to its author so we can color-code them
          const annotationAuthorMap = new Map<string, string>();
          for (const ann of result.annotations) {
            try {
              const parsed = JSON.parse(ann.data);
              if (parsed.annotationUID) {
                annotationAuthorMap.set(parsed.annotationUID, ann.authorName || 'Unknown');
              }
            } catch {
              // Skip malformed
            }
          }
          applyAuthorColorsToAnnotations(annotationAuthorMap, colorMap);
        }

        if (result.annotationCount > 0) {
          return {
            annotationCount: result.annotationCount,
            authorNames,
          };
        }
      }

      // No SR found — normal case for new studies
      return null;
    } catch {
      // Auto-load is silent — don't show error toasts for a background check
      return null;
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [studyInstanceUID, getAddAnnotationFn, fhirClient, practitionerId, patientId]);

  // Cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return useMemo(() => ({
    saveToSR,
    loadFromSR,
    autoLoadSR,
    isSaving,
    isLoading,
    lastSavedAt,
    srInstances,
    error,
    annotationCount,
    authorColorMap,
  }), [
    saveToSR,
    loadFromSR,
    autoLoadSR,
    isSaving,
    isLoading,
    lastSavedAt,
    srInstances,
    error,
    annotationCount,
    authorColorMap,
  ]);
}
