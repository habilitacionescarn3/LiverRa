---
doc: release-readiness
release: v1.0.0
status: Draft — populated on release branch creation
owners: Release management + SRE + Founder
last_updated: 2026-04-19
blocking_artifacts:
  - specs/001-zero-training-mvp/brand-tokens.md (status must be 'approved')
  - docs/runbooks/breach-tabletop-2026.md
  - docs/runbooks/dr-restore.md (drill ≤ 90 days)
  - docs/runbooks/readiness-matrix.md (all rows green)
---

# LiverRa v1.0.0 — Release Readiness Report

> **Plain-English summary.** Before we cut the tag `v1.0.0` every
> Success Criterion (SC-001..SC-016) must have a green CI run tied to
> it. This page is that proof. Each row links the SC to the CI job that
> validated it and the evidence URL. Release captain (founder + SRE
> lead) signs at the bottom.

## Scope

**In scope (v1 zero-training MVP):**
- STU-Net (parenchyma + lesions) + Pictorial Couinaud + LiLNet +
  VISTA3D + MedSAM-2 cascaded pipeline (no end-to-end training)
- Web application with DICOM upload, 3D viewer, FLR calculator,
  structured PDF report
- Multi-tenant isolation at DB + storage + audit layer
- Research Use Only disclaimer on every export

**Out of scope (deferred):**
- Custom model training / fine-tuning
- FDA submission artifacts
- Full EHR integration beyond PACS C-STORE + FHIR stub
- Mobile app
- Any autonomous-diagnosis claim

---

## SC evidence matrix

_Fill Workflow Run URL column on release-branch creation; the
release-gate workflow (T398) blocks the tag push until every row is
non-empty + green._

| SC | Description | CI Job | Workflow Run URL | Verdict |
|---|---|---|---|---|
| SC-001 | Segmentation Dice ≥ 0.85 on AMOS22 mini | `ci-ml-regression` | _TBD_ | _TBD_ |
| SC-002 | P95 end-to-end analysis ≤ 8 min | `k6-nightly` | _TBD_ | _TBD_ |
| SC-003 | Classification abstention rate ≤ 20% | `ci-ml-regression` | _TBD_ | _TBD_ |
| SC-004 | Audit chain verifier 100% pass over 24 h | `ci-fhir-integration` | _TBD_ | _TBD_ |
| SC-005 | PHI scrubber fail-closed on synthetic injections | `ci-rbac-red-team` | _TBD_ | _TBD_ |
| SC-006 | PACS C-STORE success ≥ 95% (staging) | `k6-nightly` | _TBD_ | _TBD_ |
| SC-007 | DICOM UID root configured | `ci-dicom-uid-present` | _TBD_ | _TBD_ |
| SC-008 | RUO watermark present on all exports | `e2e-cpu / us6-ruo-watermark` | _TBD_ | _TBD_ |
| SC-009 | Multi-tenant isolation (no cross-tenant reads) | `ci-rbac-red-team` | _TBD_ | _TBD_ |
| SC-010 | Erasure within 30-day SLA | `e2e-cpu / us10-erasure-request` | _TBD_ | _TBD_ |
| SC-011 | Crypto-shred within 60 s | `e2e-cpu / us10-crypto-shred-within-60s` | _TBD_ | _TBD_ |
| SC-012 | Monthly infra cost within NFR-008 envelope | `cost-budget` | _TBD_ | _TBD_ |
| SC-013 | Viewer FPS ≥ 30 on 512³ reference volume | `ci-viewer-fps` | _TBD_ | _TBD_ |
| SC-014 | Lighthouse web-vitals budget | `ci-lighthouse` | _TBD_ | _TBD_ |
| SC-015 | Bundle budget (≤ 350 KB gzip initial) | `ci-bundle-check` | _TBD_ | _TBD_ |
| SC-016 | License compliance (Apache-2.0 only) | `ci-license-check` | _TBD_ | _TBD_ |

### T469 upgraded gates

| Gate | CI Job | Workflow Run URL | Verdict |
|---|---|---|---|
| Palette CVD check | `ci-palette-cvd-check` | _TBD_ | _TBD_ |
| GPU concurrent load | `e2e-gpu (us1-end-to-end-amos22)` | _TBD_ | _TBD_ |
| Alembic round-trip | `ci-alembic-migrations` | _TBD_ | _TBD_ |
| DICOM UID present | `ci-dicom-uid-present` | _TBD_ | _TBD_ |
| Bundle budget | `ci-bundle-check` | _TBD_ | _TBD_ |

### Operational drills

| Drill | Last success | Evidence URL | Verdict |
|---|---|---|---|
| DR restore (dry-run) — ≤ 90 days | _TBD_ | _TBD_ | _TBD_ |
| Breach tabletop 2026 | `docs/runbooks/breach-tabletop-2026.md` | _TBD_ | _TBD_ |
| k6 load — latest nightly | _TBD_ | _TBD_ | _TBD_ |

### Brand + accessibility

| Gate | Evidence | Verdict |
|---|---|---|
| `brand-tokens.md` status = approved | _sign-off SHA_ | _TBD_ |
| `a11y-matrix.md` per-component test (T465) | _CI run_ | _TBD_ |
| `ResponsiveMatrix.md` visual sweep (T462) | _CI run_ | _TBD_ |
| Bootstrap validation (T399) | `docs/releases/v1.0.0/bootstrap-validation-*.md` | _TBD_ |
| verify-ruo-watermark.py (T400) | _artifact path_ | _TBD_ |
| verify-audit-chain.py (T401) | _artifact path_ | _TBD_ |

---

## Known limitations (to disclose in release notes)

- WebGPU viewer path experimental; WebGL2 fallback is the default.
- Mobile profile is read-only (no analysis trigger below md breakpoint).
- Only AMOS22 / CRLM-CT-Seg / self-collected datasets used for
  evaluation; public LiTS17 etc. used only for benchmarking, not
  training.
- Inference models all Apache-2.0; no proprietary commercial models.
- Single-hospital-per-deployment (multi-tenancy at app layer; physical
  isolation via per-tenant AWS accounts is v2).
- FDA 510(k) filing is post-CE-MDR; US sales blocked in v1.
- No mobile push, no email automation beyond transactional (pilot scope).

---

## Go / No-Go checklist

- [ ] Every SC-001..SC-016 row above is green
- [ ] Every T469 upgraded gate is green
- [ ] DR drill last success within 90 days
- [ ] Breach tabletop for current year exists
- [ ] `brand-tokens.md.status == approved`
- [ ] `a11y-matrix.md` per-component sweep green (T465)
- [ ] `dark-mode-sweep.spec.ts` green (T462)
- [ ] Bootstrap validation PASS on at least 2 clean-laptop classes (T399)
- [ ] `verify-ruo-watermark.py --all-demo-cases` exits 0 (T400)
- [ ] `verify-audit-chain.py --all-tenants` exits 0 (T401)
- [ ] Cost budget attestation current (`cost-budget.yml` green)
- [ ] License compliance attestation current (`ci-license-check` green)
- [ ] Release notes drafted + reviewed by founder
- [ ] Incident-response pager rota confirmed for the 14 days post-tag

---

## Sign-off

| Role | Name | Signature | Date |
|---|---|---|---|
| Founder / Medical director | Dr. Levan Gogichaishvili | | |
| Clinical radiology lead | Zviad Giorgadze | | |
| AI / ML lead | Irakli Giorgadze | | |
| Data science | Lika Svanadze | | |
| SRE / Release captain | _TBD_ | | |
| Design lead | _TBD_ | | |

Tag pushed only after all six signatures are present and this file is
committed to `main` by the release-captain branch.

---

## Related runbooks

- `docs/runbooks/readiness-matrix.md` — live scoreboard
- `docs/runbooks/bootstrap-validation.md` — T399 procedure
- `docs/runbooks/breach-tabletop-2026.md` — tabletop evidence
- `docs/runbooks/dr-restore.md` — DR drill
- `docs/runbooks/phi-incident-response.md` — on-call response
- `docs/runbooks/erasure-execution.md` — GDPR erasure
- `.github/workflows/release-gate.yml` — automated enforcement
