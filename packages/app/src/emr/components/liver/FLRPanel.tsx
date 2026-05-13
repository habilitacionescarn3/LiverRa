// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FLRPanel — T177
 *
 * Live Future Liver Remnant (FLR) readout. Subscribes to the active plane
 * pose through `useFLR()` (sibling agent) and renders:
 *
 *   - Large numeric value (mL + % of total)
 *   - Adequacy badge (green ≥ 40%, yellow 30–40%, red < 30%) — advisory per
 *     FR-014b, explicitly NOT prescriptive clinical guidance
 *   - RUO disclaimer variant chip via `useRUOClaim()`
 *
 * `aria-live="polite"` ensures screen readers announce FLR changes during
 * plane drag per NFR-002.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  IconActivityHeartbeat,
  IconCircleCheck,
  IconAlertCircle,
  IconAlertTriangle,
  IconRefresh,
} from '@tabler/icons-react';
import { EMRButton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

/** Disclaimer variant returned by `useRUOClaim()`. */
export type DisclaimerVariant = 'ruo' | 'ce_class_iib';

/** Shape the sibling-agent `useRUOClaim()` hook returns. */
export interface RUOClaim {
  disclaimerVariant: DisclaimerVariant;
}

/** Props for {@link FLRPanel}. */
export interface FLRPanelProps {
  /** Analysis ID (cache key). */
  analysisId: string;
  /** Optional initial FLR% (e.g. pre-fetched from the analysis record). */
  initialFlrPct?: number;
  /** Optional initial FLR in mL. */
  initialFlrMl?: number;
  /** Optional initial total liver volume in mL. */
  initialTotalMl?: number;
  /** Optional RUO claim (sibling agent); when absent we default to `ruo`. */
  ruoClaim?: RUOClaim;
  /** Optional callback to recompute FLR on demand. */
  onRecompute?: () => void;
  /** Optional test id. */
  'data-testid'?: string;
}

/**
 * Local fallback for `useRUOClaim()`. Returns `'ruo'` for MVP per spec
 * FR-028a (all outputs are Research Use Only).
 */
function useRUOClaimStub(): RUOClaim {
  return { disclaimerVariant: 'ruo' };
}

/** Map FLR% into an adequacy tier. Advisory only — never prescriptive. */
function adequacyTier(pct: number): 'adequate' | 'borderline' | 'low' {
  if (pct >= 40) return 'adequate';
  if (pct >= 30) return 'borderline';
  return 'low';
}

/** Colour + icon for each tier. */
const TIER_STYLES = {
  adequate: {
    color: 'var(--emr-success)',
    alpha: 'var(--emr-success-alpha-15)',
    icon: IconCircleCheck,
  },
  borderline: {
    color: 'var(--emr-warning)',
    alpha: 'var(--emr-warning-alpha-15)',
    icon: IconAlertTriangle,
  },
  low: {
    color: 'var(--emr-error)',
    alpha: 'color-mix(in srgb, var(--emr-error) 15%, transparent)',
    icon: IconAlertCircle,
  },
} as const;

/**
 * FLR panel.
 */
export function FLRPanel({
  analysisId: _analysisId,
  initialFlrPct,
  initialFlrMl,
  initialTotalMl,
  ruoClaim,
  onRecompute,
  'data-testid': testId = 'flr-panel',
}: FLRPanelProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const claim = ruoClaim ?? useRUOClaimStub();

  const [flrPct, setFlrPct] = useState<number | undefined>(initialFlrPct);
  const [flrMl, setFlrMl] = useState<number | undefined>(initialFlrMl);
  const [totalMl, setTotalMl] = useState<number | undefined>(initialTotalMl);

  // Subscribe to viewer events dispatched by ResectionPlaneTool. The sibling
  // agent's `useFLR()` hook is the real source of truth; this stub keeps the
  // panel live during drag without tight coupling to hook availability.
  useEffect(() => {
    const onUpdate = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ flrPct: number; remnantMl: number; totalMl: number }>).detail;
      if (!detail) return;
      setFlrPct(detail.flrPct);
      setFlrMl(detail.remnantMl);
      setTotalMl(detail.totalMl);
    };
    window.addEventListener('liverra:flr-update', onUpdate as EventListener);
    return () => window.removeEventListener('liverra:flr-update', onUpdate as EventListener);
  }, []);

  const tier = useMemo(
    () => (flrPct === undefined ? undefined : adequacyTier(flrPct)),
    [flrPct],
  );
  const tierStyle = tier ? TIER_STYLES[tier] : undefined;
  const TierIcon = tierStyle?.icon ?? IconActivityHeartbeat;

  // Disclaimer text flips to the softer CE wording if/when the tenant is
  // licensed for CE-IIb output (FR-028b). MVP will always be `ruo`.
  const disclaimerText =
    claim.disclaimerVariant === 'ce_class_iib'
      ? 'Approved for surgical planning. Not a substitute for clinical judgment.'
      : t('ruo:disclaimer.short');

  // Bar fill width: clamp to [0, 100] but visually anchor to 50% threshold.
  const barPct = flrPct === undefined ? 0 : Math.max(0, Math.min(100, flrPct));

  return (
    <Stack data-testid={testId} gap="md" p="md" aria-live="polite">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconActivityHeartbeat
            size={18}
            color="var(--emr-secondary)"
            style={{ flexShrink: 0 }}
          />
          <Text fz="var(--emr-font-md)" fw={600} c="var(--emr-text-primary)">
            {t('analysis:flr.title')}
          </Text>
        </Group>
        {onRecompute && (
          <EMRButton variant="ghost" size="sm" icon={IconRefresh} onClick={onRecompute}>
            {t('analysis:flr.recompute')}
          </EMRButton>
        )}
      </Group>

      {/* Large numeric readout — the flight-deck instrument */}
      <Box
        style={{
          padding: '18px 18px 16px',
          borderRadius: 'var(--emr-border-radius-xl)',
          background: tierStyle ? tierStyle.alpha : 'var(--emr-bg-hover)',
          border: `1px solid ${tierStyle ? tierStyle.color : 'var(--emr-border-color)'}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <Stack gap={6}>
          <Text
            fz="var(--emr-font-xs)"
            fw={600}
            c="var(--emr-text-tertiary)"
            style={{
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            {t('analysis:detail.flr.subtitle') || 'Remnant pct functional'}
          </Text>
          <Group align="baseline" gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            <Text
              fz="var(--emr-font-7xl)"
              fw={700}
              c={tierStyle ? tierStyle.color : 'var(--emr-text-primary)'}
              style={{
                lineHeight: 0.95,
                letterSpacing: '-0.03em',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {flrPct !== undefined ? flrPct.toFixed(1) : '—'}
            </Text>
            <Text
              fz="var(--emr-font-2xl)"
              fw={600}
              c={tierStyle ? tierStyle.color : 'var(--emr-text-secondary)'}
              style={{ lineHeight: 1 }}
            >
              %
            </Text>
          </Group>
          {flrMl !== undefined && totalMl !== undefined && (
            <Text
              fz="var(--emr-font-sm)"
              c="var(--emr-text-secondary)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {t('analysis:flr.valueMl', { ml: flrMl.toLocaleString(locale) })}
              {' • '}
              {totalMl.toLocaleString(locale)} mL total
            </Text>
          )}

          {/* Adequacy badge integrated into the card so it reads as one unit */}
          {tier && tierStyle && (
            <Group
              gap={6}
              wrap="nowrap"
              style={{
                marginTop: 4,
                padding: '5px 10px',
                borderRadius: 999,
                background: 'var(--emr-bg-card)',
                color: tierStyle.color,
                border: `1px solid ${tierStyle.color}`,
                alignSelf: 'flex-start',
                flexShrink: 0,
                whiteSpace: 'nowrap',
              }}
            >
              <TierIcon size={14} stroke={2.4} />
              <Text fz="var(--emr-font-xs)" fw={700} c="inherit">
                {t(`analysis:flr.adequacy.${tier}`)}
              </Text>
            </Group>
          )}
        </Stack>
      </Box>

      {/* Threshold legend — surgeon's mental anchor */}
      <Stack gap={6}>
        <Text
          fz="var(--emr-font-xs)"
          fw={600}
          c="var(--emr-text-tertiary)"
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Adequacy thresholds
        </Text>
        {/* Three-segment bar */}
        <Box
          aria-hidden="true"
          style={{
            position: 'relative',
            height: 8,
            borderRadius: 999,
            background: 'var(--emr-bg-hover)',
            border: '1px solid var(--emr-border-color)',
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          <Box style={{ flex: '0 0 30%', background: 'var(--emr-error-alpha-30)' }} />
          <Box style={{ flex: '0 0 10%', background: 'var(--emr-warning-alpha-30)' }} />
          <Box style={{ flex: '0 0 60%', background: 'var(--emr-success-alpha-30)' }} />
          {flrPct !== undefined && (
            <Box
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: -3,
                bottom: -3,
                left: `calc(${barPct}% - 2px)`,
                width: 4,
                borderRadius: 2,
                background: tierStyle?.color ?? 'var(--emr-text-primary)',
                boxShadow: '0 0 0 2px var(--emr-bg-card)',
              }}
            />
          )}
        </Box>
        <Group justify="space-between" gap={4} wrap="nowrap">
          <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
            <Text
              fz="var(--emr-font-3xs)"
              fw={700}
              c="var(--emr-error)"
              style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Low
            </Text>
            <Text
              fz="var(--emr-font-3xs)"
              c="var(--emr-text-tertiary)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              &lt; 30%
            </Text>
          </Stack>
          <Stack gap={0} style={{ minWidth: 0, flex: 1, alignItems: 'center' }}>
            <Text
              fz="var(--emr-font-3xs)"
              fw={700}
              c="var(--emr-warning)"
              style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Borderline
            </Text>
            <Text
              fz="var(--emr-font-3xs)"
              c="var(--emr-text-tertiary)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              30–40%
            </Text>
          </Stack>
          <Stack gap={0} style={{ minWidth: 0, flex: 1, alignItems: 'flex-end' }}>
            <Text
              fz="var(--emr-font-3xs)"
              fw={700}
              c="var(--emr-success)"
              style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Adequate
            </Text>
            <Text
              fz="var(--emr-font-3xs)"
              c="var(--emr-text-tertiary)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              ≥ 40%
            </Text>
          </Stack>
        </Group>
      </Stack>

      {/* RUO / CE disclaimer chip */}
      <Box
        role="note"
        style={{
          padding: '8px 10px',
          borderRadius: 'var(--emr-border-radius)',
          background: 'var(--emr-bg-hover)',
          border: '1px dashed var(--emr-border-color)',
        }}
      >
        <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)" lh={1.4}>
          {disclaimerText}
        </Text>
      </Box>
    </Stack>
  );
}

export default FLRPanel;
