# ADR 0003 — Per-tenant linear SHA-256 hash chain + daily Merkle anchor

- **Status:** Accepted
- **Date:** 2026-04-19
- **Authors:** Eng leads (backend + compliance)
- **Source:** research.md §A.3

---

## Context

Constitution Principle V mandates tamper-evident auditability: given
any finalized analysis, we must be able to prove (to an auditor, in a
future regulatory review) that the audit trail was not altered between
the action's timestamp and the audit time.

The plan § Audit trail requires:
- Every ML model run logged (input hash, model version, output hash,
  timestamp)
- Every DICOM transaction logged
- Every patient-data touchpoint logged with minimum PHI exposure
- 6-year retention (longest of EU / DE / GE regulatory minima)
- Verifiable across a disaster-recovery restore boundary

Three architectural options emerged:

1. **Blockchain** — e.g. AWS QLDB, Ethereum L2, dedicated consortium
   chain.
2. **CloudTrail alone** — rely on AWS's immutable API audit log.
3. **Application-level hash chain + S3 Object Lock anchor** — our
   audit chain writer computes a SHA-256 link per event; daily
   Merkle root is written to S3 with Object Lock compliance mode
   (6-year retention).

The constraint is: we need **application-level events** (model run,
review override, finalize, erasure) with **PHI-aware payloads** and
**tenant-scoped verification**. CloudTrail captures API calls but not
domain events; blockchain is overkill for a single-writer-per-tenant
system.

## Decision

We implement a **per-tenant linear SHA-256 hash chain in Postgres**
with a **daily Merkle root written to S3 Object Lock** (compliance
mode, 6-year retention) in the dedicated
`liverra-audit-anchors-eu-central-1` bucket.

### Chain structure

```
audit_event_chain(
  tenant_id uuid,
  seq_no bigint,                 -- monotonic per tenant
  prev_hash bytea,               -- sha256 of previous leaf
  canonical_json text,           -- RFC 8785 JCS of the event
  leaf_hash bytea,               -- sha256(prev_hash || canonical_json || tenant_id || seq_no)
  occurred_at timestamptz,
  PRIMARY KEY (tenant_id, seq_no)
)
```

Leaf hash formula: `sha256(prev_hash || canonical_json || tenant_id || seq_no)`,
where `canonical_json` is RFC 8785 JSON Canonicalization (JCS).

### Daily anchor

Celery beat at 02:00 UTC runs `liverra.tasks.daily_merkle_root` per
tenant:

1. Build a Merkle tree over yesterday's leaf hashes.
2. Write the root to `s3://liverra-audit-anchors-eu-central-1/<tenant>/<date>.json`
   with `x-amz-object-lock-mode: COMPLIANCE` and
   `x-amz-object-lock-retain-until-date: +6 years`.
3. Emit an `audit_anchor_written` AuditEvent (which itself is in the
   chain, so today's anchor implicitly anchors yesterday's anchor —
   recursive, expected).

### Verification

`scripts/verify-audit-chain.py` walks the chain from seq_no=1 upward,
recomputes each leaf, and compares the daily Merkle roots against the
Object Lock copies. Fails fast on any mismatch, emits a
`chain-tampering` alert via Prometheus.

## Consequences

### Positive

- **Tamper-evident**: altering any past event breaks the chain; the
  daily Merkle anchor catches even sophisticated rewrites that
  re-compute the local chain (the S3 Object Lock copy cannot be
  altered for 6 years).
- **Per-tenant isolation**: tenants verify their own chains; a
  compromised tenant's writer cannot forge events for another tenant.
- **Restorable**: chain survives DR because both Postgres (via RDS
  PITR) and the S3 anchors (Object Lock) are backed up. The
  `dr-restore-dryrun.sh` verifier proves this quarterly.
- **Queryable**: events are plain Postgres rows; the compliance
  dashboard slices/filters them with SQL, not a blockchain indexer.
- **Cheap**: one SHA-256 + one row-insert per event; ~0.1 ms overhead.
  S3 anchor writes are 1/day/tenant — trivial.
- **Recursive anchoring**: the `audit_anchor_written` event is itself
  in the chain, so today's anchor binds yesterday's anchor. An
  attacker would have to compromise both Postgres **and** S3 Object
  Lock simultaneously to forge continuity — practically impossible
  within the 6-year window.

### Negative

- **Single-writer constraint per tenant**: chain requires monotonic
  seq_no; our chain-writer acquires a per-tenant advisory lock in
  Postgres. Rare contention; measured <1 ms p99.
- **Schema evolution**: changing `canonical_json` format would break
  historical verification. Migration path is documented in
  `research.md §A.3` — any format change bumps a `chain_version`
  column and verifiers handle both.

### Mitigations

- **Advisory-lock contention**: monitored via
  `pg_blocking_pids()` in Grafana; alerts if p99 >10 ms.
- **Schema evolution**: Constitution Code Review gate requires two
  reviewers plus a chain-migration test when `canonical_json` format
  changes.

## Alternatives considered

### Blockchain (AWS QLDB)

- **Pro:** Cryptographically verifiable by design; managed service.
- **Con:** QLDB is deprecated as of 2025; Ethereum L2s add
  external-party dependency + key-management overhead; cost per
  event is ~100× higher than our scheme.
- **Verdict:** Rejected on cost + vendor risk.

### CloudTrail alone

- **Pro:** Already deployed; AWS guarantees immutability at the
  account level.
- **Con:** Captures AWS API calls, not domain events. We cannot emit
  a `report.finalized` audit record to CloudTrail; we can only emit
  `s3:PutObject` on the downstream PDF. Insufficient for Principle V.
- **Verdict:** Rejected — retained as a *supplementary* control, not
  the primary chain.

### Postgres only (no Object Lock anchor)

- **Pro:** Simpler; one storage location.
- **Con:** A sufficiently motivated attacker with Postgres write
  access can rewrite the entire chain. The daily Merkle anchor is
  the tamper-evidence against Postgres compromise — without it, the
  chain is merely tamper-resistant.
- **Verdict:** Rejected — anchor is the non-negotiable layer.

---

## References

- Research §A.3 — chain-of-hashes decision
- Research §X.4 — AuditEvent ↔ model-version binding
- Constitution Principle V — auditability
- `packages/ml-inference/src/tasks/daily_merkle_root.py` — anchor job
- `packages/ml-inference/src/db/alembic/versions/20260419_0005_audit_chain.py` — schema
