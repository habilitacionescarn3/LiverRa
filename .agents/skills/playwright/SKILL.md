---
name: playwright-automation
description: Browser automation via server.ts + cmd.ts. Use for screenshots, web scraping, form filling, navigation. Token-efficient alternative to MCP.
version: 2.0.0
---

# Playwright Browser Automation

This skill provides browser automation through a persistent server architecture.

## CRITICAL: Use Server + cmd.ts ONLY

**NEVER use standalone scripts** - they were removed because each launched a new browser causing SingletonLock conflicts!

**ALWAYS use:**
- `server.ts` - Keeps ONE browser alive in background
- `cmd.ts` - Sends commands to that browser

## Quick Start

```bash
# 1. Start server (runs in background)
npx tsx scripts/playwright/server.ts &
sleep 3

# 2. Send commands via cmd.ts
npx tsx scripts/playwright/cmd.ts navigate "https://example.com"
npx tsx scripts/playwright/cmd.ts fill "#username" "user"
npx tsx scripts/playwright/cmd.ts click "button"
npx tsx scripts/playwright/cmd.ts screenshot "page-name"
npx tsx scripts/playwright/cmd.ts wait 1000

# 3. Stop when done
npx tsx scripts/playwright/cmd.ts stop
```

## Available Commands

| Command | Usage | Description |
|---------|-------|-------------|
| navigate | `cmd.ts navigate "url"` | Go to URL |
| fill | `cmd.ts fill "selector" "value"` | Fill input field |
| click | `cmd.ts click "selector"` | Click element |
| click --double | `cmd.ts click "selector" --double` | Double-click |
| screenshot | `cmd.ts screenshot "name"` | Take screenshot |
| screenshot --fullpage | `cmd.ts screenshot "name" --fullpage` | Full page screenshot |
| wait | `cmd.ts wait 2000` | Wait milliseconds |
| waitfor | `cmd.ts waitfor "selector"` | Wait for element |
| text | `cmd.ts text "selector"` | Get text content |
| url | `cmd.ts url` | Get current URL |
| evaluate | `cmd.ts evaluate "script"` | Run JavaScript |
| login | `cmd.ts login [staff\|portal] [email] [pass]` | Full login flow (two-step staff or single-step portal) |
| stop | `cmd.ts stop` | Stop server |

## Common Workflows

> **Dev only**: Default credentials below are for local development only. Never use in production or commit real credentials to source control.

### Login to MediMind (Built-in Command)
```bash
# Staff login with default credentials (admin@medimind.ge)
npx tsx scripts/playwright/cmd.ts login

# Patient portal login with default credentials
npx tsx scripts/playwright/cmd.ts login portal

# Custom credentials
npx tsx scripts/playwright/cmd.ts login staff "user@example.com" "password123"
npx tsx scripts/playwright/cmd.ts login portal "patient@test.com" "pass456"
```
The `login` command handles the full two-step staff flow (email → Next → password → Sign In) and single-step portal flow automatically. It skips login if already authenticated.

### Extract DOM Data
```bash
# Get all form inputs
npx tsx scripts/playwright/cmd.ts evaluate "JSON.stringify(Array.from(document.querySelectorAll('input,select')).map(e=>({id:e.id,name:e.name,type:e.type})))"

# Get dropdown options
npx tsx scripts/playwright/cmd.ts evaluate "JSON.stringify(Array.from(document.querySelectorAll('select')).map(s=>({id:s.id,options:Array.from(s.options).map(o=>({v:o.value,t:o.text}))})))"

# Get all buttons
npx tsx scripts/playwright/cmd.ts evaluate "JSON.stringify(Array.from(document.querySelectorAll('button,[onclick]')).map(b=>({id:b.id,text:b.textContent?.trim(),onclick:b.getAttribute('onclick')})))"
```

### Take Full Page Screenshot
```bash
npx tsx scripts/playwright/cmd.ts navigate "https://example.com"
npx tsx scripts/playwright/cmd.ts wait 1000
npx tsx scripts/playwright/cmd.ts screenshot "full-page" --fullpage
```

## Output Format

All commands output JSON:

```json
{
  "url": "https://example.com",
  "title": "Page Title"
}
```

## State Management

- Browser state persists while server runs
- Screenshots saved to: `screenshots/` in project root
- Server PID: `/tmp/playwright-server.pid`

## Troubleshooting

**Server not running:**
```bash
npx tsx scripts/playwright/server.ts &
sleep 3
```

**Stale PID file:**
```bash
rm /tmp/playwright-server.pid
npx tsx scripts/playwright/server.ts &
```

**Kill all instances (nuclear option):**
```bash
pkill -9 -f Chromium; pkill -9 -f playwright
rm -rf /var/folders/*/T/playwright-user-data
rm -f /tmp/playwright-*.json /tmp/playwright-*.pid
```

## Token Efficiency

| Approach | Initial Cost | Per-Operation |
|----------|-------------|---------------|
| MCP      | ~10,000 tokens | Output only |
| Scripts  | ~100 tokens (this skill) | Output only |

**Savings: ~99% reduction in baseline token consumption**
