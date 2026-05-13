// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrClipboardService — unit tests for feature 002-acr-structured-readout T048.
 *
 * Covers the six paths through `copyReadout`:
 *   1. Happy: clipboard write + audit POST 200 → success, queuedAudit=false.
 *   2. Audit POST 5xx → enqueue, success, queuedAudit=true.
 *   3. Audit POST 401 → failure 'auth_denied', NO enqueue.
 *   4. Audit POST 403 → failure 'tenant_violation', NO enqueue.
 *   5. clipboard.writeText throws → failure 'clipboard_blocked'.
 *   6. Stale ETag (HEAD ≠ panel-open) → failure 'audit_chain_unavailable'.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReadoutSnapshot, type TFn } from '../acrAnatomicalMapping';
import {
  __resetForTests,
  copyReadout,
  pendingQueueDepth,
} from '../acrClipboardService';
import type { ReportSummary } from '../reportSummary';

// Mock telemetry so capture() is a no-op in this unit test.
vi.mock('../acrTelemetry', () => ({
  trackCopyFailed: vi.fn(),
  trackCopySucceeded: vi.fn(),
}));

const tFallback: TFn = (_key, fallback) => fallback ?? _key;

const ANALYSIS_ID = 'analysis-acr-clip-001';

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

function makeCtx(overrides: Partial<{ openTimeEtag: string | null }> = {}) {
  return {
    analysisId: ANALYSIS_ID,
    actorRole: 'radiologist',
    openTimeEtag: overrides.openTimeEtag ?? 'etag-open-time-001',
    t: tFallback,
  };
}

// -----------------------------------------------------------------
// Helpers — install fetch + clipboard mocks per test.
// -----------------------------------------------------------------

interface FetchPlan {
  head?: { status: number; etag?: string | null };
  audit?: { status: number; body?: unknown };
}

function installFetch(plan: FetchPlan): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (method === 'HEAD' && u.includes('/report/summary')) {
      const headers = new Headers();
      if (plan.head?.etag) headers.set('ETag', plan.head.etag);
      return new Response('', { status: plan.head?.status ?? 200, headers });
    }
    if (method === 'POST' && u.includes('/clipboard-export')) {
      return new Response(JSON.stringify(plan.audit?.body ?? {}), {
        status: plan.audit?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not stubbed', { status: 500 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function installClipboard(behaviour: 'ok' | 'throw'): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async (_text: string) => {
    if (behaviour === 'throw') {
      throw new DOMException('NotAllowedError', 'NotAllowedError');
    }
  });
  // happy-dom may not expose navigator.clipboard by default.
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, clipboard: { writeText } },
    configurable: true,
  });
  return writeText;
}

async function purgeQueue(): Promise<void> {
  // Drop the IndexedDB database between tests.
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('liverra-acr-audit');
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
// Test cases
// -----------------------------------------------------------------

describe('copyReadout — happy path', () => {
  it('writes plain text to clipboard, POSTs audit, returns success + queuedAudit=false', async () => {
    const fetchMock = installFetch({
      head: { status: 200, etag: 'etag-open-time-001' },
      audit: { status: 200 },
    });
    const writeText = installClipboard('ok');

    const out = await copyReadout({ snapshot: makeSnapshot(), context: makeCtx() });

    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.queuedAudit).toBe(false);
    }
    expect(writeText).toHaveBeenCalledTimes(1);
    // writeText receives the rendered plain text.
    expect(writeText.mock.calls[0]?.[0]).toMatch(/RESEARCH USE ONLY/);
    // Both HEAD + POST were issued.
    const calls = fetchMock.mock.calls.map((c) => ({
      url: String(c[0]),
      method: (c[1] as RequestInit | undefined)?.method ?? 'GET',
    }));
    expect(calls.some((c) => c.method === 'HEAD' && c.url.includes('/report/summary'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/clipboard-export'))).toBe(true);
  });
});

describe('copyReadout — audit POST 5xx', () => {
  it('enqueues to IndexedDB and returns success with queuedAudit=true', async () => {
    installFetch({
      head: { status: 200, etag: 'etag-open-time-001' },
      audit: { status: 502 },
    });
    installClipboard('ok');

    const out = await copyReadout({ snapshot: makeSnapshot(), context: makeCtx() });
    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.queuedAudit).toBe(true);
    }
    expect(await pendingQueueDepth()).toBe(1);
  });
});

describe('copyReadout — audit POST 401', () => {
  it('returns failure auth_denied with NO enqueue', async () => {
    installFetch({
      head: { status: 200, etag: 'etag-open-time-001' },
      audit: { status: 401 },
    });
    installClipboard('ok');

    const out = await copyReadout({ snapshot: makeSnapshot(), context: makeCtx() });
    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('auth_denied');
    }
    expect(await pendingQueueDepth()).toBe(0);
  });
});

describe('copyReadout — audit POST 403', () => {
  it('returns failure tenant_violation with NO enqueue', async () => {
    installFetch({
      head: { status: 200, etag: 'etag-open-time-001' },
      audit: { status: 403 },
    });
    installClipboard('ok');

    const out = await copyReadout({ snapshot: makeSnapshot(), context: makeCtx() });
    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('tenant_violation');
    }
    expect(await pendingQueueDepth()).toBe(0);
  });
});

describe('copyReadout — clipboard.writeText throws', () => {
  it('returns failure clipboard_blocked', async () => {
    installFetch({
      head: { status: 200, etag: 'etag-open-time-001' },
      audit: { status: 200 },
    });
    installClipboard('throw');

    const out = await copyReadout({ snapshot: makeSnapshot(), context: makeCtx() });
    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('clipboard_blocked');
    }
  });
});

describe('copyReadout — stale ETag', () => {
  it('returns failure audit_chain_unavailable with stale message', async () => {
    installFetch({
      // HEAD returns a different ETag from openTimeEtag → stale gate trips.
      head: { status: 200, etag: 'etag-now-different-002' },
      audit: { status: 200 },
    });
    installClipboard('ok');

    const out = await copyReadout({
      snapshot: makeSnapshot(),
      context: makeCtx({ openTimeEtag: 'etag-open-time-001' }),
    });
    expect(out.kind).toBe('failure');
    if (out.kind === 'failure') {
      expect(out.reason).toBe('audit_chain_unavailable');
      expect(out.message).toMatch(/refresh/i);
    }
  });
});
