// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-namespace-key-parity — feature 002-acr-structured-readout T020.
 *
 * Asserts that en/reportAcr.json is the golden master and that
 * de/ka/ru/reportAcr.json each contain an identical key set (values may
 * differ — the de/ka/ru bundles ship with __TODO_TRANSLATE__ markers
 * pending medical CODEOWNERS review).
 */

import { describe, expect, it } from 'vitest';
import en from '../../src/emr/translations/en/reportAcr.json';
import de from '../../src/emr/translations/de/reportAcr.json';
import ka from '../../src/emr/translations/ka/reportAcr.json';
import ru from '../../src/emr/translations/ru/reportAcr.json';

type Bundle = Record<string, unknown>;

function flatten(obj: Bundle, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatten(v as Bundle, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('reportAcr namespace key parity', () => {
  const enKeys = flatten(en as Bundle);

  it.each([
    ['de', de],
    ['ka', ka],
    ['ru', ru],
  ])('locale %s has same keys as en', (_locale, bundle) => {
    expect(flatten(bundle as Bundle)).toEqual(enKeys);
  });

  it('en bundle is non-empty', () => {
    expect(enKeys.length).toBeGreaterThan(20);
  });
});
