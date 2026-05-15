// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrClipboardService — drainPendingAuditQueue tests (T050).
 *
 * Validates the "session reload" path:
 *   - 5xx during the first session enqueues to IndexedDB.
 *   - On a subsequent session (simulated via __resetForTests + module
 *     re-state), drainPendingAuditQueue replays each row.
 *   - On 200: the row is removed.
 *   - The drained POST carries the SAME client_action_id (server uses
 *     ON CONFLICT DO NOTHING for idempotency).
 *   - On terminal 401: the row is dropped, NOT retried forever.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReadoutSnapshot, type TFn } from '../acrAnatomicalMapping';
import {
  __resetForTests,
  copyReadout,
  drainPendingAuditQueue,
  pendingQueueDepth,
} from '../acrClipboardService';
import type { ReportSummary } from '../reportSummary';

vi.mock('../acrTelemetry', () => ({
  trackCopyFailed: vi.fn(),
  trackCopySucceeded: vi.fn(),
}));

const QUEUE_DB = 'liverra-acr-audit';

const tFallback: TFn = (_key, fallback) => fallback ?? _key;
const ANALYSIS_ID = 'analysis-drain-001';

function makeSummary(): ReportSummary {
  return {
    analysis_id: ANALYSIS_ID,
    study_id: 's',
    patient_ref: null,
    status: 'completed',
    started_at: null,
    completed_at: '2026-05-13T14:00:00Z',
    updated_at: '2026-05-13T14:00:00Z',
    pipeline_version: 'v1',
    stages: [],
    flr: null,
    segmentations: [],
    lesions: [],
    qc_flags: [],
    tenant_id: 't',
  };
}

function makeSnapshot() {
  return buildReadoutSnapshot({
    reportSummary: makeSummary(),
    locale: 'en',
    ruoDisclaimer: 'RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE',
    t: tFallback,
  });
}

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

function installFetch(
  responder: (call: FetchCall) => Response,
): { calls: FetchCall[]; fn: ReturnType<typeof vi.fn> } {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method?.toUpperCase() ?? 'GET';
    const body = init?.body ? String(init.body) : null;
    const call = { url: u, method, body };
    calls.push(call);
    return responder(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

function installClipboardOk(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, clipboard: { writeText: vi.fn(async () => undefined) } },
    configurable: true,
  });
}

async function purgeQueue(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(QUEUE_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  __resetForTests();
  await purgeQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------
// Helpers — drive a "first session" failure, then a "second session"
// drain by resetting the module-private DB handle in between.
// -----------------------------------------------------------------

async function enqueueOneFailure(): Promise<{ clientActionId: string }> {
  installFetch((call) => {
    if (call.method === 'HEAD' && call.url.includes('/report/summary')) {
      return new Response('', { status: 200, headers: { ETag: 'etag-open-001' } });
    }
    if (call.method === 'POST' && call.url.includes('/clipboard-export')) {
      return new Response('{}', { status: 502 });
    }
    return new Response('not stubbed', { status: 500 });
  });
  installClipboardOk();
  const out = await copyReadout({
    snapshot: makeSnapshot(),
    context: {
      analysisId: ANALYSIS_ID,
      actorRole: 'radiologist',
      openTimeEtag: 'etag-open-001',
      t: tFallback,
    },
  });
  if (out.kind !== 'success') throw new Error('expected success/queued');
  return { clientActionId: out.clientActionId };
}

describe('drainPendingAuditQueue — success path', () => {
  it('replays each row, removes on 200, reuses the original client_action_id', async () => {
    const { clientActionId } = await enqueueOneFailure();
    expect(await pendingQueueDepth()).toBe(1);

    // "Reload" — re-open the lazy DB handle so the test models a new session.
    __resetForTests();

    // Second session: audit POST returns 200.
    const { calls } = installFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/clipboard-export')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('not stubbed', { status: 500 });
    });

    await drainPendingAuditQueue();

    expect(await pendingQueueDepth()).toBe(0);
    // The drain POST must carry the SAME client_action_id (server idempotency).
    const drainPosts = calls.filter(
      (c) => c.method === 'POST' && c.url.includes('/clipboard-export'),
    );
    expect(drainPosts).toHaveLength(1);
    const replayed = JSON.parse(drainPosts[0]!.body!) as { client_action_id: string };
    expect(replayed.client_action_id).toBe(clientActionId);
  });
});

describe('drainPendingAuditQueue — terminal 401', () => {
  it('drops the row instead of retrying forever', async () => {
    await enqueueOneFailure();
    expect(await pendingQueueDepth()).toBe(1);

    __resetForTests();

    installFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/clipboard-export')) {
        return new Response('{}', { status: 401 });
      }
      return new Response('not stubbed', { status: 500 });
    });

    await drainPendingAuditQueue();

    // Terminal 401 → row removed, queue is empty.
    expect(await pendingQueueDepth()).toBe(0);
  });
});
