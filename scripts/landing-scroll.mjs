import { chromium } from 'playwright';
const browser = await chromium.launch();

for (const dark of [false, true]) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:3001/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1');

  if (dark) {
    await page.evaluate(() =>
      document.documentElement.setAttribute('data-mantine-color-scheme', 'dark'),
    );
  }
  await page.waitForTimeout(600);

  // Find the scrollable inner container: EMRPage puts content in a div that scrolls.
  const scrollableHandle = await page.evaluateHandle(() => {
    // Walk down from body and find the deepest scrollable ancestor of the <h1>.
    const h1 = document.querySelector('h1');
    let el = h1;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement;
  });
  // Get scrollHeight of that element.
  const metrics = await page.evaluate((el) => ({
    sh: el.scrollHeight,
    ch: el.clientHeight,
    tag: el.tagName,
    cls: el.className?.toString?.().slice(0, 80),
  }), scrollableHandle);
  console.log(dark ? 'dark' : 'light', metrics);

  // Scroll the top so we capture hero, and then scroll to bottom for admin+footer.
  await page.screenshot({
    path: `screenshots/landing/desktop-${dark ? 'dark' : 'light'}-top.png`,
  });

  await page.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }), scrollableHandle);
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `screenshots/landing/desktop-${dark ? 'dark' : 'light'}-bottom.png`,
  });

  await ctx.close();
}
await browser.close();
console.log('done');
