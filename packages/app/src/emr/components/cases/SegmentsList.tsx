// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SegmentsList — Pass A2
 *
 * Plain-English: lists every anatomical region the cascade has segmented for
 * an analysis (whole liver / 8 Couinaud segments / portal vein / hepatic vein).
 *
 * Reads `useAnalysisResults(id).segmentations[]` and groups rows by
 * `anatomy_category`. For each row we render a colour swatch (Couinaud palette
 * lives in `couinaud-constants.ts`), the translated anatomy name, the volume
 * in mL, and the model version badge.
 *
 * Empty / loading / error states use the EMR component library.
 */

import { useMemo, useState } from 'react';
import { Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight, IconLayoutDashboard } from '@tabler/icons-react';
import { EMRBadge, EMREmptyState } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  COUINAUD_LABELS,
  type CouinaudLabel,
  getCouinaudColorVar,
  VESSEL_COLOR_VARS,
} from '../liver/couinaud-constants';

interface SegmentationRow {
  id: string;
  anatomy_category?: string | null;
  anatomy_detail?: string | null;
  volume_ml?: string | number | null;
  mask_url?: string | null;
  snomed_code?: string | null;
}

/** Per-stage provenance shape since Agent 2.4's GPU-response headers
 *  landed. Legacy cascades may still have plain-string values. */
interface ModelProvenance {
  model_id?: string | null;
  weights_sha?: string | null;
  model_version?: string | null;
}

interface ResultsBundle {
  segmentations?: SegmentationRow[];
  analysis?: {
    model_versions?: Record<string, string | ModelProvenance> | null;
  };
}

/** Coerce either legacy string or new ModelProvenance dict to a display
 *  string. Picks "model_id@model_version" when both present, else
 *  whichever is set, else null. */
function formatModelVersion(v: string | ModelProvenance | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  const { model_id, model_version } = v;
  if (model_id && model_version) return `${model_id}@${model_version}`;
  return model_version || model_id || null;
}

export interface SegmentsListProps {
  analysisId: string;
  apiBaseUrl: string;
  'data-testid'?: string;
}

/** Colour swatch for an anatomy row. */
function swatchFor(row: SegmentationRow): string {
  const cat = (row.anatomy_category ?? '').toLowerCase();
  if (cat === 'couinaud') {
    const detail = (row.anatomy_detail ?? '').toUpperCase() as CouinaudLabel;
    if (COUINAUD_LABELS.includes(detail)) {
      return getCouinaudColorVar(detail);
    }
    return 'var(--emr-gray-400)';
  }
  if (cat === 'portal_vein' || cat === 'portal') return VESSEL_COLOR_VARS.portal;
  if (cat === 'hepatic_vein' || cat === 'hepatic') return VESSEL_COLOR_VARS.hepatic;
  if (cat === 'liver' || cat === 'parenchyma') return 'var(--emr-success)';
  return 'var(--emr-gray-400)';
}

/** Translation key + display name for an anatomy row. */
function anatomyLabel(
  row: SegmentationRow,
  t: (k: string) => string,
): string {
  const cat = (row.anatomy_category ?? '').toLowerCase();
  if (cat === 'couinaud') {
    const detail = (row.anatomy_detail ?? '').toUpperCase();
    return t(`analysis:anatomy.couinaud.${detail}`) || `Couinaud ${detail}`;
  }
  if (cat === 'liver') return t('analysis:anatomy.liver') || 'Liver';
  if (cat === 'portal_vein' || cat === 'portal')
    return t('analysis:anatomy.portal_vein') || 'Portal vein';
  if (cat === 'hepatic_vein' || cat === 'hepatic')
    return t('analysis:anatomy.hepatic_vein') || 'Hepatic vein';
  return cat || '—';
}

/** Order categories so the list reads top-down: liver → couinaud → vessels. */
const CATEGORY_ORDER: Record<string, number> = {
  liver: 0,
  couinaud: 1,
  portal_vein: 2,
  portal: 2,
  hepatic_vein: 3,
  hepatic: 3,
};

function categoryRank(cat: string): number {
  return CATEGORY_ORDER[cat] ?? 99;
}

/** Within `couinaud`, sort I → VIII based on the Roman-numeral order. */
function couinaudRank(detail: string): number {
  const idx = COUINAUD_LABELS.indexOf(detail.toUpperCase() as CouinaudLabel);
  return idx === -1 ? 99 : idx;
}

export function SegmentsList({
  analysisId,
  apiBaseUrl,
  'data-testid': testId = 'segments-list',
}: SegmentsListProps): React.ReactElement {
  const { t, tPlural, locale } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, error } = useQuery<ResultsBundle, Error>({
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

  // Map anatomy_category → its source model name in the analysis row.
  // Values may be strings (legacy) or ModelProvenance dicts (post-Agent 2.4).
  const modelVersionFor = useMemo(() => {
    const mv = data?.analysis?.model_versions ?? {};
    return (cat: string): string | null => {
      const c = cat.toLowerCase();
      if (c === 'liver') return formatModelVersion(mv['parenchyma'] ?? mv['stu-net-parenchyma']);
      if (c === 'couinaud') return formatModelVersion(mv['couinaud'] ?? mv['pictorial-couinaud']);
      if (c === 'portal_vein' || c === 'portal' || c === 'hepatic_vein' || c === 'hepatic')
        return formatModelVersion(mv['vessels'] ?? mv['liverra-vessels']);
      return null;
    };
  }, [data]);

  const sortedRows = useMemo(() => {
    const rows = data?.segmentations ?? [];
    return [...rows].sort((a, b) => {
      const catA = (a.anatomy_category ?? '').toLowerCase();
      const catB = (b.anatomy_category ?? '').toLowerCase();
      const rankDiff = categoryRank(catA) - categoryRank(catB);
      if (rankDiff !== 0) return rankDiff;
      if (catA === 'couinaud' && catB === 'couinaud') {
        return (
          couinaudRank(a.anatomy_detail ?? '') - couinaudRank(b.anatomy_detail ?? '')
        );
      }
      return 0;
    });
  }, [data]);

  if (isLoading) {
    return (
      <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
        {t('analysis:detail.drawer.loading') || 'Loading…'}
      </Text>
    );
  }

  if (error) {
    return (
      <Text fz="var(--emr-font-sm)" c="var(--emr-error)">
        {error.message}
      </Text>
    );
  }

  if (sortedRows.length === 0) {
    return (
      <EMREmptyState
        icon={IconLayoutDashboard}
        title={t('analysis:detail.drawer.segmentsEmpty.title') || 'No segments yet'}
        description={
          t('analysis:detail.drawer.segmentsEmpty.description') ||
          'Couinaud segments and vessel masks will appear here once the cascade finishes.'
        }
        size="sm"
      />
    );
  }

  const totalVolumeMl = sortedRows.reduce((sum, row) => {
    const v = row.volume_ml;
    const n = typeof v === 'string' ? Number.parseFloat(v) : (v as number | undefined);
    return sum + (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  }, 0);
  const totalVolumeText = totalVolumeMl > 0
    ? `${totalVolumeMl.toLocaleString(locale, { maximumFractionDigits: 0 })} ml`
    : '—';
  const countLabel = tPlural(
    'analysis:detail.drawer.segmentsCount',
    sortedRows.length,
  );

  return (
    <Stack gap="xs" data-testid={testId}>
      <UnstyledButton
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`${testId}-rows`}
        data-testid={`${testId}-toggle`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderRadius: 'var(--emr-border-radius)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-color)',
          transition:
            'border-color var(--emr-transition-base), background var(--emr-transition-base)',
          width: '100%',
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.style.borderColor = 'var(--emr-secondary-alpha-30)';
          el.style.background = 'var(--emr-secondary-alpha-04)';
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget;
          el.style.borderColor = 'var(--emr-border-color)';
          el.style.background = 'var(--emr-bg-card)';
        }}
      >
        <IconChevronRight
          size={16}
          stroke={2}
          aria-hidden="true"
          style={{
            color: 'var(--emr-text-secondary)',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
            flexShrink: 0,
          }}
        />
        <Box style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <Text
            fz="var(--emr-font-sm)"
            fw={600}
            c="var(--emr-text-primary)"
            style={{ lineHeight: 1.2 }}
          >
            {countLabel}
          </Text>
          <Text
            fz="var(--emr-font-xs)"
            c="var(--emr-text-secondary)"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {t('analysis:detail.drawer.segmentsTotal') || 'Total volume'}: {totalVolumeText}
          </Text>
        </Box>
      </UnstyledButton>

      {expanded && (
        <Stack gap="xs" id={`${testId}-rows`}>
      {sortedRows.map((row) => {
        const cat = (row.anatomy_category ?? '').toLowerCase();
        const v = row.volume_ml;
        const n = typeof v === 'string' ? Number.parseFloat(v) : (v as number | undefined);
        const volumeText =
          typeof n === 'number' && Number.isFinite(n)
            ? `${n.toLocaleString(locale, { maximumFractionDigits: 0 })} ml`
            : '—';
        const label = anatomyLabel(row, t);
        const swatch = swatchFor(row);
        const modelVer = modelVersionFor(cat);

        return (
          <Group
            key={row.id}
            data-testid={`segment-row-${cat}-${row.anatomy_detail ?? 'all'}`}
            gap="sm"
            wrap="wrap"
            align="center"
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--emr-border-radius)',
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
              transition: 'border-color var(--emr-transition-base), background var(--emr-transition-base), transform var(--emr-transition-base)',
              cursor: 'default',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = 'var(--emr-secondary-alpha-30)';
              el.style.background = 'var(--emr-secondary-alpha-04)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = 'var(--emr-border-color)';
              el.style.background = 'var(--emr-bg-card)';
            }}
          >
            <Box
              aria-hidden="true"
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: swatch,
                border: '1px solid var(--emr-border-color)',
                flexShrink: 0,
                boxShadow: '0 0 0 1px var(--emr-bg-card) inset',
              }}
            />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
                style={{ lineHeight: 1.2 }}
              >
                {label}
              </Text>
              <Text
                fz="var(--emr-font-xs)"
                c="var(--emr-text-secondary)"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {volumeText}
              </Text>
            </Box>
            {modelVer && (
              <EMRBadge variant="neutral" size="sm">
                {modelVer}
              </EMRBadge>
            )}
          </Group>
        );
      })}
        </Stack>
      )}
    </Stack>
  );
}

export default SegmentsList;
