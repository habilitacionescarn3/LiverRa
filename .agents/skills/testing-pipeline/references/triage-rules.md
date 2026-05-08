# Triage Classification Rules

## Finding Deduplication

Before classifying, deduplicate findings by `(file, line, category)` tuple:

1. Group all findings that share the same file AND category code
2. **Line number matching:** If one finding has a specific line and another has "N/A" for the same file+category, treat them as duplicates. Keep the one with the specific line number.
3. If both have specific but different lines — NOT duplicates (keep both)
4. If multiple agents flagged the same `(file, line, category)`:
   - Keep the finding with the **highest severity**
   - If same severity, keep the one with the most specific fix suggestion
   - Record which other agents also flagged it (e.g., "Also flagged by: Agent 03, Agent 07")
5. **UNPARSED findings:** Deduplicate by `(agent, category)` — NOT by `(file, line, category)`. Two agents with UNPARSED findings are distinct problems and must both be kept.

---

## Auto-Fixable Findings

| Agent | Category Code | Fix Action |
|-------|--------------|------------|
| 04 FHIR | FC1 | Replace hardcoded URL string with constant from `fhir-systems.ts` |
| 04 FHIR | FC5 | Move search prefix to value string |
| 04 FHIR | FC6 | Use `IDENTIFIER_SYSTEMS.*` constant |
| 04 FHIR | FC8 | Change to `valueDate` or `valueDateTime` |
| 04 FHIR | FC10 (LOW only) | Add `_count: '100'` to unbounded `searchResources()` call |
| 07 i18n | I18N1 | Add missing key to `ka.json`/`ru.json` with English as placeholder |
| 07 i18n | I18N2 | Wrap hardcoded string with `t('key')` and add to translation files |
| 07 i18n | I18N3 | Remove `console.log` line |
| 07 i18n | I18N4 | Remove unused import line |
| 07 i18n | I18N5 | Remove commented-out/dead code block |
| 06 UI/UX | UI1 | Replace forbidden hex with `var(--emr-*)` per CLAUDE.md theme mapping |
| 06 UI/UX | UI2 | Replace hardcoded px font size with `var(--emr-font-*)` |
| 06 UI/UX | UI3 | Replace `--emr-gray-N` background with semantic `var(--emr-bg-*)` |
| 06 UI/UX | UI5 (LOW only) | For icon-only buttons missing `aria-label` — add `aria-label` based on icon name (e.g., `<IconEdit />` -> `aria-label="Edit"`) |
| 06 UI/UX | UI10 (LOW only) | Add `position: relative; z-index: 1` to the element being covered (simple overlap cases only) |
| 03 Edge | EC1 (LOW/MEDIUM only) | Add `?.` operator |
| 03 Edge | EC5 (LOW only) | Add `?.[0]` fallback |
| 03 Edge | EC9 (LOW only) | Add cleanup return to `useEffect` (e.g., `removeEventListener`, `clearInterval`) |
| 05 Security | SEC11 (MEDIUM/LOW) | Replace `error.message` in notification with `t('genericError')` |
| 07 i18n | I18N6 | Replace hardcoded date format string with `toLocaleDateString()` call |
| 07 i18n | I18N7 | Replace template literal currency with `Intl.NumberFormat` |
| 07 i18n | I18N8 | Wrap hardcoded error string in notification with `t('key')` |
| 09 Dependencies | DEP4 (LOW only) | Remove unnecessary `as any` when the type is already correct (e.g., `value as any as string` -> `value as string`) |

**Note:** Pagination checks (unbounded `searchResources()`) are handled exclusively by Agent 04 as FC10. Agents 03 and 07 no longer check for this — eliminating triple-overlap.

**Default Rule:** Any finding code + severity combination not explicitly listed in the Auto-Fixable table above is treated as **manual-review**. This covers severity gaps (e.g., EC1 at HIGH, FC10 at MEDIUM, UI5 at MEDIUM, PERF2 at LOW, DEP1 at LOW, DEP4 at MEDIUM).

---

## Manual-Review Findings (NOT auto-fixed)

| Agent | Category / Pattern | Why Manual |
|-------|-------------------|-----------|
| 01 Unit | UT1: Test Syntax Error | Fixing test syntax requires understanding test intent |
| 01 Unit | UT2: Test Runtime Error | Runtime errors need debugging context |
| 01 Unit | Failed tests | Could be real bug vs outdated test — needs judgment |
| 01 Unit | Missing test files | Writing new tests requires understanding intent |
| 02 E2E | E2E1: Page Load Failure | Could be routing, build, or server issue |
| 02 E2E | Broken journeys | Root cause unclear from screenshot alone |
| 03 Edge | CRITICAL severity | Data corruption risk — human must verify |
| 03 Edge | EC3: Race Condition | Concurrency fixes require architectural understanding |
| 03 Edge | Async/concurrency issues | Wrong fix could introduce new bugs |
| 04 FHIR | FC3: Missing reference fields | Needs to know what reference should point to |
| 04 FHIR | FC4: Missing required fields | Could break other code that reads the resource |
| 05 Security | SEC1 through SEC7 (regardless of severity) | Security fixes need human review |
| 06 UI/UX | Layout broken at viewport | Needs visual/design judgment |
| 01 Unit | UT4: Low coverage threshold | Writing new tests requires understanding intent |
| 01 Unit | UT5: Placeholder tests | Filling tests requires understanding requirements |
| 02 E2E | E2E4: Missing permission gate | Requires understanding intended access model |
| 02 E2E | E2E5: Deep link failure | Root cause could be routing, state, or auth |
| 03 Edge | EC7: Floating-point precision | Wrong fix could change financial calculations |
| 03 Edge | EC8: Georgian encoding | Needs understanding of full data flow |
| 03 Edge | EC9 (HIGH/CRITICAL) | Memory leak in critical path needs careful refactor |
| 04 FHIR | FC9: Bundle validation | Missing bundle fields could break transactions |
| 04 FHIR | FC10 (HIGH/CRITICAL) | Pagination in analytics needs architectural decision |
| 04 FHIR | FC11: Reference target type | Wrong type could corrupt data relationships |
| 05 Security | SEC8: Query string PII | Needs redesign of URL parameter strategy |
| 05 Security | SEC9: Frontend-only validation | Needs backend StructureDefinition or Bot |
| 05 Security | SEC10: Audit logging gaps | Requires adding audit calls — needs judgment |
| 05 Security | SEC11 (HIGH/CRITICAL) | Error leakage in critical path needs review |
| 06 UI/UX | UI4: Reserved | Not currently assigned — skip if encountered |
| 06 UI/UX | UI6-UI9 (all) | Layout/accessibility changes need design input |
| 06 UI/UX | UI10 (HIGH/CRITICAL) | Overlapping elements in critical path needs layout redesign |
| 06 UI/UX | UI11: Missing Empty State | Requires creating new empty state component/text |
| 04 FHIR | FC2: Extension URL Pattern | Extension URL refactoring needs verification across all usage sites |
| 04 FHIR | FC7: Status Values | Wrong status value could break state machines |
| 03 Edge | EC2: Boundary Values | Edge case handling needs understanding of valid ranges |
| 03 Edge | EC4: Network/API Failures | Error handling strategy needs architectural context |
| 03 Edge | EC6: Error Propagation | Error handling changes could affect callers |
| 01 Unit | UT3: Coverage Gap | Writing tests requires understanding feature intent |
| 02 E2E | E2E2: Console Error | Root cause needs investigation from stack trace |
| 02 E2E | E2E3: Navigation Error | Could be routing, auth, or data issue |
| 08 Performance | PERF1: Slow Page Load | Runtime measurement — needs profiling to find root cause |
| 08 Performance | PERF2: Large Bundle Import (HIGH+) | Changing import strategy could break lazy loading |
| 08 Performance | PERF3: Memory Leak Suspect | Needs memory profiling to confirm and fix |
| 08 Performance | PERF4: Unvirtualized Large List | Requires adding virtualization library — architectural change |
| 08 Performance | PERF5: Slow API Call | Backend/query optimization needed |
| 09 Dependencies | DEP1: Vulnerability (HIGH+) | Package updates can break APIs — needs testing |
| 09 Dependencies | DEP2: Outdated Package | Major version upgrades need migration plan |
| 09 Dependencies | DEP3: License Issue | Legal review needed |
| 09 Dependencies | DEP4 (HIGH+) | Removing `as any` requires understanding the actual type |
| 09 Dependencies | DEP5: Duplicate Dependency | Resolution requires understanding dependency tree |
| 10 Integration | INT1: Data Mismatch | Transformation logic requires domain knowledge |
| 10 Integration | INT2: Orphaned Resource | Rollback design requires understanding the workflow |
| 10 Integration | INT3: State Inconsistency | Cache invalidation strategy needs architectural decision |
| 10 Integration | INT4: Missing Cascade | Cascade logic requires understanding resource relationships |
| 07 i18n | I18N9: Raw Code Display | Needs a display mapping function, not just t() wrap — requires understanding data flow from FHIR to UI |
| 02 E2E | E2E6: Untranslated Text | Needs investigation — could be missing key, key typo, or raw data value needing translation mapping |

---

## Unparseable FAIL Handling

For each agent with FAIL verdict but zero extracted `#### FINDING:` blocks, create a synthetic finding:
- agent: {agent number}
- category: "UNPARSED"
- severity: HIGH
- file: "N/A"
- line: "N/A"
- title: "Agent {N} reported FAIL with no structured findings"
- description: "Review raw report at qa-reports/.parts/0N-*.md"
- classification: manual-review

This prevents the pipeline from looping to re-run agents that consistently produce unparseable FAIL reports.
