// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FR-023c stale-finding marker — derived from finding.computed_at vs
 * the latest completed-stage timestamp. Added by 002-acr-structured-readout C2.
 */
import { describe, expect, it } from 'vitest';

import { buildReadoutSnapshot, type TFn } from '../acrAnatomicalMapping';
import type { ReportSummary } from '../reportSummary';

const tFallback: TFn = (_key, fallback) => fallback ?? _key;

const baseSummary: ReportSummary = {
  analysis_id: 'a',
  study_id: 's',
  patient_ref: null,
  status: 'completed',
  started_at: null,
  completed_at: '2026-05-13T14:00:00Z',
  pipeline_version: 'v1',
  stages: [
    {
      stage_no: 2,
      stage: 'stage_2_parenchyma',
      model_version: null,
      license_hash: null,
      written_at: '2026-05-13T13:00:00Z',
      status: 'completed',
    },
    {
      stage_no: 7,
      stage: 'stage_7_flr',
      model_version: null,
      license_hash: null,
      written_at: '2026-05-13T14:00:00Z',
      status: 'completed',
    },
  ],
  flr: null,
  segmentations: [],
  lesions: [],
  qc_flags: [],
  tenant_id: 't',
  updated_at: '2026-05-13T14:00:00Z',
};

describe('FR-023c stale marker', () => {
  it('marks a row stale when finding.computed_at predates latest completed stage', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        findings: {
          hu_stats: {
            mean: 48,
            median: 47,
            p10: 40,
            p90: 56,
            std: 6,
            voxel_count: 100,
            computed_at: '2026-05-12T18:04:00Z', // older than stage 7 (14:00 next day)
          },
        },
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const liver = snap.sections.find((s) => s.section === 'liver')!;
    const row = liver.rows.find((r) => r.key === 'hu_mean');
    expect(row).toBeDefined();
    expect(row!.stale).toEqual({ computedAt: '2026-05-12T18:04:00Z' });
  });

  it('does NOT mark a row stale when finding.computed_at is fresher than latest stage', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        findings: {
          hu_stats: {
            mean: 48,
            median: 47,
            p10: 40,
            p90: 56,
            std: 6,
            voxel_count: 100,
            computed_at: '2026-05-13T14:01:00Z', // fresher
          },
        },
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const liver = snap.sections.find((s) => s.section === 'liver')!;
    const row = liver.rows.find((r) => r.key === 'hu_mean')!;
    expect(row.stale).toBeUndefined();
  });

  it('does not stamp staleness on per-lesion rows', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        lesions: [
          { id: 'L1', bbox3d: null, longest_diameter_mm: 89, size_mm: 89.6, segment: 'VIII' },
        ],
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const lesions = snap.sections.find((s) => s.section === 'lesions')!;
    const row = lesions.rows.find((r) => r.itemId === 'L1')!;
    expect(row.stale).toBeUndefined();
  });

  it('is a no-op when no stages are completed', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        stages: [],
        findings: {
          hu_stats: {
            mean: 48,
            median: 47,
            p10: 40,
            p90: 56,
            std: 6,
            voxel_count: 100,
            computed_at: '1999-01-01T00:00:00Z',
          },
        },
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const liver = snap.sections.find((s) => s.section === 'liver')!;
    const row = liver.rows.find((r) => r.key === 'hu_mean')!;
    expect(row.stale).toBeUndefined();
  });
});
