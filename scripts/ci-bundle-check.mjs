#!/usr/bin/env node
// @ts-check
/**
 * ci-bundle-check.mjs — Bundle-size budget enforcer for LiverRa (T403)
 *
 * Reads `packages/app/dist/stats.json` produced by rollup-plugin-visualizer
 * (configured with `json: true`), computes gzip size per logical chunk, and
 * enforces the plan §Bundle budget:
 *
 *   - Initial JS (entry chunks + their sync deps):         ≤ 350 KB gzip
 *   - Viewer chunk (OHIF/Cornerstone route-lazy bundle):   ≤ 2   MB gzip
 *   - Admin / Ops / Compliance route chunks (each):        ≤ 200 KB gzip
 *
 * Outputs a Markdown table to stdout, to $GITHUB_STEP_SUMMARY, and to
 * ./bundle-report.md (consumed by peter-evans/create-or-update-comment).
 * Compares against `packages/app/baseline-stats.json` if present.
 *
 * Exit code: 0 on pass, 1 on any budget violation.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const STATS_PATH = resolve(ROOT, 'packages/app/dist/stats.json');
const BASELINE_PATH = resolve(ROOT, 'packages/app/baseline-stats.json');
const REPORT_PATH = resolve(ROOT, 'bundle-report.md');

// Budgets in bytes (gzip).
const BUDGETS = {
  initial: 350 * 1024,
  viewer: 2 * 1024 * 1024,
  admin: 200 * 1024,
  ops: 200 * 1024,
  compliance: 200 * 1024,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {number} bytes */
const fmt = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

/** @param {number} delta */
const fmtDelta = (delta) => {
  if (delta === 0) return '±0';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${fmt(Math.abs(delta))}`;
};

/**
 * Categorise a chunk by its filename / route-lazy segment name.
 * @param {string} name
 * @returns {'initial'|'viewer'|'admin'|'ops'|'compliance'|'other'}
 */
function categorise(name) {
  const n = name.toLowerCase();
  if (/\b(index|main|entry|app)\b/.test(n) && !/chunk|async|lazy/.test(n)) return 'initial';
  if (/viewer|ohif|cornerstone|dicom/.test(n)) return 'viewer';
  if (/admin/.test(n)) return 'admin';
  if (/\bops\b|operations/.test(n)) return 'ops';
  if (/compliance|audit|gdpr/.test(n)) return 'compliance';
  return 'other';
}

/**
 * Normalise rollup-plugin-visualizer `json` output into an array of
 * { name, gzipSize } rows. visualizer's `tree` shape is recursive; we flatten
 * and sum at leaf level. If the stats file already contains a flat `nodeParts`
 * map (newer visualizer), we use that directly.
 *
 * @param {any} stats
 * @returns {{ name: string, gzipSize: number, rawSize: number }[]}
 */
function flattenStats(stats) {
  /** @type {{ name: string, gzipSize: number, rawSize: number }[]} */
  const out = [];

  // Newer visualizer: { nodeParts: { [uid]: { gzipLength, renderedLength } }, nodeMetas: { [uid]: { id } } }
  if (stats.nodeParts && stats.nodeMetas) {
    /** @type {Record<string, { gzip: number, raw: number }>} */
    const perChunk = {};
    for (const [uid, part] of Object.entries(stats.nodeParts)) {
      const meta = stats.nodeMetas[uid];
      if (!meta) continue;
      // Visualizer stores per-module. Group by the importing chunk (first segment).
      const id = /** @type {string} */ (meta.id || uid);
      const chunk = id.split(/[\\/]/).pop() || id;
      const p = /** @type {any} */ (part);
      if (!perChunk[chunk]) perChunk[chunk] = { gzip: 0, raw: 0 };
      perChunk[chunk].gzip += Number(p.gzipLength || 0);
      perChunk[chunk].raw += Number(p.renderedLength || 0);
    }
    for (const [name, sizes] of Object.entries(perChunk)) {
      out.push({ name, gzipSize: sizes.gzip, rawSize: sizes.raw });
    }
    return out;
  }

  // Classic visualizer tree or Rollup's own `output` bundle map.
  if (Array.isArray(stats)) {
    for (const entry of stats) {
      if (entry?.fileName && typeof entry.code === 'string') {
        const gz = gzipSync(Buffer.from(entry.code)).length;
        out.push({ name: entry.fileName, gzipSize: gz, rawSize: entry.code.length });
      }
    }
    return out;
  }

  /** @param {any} node */
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
      return;
    }
    const name = node.name || node.id;
    const gz = Number(node.gzipSize || node.gzipLength || 0);
    const raw = Number(node.size || node.renderedLength || 0);
    if (name && gz > 0) out.push({ name, gzipSize: gz, rawSize: raw });
  };
  walk(stats.tree || stats);
  return out;
}

// ---------------------------------------------------------------------------
// Load stats
// ---------------------------------------------------------------------------

if (!existsSync(STATS_PATH)) {
  console.error(`::error::Missing ${STATS_PATH}. Run the app build with rollup-plugin-visualizer (json mode) first.`);
  process.exit(1);
}

const stats = JSON.parse(readFileSync(STATS_PATH, 'utf8'));
const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  : null;

const rows = flattenStats(stats);
const baseRows = baseline ? flattenStats(baseline) : [];

/** @type {Record<string, number>} */
const baseByName = Object.create(null);
for (const r of baseRows) baseByName[r.name] = (baseByName[r.name] || 0) + r.gzipSize;

// ---------------------------------------------------------------------------
// Aggregate by category
// ---------------------------------------------------------------------------

/** @type {Record<string, { gzip: number, chunks: string[] }>} */
const byCategory = {
  initial: { gzip: 0, chunks: [] },
  viewer: { gzip: 0, chunks: [] },
  admin: { gzip: 0, chunks: [] },
  ops: { gzip: 0, chunks: [] },
  compliance: { gzip: 0, chunks: [] },
  other: { gzip: 0, chunks: [] },
};

for (const r of rows) {
  const cat = categorise(r.name);
  byCategory[cat].gzip += r.gzipSize;
  byCategory[cat].chunks.push(r.name);
}

// ---------------------------------------------------------------------------
// Evaluate budgets
// ---------------------------------------------------------------------------

/** @type {{ category: string, size: number, budget: number, pass: boolean, delta: number }[]} */
const results = [];

for (const key of /** @type {(keyof typeof BUDGETS)[]} */ (Object.keys(BUDGETS))) {
  const size = byCategory[key].gzip;
  const budget = BUDGETS[key];
  // Compute a category-level baseline by summing baseline chunks matching the same category.
  let basePrev = 0;
  for (const [name, gz] of Object.entries(baseByName)) {
    if (categorise(name) === key) basePrev += gz;
  }
  // For admin/ops/compliance we enforce "any single chunk" budget:
  let pass;
  if (key === 'admin' || key === 'ops' || key === 'compliance') {
    const worst = rows
      .filter((r) => categorise(r.name) === key)
      .reduce((m, r) => Math.max(m, r.gzipSize), 0);
    pass = worst <= budget;
  } else {
    pass = size <= budget;
  }
  results.push({
    category: key,
    size,
    budget,
    pass,
    delta: basePrev ? size - basePrev : 0,
  });
}

// ---------------------------------------------------------------------------
// Render report
// ---------------------------------------------------------------------------

const lines = [];
lines.push('## Bundle size budget report');
lines.push('');
lines.push('| Category | Size (gzip) | Budget | Status | Δ vs baseline |');
lines.push('|---|---:|---:|:---:|---:|');
for (const r of results) {
  const status = r.pass ? '✅ pass' : '❌ fail';
  lines.push(
    `| \`${r.category}\` | ${fmt(r.size)} | ${fmt(r.budget)} | ${status} | ${
      baseline ? fmtDelta(r.delta) : 'n/a'
    } |`,
  );
}
lines.push('');
lines.push('<details><summary>Per-chunk breakdown</summary>');
lines.push('');
lines.push('| Chunk | Category | Size (gzip) | Δ |');
lines.push('|---|---|---:|---:|');
for (const r of rows.sort((a, b) => b.gzipSize - a.gzipSize).slice(0, 40)) {
  const delta = baseByName[r.name] ? r.gzipSize - baseByName[r.name] : 0;
  lines.push(
    `| \`${r.name}\` | ${categorise(r.name)} | ${fmt(r.gzipSize)} | ${baseline ? fmtDelta(delta) : 'n/a'} |`,
  );
}
lines.push('');
lines.push('</details>');
lines.push('');
lines.push(
  '_Budgets: initial ≤ 350 KB · viewer ≤ 2 MB · admin/ops/compliance ≤ 200 KB (each chunk) · gzip._',
);

const report = lines.join('\n');
console.log(report);
writeFileSync(REPORT_PATH, report);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(
    `::error::Bundle budget exceeded for: ${failed.map((f) => f.category).join(', ')}`,
  );
  process.exit(1);
}
process.exit(0);
