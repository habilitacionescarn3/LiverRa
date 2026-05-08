# Quality Gates

Quality gates are checked during the final report (Step 10) and displayed as a separate table.

## Hard Gates (change the verdict)

- **Zero CRITICAL Findings** — If ANY CRITICAL finding exists across all agents, overall verdict MUST be **FAIL**, regardless of individual agent verdicts.

## Soft Gates (informational — change PASS to PASS WITH WARNINGS)

- If test coverage is below threshold but no CRITICAL findings, verdict becomes PASS WITH WARNINGS.
- If other gates fail but no CRITICAL findings, verdict becomes PASS WITH WARNINGS.

## Gate Definitions

| Gate | Threshold | Hard/Soft | Source |
|------|-----------|-----------|--------|
| Zero CRITICAL findings | 0 CRITICAL across all agents | **Hard** | All reports |
| Test Coverage (Statements) | >= 60% | Soft | Agent 01 report |
| Test Coverage (Branches) | >= 60% | Soft | Agent 01 report |
| Translation completeness (ka) | >= 95% of keys used in target area | Soft | Agent 07 report |
| E2E Operation Coverage | >= 1 Create + 1 Edit + 1 Status Change attempted | Soft | Agent 02 report |

## Skipped Agents

For any quality gate that references an agent marked as skipped (e.g., Agent 02 when Playwright unavailable), display "SKIPPED" in the Actual and Status columns instead of "0 / FAIL".

## Display Format (in final report)

```markdown
## Quality Gates
| Gate | Threshold | Actual | Status |
|------|-----------|--------|--------|
| Zero CRITICAL Findings (Hard) | 0 | N | PASS/FAIL |
| Statement Coverage | >= 60% | N% | PASS/FAIL |
| Branch Coverage | >= 60% | N% | PASS/FAIL |
| Georgian Translation | >= 95% | N% | PASS/FAIL |
| E2E Operation Coverage | >= 1 Create + 1 Edit + 1 Status Change | N Create, N Edit, N Status | PASS/FAIL |
```
