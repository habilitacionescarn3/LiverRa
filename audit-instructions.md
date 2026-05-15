# Full LiverRa Production Audit — One Command

## Quick Start

Tell Claude Code:

```
Run a LiverRa full production audit following audit-instructions.md.
Execute 3 waves on the Opus model in bypassPermissions mode:
  - Wave 0: 2 baseline agents (deps + unit tests, whole repo)
  - Wave 1: 12 production-audit agents (one per LiverRa area, all 10 dimensions)
  - Wave 2: 4 LiverRa-specific specialists + 6 mechanical sweeps (whole repo)
  - Optional Wave 3: hotspot re-audit on areas with BLOCKER/CRITICAL or ≥10 findings
Write partials to audit-findings/.parts/ and merge into THREE severity-split
reports (BLOCKER+CRITICAL+HIGH, MEDIUM, LOW+TRIVIAL) — NOT one unified file.
```

## Compute & Agent Strategy (LEAN — sized for LiverRa)

This is a Class IIb SaMD on the CE MDR path, but it is also a smaller codebase than a multi-specialty EMR. Spend compute where LiverRa has real surface area (cascade, FHIR + audit-chain, ML licensing); don't repeat coverage `production-audit` already gives you.

### Model & Parallelism

**Model:** ALL agents MUST run on `model: "opus"`. No exceptions. No Sonnet/Haiku fallbacks.

**Mode:** Run in `bypassPermissions` so agents can read freely without approval prompts.

**Orchestration:** Waves run sequentially (Wave 0 → 1 → 2 → optional 3). Agents *within* a wave are launched in a single message with parallel tool calls — never sequentially.

---

#### Wave 0 — Static baseline (2 agents, runs first)
Boring-but-foundational checks that don't need per-area agents. Runs before Wave 1 so findings feed forward.
- `qa-dependency-audit` — npm audit + Python `pip audit`, outdated packages, TS strictness, license compliance (whole repo)
- `qa-unit-test-runner` — Vitest + pytest pass/fail, identify uncovered critical paths (whole repo)

#### Wave 1 — Per-area scan (12 agents, all in parallel)
ONE `production-audit` agent per LiverRa area (see "The 12 LiverRa Areas" table below). Each agent scans ALL 10 dimensions on its area — no Correctness/Experience split. The dual-specialist split was a medimind pattern designed for 800-1500-line-per-area surfaces; LiverRa areas are small enough that one specialist sees the whole picture and the split would just produce duplicate findings.

If an area is large enough to warrant a split (>2000 lines of source), upgrade THAT area only to a dual-specialist pair — don't blanket-split all 12.

#### Wave 2 — LiverRa-specific specialists + mechanical sweeps (10 agents, whole repo, parallel)

**4 LiverRa-specific QA specialists** — catch issues `production-audit` can't see at per-area scope:
- `qa-fhir-validator` — extension URL drift across whole repo, required fields, validation against `packages/fhirtypes/src/liverra/extensions/StructureDefinition-*.json`
- `qa-security-scanner` — DICOM PHI surfaces, MinIO presigned URL TTL, audit-chain tamper surfaces, model-weight licensing, OWASP Top 10
- `qa-i18n-quality` — translation completeness across en/ru/ka (de retained-fallback), TODO-translate marker count, Locale-type drift between TranslationContext.tsx and localeService.ts
- `qa-ui-ux-tester` — viewports, dark mode, theme-token compliance, EMR component denylist, forbidden-hex denylist

**6 mechanical sweeps** — same agents the targeted recipe runs per-area, but here run ONCE across the whole repo for full-mode coverage:
- `audit-sweep-catch-blocks`, `audit-sweep-optimistic-locking`, `audit-sweep-test-quality`, `audit-sweep-type-safety`, `audit-sweep-react-hooks`, `audit-sweep-i18n-literals`

**Skipped on purpose** (would duplicate `production-audit`'s Phase 2/3 coverage):
- ~~qa-edge-case-analyzer~~ — production-audit's Phase 2 already does file-by-file edge-case scanning.
- ~~qa-integration-tester~~ — production-audit's Phase 3 already does cross-file validation; Wave 1 covers cross-service via the `cascade`, `inference`, and `audit-compliance` area assignments.
- ~~qa-performance-profiler~~ — runtime perf is better measured manually (needs dev server up + Playwright timing); run it as a separate, opt-in agent when there's a real perf complaint.
- ~~qa-e2e-browser-tester~~ — slow (needs dev server up). Run separately when validating a specific journey.
- ~~5 Wave-3 cross-cutting agents~~ — production-audit Phase 3 + `qa-fhir-validator` (cross-repo) + `qa-security-scanner` (cross-repo) collectively cover this. Keep cross-cutting as inline checks in Wave 2 specialists, not their own wave.

#### Optional Wave 3 — Hotspot re-audit (variable, opt-in)
Off by default. The parent enables it only if Wave 1 produced ≥1 BLOCKER or any single area produced ≥10 findings. Re-spawn a fresh `production-audit` on the affected areas with the prior findings in the prompt as context. Typically 1-3 extra agents, rarely 5+.

---

**Expected total:** 2 (Wave 0) + 12 (Wave 1) + 10 (Wave 2) + optional 0-3 (Wave 3) = **24 agents per full audit run** (up to ~27 with hotspot re-audit).

### Why this is the right size for LiverRa
- Medimind had 27 areas → 76-86-agent full audits made sense.
- LiverRa has 12 areas, each ~300-800 lines of source → 24 agents is the right cap.
- Per-area `production-audit` already runs all 10 dimensions; adding a second specialist per area would duplicate ~60% of findings (the medimind split was needed because areas were too big for one agent to read end-to-end).
- The targeted recipe (`/production-audit <area>`) is unchanged: ~11-18 agents (N feature + 6 sweep). Use it for normal day-to-day audits. Reserve full-mode for pre-release / pre-CE-submission deep scans.

### Depth Requirements Per Agent
Every agent MUST:
- **Read files in full** — no "grep and guess." Use the Read tool on every suspicious file end-to-end.
- **Trace at least 3 call chains per area** — follow a function from UI → hook → service → FHIR call to verify the whole path.
- **Quote evidence** — every finding includes `file_path:line_number` and the offending snippet. No unsourced claims.
- **Distinguish severity** — tag every finding with one of `BLOCKER`, `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `TRIVIAL` using the 6-tier rubric below. Severity is **impact-only**, never tied to dimension.
- **Write to `.parts/NN-area.md`** — never directly to `audit-findings/`.

### Severity Rubric (agents must follow exactly)
- **BLOCKER** — ship-stopper. Surgical-planning miscalculation (wrong FLR, wrong Couinaud topology, wrong LI-RADS class), audit-chain break, data loss, auth bypass, PHI leak, production crash, two-person-control bypass, model-provenance gap, dead safety guard. Fix before anything else ships.
- **CRITICAL** — fix before release. Broken critical feature, GDPR/MDR compliance gap, PHI-leak path, race condition on cascade or chain-of-hashes write, hard-delete of retained clinical data, stub code in security/crypto/auth/audit path, model-version not recorded for an inference output.
- **HIGH** — fix this release. Wrong behavior in expected paths, missing error handling on cascade/report path, active-risk TODO/FIXME, stale closures causing wrong data, FHIR non-compliance that causes data drift, missing dual-auth guard, bypassed kill switch, license-mismatched model weight referenced in code.
- **MEDIUM** — fix next release. Perf regression, edge-case bug, **accumulated i18n debt (≥20 missing keys) — reclassified from LOW**, non-clinical error gaps, cross-module refactor that can wait.
- **LOW** — polish. Styling inconsistencies, isolated hardcoded strings (<20 per area), scattered dead code in new-feature files, minor a11y gaps.
- **TRIVIAL** — bulk-counted in the `## Trivia` footer of each agent's output file. Never promoted to an individual finding block. See the production-audit agent's "Trivia Floor" section for the exemption list.

### Historical Severity Reconciliation

Older audit reports (pre-April 2026) used mixed vocabularies: `P0-P6`, `P0-P5`, and `Critical/Important/Minor`. When comparing those reports against ones using the new 6-tier scale, apply this mapping:

| Old (P0-P6) | Old (Critical/Important/Minor) | New (6-tier) |
|---|---|---|
| P0 data loss, P1 security breach | Critical | BLOCKER or CRITICAL (human judgment) |
| P2 broken feature | Important | HIGH |
| P3 performance | Important | MEDIUM |
| P4 UX | Minor | LOW or MEDIUM (UX-on-clinical-path) |
| P5 polish (isolated) | Minor | LOW |
| P5 i18n (≥20 keys accumulated) | Minor | **MEDIUM** (reclassified) |
| P6 code quality | Minor | LOW or TRIVIAL (per Trivia Floor rules) |

This table lives here, not in the agent file — new agents should only know the new vocabulary. Users comparing across the transition consult this table.

## The 12 LiverRa Areas

| # | Area key | Area name | Frontend paths | Backend paths |
|---|---|---|---|---|
| 1 | `pacs` | DICOM Upload & PACS | `packages/app/src/emr/services/pacs/`, `components/pacs/`, `views/pacs/` | `pacs/orthanc/`, `pacs/nginx/` |
| 2 | `cases` | Case Management & Analysis Detail | `views/cases/`, `components/cases/` | — |
| 3 | `cascade` | Cascade Pipeline Orchestrator | — | `packages/ml-inference/src/workers/`, `packages/ml-inference/src/services/cascade/`, `packages/ml-inference/src/api/analysis.py`, `scripts/real_cascade.py` |
| 4 | `inference` | ML Inference Client & GPU Split | `packages/app/src/emr/services/inference/` (if any) | `packages/ml-inference/src/services/inference_client.py`, `packages/ml-inference-gpu/` |
| 5 | `clinical-algorithms` | Couinaud + FLR + LI-RADS | `packages/app/src/emr/components/liver/FLRPanel.tsx`, `components/liver/RefineTools.tsx`, `components/liver/ReviewTools.tsx` | `packages/ml-inference/src/services/post_processing/` |
| 6 | `acr-readout` | ACR Structured Readout | `packages/app/src/emr/components/report/ACRStructuredReadout.tsx`, `ACRSection*.tsx`, `ReportInlineView.tsx` | `packages/ml-inference/src/services/report/` |
| 7 | `refinement` | Refinement Tools (lesion edit) | `packages/app/src/emr/components/liver/RefineTools.tsx`, `ReviewTools.tsx`, `views/cases/RefinementView.tsx`, `views/cases/LesionsPanelView.tsx` | — |
| 8 | `audit-compliance` | Audit Chain & FHIR Compliance | `packages/app/src/emr/services/pacs/auditService.ts`, `views/compliance/AuditSummaryView.tsx` | `packages/ml-inference/src/services/audit/`, `packages/ml-inference/src/services/fhir/audit_event_emitter.py`, `packages/ml-inference/src/services/erasure/`, `packages/ml-inference/src/jobs/audit_retention_attestation.py` |
| 9 | `design-system` | Theme + EMR Component Library | `packages/app/src/emr/components/common/`, `components/shared/EMRFormFields/`, `styles/theme.css` | — |
| 10 | `i18n` | i18n + TranslationContext | `packages/app/src/emr/contexts/TranslationContext.tsx`, `services/localeService.ts`, `translations/{en,ru,ka,de}/` | — |
| 11 | `auth-settings` | Auth, Permissions, Settings | `packages/app/src/emr/views/settings/`, `views/auth/`, `components/ProtectedRoute/` | (auth backend TBD) |
| 12 | `schema` | Database Migrations & Schema | `packages/core/src/types/audit.ts`, `packages/fhirtypes/src/liverra/extensions/` | `packages/ml-inference/alembic/versions/` |

**Wave 1 invocation:** spawn 24 agents (12 areas × 2 specialists). Each agent gets the area key + its specialist role (Correctness or Experience) + the file paths above.

**Cross-package paths:** LiverRa is a monorepo. Areas can span both TypeScript (`packages/app/`, `packages/core/`, `packages/fhirtypes/`) and Python (`packages/ml-inference/`, `packages/ml-inference-gpu/`). The auditor must read both halves of an area when present.

## 10 Audit Dimensions Per Area

Each agent scans its area across all 10 dimensions. Dimensions are **tags**, not severity — a D2 issue can be BLOCKER or LOW depending on impact.

1. **D1 Data Integrity** — null checks, race conditions, stale refs, optimistic locking, timezone handling, idempotency
2. **D2 Security** — auth gaps, XSS, injection, exposed secrets, dual-auth bypass
3. **D3 Business Logic** — wrong calculations, missing edge cases, status transitions
4. **D4 Error Handling** — silent catches, missing user feedback, critical-path observability
5. **D5 FHIR Compliance** — extensions, references, search params, resource shapes
6. **D6 React / Performance** — re-renders, O(n²), missing memoization, N+1
7. **D7 UI / Styling** — hardcoded colors, dark mode, tap targets, a11y
8. **D8 i18n** — hardcoded strings, missing translation keys
9. **D9 Code Quality** — dead code, unused imports, duplicate logic, unsafe casts, function complexity, magic numbers (see Trivia Floor for exemptions)
10. **D10 Clinical Safety & Compliance** — chain-of-hashes integrity (no rewrite outside erasure flow, no skipped sequence numbers), model-version provenance recorded on every inference output, license-clean model weights (only Apache-2.0 / MIT / CC-BY-4.0 — see CLAUDE.md "Model Licensing Discipline"), GDPR / CE-MDR audit-event coverage on PHI-bearing FHIR resources, FLR / Couinaud topology sanity (no negative volumes, no segments summing >120% of total parenchyma), DICOM PHI stripping at upload boundary, no hard-delete of retained clinical data. Only applies to code paths touching PHI-bearing FHIR resources, DICOM, or ML output.

## Output — THREE Severity-Split Reports (NOT one unified file)

After all waves complete, the parent reads every file from `audit-findings/.parts/`, runs the **Parent-Side Dedup Algorithm** (below), then splits findings by severity into **three markdown files** so the user can tackle them in priority order.

### File 1 — `audit-findings/full-emr-audit-{YYYY-MM-DD}-PART1-BLOCKER-CRITICAL-HIGH.md`
- Contains ONLY `BLOCKER`, `CRITICAL`, and `HIGH` severity findings from all 12 areas.
- Grand Summary table at top: counts per area, counts per dimension (D1..D10).
- Ordered by: BLOCKER first, then CRITICAL, then HIGH. Within each tier, grouped by area.
- **This is the "fix immediately" file.** BLOCKERs must ship before anything else.

### File 2 — `audit-findings/full-emr-audit-{YYYY-MM-DD}-PART2-MEDIUM.md`
- Contains ONLY `MEDIUM` severity findings from all 12 areas.
- Grand Summary table at top.
- Grouped by area, dimension within area.
- **This is the "next sprint" file.**

### File 3 — `audit-findings/full-emr-audit-{YYYY-MM-DD}-PART3-LOW-TRIVIAL.md`
- Contains ONLY `LOW` severity findings as full blocks, plus an aggregated `## Trivia` section that merges every agent's Trivia footer into one global bulk count.
- Grand Summary table at top.
- Grouped by area, dimension within area.
- **This is the "polish & cleanup" file.** `TRIVIAL`-severity items live only in this file's aggregated Trivia section — never promoted to individual finding blocks.

### Parent-Side Dedup Algorithm (RUN BEFORE FILE SPLIT)

Historical data shows parallel agents converge on the same bugs — one audit had **40 duplicates out of 110 raw findings (36% wasted work)**. Before splitting into PART1/PART2/PART3, run this dedup:

1. Read every file from `audit-findings/.parts/` into memory.
2. For each finding, compute a **fingerprint**:
   ```
   fingerprint = SHA1(normalized_file_path + ":" + floor(line_number / 50) * 50 + ":" + dimension_tag)
   ```
   The line-bucket of 50 groups nearby findings (same function / same block) as duplicates.
3. Group findings by fingerprint. Within each group:
   - Keep the **highest-severity** finding as the canonical entry.
   - Merge each duplicate's agent-ID into an `Also flagged by: AreaX (agent-05), AreaY (agent-11)` footer on the canonical entry.
   - Discard the duplicates from the individual outputs.
4. For any finding whose `file:line` reference points **outside** the agent's assigned area, label `CROSS-AREA` and collect into a separate `## Cross-Cutting Issues` section at the end of PART1 (regardless of severity — cross-area findings always deserve visibility). Dedup cross-area findings the same way.
5. Record dedup stats at the top of PART1: `Dedup: N raw findings → M unique (X% overlap).`

### Merge Rules (HARD REQUIREMENTS)
1. Each finding appears in **exactly one** of the three files (based on its severity tag after dedup).
2. Every finding must include: area, dimension tag (D1..D10), severity (6-tier), `file:line`, evidence snippet, recommended fix, ELI5.
3. Every BLOCKER, CRITICAL, and HIGH finding must also include `Blast Radius` (ISOLATED / LOCAL / CROSS-MODULE / CONTRACT-CHANGE).
4. After writing all three files, delete `audit-findings/.parts/` entirely: `rm -rf audit-findings/.parts`.
5. NEVER produce a fourth "unified" file. The three parts ARE the deliverable.
6. If an area had zero findings at a given severity, list it in the Grand Summary with count `0` — do not omit it.
7. Each file starts with a one-line pointer to the other two parts, so navigating between them is easy.
8. PART3's aggregated Trivia section sums each agent's trivia footer. Example: `Unused imports across all 12 areas: 487 total.`
