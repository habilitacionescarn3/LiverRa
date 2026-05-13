// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FR-034 — no patient identifiers in clipboard text.
 * Added by 002-acr-structured-readout C5.
 *
 * Even if a future refactor accidentally feeds patient identifiers
 * into the ReportSummary, the renderer MUST NOT surface them. This
 * test pins that invariant.
 */
import { describe, expect, it } from 'vitest';

import { renderReadoutPlainText } from '../acrPlainTextRenderer';
import { buildReadoutSnapshot, type TFn } from '../acrAnatomicalMapping';
import type { ReportSummary } from '../reportSummary';

const tFallback: TFn = (_key, fallback) => fallback ?? _key;

const PHI_NEEDLES = [
  'Smith, John',
  '123-45-6789',
  'MRN-99999',
  'DOB 1970-01-01',
  '1970-01-01',
  '+1 415 555 0100',
  '742 Evergreen Terrace',
];

describe('FR-034 no PHI in clipboard text', () => {
  it('does not surface patient_ref / MRN / DOB even when present on ReportSummary', () => {
    const summary: ReportSummary = {
      analysis_id: 'a',
      study_id: 's',
      // Deliberately include PHI in the wire shape — renderer must ignore it.
      patient_ref: 'Smith, John (MRN-99999, DOB 1970-01-01)',
      status: 'completed',
      started_at: null,
      completed_at: '2026-05-13T14:00:00Z',
      pipeline_version: 'v1',
      stages: [],
      flr: null,
      segmentations: [],
      lesions: [],
      qc_flags: [],
      tenant_id: 't',
      updated_at: '2026-05-13T14:00:00Z',
      findings: {
        hu_stats: { mean: 48, median: 47, p10: 40, p90: 56, std: 6, voxel_count: 100 },
      },
    };
    const snap = buildReadoutSnapshot({
      reportSummary: summary,
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const out = renderReadoutPlainText(snap);
    for (const needle of PHI_NEEDLES) {
      expect(out).not.toContain(needle);
    }
  });
});
