// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// phaseStubLog — centralized stub-log helper (M-PACS-6)
// ============================================================================
// Many PACS service modules (imagingStudyService, auditService, fhirClient,
// criticalAlertService, etc.) were ported from MediMind and still call into
// "Phase 4 will wire this" stubs. Every stub used to issue its own ad-hoc
// `console.warn('[fhir-stub] foo not wired: …')` line — 40+ sites total.
//
// That worked for "what does the running UI actually call?" diagnostics but
// becomes a logging firehose once any of these surfaces lights up under
// load. This module is the single funnel for stub call logging:
//
//   - Toggleable via `LIVERRA_STUB_LOGGING` (default OFF in production).
//   - Deduplicates same fn+args inside a single tab session.
//   - Emits a Sentry breadcrumb (via captureException) so production
//     telemetry sees which UI surfaces still depend on unwired endpoints,
//     even when the console log is suppressed.
//   - Tagged with a `serviceName` so a glob over service logs is grep-able.
//
// When Phase 4 wires a real persistence layer for a given service,
// the call sites simply drop the `phaseStubLog` line — no other refactor
// required.
// ============================================================================

import { captureException } from '../observability/sentryInit';

const STUB_LOGGED = new Set<string>();

/**
 * Best-effort detection of "stub logging enabled?" — reads from
 * `import.meta.env` at module init and falls back to `false` in any
 * environment where Vite's env injection isn't available. The flag is
 * deliberately a *string compare* so build-time replacement works even if
 * the value is `'false'` rather than the boolean `false`.
 */
function isStubLoggingEnabled(): boolean {
  try {
    const env = (import.meta as { env?: Record<string, unknown> }).env;
    if (!env) return false;
    const flag = env.VITE_LIVERRA_STUB_LOGGING ?? env.LIVERRA_STUB_LOGGING;
    return flag === true || flag === 'true' || flag === '1';
  } catch {
    return false;
  }
}

const STUB_LOGGING_ENABLED = isStubLoggingEnabled();

/**
 * Emit a single phase-stub log entry. Safe to call from any service.
 *
 * @param serviceName — short tag for the calling service ("imaging-stub",
 *   "fhir-stub", "audit-stub" etc.) so log lines + Sentry breadcrumbs are
 *   grep-able by area.
 * @param fnName — the unwired function name being invoked.
 * @param args — argument summary (safe to pass; PHI-bearing params should
 *   be scrubbed by the caller before invoking).
 */
export function phaseStubLog(
  serviceName: string,
  fnName: string,
  args: Record<string, unknown> = {},
): void {
  const key = `${serviceName}|${fnName}|${JSON.stringify(args)}`;
  if (STUB_LOGGED.has(key)) return;
  STUB_LOGGED.add(key);

  if (STUB_LOGGING_ENABLED) {
    // eslint-disable-next-line no-console
    console.warn(`[${serviceName}] ${fnName} not wired:`, args);
  }

  // Always emit a Sentry breadcrumb so production telemetry sees the
  // stub-call pattern even when console logging is suppressed. Wrapped in
  // try/catch so a missing Sentry init never breaks the service.
  try {
    captureException(new Error(`stubbed_call: ${serviceName}:${fnName}`), {
      source: `${serviceName}.phaseStubLog`,
      serviceName,
      fnName,
      ...args,
    });
  } catch {
    // Sentry not initialised — fine.
  }
}

/**
 * Test helper: reset the dedupe set so unit tests can assert "logs once
 * per session". Not exported from the module's public surface in
 * production builds; the constant is referenced only by tests.
 */
export function __resetStubLogDedupe(): void {
  STUB_LOGGED.clear();
}
