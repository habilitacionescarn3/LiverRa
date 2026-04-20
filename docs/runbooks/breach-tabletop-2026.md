# Runbook — Annual Breach Tabletop Exercise (2026)

> **Status:** Active — T386
> **Owner:** CISO + DPO
> **Invoked by:** Scheduled (calendar)
> **Cadence:** Annual (NFR-009)

---

## Plain-English summary

Once a year we pretend a bad thing happened and practice our response.
No real data is touched, no real keys are destroyed — we work through
what we *would* do, find the gaps, and patch them before an attacker
finds them first.

This year we run four scenarios across a single half-day. Each has a
clear starting condition, explicit detection points, and a "what you
should do" answer so we can score the response. Think of it like a
flight simulator for incident response — the crashes are safe to learn
from.

---

## Preconditions

- 4 h blocked on the calendar (half-day, morning preferred to catch
  EU business hours).
- Attendees: CISO, DPO, SRE on-call + alternate, Eng manager, one rep
  from Legal, one rep from Clinical (surgeon or radiologist), one
  scribe (not an active participant).
- Video bridge + shared doc for the scribe.
- No production changes during the exercise window.

## Roles

| Role | Responsibility |
|---|---|
| Facilitator | CISO — runs the exercise, reveals inject cards |
| Scribe | Records timeline + action items; no voice in discussion |
| Incident commander | Rotates per scenario (simulates real on-call rotation) |
| DPO | Always the DPO |
| Legal counsel | Always legal |
| Clinical observer | Raises patient-safety implications |

## Scenario 1 — Insider threat: admin exfiltrates patient list

### Starting condition (inject card)

At 09:17 local, a tenant's primary admin (credentialled user, full
admin role) runs a large FHIR `Bundle` export including 5,000 Patient
resources, then downloads it to a personal laptop. The export is
logged in the audit chain; no alerts fire automatically (admins are
entitled to export patient lists for tenant-internal reporting).

A few hours later, the admin's spouse (a pharmaceutical sales rep)
is observed pitching doctors at a conference with a patient list
matching the export.

### Detection points

- Audit chain: `admin.export.bundle` event at 09:17
- HR anomaly: no prior bundle-export activity from this user
- External signal: sales-rep report (most scenarios won't have this
  luxury)

### Response steps to practise

1. Forensics — preserve audit chain + S3 access logs before anything
   changes.
2. Containment — disable the admin's SSO session + revoke refresh tokens.
3. Scope — query every access event by this user across the last 90 days.
4. Legal — engage privacy counsel on the insider-threat angle;
   DPA notification obligations (GDPR Art. 33).
5. Communications — internal (leadership + the affected tenant's
   clinical lead) and external (supervisory authority filing + subject
   notification if high-risk).

### Communication template

See `templates/breach-art33-de.md` + `templates/breach-art33-en.md`.

---

## Scenario 2 — Ransomware: backup compromise

### Starting condition (inject card)

At 14:52 local, the Monitoring dashboard fires:
`liverra_pipeline_duration_seconds{quantile="0.95"}` has spiked to 900 s
across all tenants. Operators investigate and find Celery workers
cannot write to RDS. Postgres logs show a flood of `UPDATE` statements
that appear to be rewriting `audit_event_chain` rows.

Five minutes later, a ransom note appears in an ops S3 bucket.

### Detection points

- Latency dashboard: p95 spike
- Audit chain verifier: tampering alerts fire as chain hashes break
- S3 bucket notifications: unexpected `PutObject` on ops bucket

### Response steps to practise

1. Contain — pull Postgres network ACLs (no inbound/outbound except ops
   bastion); stop Celery workers.
2. Validate backup integrity — the RDS automated PITR runs in a
   different AWS account, so the tabletop twist: can we confirm the
   backups themselves aren't encrypted? (Answer: check
   `rds:describe-db-instance-automated-backups` from the separate audit
   account.)
3. DR — follow [dr-restore.md](./dr-restore.md); restore to sandbox,
   verify chain, swap DNS.
4. Law enforcement — escalate to national cybercrime authority (e.g.
   BKA for DE tenants, სპპი for GE tenants).
5. Subject notification — if PHI access was prolonged → Art. 34.

### Communication template

See `templates/breach-ransomware-en.md`.

---

## Scenario 3 — SAML IdP compromise

### Starting condition (inject card)

At 11:40 local, a tenant reports that their SSO provider (Azure AD
for one German hospital) announces a critical token-signing-cert leak.
Azure's advisory says: "assume any tokens issued in the last 18 h may
be forged."

LiverRa accepts Azure AD tokens for that tenant's users.

### Detection points

- External advisory — monitored via Azure AD status page + email
- Internal: none automatic (signed tokens look valid to us)

### Response steps to practise

1. Immediately revoke the tenant's SAML trust:

   ```bash
   aws cognito-idp update-identity-provider \
     --user-pool-id <pool> \
     --provider-name <tenant-saml> \
     --provider-details '{"MetadataURL": "<invalidated>"}'
   ```

2. Expire all active sessions for the tenant:

   ```bash
   aws cognito-idp admin-user-global-sign-out --username <all users>
   ```

3. Audit all actions for the exposure window (18 h) + categorise them
   by risk (reads vs writes vs finalizations).
4. Notify tenant clinical lead of impact on in-flight cases.
5. Wait for Azure AD all-clear + new metadata URL, then re-enable trust.

### Communication template

See `templates/tenant-sso-advisory-de.md`.

---

## Scenario 4 — Supply chain: Triton image poisoned

### Starting condition (inject card)

NVIDIA's security team publishes a CVE: the
`nvcr.io/nvidia/tritonserver:24.10-py3` image contains a backdoor that
exfiltrates model-input tensors to an attacker-controlled host. Our
MBoM pins this exact version.

### Detection points

- NVIDIA security advisory — monitored via security@liverra.ai
- Internal: egress monitoring (if we had it — tabletop twist: do we?)

### Response steps to practise

1. Pull all Triton pods from service (cordon + drain).
2. Build a fresh Triton image from source or a pinned, known-good
   commit SHA; push to our ECR.
3. Update MBoM + redeploy; audit the MBoM version-bump flow (T342 +
   T467 temperature recalibration) to confirm per-tenant calibration
   re-fits.
4. Assess exfiltration scope — how long was the backdoor live? Which
   tenants had cases in that window? Notify affected tenants.
5. Evaluate our supply-chain controls — do we pin image digests (not
   just tags)? Do we sign images with cosign? Action items from this
   scenario feed the next sprint.

### Communication template

See `templates/supply-chain-advisory-en.md`.

---

## After-action

1. Scribe consolidates the timeline for each scenario into a single
   after-action report at `docs/runbooks/breach-tabletop-2026-report.md`.
2. Each action item gets a ticket ID + owner + due date (30-day SLA
   for critical gaps, 90-day for hardening items).
3. Security team signs off the report; CISO files with the Board.
4. Report archived to `s3://liverra-audit/runbooks/breach-tabletop-2026/`.

## Evidence

All inject cards, responses, and after-action reports → same S3 prefix.

## Rollback

N/A — tabletop is simulation only.

## Sign-off

- CISO signs off that all four scenarios were exercised.
- DPO signs off that notification procedures were practised.
- Eng manager signs off that action items are tracked.
