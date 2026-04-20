// Quick screenshot capture for LandingView.
// Usage: node scripts/landing-screenshots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'screenshots/landing';
mkdirSync(OUT, { recursive: true });

const viewports = [
  { name: 'desktop-light', w: 1440, h: 900, dark: false },
  { name: 'desktop-dark', w: 1440, h: 900, dark: true },
  { name: 'tablet-light', w: 834, h: 1112, dark: false },
  { name: 'mobile-light', w: 390, h: 844, dark: false },
];

const browser = await chromium.launch();
try {
  for (const v of viewports) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: 2,
      colorScheme: v.dark ? 'dark' : 'light',
    });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => console.error(`[pageerror ${v.name}]`, err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error(`[console.error ${v.name}]`, msg.text());
    });
    await page.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give React a moment to render.
    await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    if (v.dark) {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-mantine-color-scheme', 'dark');
      });
    } else {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
      });
    }
    await page.waitForTimeout(600);

    const path = `${OUT}/${v.name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`[OK] ${path}  (${v.w}x${v.h}${v.dark ? ', dark' : ''})`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
