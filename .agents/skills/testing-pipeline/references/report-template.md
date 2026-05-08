# Final Report Template

## Verdict Logic

1. Read each agent's report and extract their individual verdict (PASS/FAIL/WARNING)
2. **Hard Gate Check:** Count CRITICAL findings across ALL agent reports. If any CRITICAL finding exists, overall verdict MUST be **FAIL**.
3. Calculate overall verdict:
   - **FAIL** — Any CRITICAL finding exists (hard gate), OR any agent has verdict FAIL
   - **PASS WITH WARNINGS** — No FAIL verdicts and no CRITICAL findings, but at least one WARNING or soft gate failure
   - **PASS** — All 10 agents report PASS, all quality gates pass

## Cost & Time Tracking

Calculate from state file:
- **Elapsed time:** Difference between `startedAt` and current time
- **Agent invocations:** Total from `agentInvocations` counter

## Report Format

Write the merged report to: `qa-reports/{area}-qa-{YYYY-MM-DD}.md`

```markdown
# QA Report: {Area} — Full Testing Pipeline
**Date:** YYYY-MM-DD | **Branch:** main | **Pipeline Version:** 5.0
**Iterations:** {N} of 3 | **Auto-fixes Applied:** {count}
**Agent Invocations:** {N} | **Elapsed Time:** {N} minutes

## Overall Verdict: PASS / PASS WITH WARNINGS / FAIL

## Executive Dashboard
| # | Agent | Pass | Fail | Warning | Verdict |
|---|-------|------|------|---------|---------|
| 01 | Unit Tests       | N | N | N | PASS/FAIL |
| 02 | E2E Browser      | N | N | N | PASS/FAIL |
| 03 | Edge Cases       | N | N | N | PASS/FAIL |
| 04 | FHIR Compliance  | N | N | N | PASS/FAIL |
| 05 | Security         | N | N | N | PASS/FAIL |
| 06 | UI/UX            | N | N | N | PASS/FAIL |
| 07 | i18n & Quality   | N | N | N | PASS/FAIL |
| 08 | Performance      | N | N | N | PASS/FAIL |
| 09 | Dependencies     | N | N | N | PASS/FAIL |
| 10 | Integration      | N | N | N | PASS/FAIL |
| **TOTAL** | | **N** | **N** | **N** | **VERDICT** |

## Quality Gates
| Gate | Threshold | Actual | Status |
|------|-----------|--------|--------|
| Zero CRITICAL Findings (Hard) | 0 | N | PASS/FAIL |
| Statement Coverage | >= 60% | N% | PASS/FAIL |
| Branch Coverage | >= 60% | N% | PASS/FAIL |
| Georgian Translation | >= 95% | N% | PASS/FAIL |
| E2E Operation Coverage | >= 1 Create + 1 Edit + 1 Status Change | N Create, N Edit, N Status | PASS/FAIL |

## Auto-Fix Summary
| Iteration | Found | Auto-Fixed | Skipped | Remaining |
|-----------|-------|------------|---------|-----------|
| 1         | N     | N          | N       | N         |
| 2         | N     | N          | N       | N         |

## Files Modified by Auto-Fix
| File | Fixes | What Changed |
|------|-------|-------------|
| stockMoveService.ts | 3 | Replaced hardcoded URLs, removed console.log |

## Remaining Issues (Manual Review Required)
[Any findings the pipeline couldn't safely auto-fix — grouped by severity]

### Immediate (blocks deploy)
- [Critical findings that must be fixed manually]

### Soon (next sprint)
- [Important findings that should be addressed]

### Backlog (when time permits)
- [Minor findings for later]

---

## Part 1: Unit Tests
[Full content from 01-unit-tests.md]

## Part 2: E2E Browser Tests
[Full content from 02-e2e-browser.md]

## Part 3: Edge Case Analysis
[Full content from 03-edge-cases.md]

## Part 4: FHIR Compliance
[Full content from 04-fhir-compliance.md]

## Part 5: Security Scan
[Full content from 05-security.md]

## Part 6: UI/UX Testing
[Full content from 06-ui-ux.md]

## Part 7: i18n & Code Quality
[Full content from 07-i18n-quality.md]

## Part 8: Performance Profiling
[Full content from 08-performance.md]

## Part 9: Dependency & Build Health
[Full content from 09-dependencies.md]

## Part 10: Integration & Data Integrity
[Full content from 10-integration.md]
```
