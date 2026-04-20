# Runbook — Bootstrap Validation (`quickstart.md` end-to-end)

> **Owner:** Onboarding lead + DevEx
> **Cadence:** Every new hire, every release branch, every significant
> dependency bump (Node, Python, Docker images, CUDA).
> **Task reference:** T399.

## Plain-English summary

This runbook is the "does LiverRa work on a clean laptop?" checklist.
A fresh clone, one script (`npm run bootstrap:dev`), and the 8 steps
from `specs/001-zero-training-mvp/quickstart.md` should take the repo
from empty to "I can see a DICOM study rendered in my browser and get
a PDF report back." If any step fails, open a blocker issue tagged
`bootstrap-regression` before shipping anything else.

---

## Pre-flight

| Requirement | Expected | How to check |
|---|---|---|
| OS | macOS 14+, Ubuntu 22.04+, or WSL2 | `uname -a` |
| Node | v20 LTS | `node --version` |
| npm | v10+ | `npm --version` |
| Python | 3.11.x | `python3 --version` |
| Docker | 24+ with BuildKit | `docker version` |
| Docker Compose | v2 | `docker compose version` |
| Free disk | ≥ 40 GB | `df -h .` |
| GPU (optional) | NVIDIA + CUDA 12 + driver ≥ 535 | `nvidia-smi` |

Hardware note: CPU-only validates steps 1-7 (CPU e2e path). GPU path
(Triton real models) is validated separately against
`e2e-gpu.yml`-backed hardware (T461 + quickstart §9).

---

## Validation steps

For each step: run the quickstart command, capture evidence into
`.tmp/bootstrap-validation-YYYY-MM-DD/step-N/`, tick the checkbox.

### Step 1 — Clone + tool check

- [ ] `git clone git@github.com:liverra/liverra.git && cd liverra`
- [ ] `./scripts/bootstrap-dev.sh --check-only` exits 0

**Evidence:** `tool-versions.txt` (script outputs).
**Failure modes:** missing Node / Python / Docker. Fix by installing
via `asdf`/`pyenv`/Docker Desktop then re-run.

### Step 2 — Dependency install

- [ ] `npm install` completes without peer-dep errors
- [ ] `npm run lint` passes
- [ ] `cd packages/ml-inference && pip install -r requirements.txt`
  completes

**Evidence:** `npm-ls.txt`, `pip-freeze.txt`.
**Failure modes:** lockfile drift → `npm ci` instead; Python wheel
missing → check `requirements.txt` pin + platform wheel.

### Step 3 — Local stack up (Docker Compose)

- [ ] `docker compose -f deploy/docker-compose.local.yml up -d`
- [ ] `docker compose ps` shows all services healthy within 120 s

Expected services: `postgres`, `redis`, `medplum`, `orthanc`,
`minio`, `triton` (or `mock-inference` on CPU), `frontend`.

**Evidence:** `docker-compose-ps.txt`, `health-probes.json`.
**Failure modes:** port conflicts (3000, 5432, 8042, 8888); fix by
editing `.env` overrides.

### Step 4 — Database migrations + seeds

- [ ] `npm run db:migrate` applies Alembic head
- [ ] `npm run seed:demo-case` seeds a demo tenant + case
- [ ] `psql` shows the new rows

**Evidence:** `alembic-current.txt`, `seed-summary.txt`.

### Step 5 — Frontend dev server

- [ ] `npm run dev` (from repo root, Turbo orchestration) starts Vite
  on port 3000
- [ ] `curl http://localhost:3000/` returns HTTP 200 with HTML
- [ ] Browser loads app shell with RUO disclaimer visible

**Evidence:** `vite-dev-log.txt`, `localhost-3000.png`.

### Step 6 — Authenticated login + tenant selection

- [ ] Log in with seeded demo user (`demo@liverra.local` / password in
  `.env.example`)
- [ ] Pick tenant; CasesListView loads demo case

**Evidence:** `login-flow.mp4` (optional) or screenshots.

### Step 7 — Run analysis on demo case

- [ ] Open demo case → trigger `Run analysis`
- [ ] Progress reaches 100% within 8 min (CPU mock path)
- [ ] AnalysisDetailView loads 3D viewer + lesion list + FLR panel

**Evidence:** `analysis-timing.json`, `analysis-detail.png`.
**Failure modes:** mock inference crash → check
`packages/ml-inference/src/inference/mock_pipeline.py`.

### Step 8 — Generate + download PDF report

- [ ] Click `Finalize → Export PDF`
- [ ] PDF downloads with RUO watermark on every page
- [ ] Re-run `scripts/verify-ruo-watermark.py --demo-case-id <id>`
  exits 0

**Evidence:** `demo-report.pdf`, `verify-ruo-exit.txt`.
**Failure modes:** watermark missing → blocker; do not sign off.

---

## Sign-off

| Field | Value |
|---|---|
| Validator | |
| Date | |
| Clean-laptop class | macOS-apple / macOS-intel / Ubuntu-x86 / WSL2 |
| Quickstart SHA | (git rev-parse HEAD) |
| Total time elapsed | |
| Defects opened | (issue IDs) |
| Verdict | PASS / FAIL |

File the filled copy as `docs/releases/v1.0.0/bootstrap-validation-YYYYMMDD.md`
once all 8 steps pass.

---

## Automation

- `e2e-cpu.yml` performs a subset of steps 3-8 on every push to `main`.
- This runbook is the **manual** wider check required before tagging a
  release branch and before accepting a new contributor's first PR.
- Step 1 checker (`bootstrap-dev.sh --check-only`) runs in CI as the
  `ci-tool-versions` job.

## Related

- `specs/001-zero-training-mvp/quickstart.md` §1-8 source material
- `scripts/bootstrap-dev.sh` — one-shot installer
- `scripts/verify-ruo-watermark.py` (T400)
- `scripts/verify-audit-chain.py` (T401)
- `docs/runbooks/readiness-matrix.md` (T396)
