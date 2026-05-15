// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useRadiologyReport — Hook for loading/saving radiology reports
// ============================================================================
// Wraps the radiologyReportService to provide React-friendly state management.
// Tracks dirty state (has the user edited the report since last save?),
// handles loading/saving, and exposes the report data.
//
// Phase-2 status (LiverRa):
//   Load currently returns null (stubbed FHIR client). Saves flow through
//   the stub — the UI shows "saved", but reloading will lose the content
//   until Phase 4 wires real storage. Callers can rely on the signature
//   being stable: when persistence arrives, this hook will start hydrating
//   with real data without further call-site changes.
//
// Ported from MediMind (hooks/pacs/useRadiologyReport.ts) with:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - Removed `CathLabData` / `CADRADSData` params (cardiology out of scope).
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  saveRadiologyReport,
  loadRadiologyReport,
  createAddendum as createAddendumService,
  getAddenda as getAddendaService,
  type RadiologyReportData,
  type SaveReportParams,
} from '../../services/pacs/radiologyReportService';

export interface UseRadiologyReportOptions {
  /** FHIR ImagingStudy resource ID. */
  studyId: string;
  /** FHIR Patient resource ID. */
  patientId: string;
}

/** localStorage key for the auto-next preference. */
const AUTO_NEXT_STORAGE_KEY = 'pacs.autoNextEnabled';

export interface UseRadiologyReportReturn {
  /** The loaded report data (null if no report exists yet). */
  report: RadiologyReportData | null;
  /** Whether the report is currently loading. */
  isLoading: boolean;
  /** Whether the report is currently saving. */
  isSaving: boolean;
  /** Error from load or save operations. */
  error: string | null;
  /** Whether the editor content has changed since last save. */
  isDirty: boolean;
  /** Update the current HTML content (tracks dirty state). */
  setContent: (html: string) => void;
  /** Current HTML content in the editor. */
  content: string;
  /** Save the report with the given status. */
  save: (params: {
    reportStatus: 'partial' | 'preliminary' | 'final';
    conclusion?: string;
    practitionerRef?: string;
    practitionerDisplay?: string;
  }) => Promise<RadiologyReportData | null>;
  /** Reload the report from the server. */
  reload: () => void;
  /** Create a new addendum linked to a signed report. */
  createAddendum: (originalReportId: string) => Promise<string | null>;
  /** List of addenda linked to the current report. */
  addenda: RadiologyReportData[];
  /** Whether addenda are loading. */
  addendaLoading: boolean;
  /** Fetch addenda for a given report. */
  loadAddenda: (reportId: string) => Promise<void>;
  /** Whether auto-next (auto-advance to next unread study after signing) is enabled. */
  autoNextEnabled: boolean;
  /** Toggle auto-next on/off (persists to localStorage). */
  toggleAutoNext: () => void;
}

export function useRadiologyReport({
  studyId,
  patientId,
}: UseRadiologyReportOptions): UseRadiologyReportReturn {
  const medplum = useLiverraFhir();
  const { t } = useTranslation();

  const [report, setReport] = useState<RadiologyReportData | null>(null);
  const [content, setContentState] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Track the last saved content to compare for dirty state
  const lastSavedContentRef = useRef('');

  // Ref that stays in sync with `content` — used inside save callbacks
  // so they don't need `content` in their dependency arrays (which would
  // cause ALL callbacks to recreate on every keystroke).
  const contentRef = useRef(content);
  contentRef.current = content;

  // ── Auto-next preference (persisted in localStorage) ──
  // Like Netflix "auto-play next episode" — after signing a report,
  // automatically advance to the next unread study.
  const [autoNextEnabled, setAutoNextEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_NEXT_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggleAutoNext = useCallback(() => {
    setAutoNextEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTO_NEXT_STORAGE_KEY, String(next));
      } catch {
        // localStorage unavailable — state still toggles in memory.
      }
      return next;
    });
  }, []);

  // Sync auto-next preference across browser tabs
  useEffect(() => {
    const handler = (e: StorageEvent): void => {
      if (e.key === AUTO_NEXT_STORAGE_KEY) {
        setAutoNextEnabled(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Load report on mount or when studyId changes
  const load = useCallback(async () => {
    if (!studyId) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await loadRadiologyReport(medplum, studyId);
      setReport(data);
      if (data) {
        setContentState(data.htmlContent);
        lastSavedContentRef.current = data.htmlContent;
      } else {
        setContentState('');
        lastSavedContentRef.current = '';
      }
      setIsDirty(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useRadiologyReport] Failed to load report:', err);
      setError(err instanceof Error ? err.message : t('pacs.report.loadError'));
    } finally {
      setIsLoading(false);
    }
    // `t` is a stable identity from TranslationContext — intentionally omitted
    // to keep load() from re-running on every re-render triggered by unrelated
    // context updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medplum, studyId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Update content and track dirty state
  const setContent = useCallback((html: string) => {
    setContentState(html);
    setIsDirty(html !== lastSavedContentRef.current);
  }, []);

  // Save the report
  const save = useCallback(
    async (params: {
      reportStatus: 'partial' | 'preliminary' | 'final';
      conclusion?: string;
      practitionerRef?: string;
      practitionerDisplay?: string;
    }): Promise<RadiologyReportData | null> => {
      setIsSaving(true);
      setError(null);
      try {
        const currentContent = contentRef.current;
        const saveParams: SaveReportParams = {
          studyId,
          patientId,
          reportStatus: params.reportStatus,
          htmlContent: currentContent,
          conclusion: params.conclusion,
          practitionerRef: params.practitionerRef,
          practitionerDisplay: params.practitionerDisplay,
        };
        await saveRadiologyReport(medplum, saveParams);
        // Reload the report to get the full data (including new ID).
        const reloaded = await loadRadiologyReport(medplum, studyId);
        setReport(reloaded);
        lastSavedContentRef.current = currentContent;
        setIsDirty(false);
        return reloaded;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useRadiologyReport] Failed to save report:', err);
        const msg = err instanceof Error ? err.message : t('pacs.report.saveError');
        setError(msg);
        return null;
      } finally {
        setIsSaving(false);
      }
    },
    // Same rationale as load() — `t` intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [medplum, studyId, patientId],
  );

  // ── Addendum support ──
  const [addenda, setAddenda] = useState<RadiologyReportData[]>([]);
  const [addendaLoading, setAddendaLoading] = useState(false);

  const loadAddenda = useCallback(async (reportId: string) => {
    setAddendaLoading(true);
    try {
      const results = await getAddendaService(medplum, reportId);
      setAddenda(results);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useRadiologyReport] Failed to load addenda:', err);
    } finally {
      setAddendaLoading(false);
    }
  }, [medplum]);

  // Auto-load addenda when report is final
  useEffect(() => {
    if (report?.id && report?.status === 'final') {
      void loadAddenda(report.id);
    }
  }, [report?.id, report?.status, loadAddenda]);

  const createAddendum = useCallback(async (originalReportId: string): Promise<string | null> => {
    try {
      const newReport = await createAddendumService(medplum, originalReportId);
      if (newReport.id) {
        // Refresh addenda list
        await loadAddenda(originalReportId);
        return newReport.id;
      }
      return null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[useRadiologyReport] Failed to create addendum:', err);
      const msg = err instanceof Error ? err.message : t('pacs.report.saveError');
      setError(msg);
      return null;
    }
    // M-HOOK-4 justification: ``t`` (translation function) is referenced
    // for the error fallback but tracked by react-i18next as stable
    // across the component lifetime; adding it would chum the deps
    // array on every locale-context render without functional benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medplum, loadAddenda]);

  return {
    report,
    isLoading,
    isSaving,
    error,
    isDirty,
    setContent,
    content,
    save,
    reload: load,
    createAddendum,
    addenda,
    addendaLoading,
    loadAddenda,
    autoNextEnabled,
    toggleAutoNext,
  };
}
