# Shared Context Block

Copy this block (with placeholders replaced) into every agent prompt.

```
TARGET AREA: {area}
TARGET DIRECTORIES: {TARGET_DIRS}
DATE: {YYYY-MM-DD}
BRANCH: {current git branch}

TEST CREDENTIALS:

EMR Staff Portal:
- URL: http://localhost:3000
- Email: admin@medimind.ge
- Password: MediMind2024

Patient Portal:
- URL: http://localhost:3000/portal
- Email: einelasha@gmail.com
- Password: Dba545c5fde36242@@

Medplum Cloud API:
- API URL: https://api.medplum.com/
- Project ID: 71c7841a-7f47-4029-8ab4-0bf62751c173
- Client ID: c7d601b8-758f-4c90-b4dd-2fe8e1d66973

Supabase:
- URL: https://kvsqtolsjggpyvdtdpss.supabase.co

PLAYWRIGHT COMMANDS:
Options:
  --context <name>    Use a named browser context (for parallel agents). Example:
  npx tsx scripts/playwright/cmd.ts --context agent02 navigate "http://localhost:3000"
  Named contexts are auto-created on first use and isolated from each other.

npx tsx scripts/playwright/cmd.ts navigate "url"
npx tsx scripts/playwright/cmd.ts fill "selector" "value"
npx tsx scripts/playwright/cmd.ts click "selector"
npx tsx scripts/playwright/cmd.ts screenshot "name"
npx tsx scripts/playwright/cmd.ts wait 2000
npx tsx scripts/playwright/cmd.ts waitfor "selector"
npx tsx scripts/playwright/cmd.ts text "selector"
npx tsx scripts/playwright/cmd.ts evaluate "script"
npx tsx scripts/playwright/cmd.ts viewport 375 812
npx tsx scripts/playwright/cmd.ts select "selector" "value"
npx tsx scripts/playwright/cmd.ts press "key"
npx tsx scripts/playwright/cmd.ts count "selector"
npx tsx scripts/playwright/cmd.ts exists "selector"
npx tsx scripts/playwright/cmd.ts html "selector"
npx tsx scripts/playwright/cmd.ts clear "selector"
npx tsx scripts/playwright/cmd.ts selectOption "selector" "value"

LANGUAGE SWITCHING:
The app stores UI language in localStorage key 'emrLanguage' with values 'en', 'ka', 'ru'.
To switch to Georgian: evaluate "localStorage.setItem('emrLanguage', 'ka'); location.reload()"
To switch to English: evaluate "localStorage.setItem('emrLanguage', 'en'); location.reload()"
Georgian (ka) is the primary UI language. Testing in Georgian catches hardcoded English strings.

CRITICAL FOR E2E AGENT (02): You MUST perform actual operations (create, edit,
delete, confirm) — not just load pages and take screenshots. Read component files
first to discover form fields and button selectors. If you can't perform an
operation, report it as a FAIL finding. Page-load-only testing is NOT acceptable.

VERDICT FORMAT: Write your actual verdict on the Verdict line like this:
  ## Verdict: PASS
  ## Verdict: FAIL
  ## Verdict: WARNING
Do NOT write "## Verdict: PASS / FAIL / WARNING" — pick ONE value.

EMPTY AREA: If you find zero matching files for the target area, write:
  ## Verdict: PASS
  No issues found — target area has no matching files for this check.

SCOPE: Only analyze files within TARGET_DIRS. Do NOT scan the entire codebase.
```
