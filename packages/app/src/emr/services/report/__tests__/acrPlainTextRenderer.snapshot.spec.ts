// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrPlainTextRenderer — locale × scenario snapshot tests (T047).
 *
 * 4 locales (en / de / ka / ru) × 5 scenarios (complete, no-lesions,
 * degraded-spleen, stale-finding, partial-payload) = 20 snapshots.
 * Vitest writes them under `__snapshots__/` next to this file.
 *
 * These snapshots are the cross-channel-parity reference: the Python
 * twin renderer (`packages/ml-inference/src/services/export/acr_plaintext_renderer.py`)
 * must produce byte-equivalent output for the same fixture inputs.
 */
import { describe, expect, it } from 'vitest';

import {
  buildReadoutSnapshot,
  type TFn,
} from '../acrAnatomicalMapping';
import { renderReadoutPlainText } from '../acrPlainTextRenderer';
import type { ReportSummary } from '../reportSummary';

type Locale = 'en' | 'de' | 'ka' | 'ru';
type ScenarioName =
  | 'complete'
  | 'no-lesions'
  | 'degraded-spleen'
  | 'stale-finding'
  | 'partial-payload';

const LOCALES: Locale[] = ['en', 'de', 'ka', 'ru'];

const RUO_BANNER: Record<Locale, string> = {
  en: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
  de: 'NUR FÜR FORSCHUNGSZWECKE — NICHT FÜR DIE PRIMÄRE DIAGNOSTIK',
  ka: 'მხოლოდ კვლევითი დანიშნულებით — არ გამოიყენება პირველად დიაგნოსტიკაში',
  ru: 'ТОЛЬКО ДЛЯ НАУЧНЫХ ЦЕЛЕЙ — НЕ ДЛЯ ПЕРВИЧНОЙ ДИАГНОСТИКИ',
};

/**
 * Translation fallback that returns each label prefixed with the locale
 * so cross-locale snapshots remain distinguishable without requiring a
 * full translation bundle in the test runner.
 */
function makeT(locale: Locale): TFn {
  return (key, fallback) => `[${locale}] ${fallback ?? key}`;
}

// -----------------------------------------------------------------
// Scenario builders — each returns the ReportSummary the renderer
// receives, plus the optional `updated_at` it should be tagged with.
// -----------------------------------------------------------------

function scenarioComplete(): ReportSummary {
  return {
    analysis_id: 'a-complete-001',
    study_id: 's-001',
    patient_ref: null,
    status: 'completed',
    started_at: '2026-05-13T13:00:00Z',
    completed_at: '2026-05-13T13:15:00Z',
    updated_at: '2026-05-13T13:15:00Z',
    pipeline_version: 'v1.0.0',
    tenant_id: 'tenant-snap',
    stages: [],
    flr: {
      total_ml: 1820,
      flr_ml: 518,
      flr_pct: 28.4,
      plane_pose: null,
      plan_pattern: 'right_hepatectomy',
      safety_class: 'low',
      computed_at: '2026-05-13T13:15:00Z',
    },
    segmentations: [],
    lesions: [
      {
        id: 'L1',
        bbox3d: null,
        longest_diameter_mm: 89.6,
        size_mm: 89.6,
        segment: 'VIII',
        classification: { label: 'icc', confidence: 0.88 },
      },
      {
        id: 'L2',
        bbox3d: null,
        longest_diameter_mm: 14.2,
        size_mm: 14.2,
        segment: 'IVb',
        classification: { label: 'metastasis', confidence: 0.71 },
      },
      {
        id: 'L3',
        bbox3d: null,
        longest_diameter_mm: 5.4,
        size_mm: 5.4,
        segment: 'II',
        classification: { label: 'cyst', confidence: 0.93 },
      },
    ],
    qc_flags: [],
    findings: {
      hu_stats: { mean: 55, median: 55, p10: 48, p90: 62, std: 4, voxel_count: 1_500_000 },
      steatosis: {
        grade: 'moderate',
        liver_mean_hu: 35,
        spleen_mean_hu: 50,
        liver_spleen_delta: -15,
        warnings: [],
        reference: 'r1',
      },
      spleen: { volume_ml: 220, splenomegaly: false, threshold_ml: 314, reference: 'r2' },
      gallbladder: {
        volume_ml: 22,
        wall_thickness_mm: 2.5,
        wall_thickened: false,
        stones_detected: false,
        stone_voxel_count: 0,
      },
      calcified_lesions: [
        { lesion_id: 'L4', hu_max: 320, pct_calcified: 80, interpretation: 'Granuloma' },
      ],
      indeterminate_malignant: {
        lr_m_count: 1,
        lesions: [{ lesion_id: 'L1', confidence: 0.88 }],
        interpretation: 'LR-M: probable malignancy not classified as HCC',
      },
    } as ReportSummary['findings'],
  };
}

function scenarioNoLesions(): ReportSummary {
  const s = scenarioComplete();
  s.analysis_id = 'a-no-lesions-001';
  s.lesions = [];
  // Drop the indeterminate_malignant payload — there are no lesions to summarize.
  if (s.findings) {
    s.findings = { ...s.findings, indeterminate_malignant: null };
  }
  return s;
}

function scenarioDegradedSpleen(): ReportSummary {
  const s = scenarioComplete();
  s.analysis_id = 'a-degraded-spleen-001';
  if (s.findings && s.findings.spleen) {
    // Add a `warning` field — the renderer surfaces it as a `! ` line.
    s.findings = {
      ...s.findings,
      spleen: {
        ...s.findings.spleen,
        // Cast — `warning` is read at runtime even though the public type
        // doesn't declare it (see acrAnatomicalMapping.ts buildSpleenRows).
        warning: 'Spleen mask <500 voxels — volume estimate degraded',
      } as ReportSummary['findings']['spleen'],
    };
  }
  return s;
}

function scenarioStaleFinding(): ReportSummary {
  const s = scenarioComplete();
  s.analysis_id = 'a-stale-finding-001';
  // Backdate the spleen computed_at so it predates the latest stage.
  // (The renderer reads `row.stale.computedAt`; buildReadoutSnapshot does
  // not currently populate stale on findings — see implementation. Still
  // useful as a snapshot input distinct from `complete`.)
  if (s.findings && s.findings.spleen) {
    s.findings = {
      ...s.findings,
      spleen: {
        ...s.findings.spleen,
        // Predates by 24h
        computed_at: '2026-05-12T13:15:00Z',
      } as ReportSummary['findings']['spleen'],
    };
  }
  return s;
}

function scenarioPartialPayload(): ReportSummary {
  const s = scenarioComplete();
  s.analysis_id = 'a-partial-payload-001';
  if (s.findings) {
    // Drop wall_thickness_mm by replacing gallbladder with a stripped-down
    // payload. Also wipe HU p10/p90 to simulate a degraded HU-stats compute.
    s.findings = {
      ...s.findings,
      hu_stats: {
        // mean still present; p10/p90 set to NaN so fmt helpers return null.
        mean: 55,
        median: 55,
        p10: Number.NaN,
        p90: Number.NaN,
        std: 4,
        voxel_count: 1_500_000,
      },
      gallbladder: {
        volume_ml: 22,
        // wall_thickness_mm missing → cast through unknown to bypass the
        // mandatory-field type guard for this partial-payload snapshot.
        wall_thickness_mm: Number.NaN as unknown as number,
        wall_thickened: false,
        stones_detected: false,
        stone_voxel_count: 0,
      },
    };
  }
  return s;
}

const SCENARIOS: Array<[ScenarioName, () => ReportSummary]> = [
  ['complete', scenarioComplete],
  ['no-lesions', scenarioNoLesions],
  ['degraded-spleen', scenarioDegradedSpleen],
  ['stale-finding', scenarioStaleFinding],
  ['partial-payload', scenarioPartialPayload],
];

// Build the cartesian product as it.each rows: 4×5 = 20.
const CASES: Array<[Locale, ScenarioName]> = LOCALES.flatMap((loc) =>
  SCENARIOS.map(([name]): [Locale, ScenarioName] => [loc, name]),
);

describe('renderReadoutPlainText — locale × scenario snapshots', () => {
  it.each(CASES)('locale=%s scenario=%s', (locale, scenarioName) => {
    const builder = SCENARIOS.find(([n]) => n === scenarioName)![1];
    const summary = builder();
    const snap = buildReadoutSnapshot({
      reportSummary: summary,
      locale,
      ruoDisclaimer: RUO_BANNER[locale],
      t: makeT(locale),
    });
    const text = renderReadoutPlainText(snap);
    expect(text).toMatchSnapshot();
  });
});
