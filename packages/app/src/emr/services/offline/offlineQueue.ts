// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * offlineQueue — IndexedDB-backed write queue for reviewer edits (T242).
 *
 * Plain-English: while the user is refining a mask, classifying a lesion, or
 * dragging the resection plane, each edit is a tiny POST to the backend. If
 * the network drops, those POSTs can't go out. This module is the local
 * outbox — every edit gets dropped into an IndexedDB store keyed by a
 * sortable ULID, and `syncWorker` drains the outbox back to the server
 * whenever connectivity returns.
 *
 * Analogy: think of it as the "drafts" folder in an email client — your
 * unsent edits stick around until the network comes back, then they flush
 * out in the exact order you wrote them.
 *
 * Schema (db `liverra-offline`, v1; plan.md §Offline reviewer-edit durability):
 *   Store `offline_reviewer_edits`:
 *     { id (ULID PK), analysis_id, edit_type, payload, created_at,
 *       client_version, attempt_count, last_error }
 *     indexed on `(analysis_id, created_at)` so per-case replay stays in
 *     insertion order even across tabs.
 *   Store `offline_metadata`:
 *     { analysis_id (PK), last_server_version, last_sync_at }
 *
 * Spec refs: FR-018c, plan.md §Offline reviewer-edit durability, research §C.6.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { ulid } from 'ulid';

const DB_NAME = 'liverra-offline';
const DB_VERSION = 1;
const STORE_EDITS = 'offline_reviewer_edits';
const STORE_META = 'offline_metadata';

/** Edit kinds recognised by the sync worker. */
export type OfflineEditType =
  | 'mask_refine'
  | 'lesion_prompt'
  | 'classification_override'
  | 'flr';

/** Canonical row shape written to IndexedDB. */
export interface OfflineEdit {
  id: string;
  analysis_id: string;
  edit_type: OfflineEditType;
  /** Opaque payload — exact contract is per-endpoint (see api-openapi.yaml). */
  payload: Record<string, unknown>;
  /** ISO-8601 UTC timestamp; also encoded into the ULID prefix. */
  created_at: string;
  /** App build id so stale schemas can be purged during upgrade. */
  client_version: string;
  /** Number of sync attempts; drives backoff in syncWorker. */
  attempt_count: number;
  /** Last error message surfaced by the server (RFC 7807 `detail`). */
  last_error: string | null;
  /**
   * Optional — when the sync worker POSTs this edit it needs to know the
   * HTTP endpoint. Stored alongside the payload so syncWorker is generic.
   */
  endpoint?: string;
}

/** Metadata row tracking per-analysis sync state. */
export interface OfflineMetadata {
  analysis_id: string;
  last_server_version: number;
  last_sync_at: string;
}

interface LiverraOfflineDB extends DBSchema {
  offline_reviewer_edits: {
    key: string;
    value: OfflineEdit;
    indexes: { 'by-analysis-created': [string, string] };
  };
  offline_metadata: {
    key: string;
    value: OfflineMetadata;
  };
}

let dbPromise: Promise<IDBPDatabase<LiverraOfflineDB>> | null = null;

/**
 * Lazy-singleton handle to the IndexedDB database. We keep one handle per
 * tab; tests can reset via `__resetForTests()` below.
 */
function getDb(): Promise<IDBPDatabase<LiverraOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<LiverraOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_EDITS)) {
          const editsStore = db.createObjectStore(STORE_EDITS, { keyPath: 'id' });
          editsStore.createIndex('by-analysis-created', ['analysis_id', 'created_at']);
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'analysis_id' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Read the current app client version. In Vite this comes from
 * `import.meta.env.VITE_APP_VERSION`; falls back to `'0.0.0-dev'` so unit
 * tests don't need to stub the environment.
 */
function readClientVersion(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return meta.VITE_APP_VERSION ?? '0.0.0-dev';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  analysis_id: string;
  edit_type: OfflineEditType;
  payload: Record<string, unknown>;
  /** Target API endpoint, e.g. `/reviews/{id}/mask-refine`. */
  endpoint?: string;
}

/**
 * Append a new edit to the outbox. Returns the generated row (including the
 * ULID that callers should keep if they intend to correlate telemetry).
 */
export async function enqueue(input: EnqueueInput): Promise<OfflineEdit> {
  const db = await getDb();
  const edit: OfflineEdit = {
    id: ulid(),
    analysis_id: input.analysis_id,
    edit_type: input.edit_type,
    payload: input.payload,
    created_at: new Date().toISOString(),
    client_version: readClientVersion(),
    attempt_count: 0,
    last_error: null,
    endpoint: input.endpoint,
  };
  await db.put(STORE_EDITS, edit);
  return edit;
}

/** Remove an edit from the outbox (called after a successful POST). */
export async function dequeue(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_EDITS, id);
}

/**
 * List all pending edits in ULID-ascending order (== chronological by
 * `created_at` because ULIDs embed timestamp + randomness).
 */
export async function listPending(): Promise<OfflineEdit[]> {
  const db = await getDb();
  const rows = await db.getAll(STORE_EDITS);
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** List pending edits scoped to one analysis. */
export async function listPendingForAnalysis(analysisId: string): Promise<OfflineEdit[]> {
  const all = await listPending();
  return all.filter((e) => e.analysis_id === analysisId);
}

/**
 * Record a failed sync attempt — increments `attempt_count` and stores the
 * last error message. Used by the sync worker to drive backoff + telemetry.
 */
export async function incrementAttempt(id: string, error: string): Promise<void> {
  const db = await getDb();
  const row = await db.get(STORE_EDITS, id);
  if (!row) return;
  row.attempt_count += 1;
  row.last_error = error;
  await db.put(STORE_EDITS, row);
}

/** Current outbox size — drives the SyncIndicator badge. */
export async function count(): Promise<number> {
  const db = await getDb();
  return db.count(STORE_EDITS);
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

export async function getMetadata(analysisId: string): Promise<OfflineMetadata | null> {
  const db = await getDb();
  return (await db.get(STORE_META, analysisId)) ?? null;
}

export async function setMetadata(meta: OfflineMetadata): Promise<void> {
  const db = await getDb();
  await db.put(STORE_META, meta);
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Drop the in-memory DB handle so the next call re-opens against a fresh
 * `fake-indexeddb` instance. Exported for Vitest — do not call at runtime.
 */
export function __resetForTests(): void {
  dbPromise = null;
}

export const offlineQueue = {
  enqueue,
  dequeue,
  listPending,
  listPendingForAnalysis,
  incrementAttempt,
  count,
  getMetadata,
  setMetadata,
};

export default offlineQueue;
