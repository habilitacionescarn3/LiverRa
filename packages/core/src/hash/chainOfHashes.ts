/**
 * Chain-of-hashes primitives (research §A.3).
 *
 * This module is pure: no I/O, no randomness, no globals. It exports three
 * helpers used by the tamper-evident audit-chain writer in
 * `packages/app/src/emr/services/auditChainService.ts` (T056):
 *
 *   - `canonicalJson(obj)` — deterministic JCS (RFC 8785) serialization.
 *   - `sha256(bytes)` — wraps `node:crypto`'s SHA-256 for a Uint8Array
 *     input/output contract that is symmetric with Web Crypto.
 *   - `leafHash(prev, canonical, tenantId, seqNo)` — the per-row
 *     `sha256(prev || sha256(tenantId || ':' || seqNo || ':' || canonical))`
 *     construction, matching the research §A.3 formula.
 *
 * The chain's integrity invariant: `row.leafHash === leafHash(prev.leafHash,
 * row.canonicalJson, row.tenantId, row.sequenceNo)` for every row,
 * with `prev.leafHash = Tenant.audit_chain_genesis_hash` at `sequenceNo = 1`.
 *
 * All helpers are deterministic — given the same inputs they produce the
 * same bytes on every platform (Node 20+, modern browsers via Web Crypto
 * fallback in the browser build).
 */

import { createHash } from 'node:crypto';

/**
 * Serialize a JSON-compatible value using RFC 8785 JSON Canonicalization
 * Scheme (JCS). Guarantees:
 *   - Object keys sorted lexicographically (UTF-16 code-unit order,
 *     matching `Array.prototype.sort`).
 *   - No whitespace between tokens.
 *   - Strings JSON-escaped per RFC 8259 §7 (via `JSON.stringify`).
 *   - Numbers serialized via ES2019 `Number.prototype.toString(10)`
 *     — matches the JCS numeric-serialization requirement for all
 *     IEEE-754 doubles that are finite and non-NaN.
 *   - `undefined`, functions, symbols are rejected (would silently be
 *     dropped by `JSON.stringify`, which is non-deterministic w.r.t.
 *     chain integrity).
 *
 * Throws on non-finite numbers, `undefined`, functions, symbols, BigInts
 * (JSON has no BigInt), and circular references — anything that cannot be
 * reproduced byte-for-byte elsewhere.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new WeakSet());
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value === true ? 'true' : 'false';

  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new RangeError(
        `canonicalJson: non-finite number (${String(n)}) has no JSON representation`,
      );
    }
    // ES2019+ Number.prototype.toString is deterministic for finite doubles
    // and matches JCS's normalized numeric output.
    return n.toString();
  }

  if (type === 'string') {
    return JSON.stringify(value);
  }

  if (type === 'bigint') {
    throw new TypeError('canonicalJson: BigInt values have no JSON representation');
  }

  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new TypeError(`canonicalJson: cannot serialize ${type}`);
  }

  // Object or array.
  const obj = value as object;
  if (seen.has(obj)) {
    throw new TypeError('canonicalJson: circular reference detected');
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item) => serialize(item, seen));
      return '[' + parts.join(',') + ']';
    }

    // Plain object. Sort keys lexicographically.
    const entries = Object.entries(obj as Record<string, unknown>);
    // Drop keys whose value is `undefined` — matches JSON.stringify semantics
    // so callers do not need to pre-clean their input. (Functions, symbols,
    // and BigInts still throw inside `serialize`.)
    const keepable = entries.filter(([, v]) => v !== undefined);
    keepable.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = keepable.map(([k, v]) => JSON.stringify(k) + ':' + serialize(v, seen));
    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(obj);
  }
}

/**
 * Compute SHA-256 of a byte string. Returns a 32-byte Uint8Array.
 * Uses Node's `createHash` — Web Crypto polyfill for browser-side use
 * lives in a separate entry point; the server-side audit writer (T056)
 * runs under Node so this import is safe.
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  const h = createHash('sha256');
  h.update(bytes);
  // Node's Buffer is a Uint8Array subclass, but we explicitly copy into a
  // fresh Uint8Array so callers cannot mutate shared Buffer memory.
  return new Uint8Array(h.digest());
}

/**
 * Compute the per-row leaf hash for the audit chain.
 *
 * Formula (research §A.3):
 *   inner = sha256(tenantId || ':' || sequenceNo || ':' || canonical)
 *   leaf  = sha256(prev || inner)
 *
 * All string inputs are UTF-8 encoded; all hashes are 32-byte Uint8Arrays.
 */
export function leafHash(
  prev: Uint8Array,
  canonical: string,
  tenantId: string,
  seqNo: number,
): Uint8Array {
  if (!Number.isInteger(seqNo) || seqNo < 1) {
    throw new RangeError(`leafHash: seqNo must be a positive integer (got ${seqNo})`);
  }
  if (prev.byteLength !== 32) {
    throw new RangeError(
      `leafHash: prev must be a 32-byte Uint8Array (got ${prev.byteLength} bytes)`,
    );
  }

  const enc = new TextEncoder();
  const innerBytes = enc.encode(`${tenantId}:${seqNo}:${canonical}`);
  const inner = sha256(innerBytes);

  const concat = new Uint8Array(prev.byteLength + inner.byteLength);
  concat.set(prev, 0);
  concat.set(inner, prev.byteLength);

  return sha256(concat);
}
