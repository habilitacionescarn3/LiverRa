# Runbook — GDPR Art. 17 Erasure Execution (DPO Operational Guide)

> **Status:** Active — T384
> **Owner:** Data Protection Officer (DPO)
> **Invoked by:** Subject erasure request (email, postal, in-app form)
> **Cadence:** On-demand (regulated SLA per FR-040: 30 days end-to-end)

---

## Plain-English summary

When a patient or data subject exercises their right-to-erasure (GDPR
Art. 17), we must find every piece of their data across our system,
destroy it so it cannot be recovered from backups either, and send
them a signed confirmation. Our trick for "can't recover from backups":
each case is encrypted with its own AWS KMS key, and we destroy the
key — the ciphertext in backups becomes unreadable noise forever.

Think of it like a bank vault: the subject's box is locked with a
unique key. We don't have to dig up every backup tape — we just
destroy the key, and every copy of the box (past, present, future)
becomes a useless rock.

---

## Preconditions

- Subject has submitted a written erasure request (email, letter, or
  in-app form). Verbal requests are logged but not acted upon.
- Requester identity is verified:
    - Patient: match national ID + DoB against the tenant's Patient
      resource; on mismatch → escalate to the tenant's clinical lead.
    - Staff: existing SSO session; step-up MFA at request time.
- DPO has current MFA device registered in Cognito (step-up required
  for `erasure.execute`).
- No active legal hold on the subject's data (check Ops dashboard →
  Legal Holds tab).

## Roles

| Role | Responsibility |
|---|---|
| DPO | Primary executor; signs off |
| SRE on-call | Observer; monitors KMS + audit chain during execution |
| Legal counsel | Validates scope when request is ambiguous |

## Steps

### 1. Receive request (day 0)

1. DPO assigns a ticket ID (format `ERASURE-YYYYMMDD-NN`).
2. Log request metadata in the compliance dashboard
   (`/compliance/erasure-log`): subject ref, received-at, channel.
3. Send acknowledgement to requester within 72 h (template
   `erasure-ack-{en|de|ka}.txt`).

### 2. Validate subject ref (day 1–3)

1. DPO opens the ErasureWizard at `/compliance/erasure/new`.
2. Enter subject ref (Patient.identifier) → wizard runs a scoped
   search across:
    - Medplum Patient resources
    - Postgres `analysis`, `study`, `report` tables
    - S3 `liverra-imaging` bucket prefix
    - Audit event chain (tenants × categories)
3. Wizard returns a **preview manifest**: count of resources found,
   KMS keys that will be destroyed, audit events that will be
   tombstoned.
4. DPO reviews; if the scope looks wrong → cancel + re-scope with
   legal counsel.

### 3. Justify + approve (day 3–5)

1. DPO enters legal justification (Art. 17(1)(a)–(f) selector) +
   free-text context.
2. Wizard requires a second reviewer (second DPO or legal counsel)
   to counter-sign within 48 h.

### 4. Execute (day 5–30, typically day 5)

1. DPO re-authenticates with step-up MFA.
2. Clicks **Execute erasure**. The system:
    - Calls `kms:ScheduleKeyDeletion` with `PendingWindowInDays=7`
      for each per-case CMK in scope (recoverable if a mistake is
      caught).
    - Writes tombstone rows in Postgres (`tombstoned_at`,
      `tombstoned_reason`).
    - Emits one FHIR AuditEvent per tombstoned resource with
      `action=delete` + extension
      `http://liverra.ai/fhir/StructureDefinition/erasure-request-id`.
    - Queues the confirmation PDF render (Celery task
      `liverra.tasks.render_erasure_confirmation`).

### 5. 7-day recovery window (day 5–12)

- If requester withdraws or a scope error is found, DPO can call
  `kms:CancelKeyDeletion` on any CMK still in the 7-day pending window.
- After day 12, all scheduled deletions execute; recovery is no longer
  possible.

### 6. Deliver confirmation (day 12–30)

1. Download the confirmation PDF from the dashboard (SHA-256 stamped).
2. Deliver to the requester via the channel they specified (encrypted
   email via S/MIME, registered mail, or in-app download).
3. Mark the ticket **Closed** with delivery timestamp + evidence URL.

### 7. 30-day SLA check

Before day 30, the compliance dashboard raises a warning if any
ticket is still open. DPO either delivers or documents lawful delay
(Art. 12(3) — complex request, up to 3 months total).

## Evidence

- Preview manifest JSON: `s3://liverra-audit/runbooks/erasure/<ticket>/manifest.json`
- KMS ScheduleKeyDeletion responses: same prefix
- AuditEvents: queryable from the compliance dashboard by ticket ID
- Confirmation PDF: `s3://liverra-audit/runbooks/erasure/<ticket>/confirmation.pdf`

## Rollback

N/A after day 12. Within the 7-day recovery window:

```bash
aws kms cancel-key-deletion \
  --key-id alias/liverra/case/<case-uuid> \
  --region eu-central-1
```

Log the cancellation as a new AuditEvent with `action=C` (create — the
key is effectively re-created) + `purpose=erasure-recalled`.

## Sign-off

- DPO signs off that every in-scope resource is tombstoned.
- SRE on-call signs off that no alerts fired during execution.
- Legal counsel signs off that scope matches the request.
