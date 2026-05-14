// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrClipboardService — orchestrates the Copy to Clipboard workflow.
 *
 * Workflow (research §D2, contracts/audit-event.md):
 *   1. Capture the panel-open ETag.
 *   2. Probe `HEAD /report/summary`; if ETag changed → block with
 *      "data changed - refresh" failure.
 *   3. Write plain text to clipboard via `navigator.clipboard.writeText`,
 *      with `document.execCommand('copy')` fallback for iOS Safari.
 *   4. POST the audit envelope to `/report/clipboard-export`.
 *   5. On audit failure → enqueue to IndexedDB; success on a later session.
 *   6. Emit success/failure PostHog event.
 *
 * Idempotency: `client_action_id` is generated once per click and
 * reused across all retries (server uses ON CONFLICT DO NOTHING).
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ulid } from 'ulid';

import { LIVERRA_EXTENSIONS as _LIVERRA_EXTENSIONS } from '../../constants/fhir-extensions';
import { renderReadoutPlainText } from './acrPlainTextRenderer';
import type { ReadoutSnapshot } from './acrAnatomicalMapping';
import { headReportSummaryEtag } from './reportSummary';
import {
  trackCopyFailed,
  trackCopySucceeded,
} from './acrTelemetry';

// Reference the extensions module so it isn't tree-shaken — the audit
// payload uses extension URLs registered in LIVERRA_EXTENSIONS so a
// future server-side validator can cross-check. Currently the server
// derives URLs itself; this keeps both sides referencing the same
// registry (T031 wiring).
void _LIVERRA_EXTENSIONS;

const QUEUE_DB = 'liverra-acr-audit';
const QUEUE_VERSION = 1;
const QUEUE_STORE = 'pendingAcrAuditEvents';

export type FailureCategory =
  | 'network'
  | 'clipboard_blocked'
  | 'audit_chain_unavailable'
  | 'auth_denied'
  | 'tenant_violation'
  // C-ACR-2: stale-view (ETag mismatch / view drift) is distinct from
  // an audit-chain outage — it's the user's view that's out of date.
  | 'stale_view';

export interface ClipboardExportAuditPayload {
  client_action_id: string;
  actor_role: string;
  locale: string;
  action_timestamp: string;
  outcome: 'success' | 'failure';
  failure_category: FailureCategory | null;
}

export interface ClipboardServiceContext {
  analysisId: string;
  /** Role to record on the audit envelope (role-at-action-time). */
  actorRole: string;
  /** ETag captured at panel-open; freshness gate compares against current. */
  openTimeEtag: string | null;
  /** Translation function for user-facing messages (toasts). */
  t: (key: string, fallback?: string) => string;
}

export type CopyOutcome =
  | { kind: 'success'; clientActionId: string; durationMs: number; queuedAudit: boolean }
  | {
      kind: 'failure';
      reason: FailureCategory;
      clientActionId: string;
      durationMs: number;
      message: string;
    };

interface PendingAuditDB extends DBSchema {
  pendingAcrAuditEvents: {
    key: string;
    value: {
      id: string;
      analysisId: string;
      payload: ClipboardExportAuditPayload;
      enqueuedAt: string;
      attemptCount: number;
      lastError: string | null;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<PendingAuditDB>> | null = null;

function getDb(): Promise<IDBPDatabase<PendingAuditDB>> {
  if (!dbPromise) {
    dbPromise = openDB<PendingAuditDB>(QUEUE_DB, QUEUE_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

/** Reset the lazy singleton — tests only. */
export function __resetForTests(): void {
  dbPromise = null;
}

async function enqueue(
  analysisId: string,
  payload: ClipboardExportAuditPayload,
  error: string,
): Promise<void> {
  const db = await getDb();
  await db.put(QUEUE_STORE, {
    id: payload.client_action_id,
    analysisId,
    payload,
    enqueuedAt: new Date().toISOString(),
    attemptCount: 1,
    lastError: error,
  });
}

export async function pendingQueueDepth(): Promise<number> {
  try {
    const db = await getDb();
    return await db.count(QUEUE_STORE);
  } catch {
    return 0;
  }
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function writeToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // iOS Safari fallback — hidden textarea + execCommand. Synchronous
  // path; must run inside the user-gesture stack.
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!ok) throw new Error('execCommand copy returned false');
    return;
  }
  throw new Error('No clipboard API available');
}

async function postAuditEnvelope(
  analysisId: string,
  payload: ClipboardExportAuditPayload,
): Promise<Response> {
  const base = readApiBaseUrl();
  return fetch(
    `${base}/analyses/${encodeURIComponent(analysisId)}/report/clipboard-export`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

function categoriseAuditFailure(status: number): FailureCategory {
  if (status === 401) return 'auth_denied';
  if (status === 403) return 'tenant_violation';
  if (status >= 500) return 'network';
  if (status >= 400) return 'audit_chain_unavailable';
  return 'network';
}

/**
 * Drain any audit events queued by a previous session. Best-effort —
 * failures keep the events in the queue for the next pass.
 */
export async function drainPendingAuditQueue(): Promise<void> {
  try {
    const db = await getDb();
    const all = await db.getAll(QUEUE_STORE);
    for (const row of all) {
      try {
        const r = await postAuditEnvelope(row.analysisId, row.payload);
        if (r.ok) {
          await db.delete(QUEUE_STORE, row.id);
        } else if (r.status === 401 || r.status === 403) {
          // Terminal: drop — auth/tenant errors won't resolve on replay.
          await db.delete(QUEUE_STORE, row.id);
        } else {
          // Bump attempt counter, keep for next session.
          await db.put(QUEUE_STORE, {
            ...row,
            attemptCount: row.attemptCount + 1,
            lastError: `HTTP ${r.status}`,
          });
        }
      } catch (err) {
        await db.put(QUEUE_STORE, {
          ...row,
          attemptCount: row.attemptCount + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch {
    // Queue inaccessible — try again next session.
  }
}

export interface CopyReadoutArgs {
  snapshot: ReadoutSnapshot;
  context: ClipboardServiceContext;
}

/**
 * Run the full copy workflow. Always emits one audit attempt (queued
 * if the POST fails). Caller toasts based on `CopyOutcome.kind`.
 */
export async function copyReadout(args: CopyReadoutArgs): Promise<CopyOutcome> {
  const { snapshot, context } = args;
  const clientActionId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : ulid();
  const start =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const actionTimestamp = new Date().toISOString();
  const lesionCount = snapshot.sections.find((s) => s.section === 'lesions')?.rows.length ?? 0;

  // 1. Freshness probe.
  try {
    const currentEtag = await headReportSummaryEtag(snapshot.analysisId);
    if (
      currentEtag &&
      context.openTimeEtag &&
      currentEtag !== context.openTimeEtag
    ) {
      const durationMs = elapsedMs(start);
      // C-ACR-2: stale-view is its own failure category — not
      // `audit_chain_unavailable` (which implies a backend outage).
      const failure: ClipboardExportAuditPayload = {
        client_action_id: clientActionId,
        actor_role: context.actorRole,
        locale: snapshot.locale,
        action_timestamp: actionTimestamp,
        outcome: 'failure',
        failure_category: 'stale_view',
      };
      // Same durable-enqueue contract as every other failure path:
      // POST first, fall back to the IndexedDB queue on transport error
      // so the audit row eventually lands.
      try {
        const r = await postAuditEnvelope(snapshot.analysisId, failure);
        if (!r.ok && r.status !== 401 && r.status !== 403) {
          await enqueue(snapshot.analysisId, failure, `HTTP ${r.status}`);
        }
      } catch (err) {
        await enqueue(
          snapshot.analysisId,
          failure,
          err instanceof Error ? err.message : String(err),
        );
      }
      trackCopyFailed({
        analysisId: snapshot.analysisId,
        locale: snapshot.locale,
        failureCategory: 'stale',
        durationMs,
      });
      return {
        kind: 'failure',
        reason: 'stale_view',
        clientActionId,
        durationMs,
        message: context.t(
          'reportAcr:copy.errorToastStale',
          'Analysis updated by another reviewer - refresh to copy',
        ),
      };
    }
  } catch (probeErr) {
    const status = (probeErr as { message?: string })?.message?.match(/HTTP (\d+)/)?.[1];
    if (status === '401' || status === '403') {
      const durationMs = elapsedMs(start);
      const reason: FailureCategory = status === '401' ? 'auth_denied' : 'tenant_violation';
      trackCopyFailed({
        analysisId: snapshot.analysisId,
        locale: snapshot.locale,
        failureCategory: reason,
        durationMs,
      });
      return {
        kind: 'failure',
        reason,
        clientActionId,
        durationMs,
        message: context.t(
          'reportAcr:copy.errorToastAuthDenied',
          'Your access to this analysis was revoked - refresh',
        ),
      };
    }
    // Network or transient — proceed; the audit POST will surface any real failure.
  }

  // 2. Render plain text.
  const text = renderReadoutPlainText(snapshot);

  // 3. Clipboard write.
  try {
    await writeToClipboard(text);
  } catch (err) {
    const durationMs = elapsedMs(start);
    const failure: ClipboardExportAuditPayload = {
      client_action_id: clientActionId,
      actor_role: context.actorRole,
      locale: snapshot.locale,
      action_timestamp: actionTimestamp,
      outcome: 'failure',
      failure_category: 'clipboard_blocked',
    };
    try {
      await postAuditEnvelope(snapshot.analysisId, failure);
    } catch {
      await enqueue(snapshot.analysisId, failure, 'clipboard-block audit POST failed');
    }
    trackCopyFailed({
      analysisId: snapshot.analysisId,
      locale: snapshot.locale,
      failureCategory: 'clipboard_blocked',
      durationMs,
    });
    return {
      kind: 'failure',
      reason: 'clipboard_blocked',
      clientActionId,
      durationMs,
      message: context.t(
        'reportAcr:copy.errorToastBlocked',
        'Browser blocked clipboard access - try again',
      ),
    };
  }

  // 4. Audit POST. Success path.
  const successPayload: ClipboardExportAuditPayload = {
    client_action_id: clientActionId,
    actor_role: context.actorRole,
    locale: snapshot.locale,
    action_timestamp: actionTimestamp,
    outcome: 'success',
    failure_category: null,
  };
  let queued = false;
  try {
    const r = await postAuditEnvelope(snapshot.analysisId, successPayload);
    if (!r.ok) {
      const cat = categoriseAuditFailure(r.status);
      if (cat === 'auth_denied' || cat === 'tenant_violation') {
        // Terminal failure — do NOT queue; user must refresh.
        const durationMs = elapsedMs(start);
        trackCopyFailed({
          analysisId: snapshot.analysisId,
          locale: snapshot.locale,
          failureCategory: cat,
          durationMs,
        });
        return {
          kind: 'failure',
          reason: cat,
          clientActionId,
          durationMs,
          message: context.t(
            'reportAcr:copy.errorToastAuthDenied',
            'Your access to this analysis was revoked - refresh',
          ),
        };
      }
      await enqueue(snapshot.analysisId, successPayload, `HTTP ${r.status}`);
      queued = true;
    }
  } catch (err) {
    await enqueue(
      snapshot.analysisId,
      successPayload,
      err instanceof Error ? err.message : String(err),
    );
    queued = true;
  }

  const durationMs = elapsedMs(start);
  trackCopySucceeded({
    analysisId: snapshot.analysisId,
    locale: snapshot.locale,
    lesionCount,
    durationMs,
    pendingQueueDepth: await pendingQueueDepth(),
  });
  return {
    kind: 'success',
    clientActionId,
    durationMs,
    queuedAudit: queued,
  };
}

function elapsedMs(start: number): number {
  const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return now - start;
}
