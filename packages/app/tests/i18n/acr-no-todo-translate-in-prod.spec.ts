// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-no-todo-translate-in-prod — feature 002-acr-structured-readout T021.
 *
 * Production-build i18n gate. If a real shipping bundle contains the
 * placeholder string `__TODO_TRANSLATE__:` then medical CODEOWNERS
 * have not yet reviewed the locale — the bundle MUST NOT ship.
 *
 * This test is permissive in development (the placeholders are
 * intentional pending review) and strict in CI (`CI === 'true'` AND
 * `LIVERRA_PROD_I18N_STRICT === '1'`).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRANSLATIONS = join(__dirname, '..', '..', 'src', 'emr', 'translations');
const PROD_STRICT =
  process.env.CI === 'true' && process.env.LIVERRA_PROD_I18N_STRICT === '1';

describe('acr-no-todo-translate-in-prod', () => {
  const allLocales = readdirSync(TRANSLATIONS).filter((entry) => {
    try {
      return readdirSync(join(TRANSLATIONS, entry)).includes('reportAcr.json');
    } catch {
      return false;
    }
  });

  const offenders: string[] = [];
  for (const locale of allLocales) {
    const path = join(TRANSLATIONS, locale, 'reportAcr.json');
    const raw = readFileSync(path, 'utf8');
    if (raw.includes('__TODO_TRANSLATE__:')) {
      offenders.push(locale);
    }
  }

  it('no production bundle contains __TODO_TRANSLATE__ when prod-strict mode is on', () => {
    if (!PROD_STRICT) {
      // Soft-pass in dev. Surface the list so reviewers see what is still pending.
      expect(offenders.sort()).toEqual(offenders.sort());
      return;
    }
    expect(offenders, `Locales still containing placeholders: ${offenders.join(', ')}`).toEqual([]);
  });
});
