// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrPlainTextRenderer — unit tests for feature 002-acr-structured-readout T046.
 *
 * Asserts the cross-channel-parity invariants of contracts/plaintext-renderer.md:
 *   - RUO disclaimer bookends the output (first AND last non-empty line).
 *   - Six section headers appear in fixed canonical order.
 *   - No markdown / HTML characters leak into the output.
 *   - NFC unicode normalization (decomposed Georgian / Cyrillic recomposed).
 *   - Deterministic: byte-equivalent across repeat calls with the same snapshot.
 *   - Empty sections render the localized emptyMessage indented two spaces.
 */
import { describe, expect, it } from 'vitest';

import {
  buildReadoutSnapshot,
  type TFn,
} from '../acrAnatomicalMapping';
import { renderReadoutPlainText } from '../acrPlainTextRenderer';
import type { ReportSummary } from '../reportSummary';

const RUO_BANNER =
  '--- RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE ---';

const tFallback: TFn = (_key, fallback) => fallback ?? _key;

const minimalSummary: ReportSummary = {
  analysis_id: 'a1',
  study_id: 's1',
  patient_ref: null,
  status: 'completed',
  started_at: null,
  completed_at: '2026-05-13T14:00:00Z',
  pipeline_version: 'v1',
  stages: [],
  flr: null,
  segmentations: [],
  lesions: [],
  qc_flags: [],
  tenant_id: 't1',
  updated_at: '2026-05-13T14:00:00Z',
};

function build(summary: ReportSummary = minimalSummary): string {
  const snap = buildReadoutSnapshot({
    reportSummary: summary,
    locale: 'en',
    ruoDisclaimer: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
    t: tFallback,
  });
  return renderReadoutPlainText(snap);
}

describe('renderReadoutPlainText — RUO bookends', () => {
  it('starts AND ends with the RUO disclaimer banner', () => {
    const text = build();
    const lines = text.split('\n');
    expect(lines[0]).toBe(RUO_BANNER);
    expect(lines[lines.length - 1]).toBe(RUO_BANNER);
  });
});

describe('renderReadoutPlainText — section ordering', () => {
  it('emits the six section headers in fixed canonical order', () => {
    const text = build();
    const headers = ['LIVER', 'LESIONS', 'VESSELS', 'GALLBLADDER', 'SPLEEN', 'FLR ASSESSMENT'];
    let cursor = 0;
    for (const header of headers) {
      const idx = text.indexOf(header, cursor);
      expect(idx, `expected to find "${header}" after position ${cursor}`).toBeGreaterThan(-1);
      cursor = idx + header.length;
    }
  });
});

describe('renderReadoutPlainText — markup hygiene', () => {
  it('contains no markdown / HTML special characters', () => {
    // Build with lesion content so we cover the per-item rendering path too.
    const summary: ReportSummary = {
      ...minimalSummary,
      lesions: [
        {
          id: 'L1',
          bbox3d: null,
          longest_diameter_mm: 89.6,
          size_mm: 89.6,
          segment: 'VIII',
          classification: { label: 'icc', confidence: 0.88 },
        },
      ],
      findings: {
        hu_stats: {
          mean: 55,
          median: 55,
          p10: 48,
          p90: 62,
          std: 4,
          voxel_count: 1_000_000,
        },
        gallbladder: {
          volume_ml: 22,
          wall_thickness_mm: 2.5,
          wall_thickened: false,
          stones_detected: false,
          stone_voxel_count: 0,
        },
      } as ReportSummary['findings'],
    };
    const text = build(summary);
    expect(text).not.toMatch(/\*/);
    expect(text).not.toMatch(/_/);
    expect(text).not.toMatch(/~/);
    expect(text).not.toMatch(/`/);
    expect(text).not.toMatch(/</);
    expect(text).not.toMatch(/>/);
  });
});

describe('renderReadoutPlainText — NFC normalization', () => {
  it('emits NFC-normalized output even when input strings are decomposed', () => {
    // Combining acute accent (U+0301) over Latin "a" → decomposed (NFD).
    // After NFC normalization the renderer output should contain the
    // precomposed character (U+00E1, "á") and NOT the decomposed pair.
    const decomposed = 'á'; // "á" in NFD form
    const summary: ReportSummary = {
      ...minimalSummary,
      findings: {
        gallbladder: {
          volume_ml: 22,
          wall_thickness_mm: 1.0,
          wall_thickened: true,
          stones_detected: false,
          stone_voxel_count: 0,
        },
      } as ReportSummary['findings'],
    };
    // Inject the decomposed string via the translation fallback so it flows
    // through the renderer like any other localized label would.
    const tDecomposed: TFn = (_key, fallback) => {
      if (_key === 'reportAcr:warnings.degraded') return `Decomposed-${decomposed}-warn`;
      return fallback ?? _key;
    };
    const snap = buildReadoutSnapshot({
      reportSummary: summary,
      locale: 'en',
      ruoDisclaimer: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
      t: tDecomposed,
    });
    const out = renderReadoutPlainText(snap);
    // The output must be NFC normalized — every code-point sequence in
    // the rendered string is identical to its own NFC form.
    expect(out).toBe(out.normalize('NFC'));
    // And the decomposed sequence must have been recomposed.
    expect(out.includes('á')).toBe(true);
    expect(out.includes(decomposed)).toBe(false);
  });
});

describe('renderReadoutPlainText — determinism', () => {
  it('returns byte-equivalent strings across repeat calls with the same snapshot', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...minimalSummary,
        lesions: [
          { id: 'L1', bbox3d: null, longest_diameter_mm: 12, size_mm: 12.0, segment: 'IV' },
          { id: 'L2', bbox3d: null, longest_diameter_mm: 8, size_mm: 8.4, segment: 'VII' },
        ],
      },
      locale: 'en',
      ruoDisclaimer: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
      t: tFallback,
    });
    const a = renderReadoutPlainText(snap);
    const b = renderReadoutPlainText(snap);
    expect(a).toBe(b);
  });
});

describe('renderReadoutPlainText — empty section', () => {
  it('renders the localized emptyMessage indented two spaces', () => {
    // No findings, no lesions, no FLR → every section is empty.
    const text = build();
    // The default empty message is `t('reportAcr:sections.<x>.empty', 'Not assessed')`.
    // The renderer indents the placeholder by exactly two spaces.
    expect(text).toMatch(/^ {2}Not assessed$/m);
  });
});
