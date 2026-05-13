#!/usr/bin/env npx tsx
/**
 * Send command to Playwright HTTP Server
 *
 * Usage:
 *   npx tsx scripts/playwright/cmd.ts navigate "http://example.com"
 *   npx tsx scripts/playwright/cmd.ts --context agent02 navigate "http://example.com"
 *   npx tsx scripts/playwright/cmd.ts fill "#username" "admin"
 *   npx tsx scripts/playwright/cmd.ts click "button[type=submit]"
 *   npx tsx scripts/playwright/cmd.ts screenshot "after-login"
 *   npx tsx scripts/playwright/cmd.ts wait 2000
 *   npx tsx scripts/playwright/cmd.ts waitfor ".dashboard"
 *   npx tsx scripts/playwright/cmd.ts url
 *   npx tsx scripts/playwright/cmd.ts stop
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

const PORT = 2400;
const PID_FILE = path.join(os.tmpdir(), 'playwright-server.pid');

// Commands that get one automatic retry on failure
const RETRYABLE_ACTIONS = new Set(['click', 'fill', 'waitfor']);

interface ServerResponse {
  success: boolean;
  data?: any;
  error?: string;
}

function sendCommand(action: string, args: string[], context: string): Promise<ServerResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, args, context });

    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 35000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid server response: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Cannot connect to server: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);

  // Parse --context flag
  let context = 'default';
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--context' && i + 1 < rawArgs.length) {
      context = rawArgs[++i];
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  if (filteredArgs.length === 0) {
    console.log(`
Playwright Command Client (HTTP)

Usage:
  npx tsx scripts/playwright/cmd.ts [--context name] <action> [args...]

Options:
  --context name    Use a named browser context (default: "default")

Actions:
  navigate <url>           Navigate to URL
  fill <selector> <value>  Fill input field
  click <selector>         Click element
  screenshot <name>        Take screenshot
  wait <ms>                Wait milliseconds
  waitfor <selector>       Wait for element
  text <selector>          Get text content
  url                      Get current URL
  evaluate <script>        Run JavaScript
  viewport <width> <height>  Set viewport size
  select <selector> <value>  Pick option from Mantine Select dropdown
  press <key>              Press keyboard key (Enter, Escape, Tab)
  type <selector> <text>   Type text character by character
  count <selector>         Count matching elements
  exists <selector>        Check if element exists (true/false)
  html <selector>          Get innerHTML of element
  clear <selector>         Clear input field
  selectOption <sel> <val> Native <select> option selection
  stop                     Stop the server

Examples:
  npx tsx scripts/playwright/cmd.ts navigate "http://example.com"
  npx tsx scripts/playwright/cmd.ts --context agent02 fill "#user" "admin"
  npx tsx scripts/playwright/cmd.ts click "button[type=submit]"
  npx tsx scripts/playwright/cmd.ts screenshot "my-page"
`);
    process.exit(0);
  }

  // Quick check — is the server process alive?
  if (fs.existsSync(PID_FILE)) {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
    } catch {
      console.error('Server not running (stale PID file)');
      console.error('   Start it: npx tsx scripts/playwright/server.ts');
      fs.unlinkSync(PID_FILE);
      process.exit(1);
    }
  } else {
    console.error('Server not running!');
    console.error('   Start it first: npx tsx scripts/playwright/server.ts');
    process.exit(1);
  }

  const action = filteredArgs[0];
  const commandArgs = filteredArgs.slice(1);

  try {
    let result = await sendCommand(action, commandArgs, context);

    // Retry once with 1s delay for retryable actions
    if (!result.success && RETRYABLE_ACTIONS.has(action)) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await sendCommand(action, commandArgs, context);
    }

    if (result.success) {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.error(JSON.stringify({ error: result.error }, null, 2));
      process.exit(1);
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, null, 2));
    process.exit(1);
  }
}

main();
