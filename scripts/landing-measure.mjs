import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('h1');
await page.waitForTimeout(1500);

const sizes = await page.evaluate(() => ({
  docHeight: document.documentElement.scrollHeight,
  bodyHeight: document.body.scrollHeight,
  rootHeight: document.getElementById('root')?.scrollHeight ?? null,
  sections: Array.from(document.querySelectorAll('section, header, footer')).map((el) => ({
    tag: el.tagName,
    cls: el.className?.toString?.().slice(0, 50),
    top: el.getBoundingClientRect().top + window.scrollY,
    height: el.getBoundingClientRect().height,
  })),
}));
console.log(JSON.stringify(sizes, null, 2));
await browser.close();
