// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrAnatomicalMapping — unit tests for feature 002-acr-structured-readout T023.
 *
 * Validates: (1) mapping enum order matches data-model.md §2;
 * (2) findingTypeToAnatomicalSection correctness for all 7 finding types;
 * (3) buildReadoutSnapshot behaviour matches ported FindingsCard rules.
 */
import { describe, expect, it } from 'vitest';

import {
  ANATOMICAL_SECTIONS,
  findingTypeToAnatomicalSection,
  buildReadoutSnapshot,
  STEATOSIS_BADGE_COLOR,
  type TFn,
} from '../acrAnatomicalMapping';
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
  stages: [],
  flr: null,
  segmentations: [],
  lesions: [],
  qc_flags: [],
  tenant_id: 't',
  updated_at: '2026-05-13T14:00:00Z',
};

describe('ANATOMICAL_SECTIONS', () => {
  it('has the fixed six-section order from data-model.md §2', () => {
    expect(ANATOMICAL_SECTIONS).toEqual([
      'liver',
      'lesions',
      'vessels',
      'gallbladder',
      'spleen',
      'flrAssessment',
    ]);
  });
});

describe('findingTypeToAnatomicalSection', () => {
  it.each([
    ['hu_stats', 'liver'],
    ['steatosis', 'liver'],
    ['spleen', 'spleen'],
    ['gallbladder', 'gallbladder'],
    ['calcified_lesions', 'lesions'],
    ['simple_biliary_cysts', 'lesions'],
    ['indeterminate_malignant', 'lesions'],
  ])('maps %s -> %s', (finding, section) => {
    expect(findingTypeToAnatomicalSection(finding)).toBe(section);
  });

  it('returns undefined for unknown types', () => {
    expect(findingTypeToAnatomicalSection('nonsense')).toBeUndefined();
  });
});

describe('STEATOSIS_BADGE_COLOR ported from FindingsCard.tsx', () => {
  it('matches FindingsCard verbatim mapping', () => {
    expect(STEATOSIS_BADGE_COLOR).toEqual({
      none: 'gray',
      mild: 'yellow',
      moderate: 'orange',
      severe: 'red',
    });
  });
});

describe('buildReadoutSnapshot', () => {
  it('produces 6 sections in fixed order even when findings are empty', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: baseSummary,
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    expect(snap.sections.map((s) => s.section)).toEqual([
      'liver',
      'lesions',
      'vessels',
      'gallbladder',
      'spleen',
      'flrAssessment',
    ]);
  });

  it('omits a steatosis row when grade === "none" (port of FindingsCard.tsx:153 rule)', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        findings: {
          steatosis: {
            grade: 'none',
            liver_mean_hu: 55,
            spleen_mean_hu: 50,
            liver_spleen_delta: 5,
            warnings: [],
            reference: 'r',
          },
        },
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const liver = snap.sections.find((s) => s.section === 'liver')!;
    expect(liver.rows.find((r) => r.key === 'steatosis')).toBeUndefined();
  });

  it('includes steatosis when grade != none', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        findings: {
          steatosis: {
            grade: 'moderate',
            liver_mean_hu: 35,
            spleen_mean_hu: 50,
            liver_spleen_delta: -15,
            warnings: [],
            reference: 'r',
          },
        },
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const liver = snap.sections.find((s) => s.section === 'liver')!;
    const st = liver.rows.find((r) => r.key === 'steatosis');
    expect(st).toBeDefined();
    expect(st!.badge?.color).toBe('orange');
  });

  it('marks computing sections when status is running', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: { ...baseSummary, status: 'running' },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    for (const s of snap.sections) {
      expect(s.status).toBe('computing');
    }
  });

  it('flags failed status as unavailable on empty sections', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: { ...baseSummary, status: 'failed' },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    for (const s of snap.sections) {
      expect(s.status).toBe('unavailable');
    }
  });

  it('sorts per-lesion rows by lesion id lexicographic (plaintext §5)', () => {
    const snap = buildReadoutSnapshot({
      reportSummary: {
        ...baseSummary,
        lesions: [
          { id: 'L3', bbox3d: null, longest_diameter_mm: 10, size_mm: 10, segment: 'II' },
          { id: 'L1', bbox3d: null, longest_diameter_mm: 89, size_mm: 89.6, segment: 'VIII' },
          { id: 'L2', bbox3d: null, longest_diameter_mm: 22, size_mm: 22.1, segment: 'IVa' },
        ],
      },
      locale: 'en',
      ruoDisclaimer: 'RUO',
      t: tFallback,
    });
    const lesions = snap.sections.find((s) => s.section === 'lesions')!;
    const ids = lesions.rows.filter((r) => r.key.startsWith('lesion-')).map((r) => r.itemId);
    expect(ids).toEqual(['L1', 'L2', 'L3']);
  });
});
