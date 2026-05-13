// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRStructuredReadout — top-level renderer for the ACR-aligned
 * anatomical structured readout (002-acr-structured-readout, T039).
 *
 * Responsibilities:
 *   - Fetch `ReportSummary` via `useReportSummary`.
 *   - Build the snapshot via `buildReadoutSnapshot`.
 *   - Render the six section components in fixed `ANATOMICAL_SECTIONS`
 *     order with a "Copy to Clipboard" action.
 *   - Capture the panel-open ETag once per analysis (concurrency gate
 *     for the clipboard service).
 *   - First-time tooltip pointing at the Copy button (FR-027) — keyed
 *     by user id in `localStorage` so each clinician sees it once.
 *   - Best-effort drain of the IndexedDB pending-audit queue on mount
 *     (FR-035) so events queued in a previous session sync as soon as
 *     the user opens a new panel.
 *
 * Replaces the old `FindingsCard` inline view inside `ReportInlineView`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Popover, Stack } from '@mantine/core';
import { IconClipboard } from '@tabler/icons-react';

import { useTranslation } from '../../contexts/TranslationContext';
import { useAuth } from '../../services/auth';
import { useReportSummary } from '../../hooks/useReportSummary';
import {
  ANATOMICAL_SECTIONS,
  buildReadoutSnapshot,
  type AnatomicalSection,
  type ReadoutSection,
  type TFn,
} from '../../services/report/acrAnatomicalMapping';
import {
  copyReadout,
  drainPendingAuditQueue,
} from '../../services/report/acrClipboardService';
import {
  trackCopyTooltipDismissed,
  trackCopyTooltipSeen,
  trackReadoutViewed,
} from '../../services/report/acrTelemetry';
import { EMRAlert, EMRButton, EMRSkeleton, EMRToast } from '../common';
import { ACRSectionLiver } from './ACRSectionLiver';
import { ACRSectionLesions } from './ACRSectionLesions';
import { ACRSectionVessels } from './ACRSectionVessels';
import { ACRSectionGallbladder } from './ACRSectionGallbladder';
import { ACRSectionSpleen } from './ACRSectionSpleen';
import { ACRSectionFLR } from './ACRSectionFLR';
import styles from './ACRStructuredReadout.module.css';

const TOOLTIP_KEY_PREFIX = 'liverra.acr.copy-tooltip.seen:';
const SUPPORTED_LOCALES: ReadonlyArray<'en' | 'ru' | 'ka' | 'de'> = [
  'en',
  'ru',
  'ka',
  'de',
];

export interface ACRStructuredReadoutProps {
  analysisId: string;
}

/**
 * Adapter so `buildReadoutSnapshot`'s `(key, fallback?) => string`
 * contract matches the project-wide `useTranslation().t` shape
 * `(key, params?) => string`. We use the fallback when the resolver
 * returns the raw key (which the TranslationContext does when a key
 * misses).
 */
function makeTFn(t: (key: string, params?: Record<string, unknown>) => string): TFn {
  return (key, fallback) => {
    const resolved = t(key);
    if (resolved === key && fallback !== undefined) return fallback;
    return resolved;
  };
}

function pickRenderer(section: ReadoutSection): JSX.Element | null {
  switch (section.section as AnatomicalSection) {
    case 'liver':
      return <ACRSectionLiver section={section} />;
    case 'lesions':
      return <ACRSectionLesions section={section} />;
    case 'gallbladder':
      return <ACRSectionGallbladder section={section} />;
    case 'spleen':
      return <ACRSectionSpleen section={section} />;
    case 'flrAssessment':
      return <ACRSectionFLR section={section} />;
    default:
      return null;
  }
}

export function ACRStructuredReadout({
  analysisId,
}: ACRStructuredReadoutProps): JSX.Element {
  const { t, locale: rawLocale } = useTranslation();
  const { user } = useAuth();
  const { query, etag, data, isLoading, isError, refetch } =
    useReportSummary(analysisId);

  const locale = useMemo(
    () => (SUPPORTED_LOCALES.includes(rawLocale as 'en') ? (rawLocale as 'en' | 'ru' | 'ka' | 'de') : 'en'),
    [rawLocale],
  );
  const tFn = useMemo<TFn>(() => makeTFn(t), [t]);

  // Capture the panel-open ETag at first successful load. The clipboard
  // service compares this against the current ETag at click-time to gate
  // copies on a stale view.
  const openEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (etag && !openEtagRef.current) openEtagRef.current = etag;
  }, [etag]);

  // Best-effort drain of audit events queued in a previous session.
  useEffect(() => {
    void drainPendingAuditQueue();
  }, []);

  // Fire `acr_readout_viewed` exactly once per (analysisId × successful-load).
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || viewedRef.current === analysisId) return;
    viewedRef.current = analysisId;
    trackReadoutViewed({
      analysisId,
      locale,
      status: data.status ?? 'unknown',
      lesionCount: data.lesions?.length ?? 0,
    });
  }, [data, analysisId, locale]);

  // Build the snapshot only when data is available — cheap memo dep on
  // `data` reference + locale.
  const snapshot = useMemo(() => {
    if (!data) return null;
    return buildReadoutSnapshot({
      reportSummary: data,
      locale,
      ruoDisclaimer: tFn('reportAcr:ruoDisclaimer', '--- RESEARCH USE ONLY ---'),
      t: tFn,
    });
  }, [data, locale, tFn]);

  // First-time tooltip — keyed by user id so each clinician sees it once.
  const tooltipStorageKey = user?.id ? `${TOOLTIP_KEY_PREFIX}${user.id}` : null;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  useEffect(() => {
    if (!snapshot || !tooltipStorageKey) return;
    try {
      if (localStorage.getItem(tooltipStorageKey) !== '1') {
        setTooltipOpen(true);
        trackCopyTooltipSeen(analysisId);
      }
    } catch {
      // localStorage unavailable — never show the tooltip rather than crash.
    }
  }, [snapshot, tooltipStorageKey, analysisId]);

  const dismissTooltip = useCallback((): void => {
    if (tooltipStorageKey) {
      try {
        localStorage.setItem(tooltipStorageKey, '1');
      } catch {
        // ignore
      }
    }
    setTooltipOpen(false);
    trackCopyTooltipDismissed(analysisId);
  }, [tooltipStorageKey, analysisId]);

  // Clipboard click handler.
  const [copying, setCopying] = useState(false);
  const handleCopy = useCallback(async (): Promise<void> => {
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
    } catch (err) {
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

  // ── Render ──

  // Hidden ARIA heading for the section.
  const ariaHeading = tFn(
    'reportAcr:panelHeading',
    'Structured Radiologic Readout',
  );

  if (isLoading && !data) {
    return (
      <section
        aria-labelledby="acr-readout-heading"
        data-testid="acr-readout-root"
        className={styles.root}
      >
        <h2 id="acr-readout-heading" className={styles.srOnly}>
          {ariaHeading}
        </h2>
        <Stack gap="md" className={styles.sections}>
          {ANATOMICAL_SECTIONS.map((s) => (
            <EMRSkeleton key={s} height={64} width="100%" />
          ))}
        </Stack>
      </section>
    );
  }

  if (isError || !snapshot) {
    return (
      <section
        aria-labelledby="acr-readout-heading"
        data-testid="acr-readout-root"
        className={styles.root}
      >
        <h2 id="acr-readout-heading" className={styles.srOnly}>
          {ariaHeading}
        </h2>
        <EMRAlert variant="error">
          {(query.error as Error | null)?.message ??
            tFn(
              'reportAcr:copy.errorToastUnknown',
              'Could not load readout — please retry',
            )}
        </EMRAlert>
        <Box>
          <EMRButton
            variant="secondary"
            onClick={() => {
              void refetch();
            }}
          >
            {tFn('common:retry', 'Retry')}
          </EMRButton>
        </Box>
      </section>
    );
  }

  const copyButtonLabel = tFn(
    'reportAcr:copy.buttonLabel',
    'Copy to Clipboard',
  );
  const copyButtonAriaLabel = tFn(
    'reportAcr:copy.buttonAriaLabel',
    'Copy structured readout to clipboard',
  );

  return (
    <section
      aria-labelledby="acr-readout-heading"
      data-testid="acr-readout-root"
      className={styles.root}
    >
      <h2 id="acr-readout-heading" className={styles.srOnly}>
        {ariaHeading}
      </h2>

      <div className={styles.header}>
        <h3 className={styles.headerTitle}>{ariaHeading}</h3>
        <Popover
          opened={tooltipOpen}
          onChange={setTooltipOpen}
          position="top"
          withArrow
          shadow="md"
          closeOnClickOutside={false}
          trapFocus={false}
          returnFocus={false}
          width={300}
        >
          <Popover.Target>
            <Box className={styles.copyButton}>
              <EMRButton
                variant="primary"
                icon={IconClipboard}
                onClick={() => void handleCopy()}
                loading={copying}
                data-testid="acr-copy-button"
                aria-label={copyButtonAriaLabel}
              >
                {copyButtonLabel}
              </EMRButton>
            </Box>
          </Popover.Target>
          <Popover.Dropdown>
            <div className={styles.tooltipContent}>
              {tFn(
                'reportAcr:copy.tooltipFirstTime',
                'Copy this readout as plain text for PACS dictation. One audit row is recorded per click.',
              )}
              <div className={styles.tooltipActions}>
                <EMRButton variant="secondary" size="xs" onClick={dismissTooltip}>
                  {tFn('reportAcr:copy.tooltipDismiss', 'Got it')}
                </EMRButton>
              </div>
            </div>
          </Popover.Dropdown>
        </Popover>
      </div>

      <Stack gap="md" className={styles.sections}>
        {ANATOMICAL_SECTIONS.map((sectionKey) => {
          const section = snapshot.sections.find((s) => s.section === sectionKey);
          if (!section) return null;
          if (sectionKey === 'vessels') {
            return (
              <Box key={sectionKey} style={{ width: '100%' }}>
                <ACRSectionVessels section={section} analysisId={analysisId} />
              </Box>
            );
          }
          return <Box key={sectionKey}>{pickRenderer(section)}</Box>;
        })}
      </Stack>

      <div className={styles.disclaimer}>{snapshot.ruoDisclaimer}</div>
    </section>
  );
}

export default ACRStructuredReadout;
