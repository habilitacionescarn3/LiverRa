# Runbook — PHI Incident Response (First 60 Minutes)

> **Status:** Active — T385
> **Owner:** On-call SRE → escalates to DPO within 15 min
> **Invoked by:** PHI-exposure alarm from `phi_scrubber.py` (fail-closed) or manual trigger
> **Cadence:** As needed
> **Regulatory clock:** GDPR Art. 33 — supervisory authority notification within 72 h

---

## Plain-English summary

If we detect PHI (personally-identifying health information) has crossed
a trust boundary it shouldn't have — e.g. a patient name leaked into a
log, or an un-anonymized DICOM header reached cloud S3 — we have 60
seconds to crypto-shred the affected case (per FR-002a) and then 72
hours to notify the regulator.

Think of it like pulling the emergency stop cord on a train: first
priority is stop the bleed (destroy the keys → ciphertext is garbage),
then triage, then formal paperwork.

The FR-002a 60-second SLA is the critical gate. Everything else bends
around that.

---

## Preconditions

- PagerDuty `liverra-critical` alert fires with `alertname=phi-scrubber-failures`
  OR an SRE manually declares via `/ops/incident/phi`.
- Incident commander is designated within 5 min.
- Legal counsel is paged in parallel (parallel track, does not block
  the crypto-shred).

## Roles

| Role | Responsibility |
|---|---|
| Incident commander | Owns timeline; makes the notification call |
| SRE on-call | Executes containment + crypto-shred |
| DPO | Validates scope; drafts breach notification |
| Legal counsel | Reviews notification; manages authority comms |
| Eng manager | Observer; escalates to leadership |

## Steps (first 60 minutes)

### T+0 min: Detect

- PagerDuty `liverra-critical` page.
- Alert payload includes: tenant ID, case IDs in scope, exposure vector
  (log sink, S3 object, DICOM header).

### T+0–5 min: Declare + mobilise

1. On-call acknowledges the page; opens `#incident-phi-<YYYYMMDD>`.
2. Pages incident commander + DPO via `/liverra incident phi` Slack command.
3. Incident commander assigns roles in-channel.

### T+5–20 min: Contain (FR-002a 60-s within this window)

1. SRE on-call runs:

   ```bash
   ./scripts/phi-emergency-contain.sh --case-ids <comma,separated>
   ```

   This calls the `crypto_shred.py` service path which:
    - Disables S3 replication to DR bucket for affected case IDs.
    - Calls `kms:ScheduleKeyDeletion` with `PendingWindowInDays=7` on the
      per-case CMKs.
    - Quarantines the affected tenant's analysis queue (no new jobs picked up).
    - Emits a `phi_emergency_contain` AuditEvent.

2. Verify quarantine effective:

   ```bash
   curl -fsS https://api.liverra.ai/ops/tenants/<tenant>/queue-state
   # expected: "quarantined"
   ```

3. Confirm KMS keys are in `PendingDeletion` state:

   ```bash
   aws kms describe-key --key-id alias/liverra/case/<uuid> --region eu-central-1 \
     | jq '.KeyMetadata.KeyState'
   # expected: "PendingDeletion"
   ```

4. **If KMS API latency > 30 s** → the FR-002a SLA is at risk. Escalate
   to KMS ops + consider the `kms-failover` runbook (separate).

### T+20–40 min: Assess

1. DPO opens the compliance dashboard → **Incident scope** tab.
2. Runs the scope query against the audit chain:

   ```sql
   SELECT COUNT(*) AS touched_resources,
          COUNT(DISTINCT subject_ref) AS subjects,
          MIN(occurred_at), MAX(occurred_at)
   FROM audit_event
   WHERE tenant_id = :tenant
     AND analysis_id = ANY(:case_ids)
     AND occurred_at BETWEEN :exposure_start AND :exposure_end;
   ```

3. Categorise exposure:
    - **Contained**: stayed within LiverRa trust boundary → no breach notification.
    - **External**: reached a third party (log sink, email) → breach notification mandatory.
4. Snapshot forensics: preserve log lines, S3 object ETags, and the
   exposure-vector commit SHA for the post-mortem.

### T+40–60 min: Notify (first layer)

1. DPO drafts preliminary internal notification using template
   `incident-notify-<en|de|ka>.md`.
2. Legal counsel reviews + validates the categorisation.
3. If external: start the Art. 33 72-hour clock. Supervisory authority
   notification template is at `templates/breach-notification-art33.md`.

## After the first hour

- **T+1–4 h**: Draft authority notification (Art. 33) + preliminary
  subject notification (Art. 34 if high-risk).
- **T+4–24 h**: Post-mortem ticket opened; root-cause analysis starts.
- **T+24–72 h**: File Art. 33 notification with supervisory authority.
- **T+72 h–30 d**: Subject notifications (Art. 34), if applicable.
- **T+30 d**: Post-mortem ratification meeting; action-items tracked
  to closure.

## Evidence

All artefacts → `s3://liverra-audit/runbooks/phi-incident-response/<incident-id>/`:

- `timeline.md` — minute-by-minute log
- `containment-audit-events.ndjson` — emitted during T+5–20
- `kms-deletion-receipts/*.json` — per-case KMS deletion confirmations
- `scope-query-result.json` — DPO's scope assessment
- `authority-notification.pdf` — if sent

## Rollback

Within the 7-day KMS pending-deletion window, canceling key deletion is
possible but discouraged — do so only if the incident is reclassified as
a false positive by legal counsel. Procedure matches the erasure-recall
clause in [erasure-execution.md](./erasure-execution.md).

## Sign-off

- Incident commander signs off on timeline.
- DPO signs off on scope + notifications.
- Legal counsel signs off on authority filing.
- Eng manager signs off on post-mortem closure.
