// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrPlainTextRenderer.parity — feature 002-acr-structured-readout T078.
 *
 * TS-side companion to the Python parity test. Reads the shared
 * snapshot fixtures and asserts the TS plain-text output matches the
 * expected golden text files under
 * `packages/ml-inference/tests/fixtures/acr_snapshots/expected/`.
 *
 * Skipped (passes vacuously) when the expected/ directory hasn't been
 * generated yet — bootstrap step.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderReadoutPlainText } from '../acrPlainTextRenderer';
import { buildReadoutSnapshot, type TFn } from '../acrAnatomicalMapping';
import type { ReportSummary } from '../reportSummary';

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'ml-inference',
  'tests',
  'fixtures',
  'acr_snapshots',
);
const EXPECTED = join(FIXTURES, 'expected');

const tFallback: TFn = (_key, fallback) => fallback ?? _key;

const SCENARIOS = [
  'complete',
  'no_lesions',
  'degraded_spleen',
  'stale_finding',
  'partial_payload',
] as const;

describe('acrPlainTextRenderer parity', () => {
  if (!existsSync(EXPECTED)) {
    it.skip('expected/ golden text not yet authored', () => undefined);
    return;
  }

  for (const scenario of SCENARIOS) {
    it(`scenario=${scenario} matches golden text`, () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES, `${scenario}.json`), 'utf8'));
      const summary: ReportSummary = {
        analysis_id: fx.analysis_id,
        study_id: 's',
        patient_ref: null,
        status: fx.status ?? 'completed',
        started_at: null,
        completed_at: null,
        pipeline_version: null,
        stages: [],
        flr: fx.flr ?? null,
        segmentations: [],
        lesions: fx.lesions ?? [],
        qc_flags: [],
        tenant_id: fx.tenant_id,
        updated_at: fx.captured_at,
        findings: fx.findings,
      };
      const snap = buildReadoutSnapshot({
        reportSummary: summary,
        locale: fx.locale,
        ruoDisclaimer: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
        t: tFallback,
      });
      const expected = readFileSync(join(EXPECTED, `${scenario}.${fx.locale}.txt`), 'utf8');
      expect(renderReadoutPlainText(snap)).toBe(expected);
    });
  }
});
