// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SegmentVolumeCard — detail card for a single selected Couinaud segment (T205).
 *
 * Plain-English analogy:
 *   When you click on a country on a world map, a little info-card
 *   pops up showing the country's name, population, capital, and
 *   neighbours. This is the same idea for a Couinaud segment: click
 *   segment VI in the viewer, and a right-drawer card appears showing
 *   the segment's Roman numeral, its Latin name ("Segmentum VI —
 *   right posterior inferior"), how many millilitres of liver tissue
 *   it contains, what percentage of the whole liver that is, which
 *   lobe it belongs to, and which major blood vessels pass through.
 *
 * Spec refs:
 *   - §FR-008 §FR-045 (glossary-backed tooltips + detail panel)
 *   - §SC-004 ≥80% surgical usability rating
 *   - §NFR-002 accessibility
 */

import { memo } from 'react';
import { Box, Group, Stack, Text, Badge } from '@mantine/core';

import { EMRCard } from '../common/EMRCard';
import { useTranslation } from '../../contexts/TranslationContext';

import {
  type CouinaudLabel,
  COUINAUD_LOBE,
  getCouinaudColorVar,
} from './couinaud-constants';

export interface SegmentVolumeCardProps {
  segment: CouinaudLabel;
  volumeMl: number;
  totalLiverVolumeMl: number;
  /** Comma-separated vessel trunk passes (e.g. "Portal vein, Hepatic vein"). */
  includedVessels?: string[];
  /** Optional close handler — shown as a card action when present. */
  onClose?: () => void;
  'data-testid'?: string;
}

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

const LOBE_LABEL: Record<ReturnType<typeof resolveLobe>, string> = {
  caudate: 'Caudate (straddles lobes)',
  left:    'Left lobe',
  right:   'Right lobe',
};

function resolveLobe(label: CouinaudLabel): 'caudate' | 'left' | 'right' {
  return COUINAUD_LOBE[label];
}

export const SegmentVolumeCard = memo(function SegmentVolumeCard({
  segment,
  volumeMl,
  totalLiverVolumeMl,
  includedVessels,
  onClose,
  'data-testid': dataTestId = 'segment-volume-card',
}: SegmentVolumeCardProps) {
  const { t } = useTranslation();

  const pct =
    totalLiverVolumeMl > 0
      ? (volumeMl / totalLiverVolumeMl) * 100
      : 0;

  const latinKey = `glossary:couinaud.${segment}.latin`;
  const latinRaw = t(latinKey);
  const latin = latinRaw && latinRaw !== latinKey ? latinRaw : DEFAULT_LATIN[segment];

  const lobe = resolveLobe(segment);
  const lobeLabel = LOBE_LABEL[lobe];

  return (
    <Box data-testid={dataTestId} style={{ minWidth: 260 }}>
      <EMRCard
        title={`Couinaud segment ${segment}`}
        description={latin}
        actions={
          onClose
            ? [
                {
                  key: 'close',
                  icon: () => <span aria-hidden>✕</span>,
                  label: 'Close',
                  onClick: onClose,
                  variant: 'muted',
                },
              ]
            : undefined
        }
      >
        <Stack gap={10}>
          <Group gap={10} wrap="wrap">
            <Box
              aria-hidden
              data-testid="segment-volume-card-swatch"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                flexShrink: 0,
                backgroundColor: getCouinaudColorVar(segment),
                border: '1px solid var(--emr-border-color)',
              }}
            />
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Text
                size="lg"
                fw={700}
                data-testid="segment-volume-card-volume"
                style={{
                  color: 'var(--emr-text-primary)',
                  fontSize: 'var(--emr-font-lg, 18px)',
                }}
              >
                {volumeMl.toFixed(1)} mL
              </Text>
              <Text
                size="sm"
                data-testid="segment-volume-card-pct"
                style={{
                  color: 'var(--emr-text-secondary)',
                  fontSize: 'var(--emr-font-sm)',
                }}
              >
                {pct.toFixed(1)}% of total liver
              </Text>
            </Box>
          </Group>

          <Group gap={6} wrap="wrap">
            <Badge
              data-testid="segment-volume-card-lobe"
              size="sm"
              variant="light"
              color="blue"
              style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              {lobeLabel}
            </Badge>
            {(includedVessels ?? []).map((vessel) => (
              <Badge
                key={vessel}
                size="sm"
                variant="outline"
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {vessel}
              </Badge>
            ))}
          </Group>

          <Text
            size="xs"
            style={{
              color: 'var(--emr-text-secondary)',
              fontSize: 'var(--emr-font-xs, 11px)',
              fontStyle: 'italic',
            }}
          >
            Research Use Only — not for clinical decision-making.
          </Text>
        </Stack>
      </EMRCard>
    </Box>
  );
});
