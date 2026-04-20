/**
 * Chain-of-hashes barrel.
 *
 * Exposes the RFC 8785 JCS canonicalization helper plus the SHA-256 and
 * `leafHash` primitives used by the tenant-scoped tamper-evident audit chain
 * (research §A.3).
 */
export * from './chainOfHashes.js';
