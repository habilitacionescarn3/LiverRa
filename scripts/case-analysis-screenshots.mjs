// Quick screenshot capture for AnalysisDetailView (case page).
// Usage: node scripts/case-analysis-screenshots.mjs <before|after>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const phase = process.argv[2] || 'before';
const OUT = `screenshots/case-analysis-${phase}`;
mkdirSync(OUT, { recursive: true });

const CASE_ID = '9221ce08-4b71-4e8c-9242-39282b6c6b9e';
const BASE = 'http://localhost:5173';

const viewports = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'tablet', w: 1024, h: 768 },
  { name: 'mobile', w: 390, h: 844 },
];

const browser = await chromium.launch();
try {
  // Try direct case URL first; if redirected to /cases (no case found), pick first case.
  for (const v of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: 1.5,
      colorScheme: 'light',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => console.error(`[pageerror ${v.name}]`, err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[console.error ${v.name}]`, msg.text());
    });

    // Always start from /cases and click "Open" on the first Completed row.
    await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    // Click first row / card with "Completed" status (desktop + mobile).
    const clicked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tr,[role="row"]'));
      for (const r of rows) {
        const txt = r.textContent || '';
        if (!txt.includes('Completed')) continue;
        const btn = r.querySelector('button,a[role="button"]');
        if (btn) { (btn).click(); return true; }
      }
      // Mobile / generic fallback: find any clickable element (cursor:pointer)
      const all = Array.from(document.querySelectorAll('div,article,li'));
      for (const el of all) {
        const cs = window.getComputedStyle(el);
        if (cs.cursor !== 'pointer') continue;
        const txt = el.textContent || '';
        if (!txt.includes('Completed')) continue;
        if (!/\d{8,}/.test(txt)) continue;
        if (el.children.length > 30) continue;
        (el).click();
        return true;
      }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(5000);
    } else {
      await page.goto(`${BASE}/cases/${CASE_ID}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
    // Wait for either the analysis root OR a fallback header.
    await page.waitForSelector('[data-testid="analysis-detail-root"], [data-testid="emr-page-header"]', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);

    const path = `${OUT}/${v.name}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`[OK] ${path}  (${v.w}x${v.h})`);

    // Full page version
    await page.screenshot({ path: `${OUT}/${v.name}-full.png`, fullPage: true });
    console.log(`[OK] ${OUT}/${v.name}-full.png`);

    await ctx.close();
  }

  // Theater-mode shot (desktop only) — only meaningful for AFTER.
  if (phase === 'after') {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      // Try table rows first (desktop)
      const rows = Array.from(document.querySelectorAll('tr,[role="row"]'));
      for (const r of rows) {
        const txt = r.textContent || '';
        if (!txt.includes('Completed')) continue;
        const btn = r.querySelector('button,a[role="button"]');
        if (btn) { (btn).click(); return true; }
      }
      // Mobile / generic fallback: find any clickable element (cursor:pointer)
      // whose direct text contains 'Completed' and a study UID-like number.
      const all = Array.from(document.querySelectorAll('div,article,li'));
      for (const el of all) {
        const cs = window.getComputedStyle(el);
        if (cs.cursor !== 'pointer') continue;
        const txt = el.textContent || '';
        if (!txt.includes('Completed')) continue;
        if (!/\d{8,}/.test(txt)) continue;
        if (el.children.length > 30) continue;
        (el).click();
        return true;
      }
      return false;
    });
    await page.waitForTimeout(5000);
    await page.waitForTimeout(1000);
    // Press F to enter theater mode
    await page.keyboard.press('f');
    await page.waitForTimeout(500);
    const path = `${OUT}/desktop-theater.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`[OK] ${path}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
