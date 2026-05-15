# Audit Pipeline Recipe

**Read this document before launching any production audit.** It defines the
mandatory orchestration steps that close the coverage gap revealed by the
2026-04-27 audit-vs-prior comparison (~59% miss rate).

This is **not an agent itself.** It's the recipe Claude (the parent agent)
follows when running an audit. The recipe is the only canonical
orchestration source — when changes land here, audits should pick them up
on the next run.

---

## What an audit launch looks like (high level)

```
User: "audit the cascade section" (or `/production-audit cascade`)
   ↓
Step 1 — Discovery (1 Explore agent, sequential)
   ↓
Step 2 — Manifest validation (parent — split files across feature agents)
   ↓
Step 3 — Parallel agent batch (one message, N + 6 Agent calls)
            • N feature agents (production-audit, one per subsystem)
            • 6 mechanical sweep agents (audit-sweep-*)
   ↓ (wait for all)
Step 4 — Merge feature + sweep partials → candidate unified report
   ↓
Step 5 — Prior-audit diff (1 audit-prior-diff agent, sequential)
   ↓
Step 6 — Append prior-diff section to unified report
   ↓
Step 7 — Quality gate (PASS / WARN / FAIL)
   ↓
Step 8 — Cleanup (delete .parts/ files individually, rmdir)
```

---

## Step 1 — Discovery (1 Explore agent)

Launch ONE Explore agent. Pass it the AUDIT_AREA from the user. Prompt
template:

```
Enumerate every TSX, TS, CSS, PY, JSON, and SQL/alembic file under the LiverRa monorepo
whose import graph or path touches <AUDIT_AREA>. Areas can span both frontend
(packages/app/, packages/core/, packages/fhirtypes/) and backend
(packages/ml-inference/, packages/ml-inference-gpu/, supabase/functions/) — read
audit-instructions.md's "12 LiverRa Areas" table for the canonical path list per
area. Classify each file by feature subsystem (e.g., for AUDIT_AREA = cascade:
subsystems include "orchestrator-api", "celery-worker", "post-processing",
"phase-runner", "real-cascade-script"; for AUDIT_AREA = acr-readout: subsystems
include "frontend-section-components", "backend-report-builder", "pdf-render",
"telemetry").

Do NOT skip:
  • files in <area>/shared/ subdirectories
  • files in sub-feature directories
  • test files (*.test.ts, *.spec.ts, test_*.py, *_test.py)
  • Playwright/e2e spec files (packages/app/src/emr/views/__e2e__/<area>/, scripts/playwright/tests/<area>/)
  • CSS modules co-located with the components
  • TypeScript type files in types/<area>/ or packages/core/src/types/
  • Alembic migrations (packages/ml-inference/alembic/versions/) when the area touches schema
  • FHIR StructureDefinition JSONs (packages/fhirtypes/src/liverra/extensions/) when the area touches FHIR
  • Python jobs (packages/ml-inference/src/jobs/) and worker tasks (packages/ml-inference/src/workers/)

Output flat JSON: { files: [{ path, subsystem, type: 'view'|'component'|'service'|'hook'|'test'|'e2e-test'|'type'|'css'|'py-api'|'py-service'|'py-worker'|'py-job'|'py-test'|'migration'|'fhir-extension' }] }.

Report the count by subsystem in a final summary block.
```

**Why this matters:** medimind's 2026-04-27 audit missed a major subsystem
because the Explore step's scope was too narrow — Mode A (file out of scope)
accounted for 40% of the misses. LiverRa is cross-language (TS + Python) and
cross-package, so the scope MUST cover both halves of any area. This step
kills Mode A by forcing dual-language discovery.

## Step 2 — Manifest validation (parent does this synchronously)

Parse the Explore agent's output. Build:

```
audit-manifest.md
| File path | Subsystem | Owner agent (feature) |
|-----------|-----------|------------------------|
| ... 215 files ... | | |
```

**Validation rules:**
- Every file must have an Owner agent.
- The union of all feature agent file lists must equal the discovered file set.
- If any file is uncovered → spawn a "miscellaneous" feature agent to cover it.
- Do not proceed to Step 3 until manifest is complete.

The 6 mechanical sweep agents are NOT assigned files — they sweep the entire
audit area. Do not list them in the manifest's "Owner agent" column.

## Step 3 — Parallel agent batch

In ONE message, launch all agents in parallel via the Agent tool. Each agent
gets a `prompt` argument containing:

- For feature agents: the assigned file list, AUDIT_AREA, and OUTPUT_PATH
  (`audit-findings/.parts/NN-<subsystem>.md`).
- For sweep agents: the entire AUDIT_AREA, and OUTPUT_PATH
  (`audit-findings/.parts/sweep-NN-<sweep-name>.md`).

**Mandatory mechanical sweep agents to launch every time:**

| Sweep | Agent name | Output path |
|-------|-----------|-------------|
| 1 | `audit-sweep-catch-blocks` | `.parts/sweep-01-catch-blocks.md` |
| 2 | `audit-sweep-optimistic-locking` | `.parts/sweep-02-optimistic-locking.md` |
| 3 | `audit-sweep-test-quality` | `.parts/sweep-03-test-quality.md` |
| 4 | `audit-sweep-type-safety` | `.parts/sweep-04-type-safety.md` |
| 5 | `audit-sweep-react-hooks` | `.parts/sweep-05-react-hooks.md` |
| 6 | `audit-sweep-i18n-literals` | `.parts/sweep-06-i18n-literals.md` |

There is no opt-in switch. If the parent skips any of these, the parent has
deviated from the recipe — log it explicitly in the unified report's intro
under "Pipeline deviations."

**Total agents per audit:** N feature + 6 sweep, where N is typically 5–12
depending on AUDIT_AREA size. Run all N+6 in parallel — they don't interfere
because each writes a unique `.parts/` file.

## Step 4 — Wait + merge

After all agents complete:

1. Glob `audit-findings/.parts/*.md`.
2. Read every partial file.
3. Build the unified report:
   - Header with date + audit area + agent count + total file count
   - Grand Summary table (severity counts across all parts)
   - Per-Part Breakdown table (one row per agent)
   - Executive Summary — list every BLOCKER and CRITICAL with one-line
     description (mirror the format in
     the closest prior LiverRa audit under `audit-findings/`)
   - Cross-cutting themes section — patterns appearing in 3+ partials
   - Then concatenate every partial under `# Part NN — <subsystem>` headers
4. Write to `audit-findings/<area>-audit-<YYYY-MM-DD>.md`.

## Step 5 — Prior-audit diff

After the unified report is written, find the most recent prior audit on the
same area:

```bash
ls audit-findings/ | grep -i "<area>" | grep -v "$(date +%Y-%m-%d)" | sort | tail -1
```

Launch ONE `audit-prior-diff` agent. Pass it:
- `NEW_AUDIT_PATH` = the just-written unified report
- `PRIOR_AUDIT_PATH` = the file from the command above
- `OUTPUT_PATH` = `audit-findings/.parts/sweep-07-prior-diff.md`

If no prior audit exists, skip Step 5 — note "no prior audit available;
coverage gate skipped" in the report's intro.

## Step 6 — Append prior-diff section

When `audit-prior-diff` finishes, read its output and **append** it to the
unified report under the heading `## Coverage vs Prior Audit`. Do not
overwrite — append.

## Step 7 — Quality gate

The `audit-prior-diff` agent's verdict (PASS / WARN / FAIL) determines next
action:

- **PASS** (`coverage_full >= 0.85` AND `miss_rate <= 0.05`): publish the
  audit. Done.
- **WARN** (`0.70 <= coverage_full < 0.85` OR `0.05 < miss_rate <= 0.15`):
  publish but flag with a clear "Coverage Warning" banner at the top of the
  unified report. Optionally launch supplemental agents per the
  Recommendations section.
- **FAIL** (`coverage_full < 0.70` OR `miss_rate > 0.15`): do **not**
  publish. Re-run the audit:
  1. Update the manifest with the missed files (from prior-diff
     attribution).
  2. Re-launch only the affected feature agents + relevant mechanical
     sweeps.
  3. Re-merge into the same unified report file (append new Parts; do not
     create a fragment file).
  4. Re-run prior-diff. Continue until PASS or WARN.

## Step 8 — Cleanup

The careful-guard.sh hook **blocks `rm -rf`**. Cleanup must use
file-by-file delete:

```bash
cd audit-findings/.parts && \
  rm 01-*.md 02-*.md 03-*.md 04-*.md 05-*.md \
     06-*.md 07-*.md 08-*.md 09-*.md 10-*.md \
     sweep-01-*.md sweep-02-*.md sweep-03-*.md \
     sweep-04-*.md sweep-05-*.md sweep-06-*.md \
     sweep-07-*.md && \
  cd .. && rmdir .parts
```

Adjust the file list to whatever the actual partials are. Use
`ls audit-findings/.parts/` first to confirm the file list.

---

## Summary of agents this recipe uses

| Agent | When | Parallel with |
|-------|------|---------------|
| Explore (discovery) | Step 1 | — (sequential) |
| `production-audit` (feature) | Step 3 | All other agents in batch |
| `audit-sweep-catch-blocks` | Step 3 | All others |
| `audit-sweep-optimistic-locking` | Step 3 | All others |
| `audit-sweep-test-quality` | Step 3 | All others |
| `audit-sweep-type-safety` | Step 3 | All others |
| `audit-sweep-react-hooks` | Step 3 | All others |
| `audit-sweep-i18n-literals` | Step 3 | All others |
| `audit-prior-diff` | Step 5 | — (sequential, after merge) |

---

## Why this recipe exists

This recipe was hardened against a real coverage-gap incident in a sibling
codebase (medimind, 2026-04-27): an audit ran 10 parallel `production-audit`
agents and missed ~59% of the prior audit's findings, broken down as:

- **Mode A** (file out of scope): 8 of 20 missed findings — fixed by Step 1
  discovery + Step 2 manifest validation.
- **Mode B** (file in scope, line-level bug missed): 5 of 20 — fixed by
  Step 3 mechanical sweeps (each grep-walks one pattern across the whole
  area, exhaustive by construction).
- **Mode C** (Trivia rollups hiding real findings): 2 of 20 — fixed by
  the tightened Trivia rules in `production-audit.md` and the per-instance
  reporting requirement in each sweep agent.
- **Mode D** (inconsistent severity bar): 5 of 20 — fixed by the explicit
  Severity Rubric in `production-audit.md`.

The prior-diff gate (Step 5–7) catches whatever survives.

Without all four pieces, coverage drops back toward the 26% baseline.
Skip nothing.
