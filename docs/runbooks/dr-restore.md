# Runbook — Disaster Recovery Restore

> **Status:** Active — T383
> **Owner:** SRE team
> **Invoked by:** `./scripts/dr-restore-dryrun.sh`
> **Cadence:** Dry-run quarterly + live incident response
> **SLA:** RTO 8 h, RPO 5 min (RDS PITR granularity)

---

## Plain-English summary

If prod dies (cloud region outage, accidental drop, ransomware encryption of
RDS data), this runbook takes us from "everything is gone" to "everything is
restored in a sandbox VPC, chain-of-hashes audit trail still verifies, DNS
is swapped to the sandbox" in under 8 hours. The same script runs quarterly
in `--dry-run` mode to prove we still can.

Think of it as a fire drill with a real extinguisher — same steps, we just
don't pull the DNS lever until it's a real fire.

---

## Preconditions

- AWS Organizations IAM identity with
    - `rds:RestoreDBInstanceToPointInTime` on the prod account
    - `s3:GetObject` on `liverra-imaging-eu-central-1` + `liverra-audit-anchors-eu-central-1`
    - `route53:ChangeResourceRecordSets` on the `liverra.ai` hosted zone
    - `kms:Decrypt` on the audit-anchors CMK
- Sandbox VPC + subnet group `liverra-dr-sandbox` pre-provisioned (see
  `deploy/terraform/dr-sandbox.tf`)
- `pg_dump`, `psql`, `aws`, `jq`, `python3` on the operator's workstation
  (or the dedicated DR runner in GitHub Actions)
- PagerDuty incident is open and the on-call is the acting commander

## Roles

| Role | Responsibility |
|---|---|
| Incident commander | Makes the `--execute` call; owns comms |
| SRE lead | Runs the restore script; owns timings |
| DPO | Approves DNS swap if PHI was in-flight |
| Eng manager | Observer + escalation to leadership |

## Steps

### 1. Detect + declare (minutes 0–10)

1. On-call receives PagerDuty `liverra-critical` page.
2. On-call confirms prod is down (not a monitoring false-positive) via:
    - Sentry EU dashboard shows > 50 5xx/min across all endpoints
    - `curl -fsS https://api.liverra.ai/system/health` fails
    - AWS Health Dashboard shows the region event
3. On-call pages the incident commander + opens a `#incident-<YYYYMMDD>`
   Slack channel; starts a Zoom bridge.

### 2. Pre-flight (minutes 10–30)

1. Incident commander assigns roles (above) in the channel.
2. SRE lead checks out the ops runner:

   ```bash
   aws sts get-caller-identity
   aws configure get region  # expect eu-central-1
   ```

3. Verify backups exist:

   ```bash
   aws rds describe-db-instance-automated-backups \
     --db-instance-identifier liverra-prod \
     --region eu-central-1
   ```

4. DPO check: was PHI in-flight at T-0? If yes → crypto-shred flow (see
   [phi-incident-response.md](./phi-incident-response.md)) runs in parallel
   on the DPO side; do NOT delay DR for this.

### 3. Dry-run first (minutes 30–90)

```bash
./scripts/dr-restore-dryrun.sh --dry-run 2>&1 | tee dr-$(date +%s).log
```

This restores into the sandbox VPC, runs the chain verifier, and tears
everything down. Confirms infrastructure is responsive before `--execute`.

**Expected outcome:** green exit + stamp written to
`s3://liverra-ops-stamps/dr-restore/last-success.json`.

### 4. Execute (minutes 90–?)

Only after the incident commander verbally confirms in the channel.

```bash
./scripts/dr-restore-dryrun.sh --execute 2>&1 | tee dr-exec-$(date +%s).log
```

The `--execute` flag:
- Keeps the sandbox RDS running (does not tear down)
- Swaps Route 53 `api.liverra.ai` + `app.liverra.ai` to the sandbox
  endpoints
- Writes the stamp + history JSON

### 5. Validate (minutes +20 after DNS TTL)

1. `curl -fsS https://api.liverra.ai/system/health` → 200
2. Open `/ops/audit/verify` in the compliance UI; click "Re-verify last
   24 h". All tenants must report green.
3. Perform one synthetic analysis on the demo case; confirm it hits
   `finalized` state.
4. Confirm PagerDuty incident is acknowledged + resolved for dependencies
   that were green-but-alerting (cascade false-positives).

### 6. Post-mortem

- Open a post-mortem ticket using [this template](../post-mortem-template.md).
- Section headers: Timeline · What went well · What went poorly · Action
  items · Lessons learned.
- Link the `dr-exec-*.log` + `docs/runbooks/dr-restore-history/*.json`
  as evidence.
- Schedule a 30-minute review within 5 business days.

## Evidence

All logs + stamps auto-archive to
`s3://liverra-audit/runbooks/dr-restore/<run-id>/`.

The `audit_anchor_written` AuditEvent emitted by the first successful
pipeline run on the sandbox is the regulatory checkpoint — it proves
chain continuity survived the restore.

## Rollback

If the sandbox is worse than prod (e.g. chain verifier fails), revert
DNS and declare a secondary incident. Do NOT try to "fix forward" on
the sandbox during an active incident. See section 5 of
[breach-tabletop-2026.md](./breach-tabletop-2026.md) for the rollback
drill.

## Sign-off

- Incident commander signs off that DNS swap + validation passed.
- DPO signs off that PHI posture is intact.
- Eng manager signs off that post-mortem is scheduled.
