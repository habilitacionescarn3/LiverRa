# Agent Dispatch Tables

## Wave 1: Static Analysis + Unit Tests (7 agents in parallel)

| # | Agent | subagent_type | Output File |
|---|-------|---------------|-------------|
| 01 | Unit Tests | qa-unit-test-runner | `qa-reports/.parts/01-unit-tests.md` |
| 03 | Edge Cases | qa-edge-case-analyzer | `qa-reports/.parts/03-edge-cases.md` |
| 04 | FHIR Compliance | qa-fhir-validator | `qa-reports/.parts/04-fhir-compliance.md` |
| 05 | Security | qa-security-scanner | `qa-reports/.parts/05-security.md` |
| 07 | i18n & Quality | qa-i18n-quality | `qa-reports/.parts/07-i18n-quality.md` |
| 09 | Dependencies | qa-dependency-audit | `qa-reports/.parts/09-dependencies.md` |
| 10 | Integration | qa-integration-tester | `qa-reports/.parts/10-integration.md` |

## Wave 2: Browser Agents (3 agents in parallel)

| # | Agent | subagent_type | Output File |
|---|-------|---------------|-------------|
| 02 | E2E Browser | qa-e2e-browser-tester | `qa-reports/.parts/02-e2e-browser.md` | **Must include Georgian language verification (Phase 3D)** |
| 08 | Performance | qa-performance-profiler | `qa-reports/.parts/08-performance.md` |
| 06 | UI/UX | qa-ui-ux-tester | `qa-reports/.parts/06-ui-ux.md` |

## Named Browser Context Instructions

When spawning each Wave 2 browser agent, add this to their prompt:

```
NAMED CONTEXT: Use --context {agentNN} for ALL your Playwright commands.
Example: npx tsx scripts/playwright/cmd.ts --context agent02 navigate "http://localhost:3000"
This gives you your own isolated browser tab. You MUST log in separately.
```

Replace `{agentNN}` with `agent02`, `agent08`, or `agent06` for each agent respectively.

## Agent Timeout Rules

- **Wave 1 agents:** Set `timeout: 600000` (10 minutes) on each Task tool call
- **Wave 2 browser agents:** Set `timeout: 900000` (15 minutes) on each Task tool call
- **If an agent times out:** Create a stub report at its output file:
  ```
  ## Verdict: FAIL
  **Reason:** Agent timed out after {N} minutes.
  ```
  The finding will appear as UNPARSED in triage (no `#### FINDING:` blocks).

## Example Prompt Structure (for all agents)

```
You are the [Agent Name] agent for the MediMind testing pipeline.

[Shared Context Block from references/shared-context.md]

YOUR OUTPUT FILE: qa-reports/.parts/0N-name.md

[Agent-specific instructions from their .md file]

Write your complete findings to YOUR OUTPUT FILE when done.
```
