---
description: Run a multi-agent production audit on the LiverRa codebase following AUDIT-PIPELINE-RECIPE.md
---

## User Input

```text
$ARGUMENTS
```

## Instructions

Run a **LiverRa production audit** on the area(s) specified in `$ARGUMENTS`.

The full orchestration is canonical in two files — **read both before launching anything**:

1. `/Users/toko/Desktop/LiverRa/audit-instructions.md` — the playbook (12 LiverRa areas, 6-tier severity rubric, 10 dimensions, 5-wave strategy, three-file split output, parent-side dedup).
2. `/Users/toko/Desktop/LiverRa/.claude/agents/AUDIT-PIPELINE-RECIPE.md` — the 8-step recipe (discovery → manifest → parallel batch → merge → prior-diff → quality gate → cleanup).

### Dispatch

Inspect `$ARGUMENTS`:

- **`full`** (or empty / `all`) → run the 3-wave full audit per `audit-instructions.md`:
  - Wave 0: 2 baseline agents (`qa-dependency-audit`, `qa-unit-test-runner`)
  - Wave 1: 12 `production-audit` agents — one per LiverRa area, all 10 dimensions (no Correctness/Experience split — LiverRa areas are small enough for one specialist)
  - Wave 2: 4 LiverRa-specific specialists (`qa-fhir-validator`, `qa-security-scanner`, `qa-i18n-quality`, `qa-ui-ux-tester`) + 6 mechanical sweeps (catch-blocks, optimistic-locking, test-quality, type-safety, react-hooks, i18n-literals) across the whole repo
  - Optional Wave 3: hotspot re-audit on areas with ≥1 BLOCKER/CRITICAL or ≥10 findings (opt-in; usually 0-3 agents)
  - **Total: ~24 agents per run** (up from your usual targeted ~11-18, but sized for full platform coverage)
  - Skipped on purpose because they duplicate `production-audit` Phase 2/3 or need dev-server: `qa-edge-case-analyzer`, `qa-integration-tester`, `qa-performance-profiler`, `qa-e2e-browser-tester`, the 5 Wave-3 cross-cutting agents from medimind. Invoke those individually when you have a specific reason.
  - Output: **three** files in `audit-findings/` (PART1 BLOCKER+CRITICAL+HIGH, PART2 MEDIUM, PART3 LOW+TRIVIAL), not one unified file.

- **A single area key** from the LiverRa area table (e.g., `pacs`, `cases`, `cascade`, `inference`, `clinical-algorithms`, `acr-readout`, `refinement`, `audit-compliance`, `design-system`, `i18n`, `auth-settings`, `schema`) → run the 8-step recipe in `AUDIT-PIPELINE-RECIPE.md` on that area:
  - Step 1 discovery → Step 2 manifest → Step 3 parallel batch (N feature agents + 6 mandatory mechanical sweeps) → Step 4 merge → Step 5 prior-diff → Step 6 append → Step 7 quality gate → Step 8 cleanup.
  - Output: a single unified `audit-findings/<area>-audit-{YYYY-MM-DD}.md`.

- **A free-form description** (e.g., "the new ACR readout", "the cascade after the GPU split") → map it to the closest area key from the table, confirm with the user in one sentence ("Mapping that to area `acr-readout` — proceed?"), then run the recipe.

### Hard rules

- Every agent runs in parallel within its wave — single message with multiple `Agent` tool calls.
- Every agent writes to `audit-findings/.parts/NN-area.md` — never directly to `audit-findings/`.
- The parent (you) reads every `.parts/*.md` after agents finish, runs the parent-side dedup algorithm (line-bucket fingerprint + cross-area labeling), and writes the merged report(s).
- After publishing the merged report(s), delete `.parts/` **file-by-file** (LiverRa likely has a `careful-guard.sh` hook that blocks `rm -rf`).
- If a prior audit on the same area exists, the prior-diff gate **must** run (Step 5–7). If the gate is FAIL, re-launch missed agents and re-merge — do **not** publish a failing audit.

### Reference files the agents read on-demand

- `.claude/agents/references/liverra-conventions.md` — theme tokens, FHIR URLs, EMR component library, audit-chain pattern, model licensing rules. Loaded on-demand by agents that flag convention-dependent findings.
- `.claude/agents/references/e2e-journey-maps.md` — 4 LiverRa journeys (DICOM upload, cascade+report, refinement, audit-chain verification). Loaded by `qa-e2e-browser-tester` and any area that touches a journey.

### Relation to other LiverRa tools

- This is **read-only**. It writes findings reports only. It never edits source code.
- For auto-fix-loop on safe issues, use `/testing-pipeline` (separate skill, different purpose).
- For pre-implementation research, use `/deep-research` or `deep-web-researcher` agent.
- For UI upgrades suggested by audit findings, hand off the report to `/ui-upgrade` per-finding.
