---
description: Upgrade plan.md with 3 parallel analysis agents after /speckit.plan. Use this command immediately after generating a plan to strengthen it with architecture reuse, UI completeness, and testing strategy. Ensures the plan references existing codebase patterns and covers all production concerns.
handoffs:
  - label: Generate Tasks
    agent: speckit.tasks
    prompt: Break the upgraded plan into tasks
    send: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

### 1. Setup

Run `.specify/scripts/bash/check-prerequisites.sh --json` from repo root. Parse JSON for FEATURE_DIR. Set PLAN = FEATURE_DIR/plan.md, SPEC = FEATURE_DIR/spec.md. Abort if plan.md is missing.

### 2. Idempotency check

Read PLAN. If it contains `<!-- UPGRADED -->`, warn the user: "This plan has already been upgraded. Running again may add duplicate content. Proceed?" Wait for confirmation before continuing.

### 3. Read context

- Read PLAN and SPEC fully
- Read data-model.md and research.md from FEATURE_DIR if they exist
- Read `.specify/memory/constitution.md` if it exists
- Read the project's `CLAUDE.md` for full conventions reference

### 4. Backup

```bash
cp PLAN PLAN.pre-upgrade
```

### 5. Create temp directory

```bash
mkdir -p FEATURE_DIR/.upgrade-parts
```

### 6. Launch 3 analysis agents IN PARALLEL

Spawn all 3 agents in a **single message** for true concurrency. Use the Agent tool with **general-purpose** subagent_type (agents need Write access for their output files). Use `model: "opus"` for all agents.

**CRITICAL — Path substitution**: Before spawning each agent, replace ALL placeholders with actual resolved absolute paths:
- `FEATURE_DIR` → the absolute path from check-prerequisites.sh
- `[ABSOLUTE_PLAN_PATH]` → the resolved PLAN path
- `[ABSOLUTE_SPEC_PATH]` → the resolved SPEC path

Do NOT pass literal placeholder strings to agents.

Also include in every agent prompt: "Read CLAUDE.md at the repo root for complete project conventions (color system, component rules, dark mode, mobile-first, FHIR patterns, typography, forbidden colors, button gradients, flexbox rules)."

---

#### Agent 1: Architecture & Codebase Integration
**Write to**: `FEATURE_DIR/.upgrade-parts/01-architecture.md`

Read the plan at [ABSOLUTE_PLAN_PATH] and spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions.

**First**: Find the most similar existing feature in the codebase (e.g., bed-management, laboratory, shift-handoff, financial) by scanning `packages/app/src/emr/views/` and `packages/app/src/emr/components/`. Study how that feature is structured end-to-end (views → hooks → services → types → translations). Use this as a reference pattern for the plan.

Then search the codebase for reusable patterns:

- **Existing services**: Search `packages/app/src/emr/services/` — can any existing service be reused or extended instead of creating new ones? List exact file paths.
- **Existing hooks**: Search `packages/app/src/emr/hooks/` — are there hooks for similar data fetching, FHIR operations, or state management?
- **Shared components**: Check `packages/app/src/emr/components/common/` and `packages/app/src/emr/components/shared/` — list all reusable components the plan should reference (EMRModal, EMRButton, EMRTable, EMREmptyState, EMRFormFields, etc.)
- **FHIR constants**: Check `packages/app/src/emr/constants/fhir-systems.ts` — are the right identifier systems and extension URLs being used?
- **Data fetching patterns**: How does the codebase fetch FHIR resources? (useMedplum, useSearch, custom hooks) — is the plan consistent?
- **State management**: What patterns exist? (React context, hooks, localStorage, sessionStorage, IndexedDB)
- **Missing architectural concerns**: Error boundaries, Suspense boundaries, code splitting, lazy loading

**Cap at 15 most critical findings.** Prioritize: reuse opportunities > FHIR compliance > architecture gaps > minor patterns.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Finding: [title]
- **Category**: reuse-opportunity | missing-pattern | fhir-concern | architecture-gap | similar-feature-reference
- **Details**: [what was found or what's missing]
- **File Path**: [exact path if referencing existing code]
- **Suggested Plan Addition**: [what to add to plan.md]
```

---

#### Agent 2: UI/Frontend Completeness
**Write to**: `FEATURE_DIR/.upgrade-parts/02-ui-frontend.md`

Read the plan at [ABSOLUTE_PLAN_PATH]. Read CLAUDE.md for project conventions. Then read these codebase files:
- `packages/app/src/emr/constants/routes.ts` (route patterns)
- `packages/app/src/AppRoutes.tsx` (route registration)
- Scan `packages/app/src/emr/components/HorizontalSubMenu/` (submenu tabs)
- Scan `packages/app/src/emr/components/EMRMainMenu/` (main menu)
- `packages/app/src/emr/styles/theme.css` (design system variables)

Audit the plan for:

- **Route registration**: Are ALL new routes listed? Do they follow the pattern in routes.ts?
- **Menu/navigation hookup**: Is the feature added to HorizontalSubMenu tabs or EMRMainMenu? Which section?
- **EMR component library**: Does the plan specify EMRModal (not raw Mantine Modal), EMRButton, EMRTable, EMRFormFields, EMREmptyState? List any raw Mantine usage that should use EMR wrappers.
- **`[frontend-designer]` annotation**: EVERY UI section in the plan MUST note that the `frontend-designer` agent handles implementation. Flag any missing annotations.
- **Dark mode**: Does the plan use CSS variables from theme.css (`--emr-bg-card`, `--emr-text-primary`, etc.)? No hardcoded colors?
- **Mobile-first**: Are responsive breakpoints addressed? 44px tap targets? Mobile layouts?
- **Loading/empty/error states**: Does every view have all three states planned?
- **Typography**: Using `--emr-font-*` variables, not hardcoded sizes?

**Cap at 15 most critical findings.** Prioritize: route/menu gaps > component misuse > state gaps > style issues.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Finding: [title]
- **Category**: route-gap | menu-gap | component-misuse | missing-state | style-issue | frontend-designer-missing
- **Details**: [what was found or what's missing]
- **File Path**: [exact path if referencing existing code]
- **Suggested Plan Addition**: [what to add to plan.md]
```

---

#### Agent 3: Testing & Production Strategy
**Write to**: `FEATURE_DIR/.upgrade-parts/03-testing.md`

Read the plan at [ABSOLUTE_PLAN_PATH] and spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions. Audit for:

- **E2E test plan**: Every user story MUST have a Playwright E2E test planned. List missing ones. Reference `scripts/playwright/` for the test infrastructure.
- **Unit test plan**: Every service function, custom hook, and utility needs a `.test.ts` file. List missing ones.
- **Integration test plan**: FHIR create/read/update/search operations need tests with MockClient from `@medplum/mock`.
- **Error handling strategy**: What happens on network failure? Permission denied? Invalid data? Is this documented in the plan?
- **i18n plan**: Are translation files planned for ALL 3 languages (ka, en, ru)? Directory structure under `packages/app/src/emr/translations/`?
- **Permission gates**: Which roles can access which routes/actions? Is `ProtectedRoute` or permission checking planned?
- **Offline behavior**: IndexedDB queueing? What operations work offline? Sync strategy?
- **Monitoring**: Any logging, error tracking, or audit trail needed?

**Cap at 15 most critical findings.** Prioritize: missing E2E tests > missing permission gates > missing error handling > missing i18n > monitoring.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Finding: [title]
- **Category**: test-gap | error-handling | i18n-gap | permission-gap | offline-gap | monitoring-gap
- **Details**: [what was found or what's missing]
- **File Path**: [exact path if relevant]
- **Suggested Plan Addition**: [what to add to plan.md]
```

---

### 7. Wait and handle failures

Wait for all 3 agents to complete. Then:
- If ALL 3 succeeded: read all files from `FEATURE_DIR/.upgrade-parts/`
- If some failed: warn the user which agent(s) failed, proceed with successful findings only, do NOT delete `.upgrade-parts/` so the user can inspect

### 8. Consolidate and update plan.md

- Deduplicate across agents (same finding from multiple = high confidence, mention once)
- **Process CRITICAL findings first**, then HIGH, then MEDIUM
- Add reuse opportunities with exact file paths to relevant plan sections
- Add missing route/menu/navigation entries to the project structure section
- Ensure a **Testing Strategy** section exists with E2E, unit, and integration plans
- Add `[frontend-designer]` annotation to EVERY UI-related plan item
- Add/enhance sections for: i18n, offline support, permission gates, dark mode, mobile responsiveness
- If a similar feature reference was found, add it as "Reference Architecture" note
- **Preserve ALL existing plan content** — only enhance, never remove
- Add `<!-- UPGRADED -->` marker at the top of the file (after the title)

### 9. Post-merge validation

Quick sanity check:
- Count sections before and after — no sections should have been deleted
- Verify no empty sections were introduced
- Confirm markdown structure is valid (headings, lists, tables intact)

### 10. Show diff

Run `git diff PLAN` to show the user exactly what changed.

### 11. Cleanup

Only if all agents succeeded and merge was validated:
```bash
rm -rf FEATURE_DIR/.upgrade-parts
```
Keep `.pre-upgrade` backup file — the user can delete it manually once satisfied.

### 12. Report

Summary table of additions by category and severity, path to updated plan.md, path to backup at plan.pre-upgrade.

"Review the diff above. If anything looks wrong, restore with: `cp PLAN.pre-upgrade PLAN`"
