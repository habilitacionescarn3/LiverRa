# ADR 0002 — Medplum self-hosted in-VPC, not Medplum Cloud

- **Status:** Accepted
- **Date:** 2026-04-19
- **Authors:** Eng leads (backend + security)
- **Source:** research.md §A.2

---

## Context

LiverRa needs a FHIR R4 server to host Patient, Practitioner,
Observation, ServiceRequest, AuditEvent, and our custom LiverRa
extensions (AuditEvent extensions + analysis extensions — see
`packages/fhirtypes/src/liverra/extensions/`). We evaluated two
deployment options:

1. **Medplum Cloud** — managed FHIR-as-a-service. SaaS with
   per-project pricing.
2. **Medplum self-hosted** — same open-source Medplum server, deployed
   inside our AWS VPC alongside FastAPI and Triton.

The constitutional constraint is Principle VII (security + residency
in eu-central-1) and GDPR Art. 44 transfer limitations. Medplum Cloud
is US-hosted (as of 2026-04); even with an EU region option, the
control-plane ultimately terminates in the US parent account.

The commercial constraint is: Medplum Cloud pricing is per-project
per-month with bandwidth overage fees; at our expected ~20 tenants
each doing ~200 analyses/month, a cost projection in research §A.2
estimated ~\$4,200/mo for Cloud vs ~\$900/mo for self-hosted (RDS +
EC2 + S3), a 4.7× difference.

The customization constraint: we need to POST StructureDefinitions at
tenant-bootstrap time + embed LiverRa-specific AccessPolicy logic.
Medplum Cloud supports both, but self-hosted gives us direct access
to the Postgres backend for analytics queries that bypass the FHIR
REST layer (big wins for the compliance dashboard's audit chain
verifier).

## Decision

We deploy Medplum as a self-hosted service inside our AWS
`eu-central-1` VPC. One Medplum `Project` per hospital tenant.

Deployment: `deploy/medplum/` — docker-compose that pins a specific
Medplum server version, uses our RDS Postgres 16 instance as the
backing store, and runs behind an ALB that terminates TLS 1.3.

## Consequences

### Positive

- **Data residency**: all FHIR data lives in our VPC; no control-plane
  hop to the US. GDPR Art. 44 is satisfied trivially.
- **Cost**: ~\$900/mo vs ~\$4,200/mo at steady state — 4.7× cheaper.
- **Customization**: direct Postgres access for the compliance
  dashboard's chain-verifier queries (which would otherwise require
  FHIR `_history` pagination at scale).
- **Bootstrap control**: the `bootstrap-medplum-project.py` script
  POSTs our StructureDefinitions at tenant-create time; no manual
  SaaS onboarding workflow.
- **CI parity**: we run the same Medplum container in
  `ci-fhir-integration` that we run in prod; zero behavioural drift.

### Negative

- **Operational burden**: we own upgrades, patching, TLS cert
  rotation, backup strategy for the Medplum server itself (its
  Postgres is already covered by our RDS backup plan).
- **Upgrade cadence lag**: Medplum Cloud gets new features on day 0;
  we opt-in per release after a 2-week CI soak.
- **Support**: we rely on Medplum's public GitHub + community Slack
  for issues, not a paid SLA. Budget contingency: $5k/yr for a
  Medplum support retainer if the community channel fails us.

### Mitigations

- **Operational burden**: absorbed by our existing SRE team at
  ~0.1 FTE/month. Upgrade drills run quarterly alongside the DR drill
  (see [dr-restore.md](../../runbooks/dr-restore.md)).
- **Upgrade lag**: intentional. Our 2-week soak in `ci-fhir-integration`
  catches breaking changes before they hit tenants.
- **Support**: the Medplum support retainer line is a budgeted
  contingency; we have not needed it to date but it is funded.

## Alternatives considered

### Medplum Cloud

- **Pro:** Zero operational burden; day-0 feature access.
- **Con:** GDPR residency issue at the control-plane level; ~4.7×
  cost; SaaS vendor lock-in; less customization depth for the
  compliance dashboard's analytics queries.
- **Verdict:** Rejected on residency + cost.

### HAPI FHIR

- **Pro:** Mature open-source FHIR server; Java-based.
- **Con:** Java stack divergence from our Python backend; no native
  AccessPolicy/Project model — we'd re-implement Medplum's
  multi-tenancy layer ourselves.
- **Verdict:** Rejected on stack-divergence + multi-tenancy
  duplication.

### Build custom FHIR server on FastAPI

- **Pro:** Full control; single-stack Python.
- **Con:** Re-implementing 20% of the FHIR R4 resource model and
  50% of the search spec — not realistic for our team + timeline.
- **Verdict:** Rejected on scope-creep.

---

## References

- Research §A.2 — FHIR server decision
- Constitution Principle VII — security + residency
- GDPR Art. 44 — international data transfers
- `deploy/medplum/` — self-hosted compose stack
- `packages/ml-inference/scripts/bootstrap-medplum-project.py`
