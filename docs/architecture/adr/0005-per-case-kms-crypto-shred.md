# ADR 0005 — Per-case KMS CMK + `ScheduleKeyDeletion` for crypto-shred

- **Status:** Accepted
- **Date:** 2026-04-19
- **Authors:** Eng leads (security + backend)
- **Source:** research.md §X.1

---

## Context

FR-040 mandates GDPR Art. 17 right-to-erasure compliance. FR-002a
adds a 60-second SLA for crypto-shred on PHI exposure incidents.

The challenge: we must render a specific case's data unrecoverable —
including from backups that may already be replicated to off-site DR
storage. Simply deleting rows in Postgres does not erase backup tapes;
purging S3 objects does not erase versioned/replicated copies.

Three erasure strategies were evaluated:

1. **Single tenant-level DEK** — one key per tenant, encrypt all of
   their cases with it, destroy the key at tenant off-boarding.
2. **Queue-based deletion** — append erasure requests to a queue,
   reconcile against backups asynchronously (could take days).
3. **Per-case envelope encryption** — every case has its own AWS KMS
   CMK; erasure = `kms:ScheduleKeyDeletion` on that case's key.

## Decision

Every case uses a unique AWS KMS CMK aliased
`alias/liverra/case/{uuid}`. All DICOM ingress, derived artefacts
(NIfTI masks, JSON manifests, PDF reports, DICOM-SEG/SR exports), and
audit metadata payloads for that case are encrypted at-rest with a
per-case DEK wrapped by that CMK.

Erasure is implemented as:
1. Synchronous `kms:ScheduleKeyDeletion` with `PendingWindowInDays=7`
   (recoverable if caught within 7 days — see
   [erasure-execution.md](../../runbooks/erasure-execution.md) §5).
2. Postgres tombstone rows (`tombstoned_at`, `tombstoned_reason`).
3. FHIR AuditEvent emission with the erasure request ID.

The **FR-002a 60-second path** bypasses the 7-day window for PHI
incidents: `scripts/phi-emergency-contain.sh` calls KMS with
`PendingWindowInDays=7` followed by an immediate `CancelKeyDeletion`
rejection block + separate queue-drain (research §X.1 + runbook
[phi-incident-response.md](../../runbooks/phi-incident-response.md)).

Key creation is performed at ingestion time in the edge anonymization
sidecar, **before** any ciphertext leaves the hospital network.

## Consequences

### Positive

- **Backup-proof erasure**: destroying the key renders every backup
  copy cryptographically useless. No need to rewrite RDS snapshots
  or S3 replicas.
- **Per-case granularity**: one subject's erasure does not touch
  another subject's keys. Tenants do not lose data continuity.
- **Sub-60-second SLA achievable**: KMS ScheduleKeyDeletion is a
  single API call; p99 latency measured at ~200 ms. FR-002a SLA is
  met with 300× headroom.
- **Recoverable within 7 days**: mistakes in erasure scope can be
  reversed via `kms:CancelKeyDeletion` within the pending window.
- **Clean audit story**: every erasure is a single KMS API call +
  one chain-anchored AuditEvent. Auditors see the exact timestamp,
  the key alias, and the requester's MFA-verified identity.

### Negative

- **KMS cost**: ~$1/case/year for the CMK. At 100 k cases in a
  mature tenant, that is ~$100 k/yr — not trivial.
- **Operational KMS pressure**: every case creates a key; KMS quota
  on keys per region is 100 k by default, must be raised.
- **Cross-region DR**: KMS keys in eu-central-1 do not replicate to
  eu-west-1. We accept this: a regional KMS outage takes the case
  offline for the duration; data is not lost but inaccessible until
  restoration. Mitigation: RDS replicas + S3 CRR stay within
  eu-central-1.
- **Performance**: every read/write performs a KMS decrypt (DEK
  unwrap). KMS cache (via AWS Encryption SDK) brings per-request
  cost to ~10 μs amortised; raw KMS API calls would be unacceptable
  at our throughput.

### Mitigations

- **Cost**: KMS cost is a line item in the pricing model; passed
  through to tenants. At scale this is still <1% of total infra cost.
- **KMS quota**: a service-quota-increase ticket is filed at tenant
  onboarding (target: 1 M keys per region for our account).
- **Performance**: AWS Encryption SDK's data-key caching
  (`MaxBytesEncrypted=10GB`, `MaxMessages=10000`, `MaxAge=5min`) is
  the default config in `packages/ml-inference/src/services/kms/`.

## Alternatives considered

### Single tenant-level DEK

- **Pro:** Simpler; fewer keys.
- **Con:** Cannot erase individual cases without re-encrypting all
  the tenant's data. Backup-proof erasure is impossible at per-
  subject granularity.
- **Verdict:** Rejected on granularity.

### Queue-based deletion

- **Pro:** Amortises erasure work; no synchronous KMS calls.
- **Con:** Cannot meet the FR-002a 60-second SLA; no backup-proofing
  (queue workers cannot rewrite tape backups).
- **Verdict:** Rejected on SLA + backup-proofing.

### Client-side envelope encryption with customer-managed keys

- **Pro:** Hospital retains the master key; LiverRa has zero-
  knowledge of plaintext.
- **Con:** Operational overhead for hospitals; key-loss risk is
  borne by clinicians (not acceptable); breaks our ability to run
  inference (we need plaintext to run Triton).
- **Verdict:** Rejected on operational realism + inference
  requirement. Considered for v2 as an opt-in for research-only
  tenants.

---

## References

- Research §X.1 — per-case KMS decision
- FR-040 — GDPR erasure
- FR-002a — 60-second crypto-shred SLA
- `packages/ml-inference/src/services/erasure/crypto_shred.py`
- Runbook: [erasure-execution.md](../../runbooks/erasure-execution.md)
- Runbook: [phi-incident-response.md](../../runbooks/phi-incident-response.md)
