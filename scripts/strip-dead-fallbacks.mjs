#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * Strip dead `t(key, 'English fallback')` patterns from acrAnatomicalMapping.ts.
 *
 * The LiverRa t() signature is `(key: string, params?: Record<string, unknown>) => string`.
 * Passing a string literal as the 2nd arg is a type lie — the i18n system has
 * its own fallback chain (locale → en → __TODO_TRANSLATE__-strip → raw key).
 * The literal is silently discarded at runtime.
 *
 * Audit reference: M-I18NLIT-2 in 2026-05-14 EMR audit.
 *
 * Operates on a single file (the audit-named one); safe to re-run.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = '/Users/toko/Desktop/LiverRa/packages/app/src/emr/services/report/acrAnatomicalMapping.ts';

const src = readFileSync(FILE, 'utf8');
let count = 0;

// Match `t(' or t(` followed by a quoted key, optional spaces, comma, then a
// quoted string fallback, then `)`. Keep the key, drop the fallback.
//
// Two cases observed in the file:
//   t('reportAcr:key', 'fallback')        — single quotes
//   t(`reportAcr:key`, 'fallback')        — template-literal key
//
// We allow only string-literal fallbacks (no template literals on the right
// side — those carry computed values and must stay). Plain regex captures the
// key, then a literal-quoted fallback.
const out = src.replace(
  // group 1: the t() call up through the key + closing key-quote
  // (1st arg may use single, double, or backtick — backticks may contain `${}`)
  /\bt\(\s*([`'"][^`'"]*[`'"])\s*,\s*'((?:\\'|[^'])*)'\s*\)/g,
  (match, keyExpr) => {
    count++;
    return `t(${keyExpr})`;
  },
);

if (count > 0) {
  writeFileSync(FILE, out, 'utf8');
  console.log(`Stripped ${count} dead t(key, 'fallback') patterns in ${FILE}`);
} else {
  console.log('No dead-fallback patterns found.');
}
