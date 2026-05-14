#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * Quick i18n coverage tally. Counts:
 *   - total leaf keys in en/ (source of truth)
 *   - leaf keys present in ru/ka/de
 *   - of those, how many are still `__TODO_TRANSLATE__:` markers
 *
 * "Real coverage" = present AND not a marker. Used by Phase 4 audit
 * verification (CC-4).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const BASE = join(REPO, 'packages/app/src/emr/translations');

const TODO = '__TODO_TRANSLATE__:';

function countLeaves(obj, includeTodos = true, depth = 0) {
  if (obj === null || obj === undefined) return { total: 0, marker: 0 };
  if (typeof obj === 'string') {
    if (obj.startsWith(TODO)) return { total: 1, marker: 1 };
    return { total: 1, marker: 0 };
  }
  if (Array.isArray(obj)) {
    return obj.reduce(
      (a, b) => {
        const c = countLeaves(b);
        return { total: a.total + c.total, marker: a.marker + c.marker };
      },
      { total: 0, marker: 0 },
    );
  }
  if (typeof obj === 'object') {
    let total = 0;
    let marker = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (depth === 0 && k === '_meta') continue;
      const c = countLeaves(v, includeTodos, depth + 1);
      total += c.total;
      marker += c.marker;
    }
    return { total, marker };
  }
  return { total: 0, marker: 0 };
}

function statsFor(locale) {
  const dir = join(BASE, locale);
  if (!existsSync(dir)) return { files: 0, total: 0, marker: 0, real: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let total = 0;
  let marker = 0;
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const c = countLeaves(data);
    total += c.total;
    marker += c.marker;
  }
  return { files: files.length, total, marker, real: total - marker };
}

const locales = ['en', 'de', 'ka', 'ru'];
console.log('Locale | Files | Total leaves | Markers | Real (translated) | Coverage');
console.log('-------|-------|--------------|---------|-------------------|---------');
const en = statsFor('en');
for (const loc of locales) {
  const s = statsFor(loc);
  const pct = ((s.real / Math.max(1, en.total)) * 100).toFixed(1);
  console.log(
    `${loc}     | ${String(s.files).padStart(5)} | ${String(s.total).padStart(12)} | ${String(s.marker).padStart(7)} | ${String(s.real).padStart(17)} | ${pct}%`,
  );
}
