# LiverRa Operational Runbooks

Incident-response and recurring-drill playbooks for the LiverRa platform.
Each runbook is invoked by a named responder role (DPO, SRE, compliance
officer) and produces an evidence artifact stored in
`s3://liverra-audit/runbooks/<slug>/<date>/`.

## Contents

| Runbook | Purpose | Owner | Cadence |
|---|---|---|---|
| [dr-restore.md](./dr-restore.md) | Quarterly DR restore drill — RDS PITR + pipeline_checkpoint replay | SRE | Quarterly |
| [erasure-execution.md](./erasure-execution.md) | Execute GDPR Art. 17 erasure for a specific subject | DPO | On request |
| [breach-tabletop-2026.md](./breach-tabletop-2026.md) | Annual breach-simulation tabletop exercise | CISO + DPO | Annual |
| [phi-incident-response.md](./phi-incident-response.md) | Suspected PHI exposure — first 60 minutes | On-call SRE | As needed |

## Conventions

- Every runbook has: **Preconditions**, **Roles**, **Steps**, **Evidence**, **Rollback**, **Sign-off**.
- Every execution produces a dated artifact in `s3://liverra-audit/runbooks/` with a `report.md` and machine-readable `outcome.json`.
- Evidence is retained 6 years (Object Lock compliance mode — research §A.3).
- Runbooks are versioned with the repo; breaking changes bump the top-level version header in each file.

## Related specs

- `specs/001-zero-training-mvp/plan.md` §DR & Ops Drills
- `specs/001-zero-training-mvp/research.md` §A.7 (DR), §A.3 (audit chain), X.1 (crypto-shred)
