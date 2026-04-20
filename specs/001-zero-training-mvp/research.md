# Research — Phase 0 Decisions

**Feature**: 001-zero-training-mvp · **Plan**: [`plan.md`](./plan.md) · **Spec**: [`spec.md`](./spec.md) · **Generated**: 2026-04-19

This document consolidates Phase 0 research. Three parallel research agents resolved 22+ unknowns across three domains. Detail files (one per agent, ~2,500–3,000 words each) are preserved under `.research/` for implementer deep-dives; this document is the **navigable index + cross-cutting merge layer**.

| Agent | Scope | Detail file |
|---|---|---|
| A | Platform backbone (auth, FHIR, audit chain, RBAC, email, observability, DR) | [`.research/A-platform-backbone.md`](./.research/A-platform-backbone.md) |
| B | Clinical imaging pipeline (anonymization, Orthanc/CTP, DICOM-SEG/SR, PACS push, RUO burn-in, Unicode) | [`.research/B-imaging-pipeline.md`](./.research/B-imaging-pipeline.md) |
| C | ML orchestration & viewer UX (Triton VRAM budget, cascade, inter-stage data, viewer, resection plane, refinement, sanity checks, MLflow/DVC) | [`.research/C-ml-viewer.md`](./.research/C-ml-viewer.md) |

---

## Consolidated decisions (one line per item)

### A — Platform backbone

| # | Area | Decision |
|---|------|----------|
| A.1 | Identity / auth | AWS Cognito `eu-central-1` user pool + per-tenant federated hospital SSO (Shibboleth SAML / Azure AD OIDC) |
| A.2 | FHIR server | **Medplum self-hosted** in-VPC; one `Project` per hospital tenant |
| A.3 | Audit chain-of-hashes | Per-tenant **linear SHA-256 chain in Postgres** + daily Merkle root to S3 Object Lock (compliance mode, 6-yr retention) |
| A.4 | RBAC | Single `rbac_matrix.yaml` → generates (a) Medplum AccessPolicy (data layer), (b) FastAPI `@require_permission` decorator (domain actions + step-up gate) |
| A.5 | Email | **AWS SES `eu-central-1`** with Jinja2 templates under `{en,de,ka}/` + DKIM/SPF/DMARC aligned + bounce hygiene via SNS → Celery |
| A.6 | Observability | Sentry EU + PostHog EU + CloudWatch + Grafana Cloud EU + OpenTelemetry, unified PHI scrubber (`phi_scrubber.py`) fail-closed |
| A.7 | DR | RDS Postgres Multi-AZ + 5-min PITR + S3 Versioning/SRR + Redis AOF + **Postgres `pipeline_checkpoint`** table for in-flight-job recovery |

### B — Clinical imaging pipeline

| # | Area | Decision |
|---|------|----------|
| B.1 | Anonymization | **Two-layer hybrid**: RSNA CTP (header PS3.15) + Presidio image-redactor (pixel OCR) in **edge appliance**; fail-closed on any error |
| B.2 | Burned-in pixel PHI | Presidio + Tesseract on **four corners + bottom strip** (triage-positive slices); full-image on Secondary Capture class |
| B.3 | Orthanc | 1.12+ + DICOMweb plugin + Postgres backend + Lua `ReceivedInstanceFilter` → sidecar webhook; DIMSE TLS 1.2 only (documented limitation) |
| B.4 | DICOM-SEG | One `MULTI_SEGMENT_BINARY` SEG per analysis (parenchyma + 8 Couinaud + 2 vessels + N lesions) with SNOMED-CT codes; fresh SOP UID per finalization |
| B.5 | DICOM-SR | Single **TID 1500 Measurement Report** referencing the SEG (no duplicated ROI geometry); RUO disclaimer as top-level `TextContentItem` |
| B.6 | PACS C-STORE push | **`pynetdicom` from FastAPI orchestrator** (not Orthanc forwarding); Postgres `ReportDelivery` state machine (pending→sending→acknowledged/failed→manual-fallback); exponential backoff 1→32 min × 6 attempts; C-ECHO pre-flight on PACS config save |
| B.7 | RUO pixel-burn | **5 defensive layers**: canvas pixel-burn + DOM overlay + `@media print` CSS + server-side WeasyPrint burn + DICOM structured-field embedding. Documented limits: `getDisplayMedia` + devtools cannot be fully intercepted |
| B.8 | Unicode / DICOM charset | Force **ISO_IR 192 (UTF-8)** everywhere; NFC normalize before PHI detection; WeasyPrint embeds Noto Sans + Noto Sans Georgian; CTP "sanitize to ASCII" filter disabled |

### C — ML orchestration & viewer UX

| # | Area | Decision |
|---|------|----------|
| C.1 | Triton VRAM policy | **Priority tiers**: Tier-A always-loaded (STU-Net parenchyma + STU-Net lesions + Couinaud ≈ 14.5 GB) + Tier-B lazy with 10-min idle unload (LiLNet / VISTA3D / MedSAM-2). Working set 23.5 GB, ~500 MB margin on L4 24 GB |
| C.2 | Cascade orchestration | **Celery + Postgres state machine** (not Prefect/Dagster/Triton ensemble); per-stage timeout budgets; `pipeline_checkpoint` row written before releasing GPU for each stage boundary |
| C.3 | Inter-stage data | In-process NumPy for stages 1→3 in one Celery task + **NIfTI-on-S3** at stage boundaries for durable audit + FR-014b partial-result recovery |
| C.4 | Viewer | **Custom Cornerstone3D 2.0 shell** (not OHIF) — OHIF's mode/extension system fights Mantine shell + makes RUO pixel-burn brittle. Port MediMind viewer primitives per CLAUDE.md asset map |
| C.5 | Resection plane | **Client-side WebGPU/WebGL** voxel counting against parenchyma mask texture; sub-20 ms per drag update — well under FR-013's ≤1 s |
| C.6 | Refinement UX | Custom Cornerstone3D tools wrapping VISTA3D click-to-refine + MedSAM-2 one-prompt; per-click undo stack **mirrored to IndexedDB** for offline/session-recovery (FR-018c) |
| C.7 | ML output sanity | **Two-layer**: inline per-stage Pydantic schema + aggregate end-of-pipeline validator; LiLNet softmax **temperature-scaled** before abstention threshold fires (raw softmax over-confident on OOD CTs) |
| C.8 | Model versioning | **MLflow Registry + DVC** weight blobs + auto-generated `MBoM.json` at build; feeds FR-038 MBoM row + every AuditEvent's `model.version` field. Build fails hard on upstream license-hash drift |

---

## Cross-cutting merge items *(where agents' domains overlap)*

The three agents each surfaced a concern that lives on another agent's territory. These are reconciled here so the implementation phase doesn't re-discover them.

### X.1 Per-case KMS envelope encryption → crypto-shred

**Source**: A.7 (DR), B.1 (anonymization), FR-040 (GDPR erasure).

**Resolution**: Every Study's DICOM + derived artifacts are encrypted at-rest with a **per-case data encryption key** (DEK). Each DEK is wrapped by a per-case AWS KMS key (alias `alias/liverra/case/{uuid}`). GDPR erasure = **synchronous KMS key destruction** + tombstone row in Postgres; backups become cryptographic garbage for the erased case without having to rewrite historical backups.

**Integration**:
- Key created at ingestion in the edge anonymization sidecar (B.1), before bytes leave the hospital network → uploaded DICOM arrives in S3 already wrapped.
- Crypto-shred path: `packages/ml-inference/src/services/erasure/crypto_shred.py` calls `kms:ScheduleKeyDeletion` with `PendingWindowInDays=7` for recoverability, downgraded to immediate deletion on final erasure confirmation.
- **FR-002a 60-second requirement**: the post-upload PHI-discovery incident path calls KMS destroy synchronously, not via queue, to meet the 60 s SLA; alarm fires if KMS API p99 > 30 s.
- Backup interaction: RDS snapshots + S3 Versioning replicas contain only ciphertext; destroying the KMS key renders all backups unrecoverable for that case — no need to rewrite or delete backup contents.

### X.2 `pipeline_checkpoint` contract

**Source**: A.7 (DR + worker restart recovery), C.2 (cascade orchestration), NFR-009.

**Resolution**: `pipeline_checkpoint(analysis_id, stage_no, stage_name, input_artifact_uri, output_artifact_uri, completed_at, model_version)` is the contract between Celery orchestration (C.2) and DR recovery (A.7). **Every stage MUST write its checkpoint row in the same Postgres transaction that releases its GPU lease before the next stage claims it.** On worker restart, the orchestrator reads the highest `stage_no` for each running Analysis and resumes from the next stage; stages 1..N-1 are not re-executed, preserving FR-014b partial-result semantics and the audit chain.

**Schema**: declared once in `packages/ml-inference/src/models/pipeline.py`; Alembic migration introduced as task `T-002-data-pipeline-checkpoint` during `/speckit.implement`.

### X.3 Shared `rbac_matrix.yaml` permission enum

**Source**: A.4 (RBAC), B.6 (PACS push retry + manual fallback), C.6 (refinement actions + model-version-promote).

**Resolution**: One authoritative permission enumeration. Each agent's domain actions merge into a single flat list. Draft keys (non-exhaustive):

```yaml
# packages/ml-inference/src/services/auth/rbac/matrix.yaml
permissions:
  # Ingest & analysis
  - study.upload
  - study.cancel_analysis
  - study.retry_analysis
  - study.request_deletion
  - study.approve_deletion
  # Review & refinement
  - review.take_seat
  - review.refine_mask            # VISTA3D click-to-refine
  - review.reprompt_lesion        # MedSAM-2 one-prompt re-seg
  - review.override_classification
  # Export & PACS
  - report.finalize               # step_up: true
  - report.retract
  - report.pacs_push
  - report.pacs_retry
  - report.manual_fallback_download
  # Admin
  - admin.invite_user
  - admin.assign_role
  - admin.suspend_user
  - admin.configure_pacs
  - admin.cecho_pacs
  - admin.approve_deletion
  - admin.view_audit
  # Ops
  - ops.view_queue
  - ops.cancel_analysis
  - ops.retry_analysis
  - ops.mark_blocked
  # Compliance
  - compliance.view_mbom
  - compliance.generate_audit_summary
  - compliance.spot_check_ruo
  - compliance.toggle_claim_registry
  # DPO (GDPR)
  - erasure.execute                # step_up: true, requires MFA + justification
roles:
  hpb_surgeon: [study.*, review.*, report.finalize, report.retract, report.pacs_push, report.pacs_retry, report.manual_fallback_download]
  radiologist: [study.upload, study.cancel_analysis, study.retry_analysis, review.*, report.finalize, report.retract, report.pacs_push, report.pacs_retry]
  fellow:      [study.upload, review.take_seat, review.refine_mask, review.reprompt_lesion, review.override_classification]   # no finalize
  admin:       [admin.*, study.approve_deletion]                                                                              # no clinical content unless also credentialed
  ops:         [ops.*]                                                                                                        # no PHI
  compliance:  [compliance.*]                                                                                                 # read-only; no modify
  dpo:         [erasure.execute, admin.view_audit]
```

Generator `rbac/generator.py` consumes this and emits (a) Medplum AccessPolicy JSON per role + tenant, (b) a Python registry consumed by `@require_permission`. `rbac_matrix.yaml` changes require a second-reviewer approval per Constitution Code Review gate.

### X.4 `AuditEvent` ↔ model-version binding

**Source**: A.3 (chain-of-hashes), C.8 (MLflow / MBoM), Constitution V.

**Resolution**: Every `AuditEvent` for a pipeline stage carries a `detail` field `model.version` sourced from `MBoM.json` baked at build. This binds each audit entry to an immutable model identity that can be re-verified later by loading the MBoM row for that version. The chain-of-hashes then guarantees the audit record itself cannot be mutated; `MBoM.json` + the S3 Object Lock daily Merkle root guarantees the model identity cannot be retroactively changed. Together: **traceable + tamper-evident + reproducible**.

---

## Decisions still open *(deliberately deferred to `/speckit.tasks` or early implementation)*

These are **not** spec-level clarifications; they are implementation sequencing items:

1. **LiverRa DICOM UID root acquisition** — one-time task before first release; free via Medical Connections or a purchased OID. Owner: ops.
2. **Tenant default for `InstitutionName` preservation** — default = anonymize; research-consortium opt-in to preserve. Confirm with Regensburg + Potsdam legal during DPA execution.
3. **RUO disclaimer exact wording in de / ka** — native-speaker review required before first finalization (Constitution X, NFR-003, Spec Dependencies).
4. **C-STORE retry horizon tuning** — 2 h default from B.6; ops may tune after observing first 20 production pushes.
5. **Pixel-PHI scan default** — corner+strip on fast path; "strict full-image" tenant opt-in. DPO confirmation.
6. **Per-claim regulatory registry seed state** — all claims start as `RUO` at go-live (FR-028b); tasks phase defines the CRUD UI for the compliance dashboard (US10 acceptance scenario 3).

None of these blocks Phase 1.

---

## Post-research constitution re-check

All ten principles still pass. No complexity-tracking entries required. Specifically:

- **Principle II (Apache 2.0 licensing)**: C.8's MLflow + DVC + MBoM hash-drift detection operationalizes the license-verification gate. Build fails on upstream drift — automated enforcement.
- **Principle III (cascaded architecture)**: C.2 explicitly rejects the Triton ensemble pattern in favor of stage-level state machine + telemetry + partial-result preservation. Cascade is preserved at the orchestration layer, not hidden inside a composite model.
- **Principle IV (FHIR-first)**: A.2 (Medplum) natively enforces extension URL conventions + tenant-isolated Projects; FHIR types centralized in `packages/fhirtypes`. No custom FHIR plumbing.
- **Principle V (auditability)**: A.3 + C.8 + X.4 give tamper-evident chain + reproducible model identity, satisfying "can we prove it" under audit.
- **Principle VI (RUO)**: B.7's five-layer pixel-burn + FR-028b per-claim registry + compliance dashboard spot-check covers the full lifecycle.
- **Principle VII (security + residency)**: A.1 Cognito + A.7 RDS Multi-AZ + X.1 crypto-shred all stay in `eu-central-1`; no third-country exposure.

Plan gate: **PASS**.

---

## Source briefs (full text on disk)

- `.research/A-platform-backbone.md` (3,000 words)
- `.research/B-imaging-pipeline.md` (2,900 words)
- `.research/C-ml-viewer.md` (2,900 words)

Each brief contains Decision / Rationale / Alternatives considered / Integration notes per item, plus risks, open items, and sources. Implementers should read the relevant brief(s) before starting a task that touches their domain.
