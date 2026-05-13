// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acr-translation-keys-cover-renderer — feature 002-acr-structured-readout T022.
 *
 * Greps every `t('reportAcr:...')` call site in the plain-text renderer
 * + anatomical mapping + section components and asserts each key
 * exists in en/reportAcr.json.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../src/emr/translations/en/reportAcr.json';

const ROOTS = [
  join(__dirname, '..', '..', 'src', 'emr', 'services', 'report'),
  join(__dirname, '..', '..', 'src', 'emr', 'components', 'report'),
  join(__dirname, '..', '..', 'src', 'emr', 'hooks'),
];

const TRANSLATION_KEY_RE = /t\(\s*['"`]reportAcr:([a-zA-Z0-9_.]+)['"`]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function keyExists(bundle: unknown, dottedKey: string): boolean {
  let current = bundle as Record<string, unknown> | undefined;
  for (const part of dottedKey.split('.')) {
    if (!current || typeof current !== 'object') return false;
    current = current[part] as Record<string, unknown> | undefined;
  }
  return current !== undefined;
}

describe('acr-translation-keys-cover-renderer', () => {
  it('every t(reportAcr:KEY) used in code exists in en/reportAcr.json', () => {
    const files = ROOTS.flatMap(walk);
    const referenced = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(TRANSLATION_KEY_RE)) {
        referenced.add(m[1]);
      }
    }

    const missing: string[] = [];
    for (const k of referenced) {
      if (!keyExists(en, k)) missing.push(k);
    }
    expect(missing, `Missing reportAcr keys in en bundle: ${missing.join(', ')}`).toEqual([]);
  });
});
