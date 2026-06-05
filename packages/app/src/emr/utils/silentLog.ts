// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight catch-block logger for non-critical paths.
 *
 * Use this in `} catch (err) { silentLog('scope', 'op', err); }` blocks
 * inside PACS / Cornerstone init, viewer hooks, parsing helpers, etc.
 * — places where the operation is best-effort and a failure should not
 * propagate or surface to the user, but the dev DOES want a debug trail.
 *
 * Emits at `debug` level only (filtered out of production browsers by
 * default but visible when DevTools verbose is enabled).
 *
 * Replaces ~196 silent `} catch {}` blocks identified by the audit.
 */
export function silentLog(scope: string, op: string, err?: unknown): void {
  if (typeof console === 'undefined') return;
  const message = err instanceof Error ? err.message : err === undefined ? '' : String(err);
  console.debug(`[${scope}] ${op}${message ? `: ${message}` : ''}`);
}
