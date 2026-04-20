/*
 * Slice-scroll latency — keydown-to-paint ≤100 ms p95.
 *
 * Plan §Load & performance · Tasks T368 · Spec §NFR-001.
 *
 * Measures the end-to-end latency from a key press (arrow up/down to change
 * slice) until the next paint timestamp. We sample 100 scroll events and
 * assert the 95th percentile is ≤100 ms.
 *
 * Methodology:
 *   1. Install a `requestAnimationFrame` observer that records paint timestamps.
 *   2. Dispatch `keydown` + `keyup` programmatically, capturing `performance.now()`.
 *   3. The next rAF callback whose timestamp is after the keydown is the "paint".
 *   4. Compute latency array, sort, pick p95.
 */

import { test, expect } from '@playwright/test';

const N_SAMPLES = 100;
const P95_MAX_MS = 100;

test.describe('Slice-scroll latency (NFR-001)', () => {
  test('p95 keydown-to-paint ≤100 ms', async ({ page }) => {
    await page.goto('/cases/demo-case-1');
    await page.waitForSelector('[data-testid="cornerstone-viewport"]', {
      timeout: 30000,
    });

    // Focus the viewport so keyboard events are routed to it.
    await page.click('[data-testid="cornerstone-viewport"]');

    const latencies = await page.evaluate(async (n) => {
      const results: number[] = [];

      function nextPaint(): Promise<number> {
        return new Promise((resolve) => {
          requestAnimationFrame((t) => resolve(t));
        });
      }

      // Warm up — two silent frames to settle any jank
      await nextPaint();
      await nextPaint();

      for (let i = 0; i < n; i++) {
        const key = i % 2 === 0 ? 'ArrowDown' : 'ArrowUp';
        const target =
          document.querySelector<HTMLElement>('[data-testid="cornerstone-viewport"]') ||
          document.body;
        const t0 = performance.now();
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        const painted = await nextPaint();
        results.push(painted - t0);
      }
      return results;
    }, N_SAMPLES);

    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const median = sorted[Math.floor(sorted.length * 0.5)];

    test.info().annotations.push({
      type: 'slice-scroll-latency',
      description: `median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms`,
    });

    expect(p95, `p95 keydown-to-paint ${p95.toFixed(1)}ms exceeds ${P95_MAX_MS}ms budget`).toBeLessThanOrEqual(P95_MAX_MS);
  });
});
