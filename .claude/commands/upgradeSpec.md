---
description: Upgrade spec.md with 3 parallel analysis agents after /speckit.specify. Use this command immediately after generating a spec to harden it with edge cases, production requirements, and complete user scenarios. Catches gaps that first-pass generation always misses.
handoffs:
  - label: Build Technical Plan
    agent: speckit.plan
    prompt: Create a plan for the upgraded spec
    send: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

### 1. Setup

Run `.specify/scripts/bash/check-prerequisites.sh --json` from repo root. Parse JSON for FEATURE_DIR. Set SPEC = FEATURE_DIR/spec.md. Abort if spec.md is missing.

### 2. Idempotency check

Read SPEC. If it contains `<!-- UPGRADED -->`, warn the user: "This spec has already been upgraded. Running again may add duplicate content. Proceed?" Wait for confirmation before continuing.

### 3. Read context

- Read SPEC fully
- Read `.specify/memory/constitution.md` if it exists
- Read the project's `CLAUDE.md` for full conventions reference

### 4. Backup

```bash
cp SPEC SPEC.pre-upgrade
```

This allows rollback if the merge produces unwanted results.

### 5. Create temp directory

```bash
mkdir -p FEATURE_DIR/.upgrade-parts
```

### 6. Launch 3 analysis agents IN PARALLEL

Spawn all 3 agents in a **single message** for true concurrency. Use the Agent tool with **general-purpose** subagent_type (agents need Write access for their output files). Use `model: "opus"` for all agents.

**CRITICAL — Path substitution**: Before spawning each agent, replace ALL placeholders with actual resolved absolute paths:
- `FEATURE_DIR` → the absolute path from check-prerequisites.sh (e.g., `/Users/toko/Desktop/medplum_medimind/specs/068-nursing-workstation`)
- `[ABSOLUTE_SPEC_PATH]` → the resolved SPEC path (e.g., `/Users/toko/Desktop/medplum_medimind/specs/068-nursing-workstation/spec.md`)

Do NOT pass literal placeholder strings to agents.

Also include in every agent prompt: "Read CLAUDE.md at the repo root for complete project conventions (color system, component rules, dark mode, mobile-first, FHIR patterns, typography)."

---

#### Agent 1: Edge Cases & Unhappy Paths
**Write to**: `FEATURE_DIR/.upgrade-parts/01-edge-cases.md`

Read the spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions. For EVERY user story and functional requirement, identify what's missing:

- **Error states**: Network failure, server errors, timeout, invalid FHIR responses, API rate limiting
- **Boundary conditions**: Empty lists, max-length inputs, zero quantities, duplicate submissions, single-item vs many-items
- **Concurrent users**: Two users editing same resource, stale data, optimistic locking needs
- **Data integrity**: Partial saves, interrupted operations, orphaned FHIR resources
- **Empty/null states**: No data yet, no search results, optional FHIR fields missing, no permissions granted
- **Input validation**: Special characters, Georgian script edge cases, 11-digit personal ID validation, date boundaries

**Cap at 15 most critical findings.** Prioritize by impact: data loss > security > UX > cosmetic.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Gap: [descriptive title]
- **Affected Story**: [which user story]
- **Current Spec Says**: [quote or summary]
- **What's Missing**: [the gap]
- **Suggested Addition**: [exact text to add to spec — business language, no implementation details]
```

---

#### Agent 2: Production Readiness
**Write to**: `FEATURE_DIR/.upgrade-parts/02-production.md`

Read the spec at [ABSOLUTE_SPEC_PATH]. Read `.specify/memory/constitution.md`. Read CLAUDE.md for project conventions. Audit for missing production concerns:

- **Performance**: Response time expectations, list pagination limits, lazy loading thresholds, search debounce
- **Security & RBAC**: Which roles can access this feature? What permission gates are needed? PHI data handling? Audit logging?
- **Accessibility**: WCAG keyboard navigation, screen reader support, 44px min tap targets, color contrast ratios
- **i18n**: Are ALL user-facing strings flagged for translation in Georgian (ka), English (en), and Russian (ru)?
- **Offline support**: What happens when the user loses connection? IndexedDB queueing? Sync conflict resolution?
- **Mobile responsiveness**: Mobile-first layout requirements? Touch interactions? Responsive breakpoints (xs/sm/md/lg/xl)?
- **Dark mode**: Both light and dark themes must work — spec should mention this if feature has custom visuals
- **FHIR R4 compliance**: Are the correct FHIR resources specified? Extension URLs following `http://medimind.ge/fhir/StructureDefinition/` pattern? Identifier systems from fhir-systems.ts?

**Cap at 15 most critical findings.** Prioritize: security > data compliance > performance > accessibility > cosmetic.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Gap: [descriptive title]
- **Affected Story**: [which user story or "Non-Functional"]
- **Current Spec Says**: [quote or summary]
- **What's Missing**: [the gap]
- **Suggested Addition**: [exact text to add to spec — business language, no implementation details]
```

---

#### Agent 3: User Scenarios & UI Integration
**Write to**: `FEATURE_DIR/.upgrade-parts/03-scenarios.md`

Read the spec at [ABSOLUTE_SPEC_PATH]. Read CLAUDE.md for project conventions. Also read these codebase files for context:
- `packages/app/src/emr/constants/routes.ts` (existing route patterns)
- Scan `packages/app/src/emr/components/HorizontalSubMenu/` (navigation tabs)
- Scan `packages/app/src/emr/components/EMRMainMenu/` (main menu entries)

Audit for:

- **User roles**: Has the spec considered ALL relevant roles? (doctor, nurse, admin, receptionist, pharmacist, lab tech, department head). List any missing role perspectives.
- **Complete workflows**: Not just happy path — what about cancel, back, undo, retry, timeout, session expiry?
- **UI integration**: Is route registration mentioned? Menu/submenu hookup? How does user navigate TO this feature and AWAY from it?
- **Cross-feature interactions**: Does this feature affect existing features? (e.g., patient history, bed board, lab queue)
- **E2E test scenarios**: For every acceptance criterion, write a concrete Playwright E2E scenario (user does X → sees Y)
- **Frontend-designer rule**: ALL UI implementation must note that the `frontend-designer` agent handles it (per project convention)

**Cap at 15 most critical findings.** Prioritize: missing workflows > missing roles > UI integration > test scenarios.

Format each finding as:

```
## [CRITICAL|HIGH|MEDIUM] Gap: [descriptive title]
- **Affected Story**: [which user story]
- **Current Spec Says**: [quote or summary]
- **What's Missing**: [the gap]
- **Suggested Addition**: [exact text to add to spec — business language, no implementation details]
```

---

### 7. Wait and handle failures

Wait for all 3 agents to complete. Then:
- If ALL 3 succeeded: read all files from `FEATURE_DIR/.upgrade-parts/`
- If some failed: warn the user which agent(s) failed, proceed with successful findings only, do NOT delete `.upgrade-parts/` so the user can inspect

### 8. Consolidate and update spec.md

- Deduplicate findings across agents (same gap from multiple agents = high confidence, mention once)
- **Process CRITICAL findings first**, then HIGH, then MEDIUM
- Integrate each unique finding into the appropriate spec.md section:
  - Edge cases → add to "Edge Cases" section (create if missing)
  - Production concerns → add to "Non-Functional Requirements"
  - Missing user scenarios → expand existing user stories or add new ones
  - UI integration points → add to relevant user story or "UI Integration" section
  - E2E test scenarios → add to "Testing" or "Acceptance Criteria" section
- **Preserve ALL existing content** — only append/enhance, never remove
- Keep the spec business-focused (WHAT, not HOW) — absolutely no implementation details
- Add `<!-- UPGRADED -->` marker at the top of the file (after the title)

### 9. Post-merge validation

Quick sanity check after editing:
- Count sections before and after — no sections should have been deleted
- Verify no empty sections were introduced
- Confirm the markdown structure is valid (headings, lists, tables intact)

### 10. Show diff

Run `git diff SPEC` to show the user exactly what changed. This makes review easy.

### 11. Cleanup

Only if all agents succeeded and merge was validated:
```bash
rm -rf FEATURE_DIR/.upgrade-parts
```
Keep `.pre-upgrade` backup file — the user can delete it manually once satisfied.

### 12. Report

Show a summary table:

| Severity | Gaps Found | Added to Spec |
|----------|-----------|---------------|
| CRITICAL | N | N |
| HIGH | N | N |
| MEDIUM | N | N |
| **Total** | **N** | **N** |

Then show:
- Path to updated spec.md
- Path to backup at spec.pre-upgrade
- "Review the diff above. If anything looks wrong, restore with: `cp SPEC.pre-upgrade SPEC`"
