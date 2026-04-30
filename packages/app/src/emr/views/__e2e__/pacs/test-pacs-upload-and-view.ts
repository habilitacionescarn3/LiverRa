/**
 * PACS upload-and-view E2E spec.
 *
 * Plain-language: a surgeon drops a real DICOM file onto the /pacs/studies
 * page. The browser uploads it to the local Orthanc via STOW-RS, the app
 * navigates to /pacs/studies/:uid, Cornerstone3D downloads pixels via
 * WADO-RS, and actual non-black content renders on the canvas. No AI
 * pipeline. No mocked backend. This is the "is the real PACS loop
 * actually working" guardrail.
 *
 * Gated behind PACS_E2E_ENABLED + the presence of fixtures/dicom/ — runs
 * opt-in because it needs a live Docker + Orthanc container. CI job
 * responsible for this spec must boot the compose stack before running.
 *
 * Prereqs:
 *   1. docker compose -f deploy/local/docker-compose.yml up -d postgres orthanc
 *   2. ./scripts/fetch-sample-dicom.sh  (populates fixtures/dicom/)
 *   3. VITE_LIVERRA_DEV_BYPASS=true     (lets ProtectedRoute pass in dev)
 *   4. PACS_E2E_ENABLED=true            (this spec stays dormant otherwise)
 */
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ORTHANC_URL = process.env.ORTHANC_URL ?? 'http://localhost:8042';
const ORTHANC_USER = process.env.ORTHANC_DEV_USER ?? 'orthanc';
const ORTHANC_PASS = process.env.ORTHANC_DEV_PASSWORD ?? 'orthanc';
const ENABLED = process.env.PACS_E2E_ENABLED === 'true';
const FIXTURE_DIR = resolve(process.cwd(), '../../fixtures/dicom');

// Top-level gate — the whole describe block skips cleanly when the
// prerequisites aren't met, so this spec is safe to include in CI lanes
// that don't boot the PACS stack.
test.describe('PACS: upload + view', () => {
  test.skip(!ENABLED, 'Set PACS_E2E_ENABLED=true to run. Requires a live Orthanc.');
  test.skip(!existsSync(FIXTURE_DIR), `Missing ${FIXTURE_DIR}. Run ./scripts/fetch-sample-dicom.sh first.`);

  const dcms = existsSync(FIXTURE_DIR)
    ? readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.dcm'))
    : [];
  test.skip(dcms.length === 0, 'No .dcm files in fixtures/dicom/.');

  // Before every test: confirm Orthanc responds. If not, skip (keeps the
  // spec resilient when the developer forgot to `docker compose up`).
  test.beforeEach(async ({ page }) => {
    const creds = Buffer.from(`${ORTHANC_USER}:${ORTHANC_PASS}`).toString('base64');
    const r = await page.request.get(`${ORTHANC_URL}/system`, {
      headers: { Authorization: `Basic ${creds}` },
    });
    test.skip(!r.ok(), 'Orthanc /system did not respond — skipping.');
  });

  test('drops a DICOM, navigates to the viewer, renders real pixels', async ({ page }) => {
    const fixture = resolve(FIXTURE_DIR, dcms[0]);

    // Capture browser console + errors for diagnostics when the canvas
    // stays black — otherwise we're flying blind.
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        // eslint-disable-next-line no-console
        console.log(`[browser:${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.log(`[browser:pageerror] ${err.message}`);
    });

    await page.goto('/pacs/studies');
    await expect(page.getByTestId('pacs-studies-view')).toBeVisible();

    // Upload the file through the Mantine Dropzone input.
    const fileInput = page.locator('[data-testid="pacs-dropzone"] input[type="file"]');
    await fileInput.setInputFiles(fixture);

    // Navigation to the viewer is async (STOW + metadata read). Allow up
    // to 30 s for the round-trip on a cold Orthanc.
    await page.waitForURL(/\/pacs\/studies\/[0-9.]+/, { timeout: 30_000 });
    await expect(page.getByTestId('pacs-study-viewer')).toBeVisible();

    // Cornerstone3D mounts its WebGL canvas inside our viewport div.
    // Wait until the loader overlay disappears and a canvas exists.
    const viewport = page.getByTestId('pacs-viewport');
    await expect(viewport).toBeVisible();
    await expect(viewport.locator('canvas').first()).toBeAttached({ timeout: 30_000 });

    // Cornerstone3D decodes pixels via web workers, so the canvas exists
    // *before* the first slice is painted. Poll for non-black pixels up to
    // the configured timeout — catches the whole class of bugs where
    // mounting worked but decoding / metadata failed, while tolerating
    // realistic decode latency (HTJ2K on CI can be a few seconds).
    await expect
      .poll(
        async () =>
          viewport.evaluate((el: HTMLElement) => {
            const canvas = el.querySelector('canvas');
            if (!canvas) return false;
            // Cornerstone3D uses a WebGL2 context by default. For WebGL we
            // have to read via gl.readPixels — `getContext('2d')` on an
            // already-GL canvas returns null. The `preserveDrawingBuffer`
            // flag matters here; Cornerstone3D enables it so readPixels
            // returns the last-rendered frame.
            try {
              const gl = (canvas.getContext('webgl2') ??
                canvas.getContext('webgl')) as WebGLRenderingContext | null;
              if (gl) {
                const w = Math.min(canvas.width, 256);
                const h = Math.min(canvas.height, 256);
                const buf = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                for (let i = 0; i < buf.length; i += 4) {
                  if (buf[i] > 5 || buf[i + 1] > 5 || buf[i + 2] > 5) return true;
                }
                return false;
              }
              const ctx = canvas.getContext('2d');
              if (!ctx) return false;
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              for (let i = 0; i < img.length; i += 4) {
                if (img[i] > 5 || img[i + 1] > 5 || img[i + 2] > 5) return true;
              }
              return false;
            } catch {
              return false;
            }
          }),
        {
          message: 'canvas stayed all-black — decode path is broken',
          timeout: 45_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBe(true);

    // Light interaction check — clicking the "liver" window preset should
    // not throw. We don't assert a specific pixel outcome because voiRange
    // maths depends on the file's modality LUT.
    await page.getByTestId('preset-liver').click();
    await expect(viewport).toBeVisible();
  });
});
