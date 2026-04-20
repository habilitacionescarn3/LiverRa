// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CouinaudLegend — 8 colour swatches with anatomical tooltips (T203).
 *
 * Plain-English analogy:
 *   Like the legend on a subway map. The map tells you where the lines
 *   go; the legend tells you what each colour means. This component
 *   is the legend for the Couinaud overlay: "orange is segment I, the
 *   caudate lobe — the little one that sits behind everything."
 *
 * Interaction:
 *   - Clicking a swatch selects that segment in the viewer (same
 *     handler as SegmentsLayer).
 *   - Hovering shows a Mantine Tooltip with the Latin anatomical name
 *     (FR-045 glossary) + a one-line clinical role.
 *   - Each swatch has `aria-label="Couinaud segment I — caudate lobe"`
 *     etc. per NFR-002.
 *
 * Spec refs:
 *   - §FR-008 §FR-045
 *   - §NFR-002 accessibility
 */

import { memo, useCallback } from 'react';
import { Box, Group, Text, Tooltip } from '@mantine/core';

import { useTranslation } from '../../contexts/TranslationContext';

import {
  COUINAUD_LABELS,
  type CouinaudLabel,
  getCouinaudColorVar,
} from './couinaud-constants';

export interface CouinaudLegendProps {
  activeSegment?: CouinaudLabel | null;
  onSegmentSelect?: (segment: CouinaudLabel) => void;
  /** Optional per-segment volume mL — shown inline when present. */
  volumesMl?: Partial<Record<CouinaudLabel, number>>;
  'data-testid'?: string;
}

const DEFAULT_ENGLISH_ROLES: Record<CouinaudLabel, string> = {
  I:    'Caudate lobe',
  II:   'Left lateral superior',
  III:  'Left lateral inferior',
  IV:   'Left medial',
  V:    'Right anterior inferior',
  VI:   'Right posterior inferior',
  VII:  'Right posterior superior',
  VIII: 'Right anterior superior',
};

const DEFAULT_LATIN: Record<CouinaudLabel, string> = {
  I:    'Lobus caudatus',
  II:   'Segmentum II',
  III:  'Segmentum III',
  IV:   'Segmentum IV',
  V:    'Segmentum V',
  VI:   'Segmentum VI',
  VII:  'Segmentum VII',
  VIII: 'Segmentum VIII',
};

export const CouinaudLegend = memo(function CouinaudLegend({
  activeSegment = null,
  onSegmentSelect,
  volumesMl,
  'data-testid': dataTestId = 'couinaud-legend',
}: CouinaudLegendProps) {
  const { t } = useTranslation();

  const getLabel = useCallback(
    (segment: CouinaudLabel, kind: 'name' | 'latin' | 'role') => {
      // Translation keys live in translations/<locale>/glossary.json
      const key = `glossary:couinaud.${segment}.${kind}`;
      const value = t(key);
      if (value && value !== key) {
        return value;
      }
      if (kind === 'latin') return DEFAULT_LATIN[segment];
      if (kind === 'role') return DEFAULT_ENGLISH_ROLES[segment];
      return `Segment ${segment}`;
    },
    [t],
  );

  return (
    <Box
      data-testid={dataTestId}
      role="list"
      aria-label="Couinaud segment legend"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 'var(--emr-space-xs, 6px)',
        background: 'var(--emr-bg-card)',
        borderRadius: 'var(--emr-radius-md, 8px)',
        padding: 'var(--emr-space-md, 12px)',
      }}
    >
      {COUINAUD_LABELS.map((label) => {
        const latin = getLabel(label, 'latin');
        const role = getLabel(label, 'role');
        const name = getLabel(label, 'name');
        const ariaLabel = `Couinaud segment ${label} — ${role}`;
        const volume = volumesMl?.[label];
        const isActive = activeSegment === label;

        return (
          <Tooltip
            key={label}
            label={
              <Box style={{ maxWidth: 220 }}>
                <Text size="sm" fw={600}>
                  {name}
                </Text>
                <Text size="xs" fs="italic">
                  {latin}
                </Text>
                <Text size="xs" mt={4}>
                  {role}
                </Text>
              </Box>
            }
            withArrow
            openDelay={150}
          >
            <Group
              role="listitem"
              tabIndex={0}
              data-testid={`couinaud-legend-item-${label}`}
              data-active={isActive ? 'true' : 'false'}
              aria-label={ariaLabel}
              aria-pressed={isActive}
              onClick={() => onSegmentSelect?.(label)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSegmentSelect?.(label);
                }
              }}
              gap={8}
              wrap="nowrap"
              style={{
                cursor: onSegmentSelect ? 'pointer' : 'default',
                padding: 'var(--emr-space-xs, 6px)',
                borderRadius: 'var(--emr-radius-sm, 6px)',
                minHeight: 44, // 44×44 tap target — NFR-002
                background: isActive ? 'var(--emr-primary-alpha-08)' : 'transparent',
                outline: isActive
                  ? '2px solid var(--emr-primary)'
                  : '2px solid transparent',
                transition: 'background 120ms ease-out, outline 120ms ease-out',
              }}
            >
              <Box
                aria-hidden
                style={{
                  width: 20,
                  height: 20,
                  minWidth: 20,
                  borderRadius: 4,
                  backgroundColor: getCouinaudColorVar(label),
                  flexShrink: 0,
                  border: '1px solid var(--emr-border-color)',
                }}
              />
              <Box style={{ minWidth: 0 }}>
                <Text
                  size="sm"
                  fw={600}
                  style={{
                    color: 'var(--emr-text-primary)',
                    fontSize: 'var(--emr-font-sm)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {name}
                </Text>
                {typeof volume === 'number' ? (
                  <Text
                    size="xs"
                    style={{
                      color: 'var(--emr-text-secondary)',
                      fontSize: 'var(--emr-font-xs, 11px)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {volume.toFixed(1)} mL
                  </Text>
                ) : null}
              </Box>
            </Group>
          </Tooltip>
        );
      })}
    </Box>
  );
});
