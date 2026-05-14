// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * CascadeStageTimeline — Pass A1
 *
 * Plain-English: a vertical "what the AI just did" timeline for an analysis.
 * Each step is one stage of the cascade pipeline (anonymisation → parenchyma →
 * vessels → Couinaud → lesion detection → classification → FLR init). For each
 * stage we show:
 *   - a green checkmark
 *   - the translated stage label
 *   - wall-clock duration vs the previous stage (e.g. "0.2s", "67s")
 *   - one stage-specific stat (parenchyma volume, lesion count, FLR %)
 *   - the model version (badge) — clicking the row reveals the S3 output_uri
 *     and license hash so a clinician can chase regulatory traceability
 *
 * Data sources:
 *   - `analysis.stage_progress[]` (from `useAnalysis`) — ordered ledger of
 *     completed pipeline_checkpoint rows
 *   - `useAnalysisResults(id).{segmentations,lesions,flr_default}` — for the
 *     stage-specific stats
 *
 * Lives between the page header and the centre viewer in `AnalysisDetailView`.
 *
 * NOTE: we deliberately reach for Mantine's `Timeline` rather than the
 * existing `EMRProgressStepper` because that stepper is *horizontal* and
 * meant for "you are here in a wizard"; this is a vertical audit log.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Box,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  Timeline,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { EMRBadge } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

interface StageProgressEntry {
  stage_no: number;
  stage: string;
  output_uri: string | null;
  written_at: string;
  model_version: string | null;
  model_license_hash: string | null;
}

interface ResultsBundle {
  segmentations?: Array<{
    anatomy_category?: string | null;
    anatomy_detail?: string | null;
    volume_ml?: string | number | null;
  }>;
  lesions?: Array<unknown>;
  flr_default?: {
    remnant_pct_functional?: string | number | null;
  } | null;
}

export interface CascadeStageTimelineProps {
  analysisId: string;
  stageProgress: StageProgressEntry[] | undefined;
  apiBaseUrl: string;
  /** Top-level analysis status — drives default expanded vs collapsed and the
   * status pill in the summary header. Optional so existing tests still work. */
  analysisStatus?: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | string;
  'data-testid'?: string;
}

/** Sum the per-stage deltas into one human-readable total duration string. */
function formatTotalDuration(stages: StageProgressEntry[]): string {
  if (stages.length < 2) return '—';
  const first = Date.parse(stages[0].written_at);
  const last = Date.parse(stages[stages.length - 1].written_at);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return '—';
  const ms = last - first;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Format a millisecond delta as a short human duration. */
function formatDelta(prevIso: string | undefined, currIso: string): string {
  if (!prevIso) return '—';
  const prev = Date.parse(prevIso);
  const curr = Date.parse(currIso);
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return '—';
  const ms = curr - prev;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** One-line stage-specific stat string, derived from the /results bundle. */
function pickStageStat(
  stage: string,
  results: ResultsBundle | undefined,
  modelVersion: string | null,
  locale: string,
): string | null {
  if (!results) return null;
  const fmt = (n: number, digits = 0): string =>
    n.toLocaleString(locale, { maximumFractionDigits: digits });

  if (stage === 'parenchyma') {
    const liver = results.segmentations?.find(
      (s) => (s.anatomy_category ?? '').toLowerCase() === 'liver',
    );
    const v = liver?.volume_ml;
    const n = typeof v === 'string' ? Number.parseFloat(v) : (v as number | undefined);
    if (typeof n === 'number' && Number.isFinite(n)) return `${fmt(n)} ml`;
    return null;
  }

  if (stage === 'lesion_detection') {
    const count = results.lesions?.length ?? 0;
    return count === 1 ? `${count} lesion` : `${count} lesions`;
  }

  if (stage === 'flr_init') {
    const raw = results.flr_default?.remnant_pct_functional;
    const n = typeof raw === 'string' ? Number.parseFloat(raw) : (raw as number | null | undefined);
    if (typeof n === 'number' && Number.isFinite(n)) return `${n.toFixed(1)}%`;
    return null;
  }

  // For all other stages the model version is the most informative thing.
  return modelVersion ?? null;
}

/**
 * Vertical Mantine Timeline rendering one item per completed cascade stage.
 *
 * Notes:
 *   - We re-use the same `['analysis', id, 'results']` query key that the
 *     parent view + Lesions tab use, so React Query dedupes across all three
 *     consumers and we never trigger a duplicate fetch.
 *   - Empty stage_progress (analysis still queued) collapses to nothing.
 */
export function CascadeStageTimeline({
  analysisId,
  stageProgress,
  apiBaseUrl,
  analysisStatus,
  'data-testid': testId = 'cascade-stage-timeline',
}: CascadeStageTimelineProps): React.ReactElement | null {
  const { t, tPlural, locale } = useTranslation();
  // BCP-47 tag used for Intl number/locale APIs throughout this component.
  // INTL_TAG re-exported from localeService via TranslationContext.
  const intlTag =
    locale === 'ru' ? 'ru-RU' : locale === 'de' ? 'de-DE' : locale === 'ka' ? 'ka-GE' : 'en-GB';
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Default behaviour: collapsed when the pipeline is done (surgeon already
  // past the wait), expanded while it's still chugging so live progress
  // is visible. User-toggled state is held only for the session.
  const isLive =
    analysisStatus === 'running' ||
    analysisStatus === 'queued' ||
    analysisStatus === 'partial' ||
    analysisStatus === 'failed';
  const [expanded, setExpanded] = useState<boolean>(isLive);
  // If the live status flips (e.g. "running" → "completed" mid-session), nudge
  // the panel back to its sensible default. We compare against a ref-like
  // memoised default to avoid clobbering an explicit user toggle on the same
  // status.
  useEffect(() => {
    setExpanded(isLive);
    // M-HOOK-3 justification: ``isLive`` is a pure derivation of
    // ``analysisStatus`` (literal definition above). Tracking the
    // source-of-truth dep keeps intent legible; isLive flips iff
    // analysisStatus flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisStatus]);

  const { data: results } = useQuery<ResultsBundle, Error>({
    queryKey: ['analysis', analysisId, 'results'],
    queryFn: async () => {
      const r = await fetch(
        `${apiBaseUrl}/analyses/${encodeURIComponent(analysisId)}/results`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: typeof analysisId === 'string' && analysisId.length > 0,
    staleTime: 30_000,
  });

  // Sort defensively even though the backend already returns them in order.
  const stages = useMemo(() => {
    if (!stageProgress || stageProgress.length === 0) return [];
    return [...stageProgress].sort((a, b) => a.stage_no - b.stage_no);
  }, [stageProgress]);

  if (stages.length === 0) return null;

  const activeStep = stages.length - 1;
  const totalDuration = formatTotalDuration(stages);
  // Russian needs 4 plural forms (one/few/many/other) — use Intl.PluralRules
  // via `tPlural` instead of a `count === 1 ? _one : _other` ternary.
  // Audit reference: H-I18NQ-6.
  const stageCountLabel = tPlural(
    'analysis:detail.cascadeTimeline.summary.stageCount',
    stages.length,
    { total: totalDuration },
  );

  // Status pill: green check / spinner / red dot, derived from analysisStatus
  // first, then falls back to "complete" when the cascade ledger is fully
  // populated even if the parent didn't pass a status string.
  const statusPill = ((): React.ReactElement => {
    if (analysisStatus === 'failed') {
      return (
        <Group gap={6} wrap="nowrap" align="center">
          <IconAlertCircle size={14} style={{ color: 'var(--emr-error)' }} />
          <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-error)">
            {t('analysis:detail.cascadeTimeline.summary.failed')}
          </Text>
        </Group>
      );
    }
    if (analysisStatus === 'running' || analysisStatus === 'partial') {
      return (
        <Group gap={6} wrap="nowrap" align="center">
          <Loader size={12} color="blue" />
          <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-text-secondary)">
            {t('analysis:detail.cascadeTimeline.summary.runningStage', {
              current: stages.length,
              total: stages.length, // best-effort when we don't know total stage count
            })}
          </Text>
        </Group>
      );
    }
    if (analysisStatus === 'queued') {
      return (
        <Group gap={6} wrap="nowrap" align="center">
          <Loader size={12} color="gray" />
          <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-text-secondary)">
            {t('analysis:detail.cascadeTimeline.summary.queued')}
          </Text>
        </Group>
      );
    }
    return (
      <Group gap={6} wrap="nowrap" align="center">
        <IconCircleCheck size={14} style={{ color: 'var(--emr-success)' }} />
        <Text fz="var(--emr-font-xs)" fw={600} c="var(--emr-success)">
          {t('analysis:detail.cascadeTimeline.summary.complete')}
        </Text>
      </Group>
    );
  })();

  // Result chips on the right — only render when the underlying number exists.
  const liver = results?.segmentations?.find(
    (s) => (s.anatomy_category ?? '').toLowerCase() === 'liver',
  );
  const liverV =
    typeof liver?.volume_ml === 'string'
      ? Number.parseFloat(liver.volume_ml)
      : (liver?.volume_ml as number | undefined);
  const lesionCount = results?.lesions?.length ?? 0;
  const flrRaw = results?.flr_default?.remnant_pct_functional ?? null;
  const flrPct =
    typeof flrRaw === 'string' ? Number.parseFloat(flrRaw) : (flrRaw as number | null);

  // Russian plural: lesion needs 4 forms via Intl.PluralRules.
  const lesionLabel = tPlural(
    'analysis:detail.cascadeTimeline.summary.lesionCount',
    lesionCount,
  );

  const toggleId = `cascade-timeline-body-${analysisId}`;

  return (
    <Box
      data-testid={testId}
      style={{
        margin: '0 16px 12px 16px',
        borderRadius: 'var(--emr-border-radius-lg)',
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        overflow: 'hidden',
        boxShadow: 'var(--emr-shadow-sm)',
      }}
    >
      {/* Sticky summary header — always visible */}
      <Box
        component="button"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        aria-expanded={expanded}
        aria-controls={toggleId}
        aria-label={
          expanded
            ? t('analysis:detail.cascadeTimeline.summary.collapse')
            : t('analysis:detail.cascadeTimeline.summary.expand')
        }
        data-testid="cascade-stage-timeline-toggle"
        style={{
          all: 'unset',
          display: 'block',
          width: '100%',
          padding: '12px 16px',
          cursor: 'pointer',
          minHeight: 44,
          boxSizing: 'border-box',
          borderBottom: expanded ? '1px solid var(--emr-border-color)' : 'none',
        }}
      >
        <Group justify="space-between" wrap="wrap" gap="sm" align="center">
          <Group gap="md" wrap="wrap" align="center" style={{ minWidth: 0, flex: 1 }}>
            {statusPill}
            <Text fz="var(--emr-font-xs)" c="var(--emr-text-tertiary)">
              {stageCountLabel}
            </Text>
          </Group>

          <Group gap={6} wrap="wrap" align="center" style={{ flexShrink: 0 }}>
            {typeof liverV === 'number' && Number.isFinite(liverV) && (
              <EMRBadge
                variant="info"
                size="sm"
                data-testid="cascade-summary-liver-volume"
              >
                {t('analysis:detail.cascadeTimeline.summary.liverVolume', {
                  ml: liverV.toLocaleString(intlTag, { maximumFractionDigits: 0 }),
                })}
              </EMRBadge>
            )}
            {lesionCount > 0 && (
              <EMRBadge
                variant="primary"
                size="sm"
                data-testid="cascade-summary-lesion-count"
              >
                {lesionLabel}
              </EMRBadge>
            )}
            {typeof flrPct === 'number' && Number.isFinite(flrPct) && (
              <EMRBadge
                variant="success"
                size="sm"
                data-testid="cascade-summary-flr"
              >
                {t('analysis:detail.cascadeTimeline.summary.flr', {
                  pct: flrPct.toFixed(1),
                })}
              </EMRBadge>
            )}
            <ActionIcon
              component="span"
              variant="subtle"
              color="gray"
              size="sm"
              aria-hidden="true"
              tabIndex={-1}
              style={{ pointerEvents: 'none' }}
            >
              <IconChevronDown
                size={16}
                style={{
                  transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 150ms ease',
                }}
              />
            </ActionIcon>
          </Group>
        </Group>
      </Box>

      <Collapse in={expanded}>
        <Box id={toggleId} style={{ padding: 16 }}>
          <Text
            fz="var(--emr-font-sm)"
            fw={600}
            c="var(--emr-text-primary)"
            mb="sm"
          >
            {t('analysis:detail.cascadeTimeline.title')}
          </Text>
          <Timeline
        active={activeStep}
        bulletSize={22}
        lineWidth={2}
        color="green"
      >
        {stages.map((entry, idx) => {
          const prevIso = idx === 0 ? undefined : stages[idx - 1].written_at;
          const delta = formatDelta(prevIso, entry.written_at);
          const stat = pickStageStat(entry.stage, results, entry.model_version, intlTag);
          const stageLabel =
            t(`analysis:stages.${entry.stage}`) ||
            entry.stage;
          const isOpen = expandedKey === `${entry.stage_no}-${entry.stage}`;
          const rowKey = `${entry.stage_no}-${entry.stage}`;
          const toggle = (): void =>
            setExpandedKey((p) => (p === rowKey ? null : rowKey));

          return (
            <Timeline.Item
              key={rowKey}
              bullet={<IconCheck size={12} />}
              data-testid={`cascade-stage-${entry.stage}`}
            >
              <Box
                role="button"
                tabIndex={0}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle();
                  }
                }}
                style={{ cursor: 'pointer', outline: 'none' }}
                aria-expanded={isOpen}
              >
                <Group gap="xs" wrap="wrap" justify="space-between" align="center">
                  <Group gap="xs" wrap="wrap" align="center" style={{ minWidth: 0 }}>
                    <Text
                      fz="var(--emr-font-sm)"
                      fw={600}
                      c="var(--emr-text-primary)"
                    >
                      {stageLabel}
                    </Text>
                    {stat && (
                      <EMRBadge
                        variant="info"
                        size="sm"
                        data-testid={`cascade-stage-${entry.stage}-stat`}
                      >
                        {stat}
                      </EMRBadge>
                    )}
                  </Group>
                  <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
                    <Text
                      fz="var(--emr-font-xs)"
                      c="var(--emr-text-tertiary)"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {delta}
                    </Text>
                    <IconChevronDown
                      size={14}
                      style={{
                        color: 'var(--emr-text-tertiary)',
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 120ms ease',
                      }}
                      aria-hidden="true"
                    />
                  </Group>
                </Group>
              </Box>

              <Collapse in={isOpen}>
                <Stack gap={4} mt={6}>
                  {entry.model_version && (
                    <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                      <Text component="span" fw={600}>
                        {t('analysis:detail.cascadeTimeline.modelVersion')}:
                      </Text>{' '}
                      {entry.model_version}
                    </Text>
                  )}
                  {entry.output_uri && (
                    <Text
                      fz="var(--emr-font-xs)"
                      c="var(--emr-text-secondary)"
                      style={{ wordBreak: 'break-all' }}
                    >
                      <Text component="span" fw={600}>
                        {t('analysis:detail.cascadeTimeline.outputUri')}:
                      </Text>{' '}
                      {entry.output_uri}
                    </Text>
                  )}
                  {entry.model_license_hash && (
                    <Text
                      fz="var(--emr-font-xs)"
                      c="var(--emr-text-tertiary)"
                      style={{ wordBreak: 'break-all' }}
                    >
                      <Text component="span" fw={600}>
                        {t('analysis:detail.cascadeTimeline.licenseHash')}:
                      </Text>{' '}
                      {entry.model_license_hash}
                    </Text>
                  )}
                </Stack>
              </Collapse>
            </Timeline.Item>
          );
        })}
          </Timeline>
        </Box>
      </Collapse>
    </Box>
  );
}

export default CascadeStageTimeline;
