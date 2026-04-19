---
description: Upgrade tasks.md with 3 parallel analysis agents after /speckit.tasks. Use this command immediately after generating tasks to add missing test tasks (E2E, unit, integration), UI hookup tasks (routes, menus, translations, frontend-designer annotations), and production-readiness tasks (error/loading/empty states, offline, permissions, accessibility).
handoffs:
  - label: Start Implementation
    agent: speckit.implement
    prompt: Start the implementation in phases
    send: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

### 1. Setup

Run `.specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks` from repo root. Parse JSON for FEATURE_DIR. Set TASKS = FEATURE_DIR/tasks.md, PLAN = FEATURE_DIR/plan.md, SPEC = FEATURE_DIR/spec.md. Abort if tasks.md is missing.

### 2. Idempotency check

Read TASKS. If it contains `<!-- UPGRADED -->`, warn the user: "These tasks have already been upgraded. Running again may add duplicate tasks. Proceed?" Wait for confirmation before continuing.

### 3. Read context

- Read TASKS, PLAN, and SPEC fully
- Note the **LAST Task ID number** (e.g., if last task is T045, new tasks will start at T046)
- Read the project's `CLAUDE.md` for full conventions reference

### 4. Backup

```bash
cp TASKS TASKS.pre-upgrade
```

### 5. Create temp directory

```bash
mkdir -p FEATURE_DIR/.upgrade-parts
```

### 6. Launch 4 analysis agents IN PARALLEL

Spawn all 4 agents in a **single message** for true concurrency. Use the Agent tool with **general-purpose** subagent_type (agents need Write access for their output files). Use `model: "opus"` for all agents.

**CRITICAL — Path substitution**: Before spawning each agent, replace ALL placeholders with actual resolved absolute paths:
- `FEATURE_DIR` → the absolute path from check-prerequisites.sh
- `[ABSOLUTE_TASKS_PATH]` → the resolved TASKS path
- `[ABSOLUTE_PLAN_PATH]` → the resolved PLAN path
- `[ABSOLUTE_SPEC_PATH]` → the resolved SPEC path

Do NOT pass literal placeholder strings to agents.

Also include in every agent prompt: "Read CLAUDE.md at the repo root for complete project conventions. All new tasks MUST follow the strict checklist format: `- [ ] TNEW___ [P] [USx] Description with file path`. Use TNEW001, TNEW002, etc. as placeholder IDs — they will be renumbered during merge."

---

#### Agent 1: Test Task Completeness
**Write to**: `FEATURE_DIR/.upgrade-parts/01-tests.md`

Read tasks at [ABSOLUTE_TASKS_PATH] and spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions.

For EVERY user story in the spec, verify tasks.md includes all necessary test tasks. List ALL missing ones.

**Required test coverage per user story:**

- **E2E test** (Playwright): Full user journey end-to-end. Uses `scripts/playwright/` infrastructure.
  - Format: `- [ ] TNEW___ [P] [USx] E2E test: [scenario description] via Playwright`
- **Unit tests**: Every service function, hook, and utility.
  - Format: `- [ ] TNEW___ [P] [USx] Unit test: [what] in [filepath].test.ts`
- **Integration tests**: FHIR resource operations using MockClient from `@medplum/mock`.
  - Format: `- [ ] TNEW___ [P] [USx] Integration test: [operation] in [filepath].test.ts`

Also check for missing tests covering:
- Error/failure paths (not just happy path)
- Permission-denied scenarios
- Empty state rendering
- i18n (switching language shows correct translations)
- Offline behavior (queued operations, sync)

**Cap at 15 most critical missing test tasks.** Prioritize: E2E tests > integration tests > unit tests > edge case tests.

Classify each as `[CRITICAL|HIGH|MEDIUM]` and write as properly formatted task lines.

---

#### Agent 2: UI Task Audit
**Write to**: `FEATURE_DIR/.upgrade-parts/02-ui-tasks.md`

Read tasks at [ABSOLUTE_TASKS_PATH]. Read CLAUDE.md for project conventions. Also read:
- `packages/app/src/emr/constants/routes.ts` (route patterns)
- `packages/app/src/AppRoutes.tsx` (route registration)
- Scan `packages/app/src/emr/components/HorizontalSubMenu/` for navigation patterns

Audit and list ALL missing tasks:

1. **`[frontend-designer]` annotation**: Every task that creates or modifies UI (views, components, pages, modals, forms) MUST include `[frontend-designer]` in its description. List existing tasks that are MISSING this annotation — these are fixes to existing tasks, format as:
   ```
   FIX: T0XX — add [frontend-designer] annotation
   ```

2. **Route registration task**: Is there a task to add routes to `packages/app/src/emr/constants/routes.ts` and `packages/app/src/AppRoutes.tsx`? If not, create it.

3. **Menu/navigation hookup task**: Is there a task to add the feature to HorizontalSubMenu tabs or EMRMainMenu? If not, create it.

4. **Translation tasks**: Are there tasks to create/update translation files for ALL 3 languages?
   - `packages/app/src/emr/translations/[feature]/ka.json`
   - `packages/app/src/emr/translations/[feature]/en.json`
   - `packages/app/src/emr/translations/[feature]/ru.json`
   - Also update the main translation context if needed

5. **Dark mode verification task**: Is there a task to verify the feature works in both light and dark themes?

6. **Mobile responsiveness task**: Is there a task to test/verify at mobile (375px), tablet (768px), and desktop (1024px+) viewports?

**Cap at 15 most critical findings.** Prioritize: route/menu gaps > missing frontend-designer annotations > translation gaps > verification tasks.

Classify each as `[CRITICAL|HIGH|MEDIUM]`. Write new tasks as formatted task lines. Write fixes to existing tasks as `FIX:` entries.

---

#### Agent 3: Edge Case & Production Tasks
**Write to**: `FEATURE_DIR/.upgrade-parts/03-production.md`

Read tasks at [ABSOLUTE_TASKS_PATH], spec at [ABSOLUTE_SPEC_PATH], and plan at [ABSOLUTE_PLAN_PATH]. Read CLAUDE.md for project conventions. Identify missing production-readiness tasks:

- **Error state UI tasks**: Network failure display, FHIR error handling, validation error messages, timeout handling
- **Loading state tasks**: Skeleton screens or spinners for every async data fetch
- **Empty state tasks**: `EMREmptyState` component for no-data scenarios (no results, no items, first-time use)
- **Offline queue tasks**: IndexedDB operations, pending action queue, sync-on-reconnect, conflict resolution UI
- **Permission gate tasks**: `ProtectedRoute` wrapper for routes, role-based UI hiding, permission-denied fallback
- **Accessibility tasks**: Keyboard navigation, aria-labels on interactive elements, focus management in modals
- **Data validation tasks**: Input validation (Georgian personal ID, date ranges, required fields), server-side error display
- **Performance tasks**: Pagination for large lists, debounced search, lazy loading for heavy components

**Cap at 15 most critical missing tasks.** Prioritize: permission gates > error handling > offline > loading/empty states > accessibility > performance.

Classify each as `[CRITICAL|HIGH|MEDIUM]` and write as properly formatted task lines.

---

#### Agent 4: Wiring & Integration Audit
**Write to**: `FEATURE_DIR/.upgrade-parts/04-wiring.md`

Read tasks at [ABSOLUTE_TASKS_PATH], plan at [ABSOLUTE_PLAN_PATH], and spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions.

Audit every task for wiring completeness. For each finding, generate a missing wiring task.

**Detection rules**:

1. **Orphan services**: For every task containing "Create" + "service" + a file path: search ALL other tasks for a reference to that service name. If no other task imports or calls it (excluding its own test task), flag as ORPHAN and generate a `[W]` wiring task.

2. **Orphan hooks**: For every task containing "Create" + ("hook" or "use[A-Z]"): search ALL other tasks for a component that imports it. If no component task references the hook, flag as ORPHAN and generate a `[W]` wiring task connecting it to its intended consumer (infer from task description context or plan.md).

3. **Orphan components**: For every task containing "Create" + ("component" | "view" | "page" | ".tsx"): verify a route registration task or parent component task references it. If not, generate a route/navigation wiring task.

4. **Parallel creation conflicts**: For every pair of `[P]` tasks in the same phase where one creates a producer and the other creates its consumer: flag as CONFLICT. The consumer task should not be `[P]` or should have an explicit `[W]` wiring task that is sequential.

5. **Cross-phase wiring gaps**: For every foundational service (Phase 2), check that each user story phase that uses it (by description keywords) has an explicit import/wire task. Foundational services used by 3 stories need 3 wiring tasks, one per story phase.

**Output format per finding**:
```
ORPHAN: T0XX creates [artifact] — no task imports it
  Intended consumer(s): [inferred from task description or plan.md]
  Missing task: - [ ] TNEW___ [W] [USx] Wire [artifact] into [consumer] — add import { [export] } from '[path]' and call [method()] in [consumer file path]
```

**Cap at 20 most critical findings.** Prioritize: orphan services > orphan hooks > parallel conflicts > cross-phase gaps > orphan components.

Classify each as `[CRITICAL|HIGH|MEDIUM]` and write missing wiring tasks as properly formatted task lines.

---

### 7. Wait and handle failures

Wait for all 4 agents to complete. Then:
- If ALL 4 succeeded: read all files from `FEATURE_DIR/.upgrade-parts/`
- If some failed: warn the user which agent(s) failed, proceed with successful findings only, do NOT delete `.upgrade-parts/` so the user can inspect

### 8. Consolidate and update tasks.md

- Collect ALL new tasks from all 3 agents
- Deduplicate (same task from multiple agents → keep one copy)
- **Process CRITICAL first**, then HIGH, then MEDIUM
- **Renumber**: Replace TNEW___ placeholders with sequential IDs continuing from the last existing ID (e.g., T046, T047, T048...)
- **Apply FIX entries**: For any `FIX: T0XX` entries from Agent 2, update the existing task in-place to add `[frontend-designer]` annotation
- **Assign each new task to the correct phase**:
  - Route/menu hookup tasks → Setup or Foundational phase
  - Translation tasks → relevant user story phase or final Polish phase
  - Test tasks → add as sub-section within each user story phase
  - Error/loading/empty state tasks → relevant user story phase
  - Dark mode, mobile, accessibility verification → final Polish phase
- Wiring [W] tasks → same phase as the consumer task they connect to. Wiring tasks MUST NOT be marked [P] relative to their producer task.
- Ensure ALL UI tasks include `[frontend-designer]` in description
- Mark parallelizable tasks with `[P]`
- **Preserve ALL existing tasks** — only append new ones (except FIX entries which modify existing)
- Maintain strict checklist format: `- [ ] TNNN [P] [USx] Description with file path`
- Add `<!-- UPGRADED -->` marker at the top of the file (after the title)

### 9. Post-merge validation

Quick sanity check:
- All task IDs are sequential with no gaps or duplicates
- All tasks follow the `- [ ] TNNN` checklist format
- Phase structure is preserved
- No existing tasks were accidentally removed (compare task count: new count >= old count)

### 10. Show diff

Run `git diff TASKS` to show the user exactly what changed.

### 11. Cleanup

Only if all agents succeeded and merge was validated:
```bash
rm -rf FEATURE_DIR/.upgrade-parts
```
Keep `.pre-upgrade` backup file — the user can delete it manually once satisfied.

### 12. Report

| Category | Severity | Tasks Added |
|----------|----------|------------|
| E2E Tests | CRITICAL/HIGH | N |
| Unit Tests | HIGH/MEDIUM | N |
| Integration Tests | HIGH/MEDIUM | N |
| UI Hookup (routes/menus) | CRITICAL | N |
| Translations (ka/en/ru) | HIGH | N |
| frontend-designer fixes | HIGH | N |
| Production (error/loading/empty) | HIGH | N |
| Accessibility | MEDIUM | N |
| Wiring (integration gaps) | CRITICAL/HIGH | N |
| **Total New Tasks** | | **N** |

Show:
- Previous task count → new task count
- Path to updated tasks.md
- Path to backup at tasks.pre-upgrade
- "Review the diff above. If anything looks wrong, restore with: `cp TASKS.pre-upgrade TASKS`"
