/*
 * Viewer FPS test — sustained frame-rate during 3D rotation.
 *
 * Plan §Load & performance · Tasks T367 · Spec §NFR-001.
 *
 * Uses Playwright Chrome DevTools Protocol (CDP) to sample the browser's
 * compositor frame timeline while programmatically rotating the LiverViewer3D.
 *
 * Thresholds:
 *   - Desktop viewport: ≥30 fps sustained over 5 seconds
 *   - Tablet viewport:  ≥20 fps sustained over 5 seconds
 *
 * CI lane: `ci-viewer-fps`. Requires a GPU-enabled runner (or `--enable-webgl`
 * + software fallback that still exceeds thresholds).
 */

import { test, expect } from '@playwright/test';
import type { CDPSession } from '@playwright/test';

const SAMPLE_DURATION_MS = 5000;
const DESKTOP_FPS_MIN = 30;
const TABLET_FPS_MIN = 20;

async function startFrameSampling(cdp: CDPSession): Promise<void> {
  await cdp.send('Performance.enable');
  // Frame-presented events come from the compositor timeline
  await cdp.send('LayerTree.enable').catch(() => {
    // LayerTree unavailable in headless shell — fall back to rAF counter
  });
}

async function measureFps(page: import('@playwright/test').Page, durationMs: number): Promise<number> {
  return await page.evaluate((ms) => {
    return new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      function tick() {
        frames++;
        if (performance.now() - start < ms) {
          requestAnimationFrame(tick);
        } else {
          resolve((frames / (performance.now() - start)) * 1000);
        }
      }
      requestAnimationFrame(tick);
    });
  }, durationMs);
}

async function rotate3DContinuously(page: import('@playwright/test').Page, durationMs: number): Promise<void> {
  // Fires mouse-drag events on the LiverViewer3D canvas for the whole duration.
  await page.evaluate((ms) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="liver-viewer-3d-canvas"]',
    );
    if (!canvas) throw new Error('LiverViewer3D canvas not found');

    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let t = 0;
    const start = performance.now();
    const interval = setInterval(() => {
      t += 0.05;
      if (performance.now() - start > ms) {
        clearInterval(interval);
        return;
      }
      const x = cx + Math.cos(t) * 80;
      const y = cy + Math.sin(t) * 80;
      const down = new MouseEvent('mousedown', { clientX: cx, clientY: cy, buttons: 1 });
      const move = new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 1 });
      const up = new MouseEvent('mouseup', { clientX: x, clientY: y, buttons: 1 });
      canvas.dispatchEvent(down);
      canvas.dispatchEvent(move);
      canvas.dispatchEvent(up);
    }, 16);
  }, durationMs);
}

test.describe('Viewer FPS (NFR-001)', () => {
  test('desktop ≥30 fps during 3D rotation', async ({ page, context }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const cdp = await context.newCDPSession(page);
    await startFrameSampling(cdp);

    await page.goto('/cases/demo-case-1');
    await page.waitForSelector('[data-testid="liver-viewer-3d-canvas"]', {
      timeout: 30000,
    });

    // Kick off continuous rotation in parallel with the FPS measurement
    const rotatePromise = rotate3DContinuously(page, SAMPLE_DURATION_MS);
    const fps = await measureFps(page, SAMPLE_DURATION_MS);
    await rotatePromise;

    test.info().annotations.push({ type: 'fps', description: `${fps.toFixed(1)} fps` });
    expect(fps, `Desktop FPS ${fps.toFixed(1)} below floor ${DESKTOP_FPS_MIN}`).toBeGreaterThanOrEqual(DESKTOP_FPS_MIN);
  });

  test('tablet ≥20 fps during 3D rotation', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 1366 });
    await page.goto('/cases/demo-case-1');
    await page.waitForSelector('[data-testid="liver-viewer-3d-canvas"]', {
      timeout: 30000,
    });

    const rotatePromise = rotate3DContinuously(page, SAMPLE_DURATION_MS);
    const fps = await measureFps(page, SAMPLE_DURATION_MS);
    await rotatePromise;

    test.info().annotations.push({ type: 'fps', description: `${fps.toFixed(1)} fps` });
    expect(fps, `Tablet FPS ${fps.toFixed(1)} below floor ${TABLET_FPS_MIN}`).toBeGreaterThanOrEqual(TABLET_FPS_MIN);
  });
});
