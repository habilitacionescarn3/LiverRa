import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const BASE = process.env.BASE || 'http://localhost:5174';
const ANALYSIS = '9d27ae93-86c1-44f6-b3b3-09228bae7118';
const OUT = '/tmp/phase1';
mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
let frames = 0;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
page.on('request', (r) => { if (/\/frames\//.test(r.url())) frames++; });

async function waitPlateau(label, maxMs = 40000) {
  let last = -1, stable = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(1500);
    if (frames === last) { stable++; if (stable >= 3) break; }
    else { stable = 0; last = frames; }
  }
  console.log(`[${label}] plateau at ${frames} frames (${((Date.now()-t0)/1000).toFixed(1)}s)`);
}

async function setView(mode) {
  const b = page.locator(`[data-testid="view-mode-${mode}"]`);
  if (await b.count()) { await b.first().click({ force: true }); return true; }
  return false;
}

await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('liverra:staging-auth', 'ok'));
await page.goto(`${BASE}/cases/${ANALYSIS}`, { waitUntil: 'domcontentloaded' });

await waitPlateau('initial-load');
await page.screenshot({ path: `${OUT}/01-loaded.png` });
const afterLoad = frames;

console.log('\n>>> switching layouts (CT should NOT re-download)');
await setView('axial'); await waitPlateau('axial'); await page.screenshot({ path: `${OUT}/02-axial.png` });
const afterAxial = frames;
await setView('mpr'); await waitPlateau('mpr-1'); await page.screenshot({ path: `${OUT}/03-mpr1.png` });
await setView('axial'); await waitPlateau('axial-2');
await setView('mpr'); await waitPlateau('mpr-2'); await page.screenshot({ path: `${OUT}/04-mpr2.png` });
const afterRoundtrips = frames;

console.log('\n========== PHASE 1 VERIFY ==========');
console.log('Frames after initial load   :', afterLoad);
console.log('Frames added on 1st switch  :', afterAxial - afterLoad);
console.log('Frames added on 4 switches  :', afterRoundtrips - afterLoad, '  (want ~0 = cached CT)');
console.log('Console errors              :', consoleErrors.length);
const unique = [...new Set(consoleErrors.map((e) => e.slice(0, 80)))];
unique.forEach((e) => console.log('  ERRTYPE:', e));
console.log('====================================');
await browser.close();
