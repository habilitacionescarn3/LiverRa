import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.error('[err]', msg.text()); });
await page.goto('http://localhost:5173/cases', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const data = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
  const rows = Array.from(document.querySelectorAll('tr,[role="row"]')).map((r) => r.textContent?.trim().slice(0, 80));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => h.textContent?.trim());
  const bodyText = document.body.innerText.slice(0, 800);
  return { url: location.href, links, rows: rows.slice(0, 10), headings, bodyText };
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
