# Quickstart — LiverRa v1 MVP

**Feature**: 001-zero-training-mvp
**Audience**: A developer joining the LiverRa team after spec + plan are merged.
**Goal**: From fresh clone to running the demo case end-to-end in ≤30 minutes, then knowing where to make your first contribution.

---

## Prerequisites

- macOS or Linux (Windows via WSL2)
- Node.js 20 LTS + npm 10
- Python 3.11 + `uv` (or `pip`)
- Docker Desktop 4.30+ with Compose v2
- `gh` (GitHub CLI) authenticated to the LiverRa org
- For the full inference stack: NVIDIA GPU with CUDA 12 (optional for frontend-only work — use Triton CPU stub)

## 1. Clone + install

```bash
git clone git@github.com:liverra/liverra.git
cd liverra
npm install                       # Turborepo — installs workspaces
cd packages/ml-inference && uv sync && cd ../..   # Python deps
```

## 2. Configure environment

```bash
cp .env.example .env
# Edit .env — fill in:
#   AWS_REGION=eu-central-1
#   COGNITO_USER_POOL_ID=<from 1Password "LiverRa / dev">
#   COGNITO_CLIENT_ID=<...>
#   MEDPLUM_CLIENT_ID=<...>
#   MEDPLUM_CLIENT_SECRET=<...>
#   LIVERRA_UID_ROOT=1.2.826.0.1.3680043.8.XXXX
#   SENTRY_DSN_DEV=<optional>
```

Secrets live in **AWS Secrets Manager** — never commit to `.env`. The dev Cognito pool + Medplum project are pre-provisioned; ask the tech lead for access.

## 3. Bring up the local stack

```bash
./scripts/switch-env.sh local
docker compose -f deploy/local/docker-compose.yml up -d
```

This starts:

| Service | Port | Purpose |
|---|---|---|
| Postgres 16 | 5432 | Domain + AuditEventChain + PipelineCheckpoint |
| Redis 7 | 6379 | Celery + session cache |
| Orthanc 1.12 | 4242 (DIMSE) / 8042 (REST) | DICOM ingestion staging |
| Medplum server | 8103 | FHIR R4 (local mode) |
| Triton CPU stub | 8000 (HTTP) / 8001 (gRPC) | Mocks the 5 ML endpoints with returned-fixture responses |
| MinIO (S3 compatible) | 9000 / 9001 (console) | Local S3 replacement for DICOM + artifacts |
| MailHog | 8025 | Captures outbound email in dev |

## 4. Bootstrap tenants, demo case, and a dev user

```bash
npm run bootstrap:dev
```

This runs:

1. Alembic migrations (Postgres)
2. Medplum Project seeding for three demo tenants: `dev-regensburg`, `dev-potsdam`, `dev-geo`
3. `scripts/seed-demo-case.sh` — loads a fixture CT + pre-computed masks so the demo case (FR-042) is playable without the real Triton stack
4. Creates a local dev user (`dev@liverra.ai` / MFA seed in `.env.dev-mfa`)

## 5. Start the web + API

```bash
# Terminal 1 — Vite dev server (critical: port 3000 per CLAUDE.md)
cd packages/app && npx vite --port 3000

# Terminal 2 — FastAPI orchestrator
cd packages/ml-inference && uvicorn src.main:app --reload --port 7050

# Terminal 3 — Celery worker
cd packages/ml-inference && celery -A src.workers.app worker --loglevel=info
```

Open `http://localhost:3000`, sign in as `dev@liverra.ai`, complete RUO acceptance and MFA enrolment, then open the pre-seeded demo case. You should see a full analysis result within 5 minutes (CPU stub) or ≤30 seconds (with a real Triton GPU).

## 6. Run the full test suite

```bash
npm test                      # All workspaces — Vitest + pytest
npm run test:e2e              # Playwright E2E per spec §End-to-End Test Scenarios
cd packages/ml-inference && pytest tests/regression -v   # Golden CT Dice thresholds
```

## 7. Validate the contracts

```bash
npx @redocly/cli lint specs/001-zero-training-mvp/contracts/api-openapi.yaml
schemathesis run specs/001-zero-training-mvp/contracts/api-openapi.yaml --base-url http://localhost:7050/api/v1
```

## 8. Validate the RUO watermark pipeline

```bash
# Finalize the demo case via the UI, then:
python scripts/verify-ruo-watermark.py ./artifacts/demo-case-01/
# Asserts: PDF has the watermark; SEG SeriesDescription ends with "(RUO)"; SR has the TextContentItem disclaimer in all 3 languages.
```

## 9. Validate the audit chain

```bash
python scripts/verify-audit-chain.py --tenant dev-regensburg --from 2026-04-19 --to 2026-04-20
# Walks the tenant's chain, recomputes each leaf hash, compares against the daily Merkle root in S3 Object Lock. Exit 0 = chain valid.
```

---

## First PR checklist *(Constitution compliance gates)*

Before opening your first pull request, verify:

- [ ] Branch name matches `NNN-feature-name` or `NNN-fix-short-description`
- [ ] Every code-producing PR references a spec artifact under `specs/NNN-.../`
- [ ] **Apache 2.0 only** — if you touched model weights or added a new upstream model, the MBoM license-hash check passes (`scripts/model-bom.sh verify`)
- [ ] **Cascaded architecture preserved** — no stage-skipping hacks; every inference path goes through the Celery orchestrator
- [ ] **FHIR conventions** — all FHIR URLs come from `packages/app/src/emr/constants/fhir-systems.ts` (no hardcoded strings)
- [ ] **Audit fail-closed** — any new write to `AuditEventChain` is in the same Postgres transaction as the business action
- [ ] **RUO disclaimer** — any UI surface showing AI-derived output has the persistent disclaimer; any new export artifact has the watermark
- [ ] **OAuth/MFA** — any new privileged action declares `x-step-up: true` in OpenAPI + `step_up_required: true` in the decorator
- [ ] **TS strict** — `npm run type-check` passes across all workspaces
- [ ] **Python typing** — `mypy --strict` passes in `packages/ml-inference`
- [ ] **Design system** — any new UI was implemented via the `frontend-designer` agent per CLAUDE.md. No hardcoded colors; no forbidden Tailwind blues.
- [ ] **i18n** — any new user-facing string has en + de + ka translations. German medical terminology reviewed.
- [ ] **Dark mode** — any new UI verified in both themes; overlay palette CVD-safe.
- [ ] **Tests** — unit tests for any new public function; integration test for any FHIR endpoint change; E2E test for any user-facing clinical workflow change.
- [ ] **No PHI in logs / telemetry / error messages** — scrubber filter passes (`tests/observability/test_phi_scrubber.py`)

## Where to find things

| What | Where |
|---|---|
| Spec (what we're building) | `specs/001-zero-training-mvp/spec.md` |
| Plan (how we're building) | `specs/001-zero-training-mvp/plan.md` |
| Research decisions (why) | `specs/001-zero-training-mvp/research.md` + `.research/*.md` |
| Data model | `specs/001-zero-training-mvp/data-model.md` |
| API contracts | `specs/001-zero-training-mvp/contracts/` |
| Constitution (principles) | `.specify/memory/constitution.md` |
| Operational guidance | `CLAUDE.md` |
| Reusable MediMind assets to port | `CLAUDE.md` § "MediMind → LiverRa Reusable Asset Map" |
| Runbooks (DR, erasure, incident) | `docs/runbooks/` (authored during implement phase) |

## Common tasks

### Port a MediMind component

1. Find it in `/Users/toko/Desktop/medplum_medimind/` per the asset map in `CLAUDE.md`
2. Copy to the analogous LiverRa path under `packages/app/src/emr/**`
3. Replace MediMind-specific imports, remove EMR-irrelevant features, rebrand colors
4. **UI work MUST go through the `frontend-designer` agent** — do not hand-edit visuals
5. Add/update translations in `packages/app/src/emr/translations/{en,de,ka}.json`

### Add a new functional requirement

1. Amend `spec.md` with an `FR-NNNx` under the appropriate subsection
2. Re-run `/speckit.analyze` to check consistency
3. Implement

### Change a permission in the RBAC matrix

1. Edit `packages/ml-inference/src/services/auth/rbac/matrix.yaml`
2. Run `npm run rbac:generate` — regenerates Medplum AccessPolicy JSON + Python decorator registry
3. Commit both (yaml + generated files)
4. Requires **second-reviewer approval** per Constitution §Code Review Requirements

### Integrate a new ML model

1. Verify license = Apache 2.0 (constitution II); reject if not
2. Add to `packages/ml-inference/triton-models/` with `config.pbtxt`
3. Run `scripts/model-bom.sh add --family <family> --commit <sha>` — adds to `MBoM.json`
4. Add an entry to `contracts/triton-stages.md` with I/O contract
5. Add regression fixtures + Dice thresholds in `packages/ml-inference/tests/regression/`

## Help

- Slack: `#liverra-dev` (internal)
- Runbooks: `docs/runbooks/`
- Constitution questions: open a PR to `.specify/memory/constitution.md` (per Amendment Process)
- Spec clarifications: open a PR amending `spec.md` (no /speckit.clarify post-plan; edit directly then re-run `/speckit.analyze`)
