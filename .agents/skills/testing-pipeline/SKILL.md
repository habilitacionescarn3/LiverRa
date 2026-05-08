---
name: testing-pipeline
description: One-command full testing system with auto-fix loop. Spawns 10 QA agents to scan, auto-fixes safe issues via coder agents, re-scans to verify — up to 3 iterations. Produces a unified QA report with PASS/FAIL verdict. v5.0 adds named browser contexts, --quick mode (static-only scan), expanded area mappings (13 areas), scope validation, progress tracking, and fixes for git rollback, translation safety, and dev server diagnostics.
version: 5.0.0
---

# Testing Pipeline v5.0 — Scan, Fix, Verify Loop

You are the orchestrator for MediMind's comprehensive testing pipeline. When invoked with `/testing-pipeline <area>`, you:
1. **Scan** — spawn 10 QA agents to find issues
2. **Triage** — classify each finding as auto-fixable or manual-review, deduplicating overlaps
3. **Fix** — spawn coder agents to apply safe fixes (with git checkpoint + post-fix validation)
4. **Verify** — re-run only the agents that had failures (all agents on final iteration)
5. **Loop** — repeat triage/fix/verify up to 3 iterations until clean (with oscillation detection)

**Analogy:** Like a car inspection where 10 mechanics check different systems, a repair crew fixes what they can on the spot (after photographing the original state), verifies their work didn't break anything else, and the mechanics re-check — all before handing you the final report.

## Reference Files

This skill uses progressive disclosure. The orchestration flow is here; detailed tables and templates are in `references/`:

| File | Contains | Read when... |
|------|----------|-------------|
| `references/shared-context.md` | Credentials, Playwright commands, verdict format | Spawning any agent (Step 3, 8) |
| `references/agent-dispatch.md` | Wave 1/2 agent tables, named context instructions | Spawning agents (Step 3, 8) |
| `references/triage-rules.md` | Auto-fixable + manual-review classification tables, dedup rules | Classifying findings (Step 6) |
| `references/coder-prompt.md` | Coder agent prompt template | Dispatching fixes (Step 7) |
| `references/quality-gates.md` | Gate definitions, thresholds, display format | Building final report (Step 10) |
| `references/report-template.md` | Final report markdown template, verdict logic | Building final report (Step 10) |

## Usage

```
/testing-pipeline <area> [--fresh] [--quick]
```

**Flags:**
- `--fresh` — Force a fresh start, ignoring any saved resume state
- `--quick` — Run Wave 1 static analysis only (7 agents), skip browser agents. Saves ~40% time and cost. Good for iterative fixes.

**Examples:**
- `/testing-pipeline warehouse` — tests all warehouse-related code
- `/testing-pipeline registration` — tests patient registration
- `/testing-pipeline laboratory` — tests lab module
- `/testing-pipeline financial` — tests financial module
- `/testing-pipeline hr` — tests HR module (including My HR portal)
- `/testing-pipeline laboratory --fresh` — fresh start, ignoring any previous partial run
- `/testing-pipeline warehouse --quick` — static analysis only, no browser tests

---

## Step 0: Initialize & Resume Check

### Check for Concurrent Runs

Before anything else, check for a lock file:

```bash
cat qa-reports/.pipeline.lock 2>/dev/null
```

**If the lock file exists:**
- If the lock file is not valid JSON, delete it and continue (treat as corrupted stale lock).
- Read its `startedAt` field
- Calculate how long ago it was created (current time minus `startedAt`)
- If `startedAt` is **less than 2 hours ago** → **ABORT** with: "Another pipeline run may still be in progress (started {startedAt}). Wait for it to finish or delete qa-reports/.pipeline.lock to force."
- If `startedAt` is **more than 2 hours ago** → The previous run is stale/crashed. Delete the lock file and continue.

### Create Lock File

Write `qa-reports/.pipeline.lock`:
```json
{
  "startedAt": "{ISO timestamp}",
  "area": "{area}"
}
```

### Handle `--fresh` Flag

If the user passed `--fresh`:
- Delete `qa-reports/.pipeline-state.json` if it exists
- Delete `qa-reports/.pipeline.lock` if it exists
- Clean up orphaned pipeline stashes from crashed runs:
  ```bash
  for i in $(seq 1 10); do git stash list | grep -q "qa-pipeline-pre-fix" || break; git stash drop "$(git stash list | grep "qa-pipeline-pre-fix" | head -1 | cut -d: -f1)" || continue; done
  ```
- Skip the resume check below
- Start fresh from Step 1

### Resume Check

Check if a previous run was interrupted:

```bash
cat qa-reports/.pipeline-state.json 2>/dev/null
```

**If the file exists**, read it and decide:
- If the file is not valid JSON, delete it and start fresh
- If the file's `version` field is not `5`, delete it and start fresh (incompatible state format)
- If the file's `branch` field doesn't match the current git branch, delete it and start fresh
- If the file's `commitHash` field doesn't match the current HEAD commit (`git rev-parse HEAD`), warn: "Code has changed since last run. Starting fresh." Delete and start fresh.
- **Same area + phase is NOT "done"** → Resume from the saved phase (skip to that step)
- **Different area OR phase is "done"** → Delete it and start fresh

**If the file doesn't exist** → Start fresh from Step 1.

On resume, always re-check the dev server and Playwright (Step 2 health checks) before continuing.

---

## Step 1: Resolve Target Area

Use a **two-tier search** to find all related code, not just directories that share the area name.

### Tier 1: Direct Match

Glob for directories under `packages/app/src/emr/` matching the area prefix:

```
components/<area>*/
services/<area>*/
hooks/<area>*/
views/<area>*/
types/<area>*
translations/<area>*/
```

### Tier 2: Known Related Directories

Some areas have code spread across multiple directory names. Check this mapping and add any extra directories:

```
AREA_MAPPINGS:
  warehouse → components/warehouse, services/warehouse, hooks/warehouse,
              services/administration, views/settings/tabs/administration,
              components/selling, components/writeoff, components/returns,
              components/procurement, components/order, components/stationary,
              types/warehouse*, translations/warehouse, translations/warehouse-config
  financial → components/financial, views/dashboard,
              services/chargeItem*, services/claim*, services/claimResponse*,
              services/payment*, services/invoice*, services/arAging*,
              services/financialDashboard*, services/drgTariff*,
              services/profitability*, services/payerMix*,
              services/collectionRate*, services/denialAnalytics*,
              hooks/useFinancial*, hooks/useARaging*, hooks/useCleanClaim*,
              hooks/useCollectionRate*, hooks/usePayerMix*, hooks/useProfitability*,
              types/financial*
  laboratory → components/laboratory, services/laboratory, hooks/laboratory,
               types/laboratory*, translations/laboratory
  hr → components/hr, services/hr, hooks/hr, views/hr, views/my-hr,
       types/hr, translations/hr
  appointments → components/appointments, services/appointments,
                 hooks/appointments, views/schedule, types/appointment*
  messaging → components/messaging, services/messaging, hooks/messaging,
              views/messaging, translations/messaging
  research → components/research, services/research, hooks/research,
             views/research, types/research*
  bed-management → components/bed-management, services/bed-management,
                   views/bed-management
  pacs → components/pacs, services/pacs, hooks/pacs, views/pacs, types/pacs*
  mediscribe → components/mediscribe, services/mediscribe, hooks/mediscribe,
               views/mediscribe
```

**Note:** Tier 2 mappings can include file-level globs (e.g., `services/chargeItem*`) in addition to directory patterns.

If the area is not in the mapping, just use Tier 1 results.

Build a comma-separated list of ALL matching directories (both tiers). This is the `TARGET_DIRS` that every agent will scan.

**Guard: Empty Target** — If TARGET_DIRS is empty (no directories found), ABORT with:
"No directories found for area '{area}'. Check spelling. Known areas: warehouse, financial, laboratory, registration, patient-history, bed-management, research, forms, reports, administration, hr, appointments, messaging, pacs, mediscribe."
Delete the lock file and exit.

## Step 2: Set Up Environment

### Clean Stale Artifacts
```bash
rm -rf qa-reports/.parts
rm -rf qa-reports/.fix-logs
rm -f screenshots/02-* screenshots/06-* screenshots/08-*
```

### Start Dev Server
```bash
lsof -ti :3000 | xargs kill -9 2>/dev/null; cd packages/app && npx vite --port 3000 > /tmp/vite-qa.log 2>&1 &
```

**Health check** — wait up to 30 seconds for the dev server to respond with HTTP 200:
```bash
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200" && break || sleep 2; done
```

**CRITICAL — Abort on failure:**
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"
```
If the dev server does NOT return HTTP 200 after the health check loop, **ABORT the entire pipeline**:
```bash
rm -f qa-reports/.pipeline.lock
rm -rf qa-reports/.parts qa-reports/.fix-logs
```
Report: "Pipeline aborted — dev server failed to start. Check `/tmp/vite-qa.log` for build errors."

### Start Playwright Server
```bash
pkill -9 -f Chromium 2>/dev/null; pkill -9 -f playwright 2>/dev/null
rm -f /tmp/playwright-server.pid
npx tsx scripts/playwright/server.ts &
sleep 3
```

**Readiness check** — verify Playwright is accepting commands:
```bash
npx tsx scripts/playwright/cmd.ts url
```

If this command fails, wait 3 more seconds and retry once.

**If Playwright still fails after retry:** Do NOT abort the pipeline. Instead, mark browser agents (02, 06, 08) as **skipped** — they will get a `FAIL` verdict with reason "Playwright server unavailable". Continue with Wave 1 (static analysis) agents only. Set `playwrightAvailable` to `false` in the state file.

### Create Output Directories
```bash
mkdir -p qa-reports/.parts
mkdir -p qa-reports/.fix-logs
```

### Write Initial State File

Write the pipeline state so we can resume if interrupted:

```jsonc
{
  "version": 5,
  "area": "{area}",
  "branch": "{current git branch}",
  "commitHash": "{git rev-parse HEAD}",
  "startedAt": "{ISO timestamp}",
  "targetDirs": "{TARGET_DIRS}",
  "iteration": 1,
  "phase": "scan",
  "failedAgents": [],
  "findings": [],
  "fixBatches": [],
  "agentInvocations": 0,
  "playwrightAvailable": true
}
```

Use the Write tool to create `qa-reports/.pipeline-state.json` with the JSON above, replacing placeholders with actual values. Set `playwrightAvailable` to `false` if Playwright failed to start.

For ALL subsequent "Update state file" instructions:
1. Read `qa-reports/.pipeline-state.json` with the Read tool
2. Parse the JSON mentally
3. Change ONLY the needed field(s) (e.g., `"phase": "triage"` → `"phase": "fix"`)
4. Write the COMPLETE updated JSON back with the Write tool
5. NEVER use sed/jq/bash to modify JSON — always use Read+Write
6. Increment `agentInvocations` by the number of agents spawned each time.

**Progress:** Output to user: "~5% — Environment ready. Dev server: OK | Playwright: {OK/FAILED}. Starting scan..."

---

## Step 3: Spawn Agents in Two Waves (SCAN Phase)

Read `references/agent-dispatch.md` for the agent tables and `references/shared-context.md` for the context block to inject into each agent prompt.

**Wave 1 (7 agents in parallel):** Launch agents 01, 03, 04, 05, 07, 09, 10 simultaneously.
**Wave 2 (3 agents in parallel):** After Wave 1 completes, launch agents 02, 08, 06 simultaneously — each uses its own named browser context.

**If `--quick` flag was passed:** Skip Wave 2 entirely. Write SKIPPED stubs for agents 02, 06, 08:
```
## Verdict: PASS
**Reason:** SKIPPED — Quick mode (--quick flag). Only static analysis agents ran.
```
Set `quickMode: true` in the state file. Quality gates referencing skipped agents display "SKIPPED" in Actual and Status columns.

If `playwrightAvailable` is `false` in the state file, **skip Wave 2 entirely**. Write stub reports for agents 02, 08, and 06:
```
## Verdict: FAIL
**Reason:** SKIPPED — Playwright server was unavailable at pipeline start.
```

Each agent writes to `qa-reports/.parts/0N-name.md`.

**On resume:** If resuming the scan phase, check which `.parts/` files already exist and are non-empty. Only re-run agents whose output files are missing or empty.

**CRITICAL:** Pass the shared context block from `references/shared-context.md` to EVERY agent in their prompt, replacing placeholders with actual values.

**After Wave 1 completes**, output progress:
"~35% — Wave 1 complete ({N}/7 agents). Verdicts: {N} PASS, {N} WARNING, {N} FAIL."

**Between waves:** Re-check dev server and Playwright health before launching Wave 2:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"
npx tsx scripts/playwright/cmd.ts url
```
If either fails, restart them. If restart also fails, skip Wave 2 with FAIL stubs.

**After Wave 2 completes**, output progress:
"~60% — Wave 2 complete. All 10 agents finished. Verdicts: {N} PASS, {N} WARNING, {N} FAIL."

## Step 4: Verify Agent Output

Wait for all 10 Task tool calls to return.

**After all agents complete**, verify each output file:
1. Check that each `.parts/0N-*.md` file exists and is non-empty
2. Verify each file contains a `## Verdict:` line
3. If an output file is missing or empty, create a stub with:
   ```
   ## Verdict: FAIL
   **Reason:** AGENT DID NOT COMPLETE — no output file produced.
   ```
4. **For the E2E report (02), additionally check:**
   - Report must contain an `## Operation Coverage` table
   - At least 1 "Create" operation must show Attempted > 0
   - If the Operation Coverage table is missing or all Create/Edit/Delete show 0, override the E2E verdict to WARNING with note: "E2E tests were page-load-only — no operations were actually performed"

Update state file: `"phase": "triage"`. Increment `agentInvocations` by the number of agents actually spawned.

## Step 5: Early-Exit Check

Read each agent's verdict. If **ALL 10 agents report PASS or WARNING** (and no agent reports FAIL):

1. Check if any WARNING agent has `#### FINDING:` blocks in its report
2. If YES → proceed to Step 6 (Triage) to extract, classify, and potentially auto-fix those findings. Skip the re-scan step (Step 8) — only do one pass of triage+fix.
3. If NO (all WARNING agents have zero findings) → skip Steps 6-9 entirely, go to Step 10.

**When skipping entirely (option 3):**
1. Update state file: set `phase` to `"done"`, `findings` to `[]`, `fixBatches` to `[]`
2. Skip Steps 6, 7, 7.5, 8, 9 entirely — go directly to **Step 10** (Final Report + Cleanup)
3. Do NOT execute any triage, fix, or verify logic
4. The report will show "Iterations: 0 of 3 | Auto-fixes Applied: 0"

**Progress:** Output to user: "All 10 agents passed! Skipping fix loop. Generating final report..."

This saves time and cost — no need to triage, fix, or verify when everything passes.

---

## Step 6: Triage (Classify Findings)

**If this is iteration 2 or 3 (not the first triage):**
1. Clear ALL previous findings from state file: set `findings` to `[]`
2. Extract FRESH findings from the NEW `.parts/` reports only
3. Assign new IDs starting from `f-001`
4. Previous iteration findings are already reflected in the fix logs

Read the `.parts/` reports from agents that did NOT pass. For each `#### FINDING:` block in those reports, extract:

- **agent**: Which agent found it (e.g., "04")
- **category**: The finding code (e.g., "FC1", "SEC3", "I18N2")
- **severity**: CRITICAL / HIGH / MEDIUM / LOW
- **file**: Full file path
- **line**: Line number (if available)
- **title**: Short description
- **description**: Full explanation
- **suggestedFix**: What the agent suggests (if any)

Assign each finding an ID (`f-001`, `f-002`, etc.).

### Scope Validation

For each finding, verify the `file` path is within one of the TARGET_DIRS. If a finding's file is outside TARGET_DIRS, set its classification to `"manual"` with reason `"File outside target area — likely a shared dependency"`. Do not auto-fix files outside scope.

### Classify as auto-fixable or manual-review

Read `references/triage-rules.md` for the complete classification tables. It contains:
- Deduplication rules (by file, line, category tuple)
- Auto-fixable findings table (which category+severity combos get auto-fixed and how)
- Manual-review findings table (which ones need human judgment and why)
- Default rule: anything not in the auto-fixable table = manual-review
- Unparseable FAIL handling (synthetic findings for agents with no structured output)

**Progress:** Output to user: "Triage: {N} raw findings -> {N} after deduplication — {N} auto-fixable, {N} manual-review."

Write all findings to the state file with their classification and `"status": "pending"`.

Record which agents had non-PASS verdicts in `failedAgents` (e.g., `["04", "07"]`).

If there are **zero auto-fixable findings**:
1. Set `phase` to `"done"` in state file
2. Skip Steps 7, 7.5, 8, 9 entirely — go directly to **Step 10** (Final Report)
3. All findings will appear in the "Remaining Issues (Manual Review Required)" section

Otherwise, update state file: `"phase": "fix"`

---

## Step 7: Dispatch Fixes

### Git Checkpoint (CRITICAL — enables rollback)

Before dispatching any coder agents, create a git checkpoint of files that will be edited:

```bash
git stash push -m "qa-pipeline-pre-fix-iter-{iteration}" -- {space-separated list of files to be edited}
```

If `git stash push` fails (e.g., no changes to stash because files are untracked), that's OK — the files are in their original state already.

After `git stash push`, verify the stash was actually created:
```bash
git stash list | head -1 | grep "qa-pipeline-pre-fix-iter-{iteration}"
```
If the grep matches → set `"stashCreated": true` in state file.
If no match → set `"stashCreated": false`. The files are in their original state.

Record the stash entry in the state file: `"lastStash": "qa-pipeline-pre-fix-iter-{iteration}"`

### Run Baseline Unit Tests (for post-fix comparison)

Before applying any fixes, capture the current test state:

Build the jest test path pattern from TARGET_DIRS basenames (not just the area name) to catch tests in all related directories:
```bash
cd packages/app && npx jest --testPathPatterns="emr/.*(dir1|dir2|dir3)" --no-cache --passWithNoTests --forceExit 2>&1 | tail -5
```
Replace `(dir1|dir2|dir3)` with the actual directory basenames from TARGET_DIRS. Example for warehouse: `"emr/.*(warehouse|administration|selling|writeoff|returns|procurement|order|stationary)"`.

Use `timeout: 300000` (5 min) on the Bash tool call. If Jest does not complete within 5 minutes, treat baseline as "unknown" and proceed with fixes. Note in progress: "Baseline test timed out — post-fix validation will compare against unknown baseline."

Record the pass/fail count in the state file: `"baselineTestResults": { "passed": N, "failed": N }`

### ON RESUME (if state file shows phase="fix")

If resuming into this step:
1. Read the `qa-reports/.fix-logs/` directory
2. For each batch in `fixBatches`:
   - If `qa-reports/.fix-logs/b-{batchId}.md` exists → skip (already done)
   - If not → add to pending dispatch queue
3. Dispatch only pending batches (do not re-run completed ones)

### Grouping Rule: One coder agent per file

Group all auto-fixable findings by their target file. Each file gets exactly one coder agent — this prevents two agents editing the same file at the same time.

**Special case — Translation files:** ALL missing-key findings (across all source files) get ONE dedicated coder agent that edits `ka.json` and `ru.json` together.

### Dispatch Order (CRITICAL — prevents file collisions)

1. **First wave:** All source file coders (max 5 parallel) — these edit `.ts`/`.tsx`/`.css` files only
2. **Second wave (AFTER all source file coders complete):** Translation coder — edits `ka.json`/`ru.json`

Source file coders must NOT edit translation files. If a finding requires both a source file change (wrapping with `t()`) AND a translation key addition, split it: source file coder handles the `t()` wrap, translation coder handles the key addition.

### Parallelism Rules

- Max **5 coder agents** running simultaneously (in each wave)
- If more than 5 files need fixing, process in sub-waves of 5
- Max **10 findings per coder agent** (take highest severity first; the rest go to next iteration)

**Overflow tracking:** When capping at 10 findings per coder, write the remaining findings to the state file with `"status": "deferred"`. At max iteration (iteration 3), any findings with status `"deferred"` are moved to `"manual"` status and included in the "Remaining Issues (Manual Review Required)" section of the final report.

### Coder Agent Prompt

Read `references/coder-prompt.md` for the full prompt template to use when spawning each coder subagent. Fill in the placeholders (file path, findings list, batch ID).

### After Each Wave

After each wave of coder agents completes:
1. Read all fix logs from `qa-reports/.fix-logs/`
2. If a coder agent returned but its fix log file is missing:
   - Mark all findings in that batch as `"skipped"` with reason `"agent did not produce fix log"`
   - These findings will be retried in the next iteration
3. Update each finding's status in the state file (`"fixed"`, `"skipped"`)
4. **Capture git diffs** for the fix audit trail:
   ```bash
   git diff -- {space-separated list of files modified in this wave} >> qa-reports/.fix-logs/wave-{N}-diff.txt
   ```
5. Continue with next wave if more files remain

### Translation JSON Validation

After the translation coder wave completes, validate the JSON files:

```bash
node -e "JSON.parse(require('fs').readFileSync('packages/app/src/emr/translations/ka.json'))" 2>&1
node -e "JSON.parse(require('fs').readFileSync('packages/app/src/emr/translations/ru.json'))" 2>&1
node -e "JSON.parse(require('fs').readFileSync('packages/app/src/emr/translations/en.json'))" 2>&1
```

If any validation fails (broken JSON), revert ALL translation files:
```bash
git checkout -- packages/app/src/emr/translations/ka.json
git checkout -- packages/app/src/emr/translations/ru.json
git checkout -- packages/app/src/emr/translations/en.json
```

**Also revert source files with I18N2 findings** — these files had strings wrapped with `t()` that now reference missing translation keys:
```bash
git checkout HEAD -- {space-separated list of source files with I18N2 findings from this batch}
```
Mark all translation findings AND their related I18N2 source file findings as `"skipped"` with reason `"translation JSON validation failed — source and translation files reverted"`.

**Progress:** Output to user: "Fix wave complete. {N} findings fixed, {N} skipped. Running post-fix validation..."

Update state file: `"phase": "post-fix-validation"`. Increment `agentInvocations`.

---

## Step 7.5: Post-Fix Validation

**Purpose:** Ensure auto-fixes didn't break existing tests. This is the single most important safety mechanism.

### Dev Server Health Check

Before running tests, verify the dev server is still alive (coder edits may have caused build errors):
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"
```
If not responding, restart it (same health check loop as Step 2). If restart fails, mark all findings from this iteration as `"skipped"` with reason `"dev server crashed after fixes"` and proceed to Step 10.

### Run Unit Tests for Target Area

Use the same TARGET_DIRS-based pattern as the baseline test (Step 7):
```bash
cd packages/app && npx jest --testPathPatterns="emr/.*(dir1|dir2|dir3)" --no-cache --passWithNoTests 2>&1 | tail -20
```

### Evaluate Results

Compare against the baseline captured in Step 7:

1. **All tests pass (or same pass/fail count as baseline)** → Continue to Step 8 (Verify)
2. **Tests that were PASSING before now FAIL** (or Jest exits with non-zero exit code AND produces no test count summary):
   - Output to user: "Post-fix validation: {N} tests broken by auto-fixes. Reverting last fix wave."
   - Before attempting rollback, check state file:
     - If `stashCreated` is `false`, skip `git stash pop`. Instead revert files directly:
       `git checkout HEAD -- {space-separated list of files modified by coder agents}`
     - If `stashCreated` is `true`, revert using the git checkpoint: `git stash pop`
   - If `git stash pop` fails (merge conflicts), fall back to extracting files directly from the stash:
     ```bash
     git checkout stash@{0} -- {space-separated list of files modified by coder agents}
     git stash drop
     ```
   - Mark all findings from this iteration as `"skipped"` with reason `"broke existing tests"`
   - These findings become manual-review items
3. **Tests that were already failing before fixes** → Ignore (not caused by our changes)

Update state file: `"phase": "verify"`

**Progress:** Output to user: "Post-fix validation: {N} tests passed, {N} failed (baseline: {N} passed, {N} failed)."

---

## Step 8: Verify (Targeted Rescan)

### Dev Server Re-Check

Before re-running any browser agents, verify the dev server is still healthy:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"
```
If it's not responding, restart: `lsof -ti :3000 | xargs kill -9 2>/dev/null; cd packages/app && npx vite --port 3000 &` and wait for HTTP 200 (same health check loop as Step 2).

### Normal Iterations (not the final one)

Re-run ONLY the agents that reported failures in the scan phase. This is faster than re-running all 10.

**Exception:** If an agent produced an UNPARSED synthetic finding in the current iteration (FAIL with no structured findings), exclude it from `failedAgents` for re-scan. It will produce the same unparseable output. The UNPARSED finding remains in the final report as a manual-review item.

### Final Iteration (iteration = 3 OR all agents about to pass)

On the **final iteration only**, re-run ALL 10 agents (not just failed ones). This catches cross-agent regressions.

### Steps:

1. Delete the `.parts/` files for agents being re-run
2. Re-spawn those agents using the same tables from `references/agent-dispatch.md` and context from `references/shared-context.md`
3. **DISPATCH ORDER:** Wave 1 agents first (parallel), wait, then Wave 2 agents (parallel with named contexts)
4. Wait for agents to complete. Read new verdicts.

Update state file with new verdicts. Increment `agentInvocations`.

**Progress:** Output to user: "Verify iteration {N}: Re-ran {N} agents. Verdicts: {N} PASS, {N} WARNING, {N} FAIL."

---

## Step 9: Loop Decision

Check the results of the verify phase:

### All agents PASS?
- Set `"phase": "done"` in state file
- Proceed to Step 10 (Final Report)
- **Progress:** "All agents pass after {N} iterations! Generating final report..."

### Fix Oscillation Detection

Before deciding to loop, check for oscillation:

1. Compare the current iteration's finding categories and locations with the previous iteration's
2. If the **same findings** (by file + category — ignoring line numbers, which shift when fixes add/remove lines) appear in both iterations, the fixes are not making progress
3. **If oscillation detected:** Abort the fix loop with message: "Fixes not making progress — iteration {N} produced the same findings as iteration {N-1}. Remaining findings require manual review."
4. Set all oscillating findings to `"manual"` status and proceed to Step 10

### Some agents still FAIL and iteration < 3?
- Increment `"iteration"` in state file
- Set `"phase": "triage"`
- Go back to **Step 6** (Triage) — re-read the new `.parts/` reports, extract new findings, classify, and fix again
- **Progress:** "Iteration {N} complete. {N} findings remain. Starting iteration {N+1}..."

### Iteration = 3 (max reached)?
- Move all findings still in `"pending"` status to `"manual"` status
- These appear in the "Remaining Issues (Manual Review Required)" section
- Set `"phase": "done"` in state file
- Proceed to Step 10
- **Progress:** "Max iterations reached. {N} findings remain for manual review. Generating final report..."

---

## Step 10: Final Report + Cleanup

### Build Unified Report

Read ALL files from `qa-reports/.parts/` and merge into one unified report.

Read `references/report-template.md` for the full report markdown template and verdict logic.
Read `references/quality-gates.md` for the gate definitions and display format.

Write the merged report to: `qa-reports/{area}-qa-{YYYY-MM-DD}.md`

### Test Resource Cleanup

If the E2E agent tracked created resources, log them for reference:
```bash
cat qa-reports/.test-resources.json 2>/dev/null
```
If the file exists, tell the user: "E2E tests created {N} test resources (prefixed with [TEST]). Review `qa-reports/.test-resources.json` and delete them from the FHIR server if desired."

### Cleanup

**Always clean up these:**
```bash
rm -f qa-reports/.pipeline.lock
rm -f qa-reports/.pipeline-state.json
rm -f qa-reports/.test-resources.json
# Clean up any stale pipeline git stashes (max 10 iterations to prevent infinite loop)
for i in $(seq 1 10); do git stash list | grep -q "qa-pipeline-pre-fix" || break; git stash drop "$(git stash list | grep "qa-pipeline-pre-fix" | head -1 | cut -d: -f1)" || continue; done
```

**If overall verdict is PASS or PASS WITH WARNINGS:**
```bash
rm -rf qa-reports/.parts
rm -rf qa-reports/.fix-logs
npx tsx scripts/playwright/cmd.ts stop
lsof -ti :3000 | xargs kill -9 2>/dev/null
```

**If overall verdict is FAIL:**

Keep the `.parts/` AND `.fix-logs/` directories and servers running for debugging. Tell the user:
```
Servers left running for debugging. When done, run:
  npx tsx scripts/playwright/cmd.ts stop
  lsof -ti :3000 | xargs kill -9 2>/dev/null
  rm -rf qa-reports/.parts qa-reports/.fix-logs
```

## Final Output

Tell the user:
1. The overall verdict (PASS/FAIL/WARNINGS)
2. How many issues were auto-fixed and in how many iterations
3. The report file path
4. Agent invocations and elapsed time
