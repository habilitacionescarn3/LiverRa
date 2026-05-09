// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FindingsCard — renders the 7 Phase 1 heuristic findings produced by
 * the cascade after stage 7 (FLR). All findings are optional; the card
 * only renders rows whose payload is present and non-empty.
 *
 * Server contract: GET /analyses/{id}/report/summary returns
 * `findings: Record<string, payload>` keyed by finding_type.
 * See `packages/ml-inference/src/services/post_processing/findings.py`.
 */
import { Badge, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';

import { useTranslation } from '../../contexts/TranslationContext';

interface HUStats {
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  voxel_count: number;
}

interface SpleenFinding {
  volume_ml: number;
  splenomegaly: boolean;
  threshold_ml: number;
  reference: string;
}

interface SteatosisFinding {
  grade: 'none' | 'mild' | 'moderate' | 'severe';
  liver_mean_hu: number;
  spleen_mean_hu: number | null;
  liver_spleen_delta: number | null;
  warnings: string[];
  reference: string;
}

interface CalcifiedLesion {
  lesion_id: string;
  hu_max: number;
  pct_calcified: number;
  interpretation: string;
}

interface SimpleBiliaryCyst {
  lesion_id: string;
  hu_mean: number;
  hu_std: number;
  sphericity: number;
  wall_thickness_mm: number;
  interpretation: string;
}

interface IndeterminateMalignant {
  lr_m_count: number;
  lesions: Array<{ lesion_id: string; confidence: number | null }>;
  interpretation: string;
}

interface GallbladderFinding {
  volume_ml: number;
  wall_thickness_mm: number;
  wall_thickened: boolean;
  stones_detected: boolean;
  stone_voxel_count: number;
}

export interface FindingsPayload {
  hu_stats?: HUStats | null;
  spleen?: SpleenFinding | null;
  steatosis?: SteatosisFinding | null;
  calcified_lesions?: CalcifiedLesion[] | null;
  simple_biliary_cysts?: SimpleBiliaryCyst[] | null;
  indeterminate_malignant?: IndeterminateMalignant | null;
  gallbladder?: GallbladderFinding | null;
}

const STEATOSIS_BADGE: Record<SteatosisFinding['grade'], { color: string; label: string }> = {
  none: { color: 'gray', label: 'None' },
  mild: { color: 'yellow', label: 'Mild' },
  moderate: { color: 'orange', label: 'Moderate' },
  severe: { color: 'red', label: 'Severe' },
};

function FindingRow({
  label,
  value,
  badge,
  detail,
  alert,
}: {
  label: string;
  value: string;
  badge?: { color: string; label: string };
  detail?: string;
  alert?: 'warn' | 'info';
}): JSX.Element {
  return (
    <Group justify="space-between" wrap="wrap" gap="sm" align="flex-start">
      <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        {alert === 'warn' && <IconAlertTriangle size={14} color="#b45309" style={{ flexShrink: 0 }} />}
        {alert === 'info' && <IconInfoCircle size={14} color="#1e40af" style={{ flexShrink: 0 }} />}
        <Text size="sm" fw={500}>
          {label}
        </Text>
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" c="dimmed">
          {value}
        </Text>
        {badge && (
          <Badge variant="light" color={badge.color} size="sm">
            {badge.label}
          </Badge>
        )}
      </Group>
      {detail && (
        <Text size="xs" c="dimmed" style={{ width: '100%' }}>
          {detail}
        </Text>
      )}
    </Group>
  );
}

export interface FindingsCardProps {
  findings: FindingsPayload | null | undefined;
}

export function FindingsCard({ findings }: FindingsCardProps): JSX.Element | null {
  const { t } = useTranslation();

  if (!findings || Object.keys(findings).length === 0) return null;

  const rows: JSX.Element[] = [];

  if (findings.hu_stats) {
    const hu = findings.hu_stats;
    rows.push(
      <FindingRow
        key="hu_stats"
        label={t('report:view.findings.hu_stats') ?? 'Liver attenuation'}
        value={`mean ${hu.mean.toFixed(0)} HU · range ${hu.p10.toFixed(0)}–${hu.p90.toFixed(0)} HU`}
      />,
    );
  }

  if (findings.steatosis && findings.steatosis.grade !== 'none') {
    const st = findings.steatosis;
    const badge = STEATOSIS_BADGE[st.grade];
    const delta =
      st.liver_spleen_delta != null
        ? `liver–spleen Δ ${st.liver_spleen_delta.toFixed(1)} HU`
        : 'spleen unavailable';
    rows.push(
      <FindingRow
        key="steatosis"
        label={t('report:view.findings.steatosis') ?? 'Steatosis'}
        value={delta}
        badge={badge}
        alert={st.grade === 'severe' ? 'warn' : st.grade === 'moderate' ? 'warn' : 'info'}
      />,
    );
  }

  if (findings.spleen) {
    const sp = findings.spleen;
    rows.push(
      <FindingRow
        key="spleen"
        label={t('report:view.findings.spleen') ?? 'Spleen volume'}
        value={`${sp.volume_ml.toFixed(0)} mL`}
        badge={
          sp.splenomegaly
            ? { color: 'orange', label: t('report:view.findings.splenomegaly') ?? 'Splenomegaly' }
            : undefined
        }
        alert={sp.splenomegaly ? 'warn' : undefined}
      />,
    );
  }

  if (findings.gallbladder) {
    const gb = findings.gallbladder;
    const flags: string[] = [];
    if (gb.stones_detected) flags.push(t('report:view.findings.stones') ?? 'stones');
    if (gb.wall_thickened) flags.push(t('report:view.findings.wallThickened') ?? 'wall thickened');
    rows.push(
      <FindingRow
        key="gallbladder"
        label={t('report:view.findings.gallbladder') ?? 'Gallbladder'}
        value={`${gb.volume_ml.toFixed(0)} mL${flags.length ? ` · ${flags.join(', ')}` : ''}`}
        alert={gb.stones_detected || gb.wall_thickened ? 'warn' : undefined}
      />,
    );
  }

  if (findings.calcified_lesions && findings.calcified_lesions.length > 0) {
    const list = findings.calcified_lesions;
    rows.push(
      <FindingRow
        key="calcified"
        label={t('report:view.findings.calcified') ?? 'Calcified lesions'}
        value={`${list.length} lesion${list.length > 1 ? 's' : ''}`}
        detail={list
          .map((l) => `#${l.lesion_id}: max ${l.hu_max.toFixed(0)} HU`)
          .join('  ·  ')}
      />,
    );
  }

  if (findings.simple_biliary_cysts && findings.simple_biliary_cysts.length > 0) {
    const list = findings.simple_biliary_cysts;
    rows.push(
      <FindingRow
        key="cysts"
        label={t('report:view.findings.simpleBiliaryCysts') ?? 'Simple biliary cysts'}
        value={`${list.length} lesion${list.length > 1 ? 's' : ''} (benign)`}
        detail={
          t('report:view.findings.cystsDetail') ??
          'Meets all 4 simple-cyst criteria — no follow-up needed.'
        }
      />,
    );
  }

  if (findings.indeterminate_malignant && findings.indeterminate_malignant.lr_m_count > 0) {
    const lrm = findings.indeterminate_malignant;
    rows.push(
      <FindingRow
        key="lr_m"
        label={t('report:view.findings.lrM') ?? 'Indeterminate malignant (LR-M)'}
        value={`${lrm.lr_m_count} lesion${lrm.lr_m_count > 1 ? 's' : ''}`}
        badge={{ color: 'red', label: 'LR-M' }}
        detail={lrm.interpretation}
        alert="warn"
      />,
    );
  }

  if (rows.length === 0) return null;

  return (
    <Card withBorder radius="md" padding="md" data-testid="findings-card">
      <Title order={4} mb="xs">
        {t('report:view.findings.title') ?? 'Additional findings'}
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        {t('report:view.findings.subtitle') ??
          'Heuristic screening from CT attenuation + segmentation masks. Not a substitute for radiologist interpretation.'}
      </Text>
      <Stack gap="sm">{rows}</Stack>
    </Card>
  );
}
