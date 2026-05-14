// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrAnatomicalMapping — canonical finding → anatomical-section mapping.
 *
 * Single source of truth (FR-024b) for how the seven Phase 1 heuristic
 * findings plus per-lesion entries are grouped into the six ACR
 * anatomical sections rendered by both the React renderer
 * (`ACRStructuredReadout`) and the PDF builder.
 *
 * This module also ports the implicit display rules previously hidden
 * inside `components/report/FindingsCard.tsx`. Each ported rule is
 * named in its code comment with the source line numbers so behaviour
 * is preserved verbatim. Once FindingsCard.tsx is deleted (T045) this
 * module is the authoritative reference.
 */

import type {
  FindingsPayload,
  ReportSummary,
  ReportSummaryLesion,
} from './reportSummary';

// -----------------------------------------------------------------
// Anatomical section enumeration
// -----------------------------------------------------------------

/** Fixed order — every section appears in every readout, even if empty (FR-001, FR-003). */
export const ANATOMICAL_SECTIONS = [
  'liver',
  'lesions',
  'vessels',
  'gallbladder',
  'spleen',
  'flrAssessment',
] as const;

export type AnatomicalSection = (typeof ANATOMICAL_SECTIONS)[number];

/** Finding-type → section mapping (data-model.md §2). */
const FINDING_TYPE_TO_SECTION: Record<string, AnatomicalSection> = {
  hu_stats: 'liver',
  steatosis: 'liver',
  spleen: 'spleen',
  gallbladder: 'gallbladder',
  calcified_lesions: 'lesions',
  simple_biliary_cysts: 'lesions',
  indeterminate_malignant: 'lesions',
};

/**
 * Resolve a finding payload key to its anatomical section. Unknown
 * keys (future finding types) fall through to undefined so the caller
 * can decide whether to skip or surface.
 */
export function findingTypeToAnatomicalSection(
  type: string,
): AnatomicalSection | undefined {
  return FINDING_TYPE_TO_SECTION[type];
}

// -----------------------------------------------------------------
// Steatosis badge map — ported verbatim from FindingsCard.tsx lines 83-88.
// Mantine semantic palette colors. Source: FindingsCard.tsx const STEATOSIS_BADGE.
// -----------------------------------------------------------------
export const STEATOSIS_BADGE_COLOR: Record<
  'none' | 'mild' | 'moderate' | 'severe',
  'gray' | 'yellow' | 'orange' | 'red'
> = {
  none: 'gray',
  mild: 'yellow',
  moderate: 'orange',
  severe: 'red',
};

// -----------------------------------------------------------------
// ReadoutSnapshot DTO (data-model.md §2)
// -----------------------------------------------------------------

export interface ReadoutRow {
  /** Localized field label. */
  label: string;
  /** Formatted value with units (e.g., "1,828 mL"); null → translated "Not available". */
  value: string | null;
  /** Localized degraded-quality warning if payload contained one. */
  warning?: string;
  /** Per-lesion identifier (e.g., "L1"). */
  itemId?: string;
  /** Couinaud segment (e.g., "VIII"). */
  segment?: string;
  /** Lesion interpretation string for plain-text rendering. */
  interpretation?: string;
  /** Optional badge for screen rendering. */
  badge?: {
    label: string;
    color: 'gray' | 'yellow' | 'orange' | 'red' | 'green' | 'blue';
  };
  /** Stale-finding marker. */
  stale?: { computedAt: string };
  /** Stable key for React rendering. */
  key: string;
}

export interface ReadoutSection {
  section: AnatomicalSection;
  title: string;
  rows: ReadoutRow[];
  status: 'present' | 'empty' | 'computing' | 'unavailable';
  emptyMessage?: string;
}

export interface ReadoutSnapshot {
  analysisId: string;
  tenantId: string;
  locale: 'en' | 'ru' | 'ka' | 'de';
  capturedAt: string;
  etag?: string | null;
  status: 'completed' | 'running' | 'partial' | 'failed' | 'queued';
  sections: ReadoutSection[];
  ruoDisclaimer: string;
}

// -----------------------------------------------------------------
// Translation-bundle shape (subset we read).
// -----------------------------------------------------------------

export type TFn = (key: string, fallback?: string) => string;

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

function fmtInt(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n).toLocaleString('en-US');
}

function fmtFloat(n: number | null | undefined, digits = 1): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return n.toFixed(digits);
}

function notAvailable(t: TFn): string {
  return t('reportAcr:status.notAvailable');
}

function sectionTitle(t: TFn, section: AnatomicalSection): string {
  // M-I18NLIT-2: dead positional fallback removed. If the bundle key is
  // missing, the i18n fallback chain (en → marker-strip → raw key) handles it.
  return t(`reportAcr:sections.${section}.title`);
}

function sectionEmpty(t: TFn, section: AnatomicalSection): string {
  return t(`reportAcr:sections.${section}.empty`);
}

// -----------------------------------------------------------------
// Per-section row builders. Each returns the rows in a stable,
// predefined field order. Empty array → render the section's empty
// state.
// -----------------------------------------------------------------

function buildLiverRows(findings: FindingsPayload | undefined, t: TFn): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  if (!findings) return rows;

  // FindingsCard.tsx:142-151 — HU stats value format.
  // H-ACR-1: 1-decimal precision matches Python `_build_liver_rows`.
  if (findings.hu_stats) {
    const hu = findings.hu_stats;
    rows.push({
      key: 'hu_mean',
      label: t('reportAcr:labels.huMean'),
      value: `${hu.mean.toFixed(1)} (p10 ${hu.p10.toFixed(1)}, p90 ${hu.p90.toFixed(1)})`,
    });
  }

  // FindingsCard.tsx:153 — skip rule: steatosis.grade === 'none' suppresses the row.
  if (findings.steatosis && findings.steatosis.grade !== 'none') {
    const st = findings.steatosis;
    const gradeLabel = t(
      `reportAcr:values.steatosis${capitalize(st.grade)}`,
      capitalize(st.grade),
    );
    const delta =
      st.liver_spleen_delta != null
        ? `${gradeLabel} (${t('reportAcr:labels.liverSpleenDelta')} = ${st.liver_spleen_delta.toFixed(1)} HU)`
        : `${gradeLabel} (${t('reportAcr:labels.liverSpleenDelta')} unavailable)`;
    rows.push({
      key: 'steatosis',
      label: t('reportAcr:labels.steatosisGrade'),
      value: delta,
      badge: { label: gradeLabel, color: STEATOSIS_BADGE_COLOR[st.grade] },
    });
  }

  return rows;
}

function buildLesionsRows(
  findings: FindingsPayload | undefined,
  lesions: ReportSummaryLesion[] | undefined,
  t: TFn,
): ReadoutRow[] {
  const rows: ReadoutRow[] = [];

  // Per-lesion list. Sort by id lexicographic (plaintext-renderer §5 stability).
  const sortedLesions = [...(lesions ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  for (const lesion of sortedLesions) {
    const size =
      lesion.size_mm != null
        ? `${lesion.size_mm.toFixed(1)} mm`
        : lesion.longest_diameter_mm != null
          ? `${lesion.longest_diameter_mm.toFixed(1)} mm`
          : notAvailable(t);
    const cls = lesion.classification;
    const clsLabel = cls?.label ? cls.label.toUpperCase() : null;
    const conf =
      cls?.confidence != null ? ` (${t('reportAcr:labels.lesionConfidence')} ${(cls.confidence * 100).toFixed(0)}%)` : '';
    const interpretation = clsLabel
      ? `${size}, ${clsLabel}${conf}`
      : size;
    rows.push({
      key: `lesion-${lesion.id}`,
      label: lesion.id,
      itemId: lesion.id,
      segment: lesion.segment ?? undefined,
      value: interpretation,
      interpretation: clsLabel ?? undefined,
    });
  }

  if (findings) {
    // FindingsCard.tsx:203-215 — calcified lesions summary line.
    if (findings.calcified_lesions && findings.calcified_lesions.length > 0) {
      const list = findings.calcified_lesions;
      rows.push({
        key: 'calcified-summary',
        label: t('reportAcr:lesions.interpretationCalcified'),
        value: `${list.length}`,
      });
    }
    // FindingsCard.tsx:217-230 — simple biliary cysts summary line.
    if (findings.simple_biliary_cysts && findings.simple_biliary_cysts.length > 0) {
      const list = findings.simple_biliary_cysts;
      rows.push({
        key: 'cysts-summary',
        label: t('reportAcr:lesions.interpretationSimpleCyst'),
        value: `${list.length}`,
      });
    }
    // FindingsCard.tsx:232-244 — indeterminate malignant LR-M summary.
    if (
      findings.indeterminate_malignant &&
      findings.indeterminate_malignant.lr_m_count > 0
    ) {
      const lrm = findings.indeterminate_malignant;
      rows.push({
        key: 'lr-m-summary',
        label: t('reportAcr:labels.lrM'),
        value: `${lrm.lr_m_count}`,
        badge: { label: t('reportAcr:labels.lrM'), color: 'red' },
        interpretation: lrm.interpretation,
      });
    }
  }

  return rows;
}

function buildVesselsRows(_findings: FindingsPayload | undefined, _t: TFn): ReadoutRow[] {
  // No vessel findings persisted yet — section is structural only (FR-002).
  // Visible content is the vessels stage image rendered by ACRSectionVessels.
  return [];
}

function buildGallbladderRows(findings: FindingsPayload | undefined, t: TFn): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  if (!findings?.gallbladder) return rows;
  const gb = findings.gallbladder;
  // FindingsCard.tsx:188-201 — flag concatenation rule.
  rows.push({
    key: 'gb-volume',
    label: t('reportAcr:labels.volume'),
    // H-ACR-1: 1-decimal precision matches Python.
    value: `${gb.volume_ml.toFixed(1)} mL`,
  });
  rows.push({
    key: 'gb-wall',
    label: t('reportAcr:labels.wallThickness'),
    value: `${gb.wall_thickness_mm.toFixed(1)} mm`,
    warning: gb.wall_thickened
      ? t('reportAcr:warnings.degraded')
      : undefined,
  });
  rows.push({
    key: 'gb-stones',
    label: t('reportAcr:labels.stones'),
    value: gb.stones_detected
      ? t('reportAcr:labels.yes')
      : t('reportAcr:labels.no'),
    badge: gb.stones_detected
      ? { label: t('reportAcr:labels.yes'), color: 'orange' }
      : undefined,
  });
  return rows;
}

function buildSpleenRows(findings: FindingsPayload | undefined, t: TFn): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  if (!findings?.spleen) return rows;
  const sp = findings.spleen;
  // FindingsCard.tsx:171-186 — splenomegaly badge-and-warn logic.
  // FindingsCard.tsx:171-186 also degraded-mask warning surfacing.
  const warningField = (sp as unknown as { warning?: string | null }).warning;
  rows.push({
    key: 'spleen-volume',
    label: t('reportAcr:labels.volume'),
    // H-ACR-1: 1-decimal precision matches Python.
    value: `${sp.volume_ml.toFixed(1)} mL`,
    warning: warningField ?? undefined,
    badge: sp.splenomegaly
      ? { label: t('reportAcr:labels.splenomegaly'), color: 'orange' }
      : undefined,
  });
  rows.push({
    key: 'spleen-splenomegaly',
    label: t('reportAcr:labels.splenomegaly'),
    value: sp.splenomegaly
      ? t('reportAcr:values.splenomegalyPresent')
      : t('reportAcr:values.splenomegalyAbsent'),
  });
  return rows;
}

function buildFlrRows(
  flr: ReportSummary['flr'] | undefined,
  t: TFn,
): ReadoutRow[] {
  if (!flr) return [];
  const rows: ReadoutRow[] = [];
  if (flr.plan_pattern) {
    rows.push({
      key: 'flr-plan',
      label: t('reportAcr:labels.flrPlan'),
      value: flr.plan_pattern.replace(/_/g, ' '),
    });
  }
  const ml = flr.flr_ml;
  const pct = flr.flr_pct;
  const safety = flr.safety_class;
  const safetyLabel =
    safety === 'low'
      ? t('reportAcr:values.flrSafetyLow')
      : safety === 'borderline'
        ? t('reportAcr:values.flrSafetyBorderline')
        : safety === 'adequate'
          ? t('reportAcr:values.flrSafetyAdequate')
          : safety ?? '';
  const valueParts: string[] = [];
  // H-ACR-1: 1-decimal precision matches Python.
  if (ml != null) valueParts.push(`${ml.toFixed(1)} mL`);
  if (pct != null) valueParts.push(`(${pct.toFixed(1)}%)`);
  if (safetyLabel) valueParts.push(`— ${safetyLabel}`);
  rows.push({
    key: 'flr-value',
    label: t('reportAcr:labels.flrPercent'),
    value: valueParts.length ? valueParts.join(' ') : notAvailable(t),
    badge:
      safety === 'low'
        ? { label: safetyLabel, color: 'red' }
        : safety === 'borderline'
          ? { label: safetyLabel, color: 'orange' }
          : safety === 'adequate'
            ? { label: safetyLabel, color: 'green' }
            : undefined,
  });
  if (safety === 'low') {
    rows.push({
      key: 'flr-recommendation',
      label: t('reportAcr:labels.flrRecommendation'),
      value: t('reportAcr:recommendations.considerPveAlpps'),
    });
  } else if (safety === 'borderline') {
    rows.push({
      key: 'flr-recommendation',
      label: t('reportAcr:labels.flrRecommendation'),
      value: t('reportAcr:recommendations.borderlineDiscussMdt'),
    });
  } else if (safety === 'adequate') {
    rows.push({
      key: 'flr-recommendation',
      label: t('reportAcr:labels.flrRecommendation'),
      value: t(
        'reportAcr:recommendations.noteAdequateRemnant',
        'remnant volume meets institutional threshold',
      ),
    });
  }
  return rows;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// -----------------------------------------------------------------
// buildReadoutSnapshot — pure factory consumed by the renderer + the
// clipboard service.
// -----------------------------------------------------------------

export interface BuildReadoutSnapshotArgs {
  reportSummary: ReportSummary;
  locale: 'en' | 'ru' | 'ka' | 'de';
  ruoDisclaimer: string;
  t: TFn;
}

export function buildReadoutSnapshot(args: BuildReadoutSnapshotArgs): ReadoutSnapshot {
  const { reportSummary, locale, ruoDisclaimer, t } = args;
  const findings = reportSummary.findings;
  const lesions = reportSummary.lesions;

  const status = mapStatus(reportSummary.status);
  // FR-023c: a finding is stale iff its computed_at predates the latest
  // completed stage. Compute the threshold once per snapshot.
  const latestStageAt = computeLatestCompletedStageAt(reportSummary);

  const sectionBuilders: Record<AnatomicalSection, () => ReadoutRow[]> = {
    liver: () => stampStale(buildLiverRows(findings, t), findings, latestStageAt),
    lesions: () => stampStale(buildLesionsRows(findings, lesions, t), findings, latestStageAt),
    vessels: () => buildVesselsRows(findings, t),
    gallbladder: () => stampStale(buildGallbladderRows(findings, t), findings, latestStageAt),
    spleen: () => stampStale(buildSpleenRows(findings, t), findings, latestStageAt),
    flrAssessment: () => buildFlrRows(reportSummary.flr ?? undefined, t),
  };

  const sections: ReadoutSection[] = ANATOMICAL_SECTIONS.map((section) => {
    const rows = sectionBuilders[section]();
    const isComputing = status === 'running' || status === 'queued';
    let sectionStatus: ReadoutSection['status'];
    if (rows.length > 0) sectionStatus = 'present';
    else if (isComputing) sectionStatus = 'computing';
    else if (status === 'failed') sectionStatus = 'unavailable';
    else sectionStatus = 'empty';

    return {
      section,
      title: sectionTitle(t, section),
      rows,
      status: sectionStatus,
      emptyMessage:
        sectionStatus === 'computing'
          ? t('reportAcr:status.computing')
          : sectionStatus === 'unavailable'
            ? t('reportAcr:status.computationFailed')
            : sectionEmpty(t, section),
    };
  });

  return {
    analysisId: reportSummary.analysis_id,
    tenantId: reportSummary.tenant_id ?? '',
    locale,
    capturedAt: reportSummary.updated_at ?? new Date().toISOString(),
    etag: reportSummary.etag ?? null,
    status,
    sections,
    ruoDisclaimer,
  };
}

function mapStatus(s: string): ReadoutSnapshot['status'] {
  if (s === 'completed' || s === 'partial' || s === 'failed' || s === 'queued' || s === 'running') {
    return s;
  }
  return 'completed';
}

/**
 * FR-023c support: derive the latest stage completion timestamp from
 * the report summary. Used as the threshold against each finding's
 * `computed_at` to decide whether to stamp the row stale.
 */
function computeLatestCompletedStageAt(reportSummary: ReportSummary): string | undefined {
  let best: string | undefined;
  for (const s of reportSummary.stages ?? []) {
    const completed = (s.status ?? 'completed') === 'completed';
    if (!completed) continue;
    const at = s.computed_at ?? s.written_at;
    if (!at) continue;
    if (!best || at > best) best = at;
  }
  return best;
}

/**
 * Map a row's key prefix to the finding payload key that produced it,
 * so we can read that finding's `computed_at` for staleness.
 */
const ROW_KEY_TO_FINDING_TYPE: Record<string, keyof FindingsPayload> = {
  hu_mean: 'hu_stats',
  steatosis: 'steatosis',
  'gb-volume': 'gallbladder',
  'gb-wall': 'gallbladder',
  'gb-stones': 'gallbladder',
  'spleen-volume': 'spleen',
  'spleen-splenomegaly': 'spleen',
  'calcified-summary': 'calcified_lesions',
  'cysts-summary': 'simple_biliary_cysts',
  'lr-m-summary': 'indeterminate_malignant',
};

function stampStale(
  rows: ReadoutRow[],
  findings: FindingsPayload | undefined,
  latestStageAt: string | undefined,
): ReadoutRow[] {
  if (!latestStageAt || !findings) return rows;
  return rows.map((row) => {
    // Per-lesion rows (itemId set) aren't driven by a single Phase 1
    // finding key — skip staleness for them.
    if (row.itemId) return row;
    const findingKey = ROW_KEY_TO_FINDING_TYPE[row.key];
    if (!findingKey) return row;
    const finding = findings[findingKey] as { computed_at?: string | null } | null | undefined;
    const computedAt = finding && Array.isArray(finding) ? undefined : finding?.computed_at;
    if (!computedAt) return row;
    if (computedAt >= latestStageAt) return row;
    return { ...row, stale: { computedAt } };
  });
}
