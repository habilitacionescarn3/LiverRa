#!/usr/bin/env npx tsx
/**
 * Playwright Background Server (HTTP)
 *
 * Keeps a browser instance alive and accepts commands over HTTP on port 2400.
 * The browser stays open between commands — perfect for interactive debugging.
 *
 * Usage:
 *   npx tsx scripts/playwright/server.ts &
 *   sleep 3
 *   npx tsx scripts/playwright/cmd.ts navigate "http://example.com"
 *   npx tsx scripts/playwright/cmd.ts screenshot "my-page"
 *   npx tsx scripts/playwright/cmd.ts stop
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = parseInt(process.env.PORT || '2400', 10);
const HEADLESS = process.env.HEADLESS === 'true';
// Bind 0.0.0.0 inside Docker so host port-forwarding works; keep localhost-only on dev machines.
const BIND_HOST = process.env.BIND_HOST || (HEADLESS ? '0.0.0.0' : '127.0.0.1');
const PID_FILE = path.join(os.tmpdir(), 'playwright-server.pid');
const USER_DATA_DIR = path.join(os.tmpdir(), 'playwright-user-data');
const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

// Multiple browser contexts for parallel agents
const contexts = new Map<string, { context: BrowserContext; page: Page }>();

let defaultContext: BrowserContext | null = null;
let defaultPage: Page | null = null;
let browser: Browser | null = null; // Separate browser for named contexts

// Contexts matching this prefix have their cookies/localStorage persisted to disk,
// so re-creating after an idle close doesn't require logging in again.
const PERSISTED_CONTEXT_PREFIX = 'casemoh';
function storageStatePath(name: string): string {
  return path.join(os.tmpdir(), `playwright-state-${name}.json`);
}

async function getPageForContext(name: string): Promise<Page> {
  if (name === 'default') return defaultPage!;
  const entry = contexts.get(name);
  if (entry) return entry.page;
  // Auto-create named context on first use
  if (!browser) throw new Error('Browser not initialized for named contexts');
  console.error(`Creating named context: ${name}`);

  // If we have a saved session for this context, reuse it (skips login).
  const persist = name.startsWith(PERSISTED_CONTEXT_PREFIX);
  const statePath = storageStatePath(name);
  const contextOpts: any = {
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  };
  if (persist && fs.existsSync(statePath)) {
    try {
      contextOpts.storageState = statePath;
      console.error(`Loading persisted storage state for ${name}`);
    } catch {
      /* ignore corrupted state */
    }
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Speed up bot lookups: block cosmetic resources the bot doesn't need.
  // (Stylesheets and scripts are NOT blocked — the form depends on them.)
  if (name === 'casemoh') {
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        return route.abort();
      }
      return route.continue();
    });
  }

  contexts.set(name, { context, page });
  return page;
}

async function persistAndCloseContext(name: string, entry: { context: BrowserContext; page: Page }): Promise<void> {
  // Save storage state before closing (best-effort) so next creation skips login.
  if (name.startsWith(PERSISTED_CONTEXT_PREFIX)) {
    try {
      await entry.context.storageState({ path: storageStatePath(name) });
      console.error(`Persisted storage state for ${name}`);
    } catch (err) {
      // Fail silently — persistence is an optimization, not a correctness requirement.
      console.error(`Failed to persist state for ${name}:`, err);
    }
  }
  await entry.context.close();
}

async function closeAllNamedContexts(): Promise<void> {
  for (const [name, entry] of contexts) {
    try {
      await persistAndCloseContext(name, entry);
      console.error(`Closed named context: ${name}`);
    } catch { /* ignore */ }
  }
  contexts.clear();
}

async function processCommand(action: string, args: string[], contextName: string): Promise<any> {
  // close-context doesn't need a page
  if (action === 'close-context') {
    const name = args[0] || contextName;
    const entry = contexts.get(name);
    if (!entry) return { name, closed: false, reason: 'not found' };
    await persistAndCloseContext(name, entry);
    contexts.delete(name);
    console.error(`Closed named context: ${name}`);
    return { name, closed: true };
  }

  const page = await getPageForContext(contextName);

  switch (action) {
    case 'navigate': {
      const url = args[0];
      if (!url) throw new Error('URL required');
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      return { url: page.url(), title: await page.title() };
    }

    case 'fill': {
      const [selector, value] = args;
      if (!selector || value === undefined) throw new Error('Selector and value required');
      await page.fill(selector, value, { timeout: 10000 });
      return { selector, filled: true };
    }

    case 'click': {
      const selector = args[0];
      const isDouble = args.includes('--double');
      const isForce = args.includes('--force');
      if (!selector) throw new Error('Selector required');
      if (isDouble) {
        await page.dblclick(selector, { timeout: 10000, force: isForce });
      } else {
        await page.click(selector, { timeout: 10000, force: isForce });
      }
      return { selector, clicked: true, double: isDouble, force: isForce };
    }

    case 'screenshot': {
      const name = args[0] || `screenshot-${Date.now()}`;
      const fullPage = args.includes('--fullpage');
      if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      }
      const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
      await page.screenshot({ path: filePath, fullPage });
      return { path: filePath, name };
    }

    case 'wait': {
      const ms = parseInt(args[0] || '1000');
      await new Promise(resolve => setTimeout(resolve, ms));
      return { waited: ms };
    }

    case 'waitfor': {
      const selector = args[0];
      const timeout = parseInt(args[1] || '30000');
      const stateArg = args[2];
      const state = (stateArg === 'attached' || stateArg === 'hidden' || stateArg === 'detached')
        ? stateArg
        : 'visible';
      if (!selector) throw new Error('Selector required');
      await page.waitForSelector(selector, { timeout, state });
      return { selector, found: true, state };
    }

    case 'waitforfunction': {
      const expr = args[0];
      const timeout = parseInt(args[1] || '30000');
      if (!expr) throw new Error('Expression required');
      // Poll the browser every 100ms until the expression is truthy.
      // Expression is evaluated in the page context.
      await page.waitForFunction(expr, undefined, { timeout, polling: 100 });
      return { found: true };
    }

    case 'text': {
      const selector = args[0];
      if (!selector) throw new Error('Selector required');
      const text = await page.textContent(selector, { timeout: 10000 });
      return { selector, text };
    }

    case 'url': {
      return { url: page.url() };
    }

    case 'viewport': {
      const width = parseInt(args[0] || '1280');
      const height = parseInt(args[1] || '720');
      await page.setViewportSize({ width, height });
      return { width, height };
    }

    case 'select': {
      const [selector, value] = args;
      if (!selector || value === undefined) throw new Error('Selector and value required');
      await page.click(selector, { timeout: 10000 });
      await page.waitForTimeout(500);
      await page.locator('.mantine-Select-option').filter({ hasText: value }).first().click({ timeout: 10000 });
      return { selector, value, selected: true };
    }

    case 'press': {
      const key = args[0];
      if (!key) throw new Error('Key required (e.g., Enter, Escape, Tab)');
      await page.keyboard.press(key);
      return { key, pressed: true };
    }

    case 'type': {
      const [selector, text] = args;
      if (!selector || text === undefined) throw new Error('Selector and text required');
      await page.locator(selector).first().pressSequentially(text, { delay: 80 });
      return { selector, typed: true, text };
    }

    case 'count': {
      const selector = args[0];
      if (!selector) throw new Error('Selector required');
      const count = await page.locator(selector).count();
      return { selector, count };
    }

    case 'exists': {
      const selector = args[0];
      if (!selector) throw new Error('Selector required');
      const count = await page.locator(selector).count();
      return { selector, exists: count > 0, count };
    }

    case 'html': {
      const selector = args[0];
      if (!selector) throw new Error('Selector required');
      const html = await page.locator(selector).first().innerHTML({ timeout: 10000 });
      return { selector, html };
    }

    case 'clear': {
      const selector = args[0];
      if (!selector) throw new Error('Selector required');
      await page.locator(selector).first().clear({ timeout: 10000 });
      return { selector, cleared: true };
    }

    case 'selectOption': {
      const [selector, value] = args;
      if (!selector || value === undefined) throw new Error('Selector and value required');
      await page.selectOption(selector, value, { timeout: 10000 });
      return { selector, value, selected: true };
    }

    case 'evaluate': {
      const script = args[0];
      if (!script) throw new Error('Script required');
      const result = await page.evaluate(script);
      return { result };
    }

    case 'wheel': {
      const x = parseInt(args[0] || '640', 10);
      const y = parseInt(args[1] || '400', 10);
      const deltaY = parseInt(args[2] || '500', 10);
      await page.mouse.move(x, y);
      await page.mouse.wheel(0, deltaY);
      return { x, y, deltaY, wheeled: true };
    }

    case 'login': {
      const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
      const portalType = (args[0] || 'staff').toLowerCase();

      // DEV-ONLY defaults — not production credentials. See CLAUDE.md for context.
      const defaults: Record<string, { email: string; password: string }> = {
        staff: { email: 'admin@medimind.ge', password: 'MediMind2024' },
        portal: { email: 'einelasha@gmail.com', password: 'Dba545c5fde36242@@' },
      };

      const creds = defaults[portalType] || defaults.staff;
      const email = args[1] || creds.email;
      const password = args[2] || creds.password;

      if (portalType === 'portal') {
        // Portal: single-step login (email + password on same form)
        await page.goto(`${BASE_URL}/portal/login`, { waitUntil: 'load', timeout: 30000 });

        // Wait for form or detect already logged in
        try {
          await page.waitForSelector('input[placeholder="patient@example.com"]', { timeout: 5000 });
        } catch {
          return { portalType, alreadyLoggedIn: true, url: page.url() };
        }

        await page.fill('input[placeholder="patient@example.com"]', email, { timeout: 10000 });
        await page.fill('input[placeholder="••••••••"]', password, { timeout: 10000 });
        await page.click('button[type="submit"]', { timeout: 10000 });
        await page.waitForURL('**/portal/dashboard**', { timeout: 30000 });

        return { portalType, loggedIn: true, url: page.url() };
      } else {
        // Pre-set English language BEFORE navigating so we avoid a reload later
        await page.goto(`${BASE_URL}/signin`, { waitUntil: 'load', timeout: 30000 });
        await page.evaluate(() => localStorage.setItem('emrLanguage', 'en'));

        // Wait for email input or detect already logged in
        try {
          await page.waitForSelector('input[placeholder="name@domain.com"]', { timeout: 5000 });
        } catch {
          return { portalType: 'staff', alreadyLoggedIn: true, url: page.url() };
        }

        // Step 1: Email
        await page.fill('input[placeholder="name@domain.com"]', email, { timeout: 10000 });
        await page.click('button:has-text("Next")', { timeout: 10000 });

        // Step 2: Wait for password field, then fill and submit
        await page.waitForSelector('input[placeholder="Enter your password"]', { timeout: 10000 });
        await page.fill('input[placeholder="Enter your password"]', password, { timeout: 10000 });
        await page.click('button:has-text("Sign In")', { timeout: 10000 });

        // Wait for authenticated redirect
        await page.waitForURL('**/emr/**', { timeout: 30000 });

        // Wait for the main app to be interactive (a real element, not an arbitrary timeout)
        await page.waitForSelector('[class*="TopNavBar"], [class*="EMRMainMenu"], nav, header', { timeout: 10000 });

        return { portalType: 'staff', loggedIn: true, url: page.url() };
      }
    }

    case 'setOffline': {
      const offline = args[0] === 'true' || args[0] === true;
      const context = page.context();
      await context.setOffline(offline);
      return { success: true, offline };
    }

    case 'stop': {
      // Graceful shutdown — handled after response is sent
      return { stopped: true };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function main(): Promise<void> {
  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const existingPid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(existingPid), 0);
      console.error(`Server already running (PID: ${existingPid})`);
      process.exit(0);
    } catch {
      fs.unlinkSync(PID_FILE);
    }
  }

  console.error('Starting Playwright Background Server...');
  fs.writeFileSync(PID_FILE, process.pid.toString());

  // Ensure directories exist
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  // Launch browser with persistent context (stays open between commands)
  defaultContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const pages = defaultContext.pages();
  defaultPage = pages.length > 0 ? pages[0] : await defaultContext.newPage();

  // Separate browser instance for named contexts (parallel QA agents)
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  // HTTP server — accepts commands from cmd.ts
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { action, args = [], context: ctxName = 'default' } = JSON.parse(body);
        const data = await processCommand(action, args, ctxName);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));

        // Handle stop after response is sent
        if (action === 'stop') {
          setTimeout(async () => {
            console.error('Stopping server...');
            server.close();
            await closeAllNamedContexts();
            if (browser) await browser.close();
            if (defaultContext) await defaultContext.close();
            if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
            console.error('Server stopped.');
            process.exit(0);
          }, 200);
        }
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use — another server instance is running.`);
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      process.exit(0);
    }
    throw err;
  });

  server.listen(PORT, BIND_HOST, () => {
    console.error(`Browser ready (headless=${HEADLESS}). HTTP server listening on http://${BIND_HOST}:${PORT}`);
    console.error(`PID: ${process.pid}`);
  });
}

process.on('SIGINT', async () => {
  await closeAllNamedContexts();
  if (browser) await browser.close();
  if (defaultContext) await defaultContext.close();
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeAllNamedContexts();
  if (browser) await browser.close();
  if (defaultContext) await defaultContext.close();
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  process.exit(0);
});

main().catch(error => {
  console.error('Server error:', error);
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  process.exit(1);
});
