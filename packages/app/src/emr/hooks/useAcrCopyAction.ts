// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useAcrCopyAction — shared Copy-to-Clipboard logic for the ACR readout.
 *
 * Extracted from `ACRStructuredReadout.tsx` so both the panel-level
 * Copy button AND the hero-level Copy CTA on `AnalysisDetailView`
 * trigger the same workflow with the same audit/telemetry shape.
 *
 * The hero CTA is required by FR-009 — the Copy action MUST be visible
 * without scrolling on a 13" laptop. On compact viewports the panel
 * itself often falls below the fold, so the hero gets a thin proxy
 * button that calls into this hook.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../services/auth';
import { useTranslation } from '../contexts/TranslationContext';
import { useReportSummary } from './useReportSummary';
import {
  buildReadoutSnapshot,
  type ReadoutSnapshot,
  type TFn,
} from '../services/report/acrAnatomicalMapping';
import { copyReadout } from '../services/report/acrClipboardService';
import { EMRToast } from '../components/common';

const SUPPORTED_LOCALES: ReadonlyArray<'en' | 'ru' | 'ka' | 'de'> = [
  'en',
  'ru',
  'ka',
  'de',
];

/**
 * Adapter: project-wide `t(key, params)` → renderer-style `(key, fallback?)`.
 * Identical to the one in ACRStructuredReadout.tsx; kept here so the
 * hook is self-contained.
 */
function makeTFn(t: (key: string, params?: Record<string, unknown>) => string): TFn {
  return (key, fallback) => {
    const resolved = t(key);
    if (resolved === key && fallback !== undefined) return fallback;
    return resolved;
  };
}

export interface UseAcrCopyActionResult {
  /** True once the snapshot is built and `copy()` is callable. */
  ready: boolean;
  /** True while a copy is in flight. */
  copying: boolean;
  /** Trigger the copy workflow. No-op if !ready. */
  copy: () => Promise<void>;
  /** Localized "Copy to Clipboard" label. */
  buttonLabel: string;
  /** Localized aria-label. */
  ariaLabel: string;
  /** Underlying snapshot (null until data loads). */
  snapshot: ReadoutSnapshot | null;
}

export function useAcrCopyAction(analysisId: string): UseAcrCopyActionResult {
  const { t, locale: rawLocale } = useTranslation();
  const { user } = useAuth();
  const { etag, data } = useReportSummary(analysisId);

  const locale = useMemo(
    () =>
      SUPPORTED_LOCALES.includes(rawLocale as 'en')
        ? (rawLocale as 'en' | 'ru' | 'ka' | 'de')
        : 'en',
    [rawLocale],
  );
  const tFn = useMemo<TFn>(() => makeTFn(t), [t]);

  // Capture the panel-open ETag at first successful load. The
  // clipboard service compares this against the current ETag at
  // click-time to gate copies on a stale view.
  const openEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (etag && !openEtagRef.current) openEtagRef.current = etag;
  }, [etag]);

  const snapshot = useMemo(() => {
    if (!data) return null;
    return buildReadoutSnapshot({
      reportSummary: data,
      locale,
      ruoDisclaimer: tFn('reportAcr:ruoDisclaimer', '--- RESEARCH USE ONLY ---'),
      t: tFn,
    });
  }, [data, locale, tFn]);

  const [copying, setCopying] = useState(false);
  const copy = useCallback(async (): Promise<void> => {
    if (!snapshot) return;
    setCopying(true);
    try {
      const actorRole =
        ((user as unknown as { role?: string } | null)?.role) ??
        'attending_radiologist';
      const outcome = await copyReadout({
        snapshot,
        context: {
          analysisId,
          actorRole,
          openTimeEtag: openEtagRef.current,
          t: tFn,
        },
      });
      if (outcome.kind === 'success') {
        if (outcome.queuedAudit) {
          EMRToast.warning(
            tFn(
              'reportAcr:copy.warningToastAuditPending',
              'Readout copied; export audit will retry',
            ),
          );
        } else {
          EMRToast.success(
            tFn('reportAcr:copy.successToast', 'Readout copied to clipboard'),
          );
        }
      } else {
        EMRToast.error(outcome.message);
      }
    } catch {
      EMRToast.error(
        tFn(
          'reportAcr:copy.errorToastUnknown',
          'Could not copy readout — please retry',
        ),
      );
    } finally {
      setCopying(false);
    }
  }, [snapshot, analysisId, tFn, user]);

  return {
    ready: snapshot !== null,
    copying,
    copy,
    snapshot,
    buttonLabel: tFn('reportAcr:copy.buttonLabel', 'Copy to Clipboard'),
    ariaLabel: tFn(
      'reportAcr:copy.buttonAriaLabel',
      'Copy structured readout to clipboard',
    ),
  };
}
