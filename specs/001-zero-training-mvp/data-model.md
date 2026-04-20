# Data Model — Phase 1

**Feature**: 001-zero-training-mvp · **Spec**: [`spec.md`](./spec.md) · **Plan**: [`plan.md`](./plan.md) · **Research**: [`research.md`](./research.md)

This document defines the 18 domain entities introduced by spec §Key Entities, their fields, relationships, lifecycle, tenant scoping, FHIR mapping where relevant, and state machines. **It is the contract between the Postgres schema, the Medplum FHIR projection, and the TypeScript domain types in `packages/core/src/types`.**

Conventions:

- PKs are UUID v7 (time-sortable) unless noted.
- Every tenant-scoped table has `tenant_id uuid NOT NULL` + an RLS policy enforcing `tenant_id = current_setting('app.tenant_id')`.
- Timestamps are `timestamptz NOT NULL`.
- FHIR projections live in Medplum (per research A.2); the Postgres tables are the authoritative source of truth for domain logic, and Medplum resources are maintained via outbox-pattern sync.
- "Cognito claim binding" = the user identity in this column corresponds to a Cognito `sub` (UUID), not a Postgres FK to `User`.

---

## 1. Tenant

One per design-partner hospital. Creation is a manual admin task at onboarding.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `slug` | text | no | e.g. `regensburg`, `potsdam`, `geo-hospitals` — used in hosted-UI URLs |
| `display_name` | text | no | e.g. "University Hospital Regensburg" |
| `primary_locale` | enum(`en`,`de`,`ka`) | no | Default UI + email language |
| `data_residency_region` | text | no | Default `eu-central-1`; overridable per tenant if non-DACH |
| `pacs_destination` | jsonb | yes | `{ae_title, host, port, use_tls, cert_fingerprint}`; null until configured (US6) |
| `dpo_contact_email` | text | no | Required per Dependencies (FR-002a notifications + FR-040 erasure) |
| `institution_name_preserve` | bool | no | Default `false` (anonymize); tenant-configurable |
| `ruo_partial_coverage_override_enabled` | bool | no | Default `false` (FR-006a) |
| `retention_policy` | jsonb | no | `{raw_dicom_days: 90, derived_days: 365, audit_years: 6}`; per-NFR-008/010 defaults |
| `audit_chain_genesis_hash` | bytea(32) | no | A.3 genesis — `sha256("liverra-audit-genesis-" || id || created_at)` |
| `created_at`, `updated_at` | timestamptz | no | |

FHIR projection: `Organization` resource with `identifier.system=http://liverra.ai/fhir/sid/tenant`. Medplum `Project` is 1:1 with Tenant.

---

## 2. User

Clinicians, admins, ops, compliance, DPO. Identity lives in Cognito; Postgres mirrors role + tenant membership + MFA state for domain logic.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK (matches Cognito `sub` for convenience) |
| `cognito_sub` | uuid | no | Unique; Cognito identity |
| `tenant_id` | uuid | no | FK → Tenant; single-tenant in v1 (compliance reviewer may have multi-tenant via separate mapping table — see `ComplianceAssignment`) |
| `role` | enum(`hpb_surgeon`,`radiologist`,`fellow`,`admin`,`ops`,`compliance`,`dpo`) | no | |
| `email` | text | no | |
| `display_name` | text | no | |
| `locale_preference` | enum(`en`,`de`,`ka`) | no | |
| `theme_preference` | enum(`light`,`dark`,`system`) | no | Default `system` |
| `mfa_enrolled_at` | timestamptz | yes | Null until FR-041 onboarding complete |
| `mfa_last_challenged_at` | timestamptz | yes | Used by step-up gate (NFR-006) |
| `ruo_accepted_at` | timestamptz | yes | Null until onboarding step 3 complete — blocks real-patient uploads if null |
| `ruo_acceptance_signature` | bytea | yes | HMAC-SHA256(user_id + timestamp + tenant_genesis) — tamper-evident |
| `suspended_at` | timestamptz | yes | Set by admin (US6); Cognito user also disabled |
| `created_at`, `updated_at` | timestamptz | no | |

FHIR projection: `Practitioner` + `PractitionerRole`. Role + tenant materialize as `PractitionerRole.code` + `.organization`.

**Invariant**: A user with `ruo_accepted_at IS NULL` MUST NOT hold any permission except `study.view_demo_case` — enforced by `@require_permission` middleware.

---

## 3. Study

One patient's uploaded imaging. Identified by DICOM Study Instance UID; carries per-case KMS key alias.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | FK → Tenant |
| `study_instance_uid` | text | no | DICOM `(0020,000D)`; unique within tenant |
| `uploader_user_id` | uuid | no | FK → User |
| `upload_started_at` | timestamptz | no | |
| `upload_completed_at` | timestamptz | yes | Null until resumable upload finishes |
| `anonymization_status` | enum(`pending`,`passed`,`failed`,`phi_contaminated`) | no | Default `pending` |
| `phase_coverage` | jsonb | no | `{non_contrast: bool, arterial: bool, portal_venous: bool, delayed: bool}` — result of FR-003 + FR-004 phase detection |
| `ingestion_outcome` | enum(`accepted`,`rejected`) | no | |
| `ingestion_rejection_reason` | text | yes | One of `missing_portal_venous`, `mixed_patient_uid`, `insufficient_coverage`, `partial_coverage_no_override`, `non_liver_ct`, `malformed_dicom`, `phi_burned_in` |
| `partial_coverage_flag` | bool | no | Default `false`; set when admin override used (FR-006a) |
| `partial_coverage_justification` | text | yes | Captured per FR-006a audit |
| `phi_contamination_flag` | bool | no | Default `false`; set by anonymization failure (FR-002a) — blocks further access |
| `kms_case_key_alias` | text | no | `alias/liverra/case/<uuid>` — per X.1 envelope encryption |
| `created_at`, `updated_at` | timestamptz | no | |

FHIR projection: `ImagingStudy` with `identifier.system=http://liverra.ai/fhir/sid/study-uid`.

**Indexes**: `(tenant_id, study_instance_uid)` unique; `(tenant_id, phi_contamination_flag)` for the admin's quarantine view.

---

## 4. Series

One phase of the 4-phase CT protocol. Child of Study.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `study_id` | uuid | no | FK → Study (cascade on hard-delete) |
| `series_instance_uid` | text | no | DICOM `(0020,000E)` |
| `modality` | text | no | `CT` in v1 |
| `phase_label` | enum(`non_contrast`,`arterial`,`portal_venous`,`delayed`) | no | Output of phase-detection heuristic |
| `slice_count` | integer | no | |
| `image_geometry` | jsonb | no | `{rows, columns, pixel_spacing, slice_thickness, orientation}` |
| `s3_uri` | text | no | KMS-encrypted NIfTI + original DICOM tar |
| `created_at` | timestamptz | no | |

---

## 5. Analysis

One end-to-end run of the inference pipeline over a Study. Central orchestration record.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | Denormalized for RLS |
| `study_id` | uuid | no | FK → Study |
| `status` | enum(`queued`,`running`,`complete`,`failed`,`cancelled`,`partial_result`) | no | State machine below |
| `queued_at` | timestamptz | no | |
| `started_at` | timestamptz | yes | Set when worker picks up |
| `completed_at` | timestamptz | yes | Any terminal state |
| `pipeline_version` | text | no | Git SHA of orchestrator + MBoM hash |
| `cold_start_indicator` | bool | no | Set when inference began within 30 s of GPU spin-up |
| `implausible_output_reason` | text | yes | Populated when FR-007a sanity rejects; one of `total_volume_out_of_range`, `segment_zero_voxel`, `flr_negative`, `classification_sum_mismatch`, `lesion_outside_parenchyma` |
| `timeout_reason` | text | yes | Populated on FR-014a 15-min timeout |
| `retry_of_analysis_id` | uuid | yes | Self-FK; set when ops/user clicks Retry (FR-033b) |
| `cancelled_by_user_id` | uuid | yes | FK → User; nulled on retry |
| `cancelled_reason` | text | yes | |
| `atypical_anatomy_flags` | jsonb | no | Array subset of `{post_resection, transplant, pediatric, tumor_replacement_high}` (FR-007b) |
| `confidence_flags` | jsonb | no | Array subset of `{cirrhotic_degraded, low_phase_coverage, partial_coverage}` |
| `created_at`, `updated_at` | timestamptz | no | |

**State machine**:

```
queued ─[worker picks]→ running
running ─[all stages ok]→ complete
running ─[stage fails + some upstream succeeded]→ partial_result
running ─[stage fails + no upstream]→ failed
running ─[timeout FR-014a]→ failed (timeout_reason set)
running ─[sanity fails FR-007a]→ failed (implausible_output_reason set)
queued|running ─[user/ops cancel]→ cancelled
failed|cancelled|partial_result ─[user retry]→ new Analysis row with retry_of = prior
```

Indexes: `(tenant_id, status, queued_at)` for queue dashboard; `(tenant_id, study_id)` for case view.

---

## 6. PipelineCheckpoint

Per-stage durability record (cross-cutting X.2). Enables in-flight recovery after worker restart.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `analysis_id` | uuid | no | FK → Analysis, composite PK |
| `stage_no` | integer | no | 1..7 per cascade (FR-014b stage labels) |
| `stage_name` | enum(`anonymization`,`parenchyma`,`vessels`,`couinaud`,`lesion_detection`,`classification`,`flr_init`) | no | |
| `input_artifact_uri` | text | yes | NIfTI-on-S3 per research C.3 |
| `output_artifact_uri` | text | yes | |
| `completed_at` | timestamptz | no | |
| `duration_ms` | integer | no | For latency SLO tracking |
| `model_version` | text | no | MBoM row key per X.4 |
| `sanity_passed` | bool | no | |

PK: `(analysis_id, stage_no)`. Orchestrator reads `MAX(stage_no)` on worker startup to resume.

---

## 7. Segmentation

A labelled 3D mask. Subtypes distinguished by `anatomy_category`.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `analysis_id` | uuid | no | FK → Analysis |
| `anatomy_category` | enum(`parenchyma`,`couinaud`,`portal_vein`,`hepatic_vein`,`lesion`) | no | |
| `anatomy_detail` | text | yes | For `couinaud`: `I`..`VIII`; for `lesion`: FK → Lesion.id |
| `volume_ml` | numeric(10,2) | no | From voxel count × voxel volume |
| `generation_source` | enum(`ai_original`,`reviewer_edited`) | no | |
| `parent_segmentation_id` | uuid | yes | FK self; set when this is the reviewer-edited successor |
| `snomed_code` | text | no | From `fhir-codesystems.ts` LiverRa canon (research B.4) |
| `mask_s3_uri` | text | no | NIfTI label map |
| `sanity_flags` | jsonb | no | `{outside_parenchyma_pct, near_zero_volume}` |
| `created_at` | timestamptz | no | |
| `created_by_user_id` | uuid | yes | Null for AI-original; set for reviewer-edited |

Indexes: `(analysis_id, anatomy_category)`; `(analysis_id, generation_source)`.

---

## 8. Lesion

A detected focal lesion. Distinct from its Segmentation (which holds the mask).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `analysis_id` | uuid | no | FK → Analysis |
| `segmentation_id` | uuid | no | FK → Segmentation (anatomy_category=`lesion`) |
| `couinaud_location` | text | no | `I`..`VIII` or `multi_segment` |
| `longest_diameter_mm` | numeric(6,1) | no | From mask analysis |
| `volume_ml` | numeric(8,2) | no | |
| `discovery_source` | enum(`ai_detected`,`reviewer_prompted`) | no | `reviewer_prompted` = MedSAM-2 one-prompt (FR-016) |
| `display_order` | integer | no | UI list ordering |

---

## 9. Classification

Per-lesion 6-class assignment + confidence vector + abstention state.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `lesion_id` | uuid | no | FK → Lesion |
| `suggested_class` | enum(`hcc`,`icc`,`metastasis`,`fnh`,`hemangioma`,`cyst`,`abstained`) | no | `abstained` fires when max prob < threshold (FR-011) |
| `confidence_vector` | jsonb | no | `{hcc: f, icc: f, metastasis: f, fnh: f, hemangioma: f, cyst: f}`; Σ = 1.0 ± 0.01 after temperature scaling (research C.7) |
| `abstention_threshold_used` | numeric(4,3) | no | Tenant-configurable; defaults to model-family default |
| `temperature_applied` | numeric(4,2) | no | Calibration temperature (research C.7) |
| `model_version` | text | no | MBoM key |
| `reviewer_override_class` | enum(same) | yes | Non-null when user overrode (FR-046 semantics; spec §Edge Cases "Pathology disagrees") |
| `reviewer_override_at` | timestamptz | yes | |
| `reviewer_override_user_id` | uuid | yes | |
| `reviewer_override_reason` | text | yes | |

**Invariant**: `reviewer_override_class` is never mutated in place — a new Classification row supersedes with `SupersedesBy` link; both rows retained for FR-017 history.

---

## 10. FLRCalculation

Resection-plane-parameterized remnant volume.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `analysis_id` | uuid | no | FK → Analysis |
| `plane_normal` | numeric(8,5)[3] | no | Unit vector in patient coordinates |
| `plane_offset_mm` | numeric(8,2) | no | Signed distance from parenchyma centroid |
| `resected_volume_ml` | numeric(10,2) | no | |
| `remnant_volume_ml` | numeric(10,2) | no | |
| `remnant_pct_functional` | numeric(6,2) | no | FLR % |
| `author` | enum(`ai_default`,`surgeon_edited`) | no | |
| `edited_by_user_id` | uuid | yes | |
| `created_at` | timestamptz | no | |

**Invariant**: `resected_volume_ml + remnant_volume_ml = parenchyma.volume_ml ± 0.5%` — sanity-checked at write.

---

## 11. SurgeonReview

The edit-session envelope over an Analysis. Holds the review-seat lock + finalize intent.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `analysis_id` | uuid | no | FK → Analysis; unique (one review per analysis; addenda get their own row) |
| `reviewer_user_id` | uuid | no | FK → User; must hold `review.take_seat` permission |
| `seat_held_until` | timestamptz | no | Heartbeat extended every 60 s; expired seats auto-release (FR-017a) |
| `started_at` | timestamptz | no | |
| `finalized_at` | timestamptz | yes | Null = draft; non-null = locked (FR-017b) |
| `is_addendum_of_review_id` | uuid | yes | Self-FK; post-finalize addenda |
| `edit_count` | integer | no | Denormalized for UI indicator |

**Invariant**: At most one non-finalized SurgeonReview per Analysis at any time. A UNIQUE partial index `(analysis_id) WHERE finalized_at IS NULL` enforces it.

---

## 12. Report

A bundled export artifact (PDF + DICOM-SEG + DICOM-SR). Created on finalize; one Report per finalize event.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | |
| `surgeon_review_id` | uuid | no | FK → SurgeonReview |
| `analysis_id` | uuid | no | FK → Analysis (denormalized for search) |
| `status` | enum(`draft`,`finalized`,`superseded`,`retracted`) | no | |
| `finalized_at` | timestamptz | yes | |
| `finalized_by_user_id` | uuid | yes | Required step-up verified at this action |
| `superseded_by_report_id` | uuid | yes | Chain-of-corrections |
| `retracted_at` | timestamptz | yes | |
| `retraction_reason` | text | yes | |
| `pdf_sop_instance_uid` | text | yes | For consistency; PDF is not DICOM but we mint UID for audit |
| `seg_sop_instance_uid` | text | no | Fresh per finalize (FR-026b) |
| `sr_sop_instance_uid` | text | no | Fresh per finalize (FR-026b) |
| `pdf_s3_uri` | text | no | KMS-encrypted |
| `seg_s3_uri` | text | no | |
| `sr_s3_uri` | text | no | |
| `pdf_sha256` | bytea(32) | no | |
| `seg_sha256` | bytea(32) | no | |
| `sr_sha256` | bytea(32) | no | |
| `ruo_watermark_present` | bool | no | Always true; enforced at generation — if false, build fails |
| `claim_registry_snapshot` | jsonb | no | Per-claim RUO state at finalize time (FR-028b) |
| `created_at` | timestamptz | no | |

**State machine**: `draft → finalized → superseded | retracted`. Superseding creates a **new** Report with `supersedes_report_id` pointing back. Retraction sets `retracted_at` on the old row without deletion — audit-preserving per FR-027a.

---

## 13. ReportDelivery

Per-artifact per-destination PACS push state. Cross-cutting with research B.6.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `report_id` | uuid | no | FK → Report |
| `artifact_type` | enum(`seg`,`sr`) | no | PDF not pushed via DICOM store |
| `destination_ae_title` | text | no | From Tenant.pacs_destination |
| `status` | enum(`pending`,`sending`,`acknowledged`,`failed`,`manual_fallback`) | no | |
| `retry_count` | integer | no | |
| `last_error` | text | yes | PHI-scrubbed |
| `next_attempt_at` | timestamptz | yes | Exponential backoff |
| `first_sent_at`, `last_attempted_at`, `acknowledged_at` | timestamptz | yes | |

**Invariant**: status `acknowledged` implies the DICOM receiver returned `Status 0x0000`; `failed` only after retry_count ≥ 6; `manual_fallback` requires admin action.

---

## 14. AuditEvent + AuditEventChain

Immutable FHIR AuditEvent record + tamper-evident chain. Research A.3 is authoritative.

**AuditEvent** (Medplum-managed): standard FHIR R4 AuditEvent resource. LiverRa extensions:
- `http://liverra.ai/fhir/StructureDefinition/audit-permission-checked` → string (permission enum key)
- `http://liverra.ai/fhir/StructureDefinition/audit-model-version` → string (MBoM key)
- `http://liverra.ai/fhir/StructureDefinition/audit-chain-sequence-no` → integer
- `http://liverra.ai/fhir/StructureDefinition/audit-chain-leaf-hash` → bytes(32) as hex

**AuditEventChain** (Postgres):

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | Partition key |
| `sequence_no` | bigint | no | Per-tenant monotonic |
| `fhir_audit_event_id` | text | no | Medplum resource id |
| `canonical_sha256` | bytea(32) | no | SHA-256 of canonicalized (RFC 8785) FHIR AuditEvent body |
| `prev_hash` | bytea(32) | no | Genesis from `Tenant.audit_chain_genesis_hash` for sequence_no=1 |
| `leaf_hash` | bytea(32) | no | `sha256(prev_hash || canonical_sha256 || tenant_id || sequence_no)` |
| `written_at` | timestamptz | no | |

**Constraints**: `UNIQUE(tenant_id, sequence_no)`; trigger blocks UPDATE + DELETE → writes a new `tampering_attempt` AuditEvent. Daily Merkle root rolled up to S3 Object Lock (compliance mode, 6-yr retention).

**Event categories** (enumerated — spec FR-029a): `sign_in`, `sign_out`, `mfa_challenge`, `ruo_acceptance`, `permission_check`, `study_upload`, `anonymization_passed`, `anonymization_failed`, `inference_stage_start`, `inference_stage_end`, `mask_edit`, `classification_override`, `report_finalize`, `report_retract`, `artifact_export`, `pacs_push_attempt`, `pacs_push_success`, `pacs_push_failure`, `tenant_data_deletion`, `model_version_update`, `analysis_cancel`, `analysis_retry`, `privacy_incident`, `ruo_capture_attempt`.

---

## 15. PermissionGrant

Materialized view of `rbac_matrix.yaml` × Tenant × Role. Refreshed on every `rbac:generate` run.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `tenant_id` | uuid | no | |
| `role` | enum(role set) | no | |
| `permission_key` | text | no | From the permission enum in research X.3 |
| `step_up_required` | bool | no | |
| `matrix_yaml_version` | text | no | Git SHA of the yaml at generation |

PK: `(tenant_id, role, permission_key)`. Read-only to application code; maintained by the generator.

---

## 16. ModelBillOfMaterials

Per-build auto-generated model registry (FR-038). JSON-as-file in the build artifact + mirrored to Postgres for query access.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `build_sha` | text | no | PK — Git SHA of the build |
| `model_name` | text | no | Composite PK with build_sha |
| `model_family` | text | no | `stu_net`,`pictorial_couinaud`,`lilnet`,`vista3d`,`medsam2` |
| `source_url` | text | no | GitHub repo URL |
| `pinned_commit_sha` | text | no | Upstream commit hash |
| `license_text_hash` | bytea(32) | no | SHA-256 of LICENSE file at pin — drift-check input |
| `license_name` | text | no | `Apache-2.0` — asserted at build |
| `integration_date` | date | no | |
| `approver_user_id` | uuid | no | Must hold `admin.view_audit` permission at minimum |
| `mlflow_run_uri` | text | no | MLflow Registry URL |
| `dvc_path` | text | no | DVC weight blob path |

**Build invariant** (FR-038): On `npm run build:release`, the pipeline computes current license hash of each model's upstream LICENSE; any mismatch vs. stored `license_text_hash` fails the build — forces a human to review and re-approve.

---

## 17. RegulatoryClaimRegistry

Per-tenant per-claim RUO lifecycle (FR-028b).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `tenant_id` | uuid | no | |
| `claim_key` | enum(`parenchyma_volumetry`,`flr`,`couinaud_segmentation`,`vessel_identification`,`lesion_detection`,`lesion_classification`,`surgical_planning`) | no | |
| `status` | enum(`ruo`,`under_conformity_assessment`,`cleared`) | no | Default `ruo` at tenant creation |
| `effective_from` | timestamptz | no | |
| `updated_by_user_id` | uuid | no | Must hold `compliance.toggle_claim_registry` |
| `regulatory_reference` | text | yes | e.g. CE mark certificate number |

PK: `(tenant_id, claim_key)`. Referenced by the RUO disclaimer assembler at every export (FR-028b) + in every Report's `claim_registry_snapshot` JSON.

---

## 18. ErasureRequest

GDPR Art. 17 case-level erasure workflow (FR-040).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | |
| `target_study_id` | uuid | no | FK → Study (soft ref; target gets hard-deleted) |
| `requested_by_user_id` | uuid | no | Must hold `erasure.execute` (dpo role) |
| `justification` | text | no | Captured per FR-040 |
| `mfa_challenge_at` | timestamptz | no | Must be ≤5 min before execution |
| `executed_at` | timestamptz | yes | |
| `tombstone_hash` | bytea(32) | no | `sha256(study_instance_uid || tenant_id || executed_at)` |
| `confirmation_pdf_s3_uri` | text | yes | Generated post-execution |
| `status` | enum(`requested`,`executing`,`completed`,`rolled_back`) | no | |

**Invariant**: After `completed`, the target Study row and all FK-linked records (Series, Analysis, Segmentation, Lesion, Classification, FLRCalculation, SurgeonReview, Report, ReportDelivery) are hard-deleted; AuditEvents that referenced the Study are rewritten in-memory at read time (chain integrity preserved per research A.3) to substitute `sha256(pre-erasure-identifier || tombstone_hash)` placeholders for residual identifiers.

---

## 19. DemoCase

Tenant-scoped pre-loaded sample fixture (FR-042).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `tenant_id` | uuid | no | |
| `fixture_name` | text | no | e.g. `demo-case-crlm-right-hepatectomy-01` |
| `study_id` | uuid | no | FK → Study (with `anonymization_status=passed`, synthetic patient data) |
| `seeded_at` | timestamptz | no | From `scripts/seed-demo-case.sh` |

**Invariant**: Reports generated from a DemoCase carry a mandatory "Sample data — not real patient" badge AND cannot target a real PACS destination — a `Report.sample_case_flag` + ReportDelivery pre-flight check enforces this.

---

## 20. NotificationPreference

Per-user opt-in/out for non-critical notification categories (FR-043).

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `user_id` | uuid | no | PK |
| `opt_out_categories` | text[] | no | Subset of `{analysis_queue_long, pacs_failed_admin, invite_accepted_admin}` — critical categories (`auth`, `erasure_confirmation`) cannot be opted-out by schema constraint |
| `updated_at` | timestamptz | no | |

---

## 21. ComplianceAssignment *(cross-tenant mapping for compliance role)*

A compliance reviewer may audit multiple tenants (external auditor under NDA). This table is the only place where a User maps to >1 Tenant.

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `user_id` | uuid | no | Must have role=`compliance` |
| `tenant_id` | uuid | no | |
| `assignment_start` | timestamptz | no | |
| `assignment_end` | timestamptz | no | Hard-expiry; access auto-revokes |
| `scope_json` | jsonb | no | `{audit_windows: [{from, to}], permissions_scope: [...]}` — narrower than full role grant |

---

## Entity relationship overview

```
Tenant ──┬─ User (1..n)
         ├─ Study (0..n) ──┬─ Series (1..n)
         │                 ├─ Analysis (1..n) ──┬─ PipelineCheckpoint (n)
         │                 │                    ├─ Segmentation (n) ── Lesion (n) ── Classification (n)
         │                 │                    └─ FLRCalculation (n)
         │                 └─ ErasureRequest (0..n)
         ├─ SurgeonReview (n) ── Report (0..n) ── ReportDelivery (n)
         ├─ AuditEventChain (n)  [partitioned by tenant_id]
         ├─ RegulatoryClaimRegistry (7 rows, one per claim_key)
         ├─ DemoCase (n)
         └─ ModelBillOfMaterials (global, not tenant-scoped but filtered)

Cross-cutting:
  PermissionGrant (Tenant × Role × Permission; materialized from rbac_matrix.yaml)
  NotificationPreference (per User)
  ComplianceAssignment (Compliance User × Tenant, expiry-bounded)
```

---

## RLS + Medplum AccessPolicy mapping summary

Every tenant-scoped Postgres table has an RLS policy like:
```sql
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```
`app.tenant_id` is set at the start of every request by the FastAPI middleware from the Cognito `custom:tenant_id` claim.

Every FHIR resource projected to Medplum inherits Medplum's `Project` isolation (per research A.2) — a tenant == a Medplum Project. Cross-project reads return 404 (not 403), satisfying FR-032a existence-disclosure hardening at the FHIR layer.

---

## Invariants enforced at the data layer

- Single active SurgeonReview per Analysis (`UNIQUE partial idx`)
- SOP Instance UIDs globally unique + cryptographically random (UUID-derived)
- FLRCalculation: resected + remnant == parenchyma.volume_ml ± 0.5% (CHECK)
- AuditEventChain UPDATE/DELETE trigger → forbidden; logs tampering attempt
- MBoM build fails on license-hash drift (build-time, not data-layer)
- ErasureRequest executed_at requires mfa_challenge_at within last 5 min (CHECK + app guard)
- User.ruo_accepted_at NULL ⇒ no permissions except demo-case viewing (app guard)
