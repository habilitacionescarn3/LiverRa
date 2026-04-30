#!/usr/bin/env node
/**
 * One-off smoke test for LiverRa dev server at http://localhost:5173/.
 * Captures console errors, network failures, visible routes.
 * Not a CI artifact — temporary diagnostic.
 */
import { chromium } from 'playwright';

const BASE = process.env.LIVERRA_SMOKE_URL ?? 'http://localhost:5173';
const ROUTES = [
  '/',
  '/signin',
  '/onboarding',
  '/cases',
  '/ops/queue',
  '/help',
  '/help/glossary',
  '/profile',
  '/settings/notifications',
  '/admin/users',
  '/admin/pacs-config',
  '/admin/audit',
  '/compliance/audit-summary',
  '/compliance/mbom',
  '/compliance/claim-registry',
  '/compliance/ruo-spot-check',
  '/erasure',
  '/erasure/new',
  '/demo-case',
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const report = {};
for (const route of ROUTES) {
  const url = BASE + route;
  const entry = { consoleErrors: [], pageErrors: [], failedRequests: [], status: null, title: null };
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.removeAllListeners('requestfailed');
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter known-noisy Vite HMR messages
      if (!text.includes('[vite]') && !text.includes('HMR')) entry.consoleErrors.push(text.slice(0, 300));
    }
  });
  page.on('pageerror', (err) => entry.pageErrors.push(String(err).slice(0, 300)));
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.startsWith('data:') && !url.includes('hot-update')) {
      entry.failedRequests.push({ url: url.slice(0, 200), error: req.failure()?.errorText });
    }
  });
  page.on('response', (resp) => {
    if (resp.status() >= 400 && !resp.url().includes('hot-update')) {
      entry.failedRequests.push({ url: resp.url().slice(0, 250), error: `HTTP ${resp.status()}` });
    }
  });
  try {
    const resp = await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    entry.status = resp?.status() ?? null;
    await page.waitForTimeout(3000);
    entry.title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 160));
    entry.bodyPreview = bodyText;
  } catch (err) {
    entry.loadError = String(err).slice(0, 200);
  }
  report[route] = entry;
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
