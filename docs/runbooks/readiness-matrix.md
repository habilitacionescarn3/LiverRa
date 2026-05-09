# Runbook — Production-Readiness Matrix (Live Dashboard)

> **Status:** Active skeleton — T396 + T469 upgraded-SC rows
> **Owner:** SRE + release management
> **Source of truth:** regenerated nightly from `readiness-matrix.yml` CI
> workflow artefacts; this file is checked into Git as the fallback
> when the dashboard is offline.

---

## Plain-English summary

Before we tag a `v1.0.0` release we must prove, with CI evidence, that
every Success Criterion (SC-001..SC-016) and every production-readiness
gate is green. This matrix is the single page that tells us whether
we can ship.

Each row links the SC or gate to the CI job that proves it, the last
known outcome, and the evidence URL (typically an S3 artefact).

---

## Success Criteria (SC-001..SC-016)

| SC | Description | CI job | Status | Evidence |
|---|---|---|---|---|
| SC-001 | Segmentation Dice ≥ 0.85 on AMOS22 mini | `ci-ml-regression` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-002 | P95 end-to-end analysis ≤ 8 min | `k6-nightly` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25539003311 |
| SC-003 | Classification abstention rate ≤ 20% on validation | `ci-ml-regression` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-004 | Audit chain verifier 100% pass over 24 h | `ci-fhir-integration` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-005 | PHI scrubber fail-closed on all synthetic injections | `ci-rbac-red-team` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-006 | PACS C-STORE success rate ≥ 95% (staging) | `k6-nightly` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25539003311 |
| SC-007 | DICOM UID root configured | `ci-dicom-uid-present` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-008 | RUO watermark present on all exports | `e2e-cpu` (us6-ruo-watermark) | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167450 |
| SC-009 | Multi-tenant isolation (no cross-tenant reads) | `ci-rbac-red-team` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-010 | Erasure within 30-day SLA | `e2e-cpu` (us10-erasure-request) | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167450 |
| SC-011 | Crypto-shred within 60 s | `e2e-cpu` (us10-crypto-shred-within-60s) | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167450 |
| SC-012 | Monthly infra cost within NFR-008 envelope | `cost-budget` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25207684001 |
| SC-013 | Viewer FPS ≥ 30 on 512³ reference volume | `ci-viewer-fps` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-014 | Lighthouse web-vitals budget | `ci-lighthouse` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-015 | Bundle budget (≤ 350 KB gzip initial) | `ci-bundle-check` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |
| SC-016 | License compliance (Apache-2.0 only) | `ci-license-check` | :x: red | https://github.com/MediMindAI/LiverRa/actions/runs/25575167486 |

---

## Upgraded SC gates (T469)

These are post-`/upgradeTasks` gates folded into the release process.
Each must be green for any `release/*` branch tag.

| Gate | CI job | Purpose | Status |
|---|---|---|---|
| Palette CVD check | `ci-palette-cvd-check` | Deuteranopia/protanopia/tritanopia ≥ 3:1 | :x: red |
| GPU load | `e2e-gpu` (us1-end-to-end-amos22) | Real-Triton end-to-end smoke | :arrows_counterclockwise: pending |
| Alembic round-trip | `ci-alembic-migrations` | Every migration applies + downgrades cleanly | :x: red |
| DICOM UID present | `ci-dicom-uid-present` | `liverra/dicom-uid-root` secret exists | :x: red |
| Bundle budget | `ci-bundle-check` | Initial JS ≤ 350 KB gz, viewer chunk ≤ 2 MB gz | :x: red |

---

## Operational drills

| Drill | Workflow | Cadence | Last success |
|---|---|---|---|
| DR restore (dry-run) | `dr-drill.yml` | quarterly | — |
| Breach tabletop | N/A (calendar) | annual | — |
| k6 load | `k6-nightly.yml` | nightly | — |
| PHI fire drill | manual | annual | — |

---

## How the matrix updates

The `readiness-matrix.yml` workflow (T397) runs nightly:

1. Queries each CI workflow's most recent run via `gh run list`.
2. Downloads the evidence artefact (CI-job-defined).
3. Rewrites this file's Status + Evidence columns.
4. Commits the change via a bot PR.

Manual edits are OK for the descriptive sections (top matter, headings)
but columns are regenerated.

---

## Release gate

The `release-gate.yml` workflow blocks any `release/*` tag when:

- Any SC row is ❌ red.
- Any upgraded-SC-gate row is ❌ red.
- `dr-drill.yml` last success > 90 days.
- `breach-tabletop-2026.md` evidence missing for the current year.

See `.github/workflows/release-gate.yml` for the authoritative logic.
