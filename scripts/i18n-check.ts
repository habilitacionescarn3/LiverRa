#!/usr/bin/env node
// T376 — i18n key coverage checker.
//
// Plain-English:
//   Walks every .ts / .tsx / .jsx / .js source file in packages/app/src,
//   finds calls that look like `t('some.key')` or `t("some.key")`, then
//   asserts that every distinct key exists in all three translation
//   bundles (en, de, ka). Missing keys fail the build so translators
//   never discover a gap in production.
//
// Usage:
//   npx tsx scripts/i18n-check.ts
//
// Exits 0 on full parity, 1 on any missing key.
//
// Notes:
//   - Russian is intentionally NOT checked (plan §i18n: en/de/ka only).
//   - Translation JSON is merged across all per-file bundles under
//     packages/app/src/emr/translations/<lang>/*.json — a key is
//     considered present if it resolves in the merged namespace tree.
//   - Keys built from template literals / variables are unanalysable
//     and are reported as `dynamic-unchecked` for maintainer review.
/* eslint-disable no-console */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_SRC = path.join(REPO_ROOT, 'packages', 'app', 'src');
const TRANSLATIONS_DIR = path.join(APP_SRC, 'emr', 'translations');
const LANGS = ['en', 'de', 'ka'] as const;
type Lang = (typeof LANGS)[number];

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.next',
  'playwright-report',
  'test-results',
]);

interface CallSite {
  file: string;
  line: number;
  column: number;
}

interface KeyOccurrence {
  key: string;
  sites: CallSite[];
  dynamic: boolean;
}

// ---------------------------------------------------------------------------
// Translation bundle loader
// ---------------------------------------------------------------------------

type JsonObject = { [k: string]: unknown };

function deepMerge(a: JsonObject, b: JsonObject): JsonObject {
  const out: JsonObject = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof prev === 'object' &&
      prev !== null &&
      !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as JsonObject, v as JsonObject);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function loadBundle(lang: Lang): Promise<JsonObject> {
  const dir = path.join(TRANSLATIONS_DIR, lang);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return {};
  }
  let merged: JsonObject = {};
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(dir, entry), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`[i18n-check] invalid JSON in ${lang}/${entry}: ${err}`);
      process.exit(1);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // The translation convention is `translations/<lang>/<namespace>.json`;
      // the namespace becomes the top-level key so that `t('common.save')`
      // resolves against common.json's `"save"` entry.
      const namespace = entry.replace(/\.json$/, '');
      merged = deepMerge(merged, { [namespace]: parsed as JsonObject });
    }
  }
  return merged;
}

function keyExistsInBundle(key: string, bundle: JsonObject): boolean {
  // Runtime supports both `ns.key.path` (dot-namespace) and `ns:key.path`
  // (colon-namespace) — see TranslationContext.splitKey(). Normalize to
  // dot form before walking the merged bundle.
  const parts = key.replace(':', '.').split('.');
  let node: unknown = bundle;
  for (const part of parts) {
    if (
      node !== null &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      part in (node as JsonObject)
    ) {
      node = (node as JsonObject)[part];
    } else {
      return false;
    }
  }
  return typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean';
}

// ---------------------------------------------------------------------------
// Source walker
// ---------------------------------------------------------------------------

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(full, acc);
    } else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// AST visitor — collect t('...') and t("...") string literal arguments.
// Any non-literal first argument is recorded as dynamic.
// ---------------------------------------------------------------------------

function collectKeys(filePath: string, source: string): KeyOccurrence[] {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const out: KeyOccurrence[] = [];
  const seen = new Map<string, CallSite[]>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isT =
        (ts.isIdentifier(callee) && callee.text === 't') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 't');
      if (isT && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        const { line, character } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
        const site: CallSite = { file: filePath, line: line + 1, column: character + 1 };
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          const key = arg.text;
          const prior = seen.get(key);
          if (prior) {
            prior.push(site);
          } else {
            seen.set(key, [site]);
          }
        } else {
          out.push({ key: '<dynamic>', sites: [site], dynamic: true });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  for (const [key, sites] of seen) {
    out.push({ key, sites, dynamic: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [enBundle, deBundle, kaBundle] = await Promise.all(LANGS.map(loadBundle));
  const bundles: Record<Lang, JsonObject> = {
    en: enBundle,
    de: deBundle,
    ka: kaBundle,
  };

  const files = await walk(APP_SRC);
  const allOccurrences: KeyOccurrence[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    if (!source.includes('t(')) continue;
    allOccurrences.push(...collectKeys(file, source));
  }

  const missing: { lang: Lang; key: string; site: CallSite }[] = [];
  const dynamicSites: CallSite[] = [];
  const staticKeys = new Set<string>();

  for (const occ of allOccurrences) {
    if (occ.dynamic) {
      dynamicSites.push(...occ.sites);
      continue;
    }
    staticKeys.add(occ.key);
    for (const lang of LANGS) {
      if (!keyExistsInBundle(occ.key, bundles[lang])) {
        for (const site of occ.sites) {
          missing.push({ lang, key: occ.key, site });
        }
      }
    }
  }

  console.log(
    `[i18n-check] scanned ${files.length} files; found ${staticKeys.size} distinct keys; ` +
      `${dynamicSites.length} dynamic call-sites.`,
  );

  if (dynamicSites.length > 0) {
    console.log(`[i18n-check] dynamic-unchecked call-sites (review manually):`);
    for (const s of dynamicSites.slice(0, 10)) {
      const rel = path.relative(REPO_ROOT, s.file);
      console.log(`  - ${rel}:${s.line}:${s.column}`);
    }
    if (dynamicSites.length > 10) {
      console.log(`  … and ${dynamicSites.length - 10} more`);
    }
  }

  if (missing.length > 0) {
    console.error(`[i18n-check] MISSING KEYS (${missing.length}):`);
    for (const m of missing) {
      const rel = path.relative(REPO_ROOT, m.site.file);
      console.error(`  - [${m.lang}] "${m.key}" (referenced at ${rel}:${m.site.line})`);
    }
    process.exit(1);
  }

  console.log('[i18n-check] OK — all translation keys resolve in en/de/ka');
}

main().catch((err) => {
  console.error('[i18n-check] fatal:', err);
  process.exit(1);
});
