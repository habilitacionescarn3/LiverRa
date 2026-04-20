import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1');
await page.waitForTimeout(1000);
await page.screenshot({ path: 'screenshots/landing/desktop-light-fullpage.png', fullPage: true });
await browser.close();
console.log('done');
