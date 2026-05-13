// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrPlainTextRenderer — pure transform: ReadoutSnapshot → plain text.
 *
 * Implements contracts/plaintext-renderer.md:
 *   - RUO disclaimer first AND last line
 *   - Fixed section order
 *   - Two-space indent for fields and per-item lists
 *   - Lists prefixed `  - ` with item id + segment + summary
 *   - Warnings prefixed `  ! ` indented under the field they describe
 *   - Stale markers `(last computed <ISO time>)`
 *   - NFC unicode normalization on every output string
 *   - No markdown / HTML characters
 *   - Deterministic; no Date.now / Math.random / UUID generation
 *
 * Twin: packages/ml-inference/src/services/export/acr_plaintext_renderer.py
 * The cross-channel parity test asserts byte-equivalent output between
 * the two implementations for the shared fixture corpus.
 */

import type { ReadoutSection, ReadoutSnapshot } from './acrAnatomicalMapping';

/**
 * Convert a snapshot into clipboard-ready plain text. The string is
 * already NFC-normalized; callers MAY pass it directly to
 * `navigator.clipboard.writeText`.
 */
export function renderReadoutPlainText(snapshot: ReadoutSnapshot): string {
  const lines: string[] = [];
  const ruoBanner = `--- ${snapshot.ruoDisclaimer.replace(/^---\s*|\s*---$/g, '')} ---`;
  lines.push(ruoBanner);
  lines.push('');

  snapshot.sections.forEach((section, idx) => {
    if (idx > 0) lines.push('');
    renderSection(section, lines);
  });

  lines.push('');
  lines.push(ruoBanner);

  const out = lines.join('\n');
  return out.normalize('NFC');
}

function renderSection(section: ReadoutSection, lines: string[]): void {
  lines.push(section.title);
  if (section.rows.length === 0) {
    const placeholder = section.emptyMessage ?? 'No findings to report.';
    lines.push(`  ${placeholder}`);
    return;
  }

  // Per-item lesion rows render as `- ID (segment N): summary`. Other
  // rows render as `Label: value`.
  for (const row of section.rows) {
    if (row.itemId) {
      const segment = row.segment ? ` (segment ${row.segment})` : '';
      const value = row.value ?? 'Not available';
      lines.push(`  - ${row.itemId}${segment}: ${value}`);
      if (row.stale) {
        lines.push(`    (last computed ${row.stale.computedAt})`);
      }
      if (row.warning) {
        lines.push(`  ! ${row.warning}`);
      }
      continue;
    }
    const value = row.value ?? 'Not available';
    const staleTail = row.stale ? ` (last computed ${row.stale.computedAt})` : '';
    lines.push(`  ${row.label}: ${value}${staleTail}`);
    if (row.warning) {
      lines.push(`  ! ${row.warning}`);
    }
  }
}
