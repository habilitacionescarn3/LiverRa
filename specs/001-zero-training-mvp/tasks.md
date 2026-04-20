---
description: "LiverRa v1 MVP — Zero-Training Cascaded Pretrained Liver AI Pipeline — implementation tasks"
---

# Tasks: Zero-Training Cascaded Pretrained Liver AI Pipeline (v1 MVP)

<!-- UPGRADED -->
<!-- 2026-04-19: /upgradeTasks merged 67 new tasks (T403-T469) from 4 parallel audit agents: test completeness, UI coverage, production readiness, wiring orphans. 27 existing tasks received inline `[frontend-designer]` annotations. -->


**Input**: Design documents from `/specs/001-zero-training-mvp/`
**Prerequisites**: [`spec.md`](./spec.md) (564 lines, 47 FRs / 10 NFRs / 10 user stories / 16 SCs) · [`plan.md`](./plan.md) (1,114 lines, 10 new architecture/testing sections) · [`research.md`](./research.md) (22+ Phase-0 decisions) · [`data-model.md`](./data-model.md) (21 entities) · [`contracts/`](./contracts/) (OpenAPI + Triton + DICOM schemas) · [`quickstart.md`](./quickstart.md)

**Format**: `[ID] [P?] [W?] [Story?] Description with file path + spec/FR/NFR/SC ref`

- **[P]** — parallel-safe (different files, no dependency on an in-flight task)
- **[W]** — integration wire task (imports a created artifact into its consumer; never `[P]` with its producer)
- **[USn]** — user-story phase tasks only

**Execution agents** (per CLAUDE.md):
- UI work (anything under `packages/app/src/emr/components/**` or CSS) — **MUST** go through the `frontend-designer` agent
- FHIR work — invoke the `fhir-developer` skill first
- Everything else — `coder` agent

**Constraints** (Constitution + CLAUDE.md):
- Max 3 files per batch (No Bulk File Edits — MediMind 377-file regex incident)
- No hardcoded FHIR URLs (use `packages/app/src/emr/constants/fhir-systems.ts`)
- No hardcoded colors (forbidden: `#3b82f6`, `#60a5fa`, `#2563eb`, `#4267B2`)
- No Russian translation keys (only en/de/ka)
- Every FHIR/DICOM/ML task emits a FHIR AuditEvent via the chain-of-hashes writer
- Every state-changing task includes its matching wiring

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Repo baseline, tooling, local + cloud infra, CI scaffolding. No business logic.

- [X] T001 Create root `.gitignore` entries for `.env`, `.env.*`, `node_modules/`, `dist/`, `.turbo/`, `*.log`, `packages/ml-inference/.venv/`, `packages/ml-inference/triton-models/**/weights.bin`, `packages/app/dist/`, `coverage/`, `.research/`, `.upgrade-parts/`
- [X] T002 Create `.env.example` covering all required env vars from plan §Technical Context + research §A (Cognito, Medplum, RDS, Elasticache, S3, KMS, SES, Sentry, PostHog, OTel, `LIVERRA_UID_ROOT`) per quickstart.md
- [X] T003 [P] Create `.pre-commit-config.yaml` with `gitleaks`, `ruff`, `mypy` (py), `eslint` (ts), `prettier`, custom `no-bulk-regex-touch` hook (rejects diffs >3 files with identical line-level edits)
- [X] T004 [P] Update root `package.json` workspaces to declare `packages/{app,core,imaging,fhirtypes}` (not `ml-inference` — Python)
- [X] T005 [P] Update root `turbo.json` pipeline with tasks: `check-types`, `generate:openapi-client`, `generate:fhir-types`, `generate:permissions`, `model-bom`, `license-check`, `bundle-analyze`, `palette-cvd-check`, `i18n-check` per plan §Monorepo & Guardrails
- [X] T006 [P] Scaffold `packages/core/eslint-plugin-liverra/` with plugin skeleton + placeholder rules (11 rules per plan §Guardrail lint rules)
- [X] T007 [P] Create root `.eslintrc.cjs` with `eslint-plugin-boundaries` enforcing: `app→{core,imaging,fhirtypes}`, `imaging→{core,fhirtypes}`, `fhirtypes→∅`, `core→∅` per plan §Import graph rules
- [X] T008 Create `deploy/local/docker-compose.yml` with services: postgres:16, redis:7, orthanc:1.12, medplum-server, triton-cpu-stub, minio, mailhog per quickstart §3
- [X] T009 Create `deploy/production/docker-compose.yml` referencing managed AWS services (RDS, Elasticache, S3) per research §A.7
- [X] T010 Create `scripts/switch-env.sh` supporting `local|production|onprem` targets; symlinks `.env` + selects docker-compose file
- [X] T011 Create `scripts/seed-demo-case.sh` (stub for FR-042 — full impl in Phase 9)
- [X] T012 Create `scripts/model-bom.sh` stub (reads `triton-models/*`, `requirements.txt` → `MBoM.json` per FR-038; full logic in Phase 2)
- [X] T013 Create `scripts/gdpr-erasure-sim.sh` stub (full impl in Phase 11)
- [X] T014 Create `scripts/dr-restore-dryrun.sh` stub (full impl in Phase 13)
- [X] T015 [P] Provision AWS Cognito user pool in `eu-central-1` via Terraform at `deploy/terraform/cognito.tf` (TOTP MFA + required `custom:tenant_id`) per research §A.1
- [X] T016 [P] Provision RDS Postgres 16 Multi-AZ + 5-min PITR + Elasticache Redis Multi-AZ via Terraform at `deploy/terraform/{rds,elasticache}.tf` per research §A.7
- [X] T017 [P] Provision S3 buckets `liverra-imaging-eu-central-1` (Versioning+SRR) + `liverra-audit-anchors-eu-central-1` (Object Lock, compliance mode, 6-yr retention) via `deploy/terraform/s3.tf` per research §A.3/§A.7
- [X] T018 [P] Provision KMS alias template `alias/liverra/case/*` + Secrets Manager entries for `LIVERRA_UID_ROOT`, `MEDPLUM_CLIENT_SECRET`, `COGNITO_CLIENT_SECRET` via `deploy/terraform/kms.tf`
- [X] T019 [P] Provision SES sending identity `notifications@liverra.ai` + DKIM/SPF/DMARC Route 53 records via `deploy/terraform/ses.tf` per research §A.5
- [X] T020 Create `.github/workflows/ci.yml` skeleton with jobs `ci-unit-ts`, `ci-unit-py`, `ci-lint`, `ci-typecheck`, `ci-contract`, `ci-bundle-check`, `ci-i18n`, `ci-forbidden-colors`, `ci-ui-agent-check` per plan §Testing Strategy
- [X] T021 [P] Create `.github/workflows/security.yml` with `zap-baseline`, `gitleaks`, `trivy-image`, `trivy-config`, `npm-audit`, `pip-audit`, `semgrep-ts`, `semgrep-py`, `bandit`, `testssl` per plan §Security scanning
- [X] T022 [P] Create `.github/workflows/dr-drill.yml` (scheduled monthly; runs `scripts/dr-restore-dryrun.sh`; blocks release if stale >90 days) per plan §DR & Ops Drills
- [X] T023 [P] Create `.github/workflows/cost-budget.yml` (monthly AWS Cost Explorer alarm check vs NFR-008 envelope, 70% + 90% thresholds) per plan §Production-Readiness Matrix SC-012
- [X] T024 [P] Create `.github/CODEOWNERS` declaring medical-terminology reviewers: `packages/app/src/emr/translations/de/glossary.medical.json @german-hpb-reviewer`, `packages/app/src/emr/translations/ka/glossary.medical.json @georgian-hpb-reviewer` per plan §i18n wiring
- [X] T025 Create `docs/runbooks/` directory with stub README + placeholder files `dr-restore.md`, `erasure-execution.md`, `breach-tabletop-2026.md`, `phi-incident-response.md`
- [X] T403 [P] Create `scripts/ci-bundle-check.mjs` + extend `.github/workflows/ci.yml` job `ci-bundle-check` — parses `rollup-plugin-visualizer` stats.json; fails PR if initial JS > 350 KB gzip OR viewer chunk > 2 MB gzip OR any admin/ops/compliance chunk > 200 KB gzip per plan §Route-level lazy-loading §Bundle budget; posts chunk-size-delta table as PR comment
- [X] T404 Create `scripts/ops/acquire-dicom-oid.md` runbook + `scripts/ops/configure-dicom-uid-root.sh` — documents Medical Connections OID request process (~5-day lead time, ~$300 USD), writes acquired OID to AWS Secrets Manager key `liverra/dicom-uid-root` (format `1.2.826.0.1.XXXXXX`), sets env `LIVERRA_UID_ROOT` for T138 bootstrap; CI check `ci-dicom-uid-present` asserts secret exists before go-live tag per SC-007 (spec §Clarifications open operational item)

**Checkpoint 1**: Setup done — repo + infra + CI scaffolding ready. Team can clone + `npm install` + bring up local stack.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Everything required BEFORE any user story can be implemented. MediMind → LiverRa ports, FHIR constants, Postgres schema, RBAC generator, audit chain, PHI scrubber, API codegen, translation system, theme, EMR library.

**⚠️ CRITICAL**: No US work starts until Checkpoint 2.

### Sub-2a: Core packages scaffolding

- [X] T026 Create `packages/core/src/{types,fhir,hash,i18n}/` barrel + `tsconfig.json` (strict ESM) + `package.json` per plan §Project Structure
- [X] T027 [P] Create `packages/core/src/types/analysis.ts` with domain types `Analysis`, `PipelineCheckpoint`, `AnalysisStatus` enum matching data-model §5/§6
- [X] T028 [P] Create `packages/core/src/types/segmentation.ts` (`Segmentation`, `Lesion`, `Classification`, `FLRCalculation`) matching data-model §7-10
- [X] T029 [P] Create `packages/core/src/types/report.ts` (`SurgeonReview`, `Report`, `ReportDelivery`) matching data-model §11-13
- [X] T030 [P] Create `packages/core/src/types/audit.ts` (`AuditEvent`, `AuditEventChain`, `AuditCategory` enum of 24 categories) matching data-model §14
- [X] T031 [P] Create `packages/core/src/types/tenant.ts` (`Tenant`, `User`, `Role` enum, `PermissionGrant`, `NotificationPreference`, `ComplianceAssignment`) matching data-model §1/§2/§15/§20/§21
- [X] T032 [P] Create `packages/core/src/types/regulatory.ts` (`ModelBillOfMaterials`, `RegulatoryClaimRegistry`, `ClaimKey` enum, `ErasureRequest`, `DemoCase`) matching data-model §16-19
- [X] T033 Create `packages/core/src/hash/chainOfHashes.ts` — pure helpers: `canonicalJson(obj)` (RFC 8785 JCS), `sha256(bytes)`, `leafHash(prev, canonical, tenantId, seqNo)` per research §A.3
- [X] T034 [P] Scaffold `packages/fhirtypes/src/{r4,liverra}/` + generator script `scripts/generate-fhir-types.ts` that consumes FHIR R4 JSON schema → TS types
- [X] T035 [P] Scaffold `packages/imaging/src/{dicom,cornerstone,highdicom-wrapper,viewer}/` + `tsconfig.json` (strict ESM) + `package.json`

### Sub-2b: FHIR constants + Medplum bootstrap

- [X] T036 Create `packages/app/src/emr/constants/fhir-systems.ts` — all identifier systems + code systems under `http://liverra.ai/fhir/sid/*` per Constitution IV (reference MediMind pattern at `/Users/toko/Desktop/medplum_medimind/packages/app/src/emr/constants/fhir-systems.ts`)
- [X] T037 [P] Create `packages/app/src/emr/constants/fhir-extensions.ts` — LiverRa StructureDefinition URLs under `http://liverra.ai/fhir/StructureDefinition/*` (audit-permission-checked, audit-model-version, audit-chain-sequence-no, audit-chain-leaf-hash, ruo-claim-key, ruo-watermark-present, atypical-anatomy-flags, implausible-output-reason)
- [X] T038 [P] Create `packages/app/src/emr/constants/fhir-identifiers.ts` — tenant, study-uid, analysis-id, report-id, user-cognito-sub naming systems
- [X] T039 [P] Create `packages/app/src/emr/constants/fhir-codesystems.ts` — all SNOMED-CT codes from contracts/dicom-artifacts.md (10200004 liver, 245302009..245309003 Couinaud I-VIII, 32764006 portal vein, 8887007 hepatic vein, 109841003 HCC, 312104005 ICC, 62129009 FNH, 235857004 hemangioma, 235866006 cyst, 94381002 metastasis)
- [X] T040 Create `packages/fhirtypes/src/liverra/extensions/StructureDefinition-audit-*.json` files (4 StructureDefinitions for the 4 LiverRa AuditEvent extensions in T037)
- [X] T041 [P] Create `packages/fhirtypes/src/liverra/extensions/StructureDefinition-analysis-*.json` (implausible-output-reason, atypical-anatomy-flags, partial-coverage-flag)
- [X] T042 Create `packages/ml-inference/scripts/bootstrap-medplum-project.py` — registers a Medplum `Project` per tenant, POSTs all StructureDefinitions from T040-T041 at first boot per research §A.2
- [X] T043 [W] Wire `fhir-systems.ts` / `fhir-extensions.ts` / `fhir-identifiers.ts` / `fhir-codesystems.ts` into a single re-export — create `packages/app/src/emr/constants/index.ts` with `export * from './fhir-*'`

### Sub-2c: Cognito identity + OIDC client

- [X] T044 Create `packages/ml-inference/src/lambda/cognito-backup-codes.py` Lambda trigger (generates + hashes 10 argon2id codes on MFA enrolment, stores in Postgres `user_backup_codes`) per research §A.1
- [X] T045 Wire Cognito pool → Lambda triggers in `deploy/terraform/cognito.tf` (Pre-Sign-Up: tenant assignment; Post-Authentication: audit event; Define Auth Challenge: backup codes)
- [X] T046 [P] Create `packages/app/src/emr/services/auth/oidcClient.ts` using `oidc-client-ts` with silent-renew iframe + `auth_time` claim extraction for step-up
- [X] T047 [P] Create `packages/ml-inference/src/services/auth/jwks_validator.py` using `python-jose` + `aws-jwt-verify` equivalent per research §A.1
- [X] T048 Create `packages/app/src/emr/services/auth/index.ts` barrel + `useAuth()` hook returning `{user, tenant, permissions, signIn, signOut, refresh, challengeStepUp}`
- [X] T049 Create `packages/ml-inference/src/middleware/auth_middleware.py` — FastAPI dependency validating Cognito JWT, setting `request.state.tenant_id` + `request.state.user` + `request.state.auth_time`
- [X] T050 [W] Wire `jwks_validator.py` into FastAPI app factory — add `app.add_middleware(AuthMiddleware)` in `packages/ml-inference/src/main.py`

### Sub-2d: Postgres schema + Alembic migrations

- [X] T051 Create `packages/ml-inference/alembic.ini` + `packages/ml-inference/src/db/alembic/env.py` configured for `DATABASE_URL` env var
- [X] T052 Create Alembic migration `20260419_0001_tenant_user.py` — tables `tenant`, `user`, `notification_preference`, `compliance_assignment` per data-model §1/§2/§20/§21 with RLS policies on `tenant`-scoped tables
- [X] T053 Create Alembic migration `20260419_0002_study_series_analysis.py` — tables `study`, `series`, `analysis`, `pipeline_checkpoint` per data-model §3-6 with indexes `(tenant_id, study_instance_uid)`, `(tenant_id, status, queued_at)`, `(analysis_id, stage_no)` PK
- [X] T054 Create Alembic migration `20260419_0003_segmentation_lesion.py` — tables `segmentation`, `lesion`, `classification`, `flr_calculation` per data-model §7-10 with invariant CHECK constraints (FLR sum ±0.5%, classification vector sum 1.0 ±0.01)
- [X] T055 Create Alembic migration `20260419_0004_review_report.py` — tables `surgeon_review` (with UNIQUE partial index `(analysis_id) WHERE finalized_at IS NULL`), `report`, `report_delivery` per data-model §11-13
- [X] T056 Create Alembic migration `20260419_0005_audit_chain.py` — table `audit_event_chain` partitioned by `tenant_id`, UNIQUE `(tenant_id, sequence_no)`, trigger function `raise_tampering_attempt()` on UPDATE/DELETE per research §A.3
- [X] T057 Create Alembic migration `20260419_0006_rbac_mbom_claims.py` — tables `permission_grant`, `model_bill_of_materials`, `regulatory_claim_registry` (seeded with 7 claim rows per tenant, all `status=ruo`)
- [X] T058 Create Alembic migration `20260419_0007_erasure_democase.py` — tables `erasure_request`, `demo_case`
- [X] T059 Create `packages/ml-inference/src/db/session.py` — SQLAlchemy 2 engine + async session factory + RLS-aware context manager that sets `SET LOCAL app.tenant_id = '...'` per request

### Sub-2e: RBAC matrix + generator

- [X] T060 Create `packages/ml-inference/src/services/auth/rbac/matrix.yaml` with full permission enum (30+ permissions) + 7 roles per research §X.3 (draft in research.md §Cross-cutting)
- [X] T061 Create `packages/ml-inference/src/services/auth/rbac/generator.py` — consumes `matrix.yaml` → emits (a) `packages/app/src/emr/constants/permissions.gen.ts` (string-literal union type), (b) `permissions_registry.py` (Python enum), (c) Medplum AccessPolicy JSON per role × tenant under `deploy/medplum/access-policies/`
- [X] T062 Create `packages/ml-inference/src/middleware/require_permission.py` — FastAPI decorator `@require_permission(perm, step_up=False)` checking `request.state.user.permissions`, `auth_time` freshness for step-up, tenant scoping, emitting `permission_check` AuditEvent with outcome
- [X] T063 Create Turbo task `generate:permissions` in root `turbo.json` invoking `python -m src.services.auth.rbac.generator` with outputs `permissions.gen.ts` + `permissions_registry.py` + `access-policies/*.json`
- [X] T064 Run `npm run generate:permissions` once + commit outputs (populates `permissions.gen.ts` before downstream tasks consume it)

### Sub-2f: Audit chain-of-hashes (backend)

- [X] T065 Create `packages/ml-inference/src/services/audit/chain_of_hashes.py` — `AuditChainWriter.write(event_dict, tenant_id)`: canonicalize → compute `leaf_hash` → INSERT `audit_event_chain` row in same Postgres txn as caller's business row per research §A.3
- [X] T066 Create `packages/ml-inference/src/services/fhir/audit_event_emitter.py` — converts domain event to FHIR `AuditEvent` resource with LiverRa extensions → POSTs to Medplum → calls `chain_of_hashes.write()` in the same txn (fail-closed per FR-029b)
- [X] T067 Create `packages/ml-inference/src/tasks/daily_merkle_root.py` Celery-beat task — runs 02:00 UTC per tenant, computes Merkle root of prior day's leaves, writes to `s3://liverra-audit-anchors-eu-central-1/<tenant>/<yyyy-mm-dd>.json` with Object Lock compliance mode
- [X] T068 [W] Wire `AuditChainWriter` into FastAPI app lifespan — instantiate singleton + inject via `Depends()` in `packages/ml-inference/src/main.py`

### Sub-2g: PHI scrubber

- [X] T069 Create `packages/ml-inference/src/observability/phi_scrubber.py` — rules-based scrubber (DICOM UID regex, MRN patterns per tenant, German + Georgian name lists via Aho-Corasick, email, allow-list for safe fields) with fail-closed on ambiguity + `phi_scrubber_failed_total` Prometheus counter per NFR-007
- [X] T070 [P] Create `packages/app/src/emr/services/observability/phiScrubber.ts` — TS mirror of T069 rules for Sentry/PostHog `before_send` hooks
- [X] T071 Create `packages/ml-inference/tests/observability/test_phi_scrubber.py` — 100+ fixtures (real anonymized DICOM headers, German + Georgian names, PACS AE titles) asserting zero leakage + fail-closed on scrubber-crash

### Sub-2h: OpenAPI codegen + API client

- [X] T072 Add Turbo task `generate:openapi-client` invoking `openapi-typescript contracts/api-openapi.yaml -o packages/app/src/emr/services/api-schema.gen.ts`
- [X] T073 Run `npm run generate:openapi-client` + commit generated file
- [X] T074 Create `packages/app/src/emr/services/api-client.ts` — `openapi-fetch` typed client wrapper injecting `Authorization: Bearer {cognito_access_token}` + `X-LiverRa-Tenant: {tenant_id}` headers + TanStack Query adapter per plan §Contract-first codegen
- [X] T075 Create pre-commit hook in `.pre-commit-config.yaml` rejecting hand edits to `*.gen.ts` files (detects `contracts/api-openapi.yaml` diff without `.gen.ts` diff)

### Sub-2i: Translation system + Georgian font

- [X] T076 Port `packages/app/src/emr/contexts/TranslationContext.tsx` from MediMind — **re-wire** to replace `{ka, en, ru}` locale set with `{en, de, ka}`; lazy-load domain bundles; fallback chain `de→en`, `ka→en`
- [X] T077 Port `packages/app/src/emr/services/localeService.ts` — replace ka/en/ru with en/de/ka; add OS-preference detection via `matchMedia`
- [X] T078 Create locale directory scaffold `packages/app/src/emr/translations/{en,de,ka}/{common,auth,nav,upload,analysis,lesions,refine,report,admin,onboarding,compliance,ops,erasure,help,glossary,errors,ruo}.json` with empty `{}` files (17 namespaces × 3 locales = 51 files; batch in 3 tasks of ~17 files each is OK since empty files don't risk regex corruption)
- [X] T079 [W] Wire `TranslationContext` into `packages/app/src/main.tsx` — wrap `<App />` in `<TranslationProvider>` + preload Noto Sans + Noto Sans Georgian via `<link rel="preload" as="font">` in `packages/app/index.html`

### Sub-2j: Theme + EMR common library port (frontend-designer)

> All tasks in Sub-2j and Sub-2k are `[frontend-designer]` — delegate UI work to the frontend-designer agent per CLAUDE.md.

- [X] T080 [frontend-designer] Port `packages/app/src/emr/styles/theme.css` from MediMind — preserve `--emr-font-*` + `--emr-spacing-*` + `--emr-bg-*` tokens; rebrand `--emr-primary-*` ramp to placeholder neutral warm-gray pending brand decision (§Brand Rebrand)
- [X] T081 [frontend-designer] Add 16 overlay tokens to `theme.css`: `--liverra-seg-couinaud-{I..VIII}`, `--liverra-lesion-marker`, `--liverra-plane-handle`, `--liverra-overlay-text`, `--liverra-vessel-portal`, `--liverra-vessel-hepatic` (+ `-dark` variants each)
- [X] T082 [P] [frontend-designer] Port EMR common batch 1: `packages/app/src/emr/components/common/{EMRModal,EMRButton,EMRCard}.tsx` + matching `.module.css` + `.test.tsx` from MediMind (drop-in + rebrand color refs)
- [X] T083 [P] [frontend-designer] Port EMR common batch 2: `{EMRConfirmationModal,EMRPageHeader,EMRErrorBoundary}.tsx`
- [X] T084 [P] [frontend-designer] Port EMR common batch 3: `{EMREmptyState,EMRSkeleton,EMRAlert}.tsx` + illustration asset directory `packages/app/src/emr/assets/empty-states/`
- [X] T085 [P] [frontend-designer] Port EMR common batch 4: `{EMRTableSkeleton,EMRTableEmptyState,EMRToast}.tsx`
- [X] T086 [P] [frontend-designer] Port EMR common batch 5: `{EMRProgressStepper,EMRWizardStepper,EMRDropzone}.tsx`
- [X] T087 [P] [frontend-designer] Port EMR common batch 6: `{EMRBreadcrumbs,EMRFAB,EMRNotificationCenter}.tsx`
- [X] T088 [P] [frontend-designer] Port EMR common batch 7: `{SessionTimeoutModal,FailClosedErrorStates,FormLoadingSkeleton}.tsx`
- [X] T089 [P] [frontend-designer] Port EMR common batch 8: `{FormErrorBoundary,EMRBottomSheet,MobileFormWrapper}.tsx`
- [X] T090 [frontend-designer] Create `packages/app/src/emr/components/common/index.ts` barrel exporting all 24 ported components

### Sub-2k: EMR form fields port (frontend-designer)

- [X] T091 [P] [frontend-designer] Port form fields batch 1: `packages/app/src/emr/components/shared/EMRFormFields/{EMRTextInput,EMRSelect,EMRDatePicker}.tsx`
- [X] T092 [P] [frontend-designer] Port form fields batch 2: `{EMRCheckbox,EMRNumberInput,EMRTextarea}.tsx`
- [X] T093 [P] [frontend-designer] Port form fields batch 3: `{EMRSwitch,EMRMultiSelect,EMRRadioGroup}.tsx`
- [X] T094 [P] [frontend-designer] Port form fields batch 4: `{EMRAutocomplete,EMRColorInput,EMRDateTimePicker}.tsx`
- [X] T095 [P] [frontend-designer] Port form fields batch 5: `{EMRTimeInput,EMRVirtualSelect,EMRFormRow}.tsx`
- [X] T096 [P] [frontend-designer] Port form fields batch 6: `{EMRFormSection,EMRFormActions,EMRFieldWrapper}.tsx` + `EMRFieldTypes.ts`
- [X] T097 [frontend-designer] Create `packages/app/src/emr/components/shared/EMRFormFields/index.ts` barrel exporting all 18 fields

### Sub-2l: Access-control port

- [X] T098 [P] [frontend-designer] Port `packages/app/src/emr/components/access-control/{RequirePermission,PermissionButton,PermissionGate}.tsx` from MediMind — re-wire to read from `PermissionContext` (defined in T099)
- [X] T099 Port `packages/app/src/emr/contexts/PermissionContext.tsx` + `useHasPermission` hook — reads permissions from `AuthContext`, exposes typed `useHasPermission(perm: LiverraPermission)` using `permissions.gen.ts`
- [X] T100 [P] [frontend-designer] Port `packages/app/src/emr/components/access-control/{SensitiveDataGate,RecordLockBanner}.tsx`
- [X] T101 [frontend-designer] Port `packages/app/src/emr/components/access-control/EmergencyAccessModal.tsx` → rename to `StepUpAuthModal.tsx`; re-wire to Cognito `prompt=login max_age=0` flow per plan §Frontend RBAC
- [X] T102 Port `packages/app/src/emr/components/ProtectedRoute/ProtectedRoute.tsx` — re-wire to `<ProtectedRoute requires={['perm.key']}>` that redirects to 404 (not 403) per FR-032a
- [X] T103 [W] Wire `PermissionContext` into app root — wrap `<App />` inside `<TranslationProvider>` + `<AuthProvider>` + `<PermissionProvider>` in `packages/app/src/main.tsx`

### Sub-2m: Routes + navigation port (frontend-designer)

- [X] T104 Create `packages/app/src/emr/constants/routes.ts` with typed `LIVERRA_ROUTES` constant covering all 25 routes from plan §Route registration table
- [X] T105 Create `packages/app/src/AppRoutes.tsx` using React Router v7 `createBrowserRouter` + `lazy()` per plan §Route-level lazy-loading policy (every admin/compliance/ops/erasure route lazy; auth + cases list eager)
- [X] T106 Create `packages/app/src/emr/constants/nav-registry.ts` — per-role nav items (HPB surgeon / radiologist / fellow / admin / ops / compliance / dpo) per plan §Navigation port
- [X] T107 [P] [frontend-designer] Port `packages/app/src/emr/components/nav/EMRMainMenu.tsx` from MediMind — re-wire to `nav-registry.ts` + `useHasPermission`
- [X] T108 [P] [frontend-designer] Port `packages/app/src/emr/components/nav/HorizontalSubMenu.tsx` from MediMind
- [X] T109 [frontend-designer] Create `packages/app/src/emr/components/nav/Breadcrumbs.tsx` — derives from React Router `useMatches()` + each route's `handle.breadcrumb` function
- [X] T110 [frontend-designer] Create `packages/app/src/emr/components/nav/SessionRecoveryBanner.tsx` — reads pending drafts from IndexedDB + `SurgeonReview.seat_held_until` (stub until US4 impl)
- [X] T111 [W] Wire `AppRoutes` into app entry — replace stub content in `packages/app/src/main.tsx` with `<RouterProvider router={appRouter} />`
- [X] T112 [W] Wire `EMRMainMenu` + `Breadcrumbs` + `SessionRecoveryBanner` into app shell — add to `packages/app/src/emr/EMRPage.tsx` (port layout shell pattern from MediMind)

### Sub-2n: Core contexts

- [X] T113 [P] [frontend-designer] Create `packages/app/src/emr/contexts/ThemeContext.tsx` — reads `User.theme_preference` + OS fallback via `matchMedia('(prefers-color-scheme: dark)')` + toggles `<html data-mantine-color-scheme={mode}>`
- [X] T114 [P] Create `packages/app/src/emr/contexts/MobileContext.tsx` — exposes `breakpoint: 'xs'|'sm'|'md'|'lg'|'xl'` + `isTouch: boolean`
- [X] T115 [P] [frontend-designer] Create `packages/app/src/emr/contexts/AccessibilityContext.tsx` — exposes `prefersReducedMotion` + `announceToSR(text)` live-region router
- [X] T116 [P] Create `packages/app/src/emr/contexts/AuthContext.tsx` — fetches `/auth/me` on session start; exposes `{user, tenant, permissions, signIn, signOut}`
- [X] T117 [W] Wire `ThemeContext`, `MobileContext`, `AccessibilityContext`, `AuthContext` into app root — add providers to `packages/app/src/main.tsx` in correct nesting order (Auth → Permission → Theme → Mobile → A11y → Router)

### Sub-2o: Cornerstone3D initialization

- [X] T118 Port `packages/app/src/emr/services/pacs/cornerstoneInit.ts` from MediMind — re-wire tools; add touch gesture bindings (PinchGesture, TwoFingerRotateGesture, DragGesture, TapGesture) per plan §Mobile & touch strategy
- [X] T119 [P] Port `packages/app/src/emr/services/pacs/dicomwebClient.ts` from MediMind — swap auth from Medplum JWT to Cognito JWT; target `/dicom-web/` on clean-side Orthanc
- [X] T120 [P] Port `packages/app/src/emr/services/pacs/dicomParserService.ts` from MediMind (drop-in)
- [X] T121 [P] Port `packages/app/src/emr/services/pacs/progressiveLoader.ts` from MediMind (drop-in)

### Sub-2p: ESLint guardrail rules

- [X] T122 Implement `packages/core/eslint-plugin-liverra/rules/no-hardcoded-fhir-url.ts` + `no-forbidden-hex.ts` + `no-russian-locale.ts`
- [X] T123 Implement `packages/core/eslint-plugin-liverra/rules/{no-hardcoded-color,no-hardcoded-font-size,require-emr-button,no-raw-mantine-inputs}.ts`
- [X] T124 Implement `packages/core/eslint-plugin-liverra/rules/{no-any-without-justification,mantine-button-padding-check,require-state-triplet}.ts`
- [X] T125 [W] Wire `eslint-plugin-liverra` into root `.eslintrc.cjs` — add plugin + enable all 11 rules + per-rule configuration

### Sub-2q: Observability SDK init + Grafana scaffold

- [X] T126 [P] Create `packages/ml-inference/src/observability/sentry_init.py` — EU region, `before_send` wrapping `phi_scrubber.py`, `phi_scrubber_failed_total` counter
- [X] T127 [P] Create `packages/app/src/emr/services/observability/sentryInit.ts` — EU region, `beforeSend` wrapping `phiScrubber.ts`
- [X] T128 [P] Create `packages/app/src/emr/services/telemetry/events.ts` — string-literal union type for all PostHog event names per plan §Telemetry event catalog
- [X] T129 [P] Create `packages/app/src/emr/services/telemetry/postHogClient.ts` — EU host, anonymous events, PHI-scrubber-wrapped
- [X] T130 [P] Create `packages/ml-inference/src/observability/otel_init.py` — OTel SDK with OTLP exporter targeting in-VPC collector
- [X] T131 Create `deploy/grafana/dashboards/` with 8 JSON files: `liverra-queue.json`, `liverra-latency.json`, `liverra-gpu.json`, `liverra-errors.json`, `liverra-users.json`, `liverra-audit-chain.json`, `liverra-cost.json`, `liverra-health.json`

### Sub-2r: FastAPI app factory + health endpoint

- [X] T132 Create `packages/ml-inference/src/main.py` — FastAPI app with middleware stack (CORS, AuthMiddleware, RLS session, Sentry, OTel)
- [X] T133 Create `packages/ml-inference/src/api/system.py` — `/api/v1/system/health` aggregator (postgres + redis + triton + medplum + orthanc + per-tenant PACS C-ECHO) + `/api/v1/system/version` (app_version, pipeline_version, mbom_hash, commit_sha, built_at) per plan §Health aggregator
- [X] T134 [W] Wire `system.py` router into app — include router in `main.py`

### Sub-2s: Model Bill of Materials + license-drift check

- [X] T135 Implement `scripts/model-bom.sh` — reads `packages/ml-inference/triton-models/*/model.info` + `requirements.txt` → generates `MBoM.json` at repo root with `{build_sha, model_name, model_family, source_url, pinned_commit_sha, license_text_hash, license_name, integration_date, approver}` per FR-038
- [X] T136 Implement `scripts/license-check.sh` — fetches each model's upstream LICENSE, computes SHA-256, compares against `MBoM.json.license_text_hash`; exits non-zero on drift
- [X] T137 [W] Wire `license-check` into `.github/workflows/ci.yml` as blocking job `ci-license-check`

### Sub-2t: Quickstart bootstrap

- [X] T138 Create `npm run bootstrap:dev` script in root `package.json` — runs `alembic upgrade head` + `bootstrap-medplum-project.py` + `seed-demo-case.sh` + creates dev user with pre-enrolled MFA token per quickstart §4
- [X] T139 Create `packages/app/src/main.tsx` final version — wires all providers (Translation, Auth, Permission, Theme, Mobile, A11y, Router) in correct nesting order

### Sub-2u: Error handling + security middleware (merged via /upgradeTasks)

- [X] T405 [P] Create `packages/ml-inference/src/services/errors/catalog.py` — enum of 17 canonical RFC 7807 slugs (`not-found`, `forbidden`, `validation`, `step-up-required`, `seat-taken`, `analysis-expired`, `analysis-failed`, `analysis-timeout`, `analysis-implausible-output`, `pacs-unreachable`, `pacs-rejected`, `ruo-acceptance-required`, `license-hash-drift`, `audit-write-failed`, `scrubber-failed`, `erasure-in-progress`, `erasure-mfa-stale`) + `problem_detail(slug, status, detail, instance, tenant_id, claim_key=None)` helper emitting `application/problem+json`; register as FastAPI exception handler in `src/main.py` per plan §Error Handling §Server-side
- [X] T406 Create `packages/app/src/emr/services/errorClient.ts` — axios/openapi-fetch response interceptor mapping HTTP→UX: 401→`StepUpAuthModal` replay, 403→"request access from admin", 404→"Not found" (never hints cross-tenant per FR-032a), 409→`ConflictResolutionModal`/takeover, 410→"case erased", 422→inline `detail.errors[]`, 429→jittered backoff toast, 5xx→retry banner + incident reference; parses `application/problem+json` + feeds Sentry with `instance` UUID; wire into T074 `api-client.ts` per plan §Error Handling §Frontend error hierarchy
- [X] T407 [P] Create `packages/app/src/emr/hooks/useIdleTimeout.ts` — listens to mouse/keyboard/touch/focus; 15-min inactivity triggers `SessionTimeoutModal` (T088) + revokes in-memory tokens + redirects to sign-in preserving `returnTo`; exposes `resetIdle()`; cross-tab sync via `BroadcastChannel`; mount once in `EMRPage.tsx` per NFR-006
- [X] T408 Create `packages/ml-inference/src/middleware/rate_limit.py` — `slowapi`-based per-`(tenant_id, user_id, endpoint)` limits: finalize 10/min, PACS-push 20/min, PACS-retry 6/min, erasure 5/min, demo-seed 2/min, auth-step-up 10/5min, upload 60/min; emits 429 via error-catalog `rate-limit-exceeded` slug with `Retry-After` header; wire into protected routers
- [X] T409 Create `packages/ml-inference/src/middleware/security_headers.py` + `deploy/nginx/security.conf` — global CSP with `frame-ancestors 'none'`, `default-src 'self'`, `script-src 'self'`, `connect-src 'self' {medplum_url} {sentry_url}`, `img-src 'self' data: blob:`, `worker-src 'self' blob:` (Cornerstone WASM); plus `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` per FR-028a globally (not just T269 PDFPreview)
- [X] T410 [frontend-designer] Create 8 SVG illustrations in `packages/app/src/emr/assets/empty-states/`: `no-cases.svg`, `no-lesions.svg`, `no-audit-events.svg`, `no-stuck-cases.svg`, `no-users.svg`, `no-mbom.svg`, `no-artifacts.svg`, `erased-case.svg` — each uses only `currentColor` + overlay tokens (no hardcoded hex) for light/dark auto-theme per plan §View state matrix
- [X] T411 [frontend-designer] Create `packages/app/scripts/palette-cvd-check.ts` — reads `theme.css`, extracts `--liverra-seg-couinaud-{I..VIII}` (+ `-dark` variants), runs `chroma-js` deuteranopia/protanopia/tritanopia simulation, asserts pairwise ΔE2000 ≥ 12 across all simulations; exits non-zero on failure (Turbo task `palette-cvd-check` slot from T005)

**Checkpoint 2**: Foundational done. All user stories (US1-US10) can now proceed in parallel. **No business logic yet — only infrastructure, ports, and gates.**

---

## Phase 3: User Story 1 — Upload → FLR (Priority: P1) 🎯 MVP

**Goal**: HPB surgeon uploads 4-phase contrast liver CT, receives 3D parenchyma + interactive resection plane + live FLR readout within 5 minutes. This is the MVP slice — demoable alone.

**Independent Test**: Surgeon uploads valid CT, drags resection plane, reads FLR% — must complete ≤5 min on warm infra (SC-002), FLR within ±5% expert volumetry on 20-scan set (SC-003), RUO disclaimer visible at all times (SC-009).

**Spec refs**: US1, FR-001..FR-014b (core pipeline), FR-022/028/028a (viewer + RUO), FR-032/032a (tenant isolation), NFR-001 (perf), NFR-007 (observability).

### Ingestion + anonymization

- [X] T140 [US1] Create `pacs/orthanc/orthanc.json` edge-appliance config per research §B.3 (DIMSE :4242, DICOMweb `/dicom-web/`, Postgres backend, DICOM-TLS enabled)
- [X] T141 [US1] Create `pacs/orthanc/liverra-hooks.lua` Lua `ReceivedInstanceFilter` hook that POSTs new instances to anonymization sidecar webhook at `http://localhost:7070/orthanc-webhook`
- [X] T142 [US1] Create `pacs/ctp/pipeline.xml` — RSNA CTP DICOM anonymization profile per PS3.15; **disable** CTP's default "sanitize to ASCII" filter per research §B.8 UTF-8
- [X] T143 [US1] Create `pacs/anon-sidecar/main.py` FastAPI sidecar — implements 3-gate pipeline: UTF-8 NFC normalize + CTP call + Presidio burned-in pixel PHI scan (corners + bottom strip on triage-positive slices) per research §B.1/§B.2
- [X] T144 [US1] Create `pacs/anon-sidecar/presidio_recognizers.py` — per-image custom recognizers built from DICOM metadata (PatientName, PatientID, PatientBirthDate, InstitutionName, ReferringPhysicianName) per research §B.2
- [X] T145 [P] [US1] Create `packages/ml-inference/src/services/anon/triage.py` — SOPClass-based triage filter (Secondary Capture / US / CR / DX → full-image scan; primary CT liver → corner-strip scan)
- [X] T146 [US1] Create `packages/ml-inference/src/services/erasure/crypto_shred.py` — per-case KMS envelope key create at ingest, `kms:ScheduleKeyDeletion` synchronous with p99 <60 s alarm per research §X.1 + FR-002a
- [X] T147 [W] [US1] Wire `crypto_shred` into ingest flow — call `create_case_key(study_id, tenant_id)` in `pacs/anon-sidecar/main.py` before writing to S3

### Ingest API + study validation

- [X] T148 [US1] Create `packages/ml-inference/src/api/ingest.py` — `POST /api/v1/ingest/uploads` (tus-style resumable upload init), `GET /api/v1/ingest/studies` (list), `GET /api/v1/ingest/studies/{id}` per contracts/api-openapi.yaml
- [X] T149 [US1] Create `packages/ml-inference/src/services/ingest/phase_detection.py` — per-series heuristic (contrast-uptake timing windows) returning phase_coverage map; rejects if portal-venous missing per FR-003
- [X] T150 [US1] Create `packages/ml-inference/src/services/ingest/uid_consistency.py` — validates Patient ID + Study Instance UID + acquisition-date window (all phases within 24 h) per FR-003a
- [X] T151 [US1] Create `packages/ml-inference/src/services/ingest/coverage_check.py` — liver superior-inferior extent check per FR-006/006a (with admin override path)
- [X] T152 [US1] Create `packages/ml-inference/src/services/ingest/zip_safety.py` — reject malformed/encrypted archives; sanitize DICOM tag values per FR-001a/001c
- [X] T153 [W] [US1] Wire `AuditChainWriter` into `ingest.py` — emit `study_upload` + `anonymization_passed/failed` AuditEvents at each ingestion state transition
- [X] T154 [W] [US1] Wire `require_permission` decorator into all ingest routes — `study.upload` on POST, `study.upload` on GETs

### Stage-1 STU-Net parenchyma + pipeline orchestration

- [X] T155 [US1] Create `packages/ml-inference/triton-models/stunet-parenchyma/config.pbtxt` — Triton model config per contracts/triton-stages.md §Stage 1 (fp16, GPU instance count 1, explicit load mode)
- [X] T156 [US1] Create `packages/ml-inference/triton-models/stunet-parenchyma/1/model.pt` — TorchScript export of STU-Net-Huge parenchyma checkpoint (downloaded from upstream; Apache 2.0)
- [X] T157 [US1] Create `packages/ml-inference/src/services/triton/client.py` — tritonclient gRPC wrapper with per-stage inference wrappers + load/unload control (explicit mode) + Tier-A/B policy per research §C.1
- [X] T158 [US1] Create `packages/ml-inference/src/orchestrator/cascade.py` — Celery task graph: `anonymization → parenchyma → vessels → couinaud → lesion_detection → classification → flr_init`; per-stage timeout budgets summing ≤120s; partial-result preservation per FR-014a/b + research §C.2
- [X] T159 [US1] Create `packages/ml-inference/src/orchestrator/sanity.py` — Pydantic + numeric bounds per FR-007a (total 300–3500 mL, non-zero segments, FLR ≥0 etc.); on failure sets `implausible_output_reason`
- [X] T160 [US1] Create `packages/ml-inference/src/orchestrator/checkpoint.py` — writes `pipeline_checkpoint` row after each stage in same txn as GPU-release per research §X.2 + NFR-009
- [X] T161 [P] [US1] Create `packages/ml-inference/src/tasks/anonymization.py` Celery task wrapping the anon-sidecar webhook flow
- [X] T162 [P] [US1] Create `packages/ml-inference/src/tasks/parenchyma.py` Celery task calling Triton `liverra-stunet-parenchyma`
- [X] T163 [P] [US1] Create `packages/ml-inference/src/tasks/flr_default.py` Celery task computing default resection plane (axial mid-hepatic-vein heuristic) + initial FLR
- [X] T164 [US1] Create `packages/ml-inference/src/workers/app.py` Celery app config with Redis broker + Postgres result backend + retry policy per NFR-009
- [X] T165 [W] [US1] Wire `checkpoint.write` into every cascade task — at end of each Celery task, call `checkpoint.write(analysis_id, stage_no, output_uri)` before returning
- [X] T166 [W] [US1] Wire `sanity.check` + `AuditChainWriter` into `cascade.py` — sanity at stage boundary, audit event on every start/end/fail

### Analysis API + SSE streaming

- [X] T167 [US1] Create `packages/ml-inference/src/api/analysis.py` — `POST /api/v1/analyses`, `GET /api/v1/analyses/{id}`, `GET /api/v1/analyses/{id}/results`, `POST /api/v1/analyses/{id}/cancel`, `POST /api/v1/analyses/{id}/retry` per contracts/api-openapi.yaml §analysis
- [X] T168 [US1] Create `packages/ml-inference/src/api/analysis_stream.py` — `GET /api/v1/analyses/{id}/stream` Server-Sent Events endpoint yielding stage-complete events from `pipeline_checkpoint` writes per plan §Data Fetching Strategy
- [X] T169 [W] [US1] Wire `@require_permission('study.upload')` onto all analysis routes
- [X] T170 [W] [US1] Wire `AuditChainWriter` into cancel/retry endpoints — emit `analysis_cancel`/`analysis_retry` AuditEvents

### Frontend: upload + cases list + viewer shell (frontend-designer)

- [X] T171 [US1] [frontend-designer] Create `packages/app/src/emr/components/upload/DicomDropzone.tsx` — drag-drop zone, file-type validation, tus-style chunked upload to `/api/v1/ingest/uploads`, progress bar, PHI-detect warning surface per FR-001/005
- [X] T172 [US1] [frontend-designer] Create `packages/app/src/emr/components/upload/UploadProgress.tsx` — multi-stage indicator (uploading → anonymizing → queued → running) driven by SSE stream
- [X] T173 [US1] [frontend-designer] Create `packages/app/src/emr/views/cases/CasesListView.tsx` — `EMRTable`-based list of the tenant's analyses with status, timestamps, thumbnails; empty state `no-cases.svg` illustration; skeleton loading
- [X] T174 [US1] [frontend-designer] Create `packages/app/src/emr/views/cases/AnalysisDetailView.tsx` — **mirror MediMind `ImagingTabView.tsx` pattern** per plan §Reference Architecture: lazy-load `LiverViewer3D`, Suspense + `PACSErrorBoundary` port (→ `LiverErrorBoundary`), resizable drawer pattern
- [X] T175 [US1] [frontend-designer] Create `packages/app/src/emr/components/liver/LiverViewer3D.tsx` — Cornerstone3D shell with parenchyma layer only (segments/vessels/lesions added in later stories), toggle layers, ARIA role=application per NFR-002
- [X] T176 [US1] [frontend-designer] Create `packages/app/src/emr/components/liver/ResectionPlaneTool.tsx` — WebGPU voxel-counting implementation; sub-20 ms update per FR-013; ARIA slider with value/min/max/orientation per NFR-002 per research §C.5
- [X] T177 [US1] [frontend-designer] Create `packages/app/src/emr/components/liver/FLRPanel.tsx` — live FLR mL + % readout, updates during plane drag via `useRUOClaim()` hook (disclaimer variant) + `aria-live=polite` per NFR-002
- [X] T178 [US1] [frontend-designer] Create `packages/app/src/emr/components/ruo/RUODisclaimer.tsx` — persistent, un-dismissable overlay + 5-layer pixel-burn canvas util per FR-028/028a + research §B.7
- [X] T179 [US1] Create `packages/imaging/src/watermark.ts` — shared canvas `burnWatermark(canvas, opts)` util used by viewer + PDF export per plan §UI Conventions
- [X] T180 [US1] Create `packages/app/src/emr/contexts/AnalysisContext.tsx` — selected analysis + partial-results SSE stream handle per plan §Contexts graph
- [X] T181 [US1] Create `packages/app/src/emr/contexts/ViewerStateContext.tsx` — camera, layers, plane pose, tool mode
- [X] T182 [P] [US1] Create `packages/app/src/emr/hooks/useAnalysis.ts` — TanStack Query hook keyed `['analysis', analysisId]` with SSE-driven invalidation per plan §Data Fetching Strategy
- [X] T183 [P] [US1] Create `packages/app/src/emr/hooks/useCasesList.ts` — TanStack Query keyed `['tenant', tenantId, 'analyses', filters]`
- [X] T184 [P] [US1] Create `packages/app/src/emr/hooks/useRUOClaim.ts` — reads `RegulatoryClaimRegistry` via `/api/v1/compliance/claim-registry`, returns `{status, disclaimerVariant, watermark, uiGate}` per plan §Claim Registry as feature-flag source
- [X] T185 [US1] Create `packages/app/src/emr/contexts/RUOClaimRegistryContext.tsx` — provider for `useRUOClaim`
- [X] T186 [W] [US1] Wire `AnalysisContext` + `ViewerStateContext` + `RUOClaimRegistryContext` into `AnalysisDetailView` — add providers scoped to the route + consume in child panels
- [X] T187 [W] [US1] Wire `DicomDropzone` → `useAnalysis` → `AnalysisDetailView` — on upload-complete navigate to `/cases/:id`; `useAnalysis` auto-subscribes to SSE stream
- [X] T188 [W] [US1] Wire `RUODisclaimer` into app shell — add to `EMRPage.tsx` so it renders on every authenticated view + `burnWatermark` applied in `LiverViewer3D` + `FLRPanel` frame renders
- [X] T189 [W] [US1] Wire `api-client` typed endpoints into `useAnalysis`, `useCasesList` — import from `api-client.ts` and use `client.GET('/api/v1/analyses/{id}')`

### Tests for US1

- [X] T190 [P] [US1] Create `packages/ml-inference/tests/integration/test_ingest_flow.py` — happy path: valid 4-phase CT → phases detected → UID-consistent → accepted → Analysis row created; failure: missing portal-venous → rejected with correct `ingestion_rejection_reason`; PHI-contamination race → FR-002a 60-s crypto-shred path
- [X] T191 [P] [US1] Create `packages/ml-inference/tests/regression/test_parenchyma_dice.py` — golden `ct-001..005` fixtures; asserts Dice ≥0.92 per SC-003 threshold
- [X] T192 [P] [US1] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us1-upload-flr.ts` — 3 Playwright scenarios (happy upload-to-FLR ≤5 min, failure on missing phase, edge cold-start indicator distinct from error)
- [X] T193 [P] [US1] Create `packages/imaging/src/__tests__/watermark.test.ts` — canvas burn-in test via headless Chromium screenshot diff asserting RUO text pixels present at zoom 50%/100%/300%
- [X] T194 [P] [US1] Create `packages/ml-inference/tests/security/test_step_up_on_finalize.py` — placeholder for Phase 7 finalize (asserts middleware scaffold exists)

### US1 wiring + cold-start UX (merged via /upgradeTasks)

- [X] T412 [W] [US1] Wire ingestion gate services into `packages/ml-inference/src/api/ingest.py` — after chunk-merge in `POST /api/v1/ingest/uploads` completion, call `zip_safety.scan()` → `phase_detection.detect()` → `uid_consistency.validate()` → `coverage_check.verify()` in sequence; on any failure set `study.ingestion_rejection_reason` and return 422 via error catalog (T405); on success transition `study.ingestion_outcome='accepted'` and enqueue cascade per FR-001a/003/003a/006
- [X] T413 [W] [US1] Wire `triage.classify(sop_class)` + `presidio_recognizers.build_from_dicom(ds)` into `pacs/anon-sidecar/main.py` `/orthanc-webhook` handler — triage result selects corner-strip vs full-image scan; recognizers feed Presidio `AnalyzerEngine` before pixel scan per research §B.1/§B.2 (fail-closed on any error)
- [X] T414 [W] [US1] Wire `mbom_reader.get(model_name)` into `packages/ml-inference/src/orchestrator/checkpoint.py` — every `checkpoint.write()` MUST stamp `model_version` + `model_license_hash` from MBoM; also wire into `services/seg_sr/seg_builder.py` to populate `AlgorithmIdentificationSequence.Name` with `liverra-` prefix + `Version` from MBoM per FR-038 + X.4
- [X] T415 [W] [US1] Wire `useRUOClaim()` into `FLRPanel.tsx`, `LesionBadge.tsx` (T218), `LesionDetailPanel.tsx` (T219), `PDFPreview.tsx` (T269), `SampleDataBadge.tsx` (T310) — each consumer reads `{status, disclaimerVariant, watermark, uiGate}` and renders the per-claim disclaimer text; FR-028b scope-narrowing flows through every surface (T352 alone covers only RUODisclaimer + burnWatermark)
- [X] T416 [frontend-designer] [US1] Create `packages/app/src/emr/components/liver/ColdStartIndicator.tsx` — reads `/api/v1/system/health` payload `gpu.predicted_warm_s` (T133) + analysis queue state; renders a distinct "Warming models (~Xs)" info-variant banner (NOT error-variant); polls every 3 s during queued-state when `predicted_warm_s > 0`; wire into `AnalysisDetailView` (T174) above viewer; i18n keys in `translations/{en,de,ka}/analysis.json` per FR-034 (T192 asserts existence)

**Checkpoint 3**: User Story 1 fully functional. **MVP demoable**: surgeon uploads a CT, sees 3D liver, drags resection plane, reads FLR%. Deploy / screen-record demo video per SC-013.

---

## Phase 4: User Story 2 — Couinaud segments & vessels (Priority: P2)

**Goal**: Surgeon sees 8 Couinaud segments + portal/hepatic vein trunks overlaid on parenchyma; click per-segment volume; synchronized 3D + axial/coronal/sagittal views.

**Independent Test**: HPB surgeon reviewers rate segmentation "surgically usable without re-segmentation" on ≥80% of 20-scan set (SC-004).

**Spec refs**: US2, FR-008, FR-009, FR-019, FR-020.

- [X] T195 [US2] Create `packages/ml-inference/triton-models/couinaud-segments/config.pbtxt` per contracts/triton-stages.md §Stage 3
- [X] T196 [US2] Create `packages/ml-inference/triton-models/couinaud-segments/1/model.pt` (Pictorial Couinaud upstream Apache 2.0 export)
- [X] T197 [US2] Create `packages/ml-inference/src/tasks/couinaud.py` Celery task — calls Triton `liverra-couinaud-segments` with parenchyma mask from Stage 1
- [X] T198 [US2] Create `packages/ml-inference/src/tasks/vessels.py` Celery task — vessel-trunk segmentation (portal + hepatic) as part of Couinaud model output
- [X] T199 [US2] Extend `cascade.py` graph — add `couinaud` + `vessels` after `parenchyma`; sanity: sum of 8 segments ≈ parenchyma ±2%; vessels ≥90% contained in parenchyma
- [X] T200 [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/SegmentsLayer.tsx` — 8 Couinaud color-coded overlays using `--liverra-seg-couinaud-{I..VIII}` tokens; CVD-safe palette verified
- [X] T201 [P] [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/VesselsLayer.tsx` — portal + hepatic vein trunk overlays using `--liverra-vessel-portal` / `-hepatic` tokens
- [X] T202 [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/LayerToggle.tsx` — toggle parenchyma/segments/vessels/lesions layers with keyboard shortcut `L`
- [X] T203 [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/CouinaudLegend.tsx` — 8 swatches with `aria-label` per NFR-002, hover tooltip with segment name per FR-045
- [X] T204 [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/MultiPlanarViews.tsx` — axial/coronal/sagittal slice views with synchronized click-to-recenter per FR-020
- [X] T205 [US2] [frontend-designer] Create `packages/app/src/emr/components/liver/SegmentVolumeCard.tsx` — clicked-segment detail panel (volume mL, % of total)
- [X] T206 [US2] Add translation keys for 8 Couinaud names + vessel labels to `translations/{en,de,ka}/glossary.json` (medical-terminology-lock-gated per plan §i18n wiring)
- [X] T207 [W] [US2] Wire `SegmentsLayer` + `VesselsLayer` + `MultiPlanarViews` into `LiverViewer3D` — add as children conditionally rendered via `ViewerStateContext.activeLayers`
- [X] T208 [W] [US2] Wire `useAnalysis` SSE → Couinaud result — consume stage-complete event with `stage: 'couinaud'`, populate segments into viewer
- [X] T209 [P] [US2] Create `packages/ml-inference/tests/regression/test_couinaud_iou.py` — asserts mean IoU ≥0.70 per SC-004 threshold
- [X] T210 [P] [US2] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us2-couinaud.ts` — 3 scenarios (happy 8-segment display + toggle, failure cirrhotic degraded flag, edge view-sync across 3D/axial/coronal/sagittal)

**Checkpoint 4**: US2 done. Surgeon can see segments + vessels + per-segment volumes.

---

## Phase 5: User Story 3 — Lesion detection & classification (Priority: P3)

**Goal**: Lesion list with Couinaud location, diameter, AI-suggested class (HCC/ICC/MET/FNH/HEM/CYST), confidence, abstention when uncertain.

**Independent Test**: Lesion detection ≥78% sensitivity @ ≥10 mm on 20-scan set (SC-005); abstention fires on low-confidence cases.

**Spec refs**: US3, FR-010, FR-011.

- [X] T211 [US3] Create `packages/ml-inference/triton-models/stunet-lesions/{config.pbtxt,1/model.pt}` per contracts/triton-stages.md §Stage 2 (fp16, Apache 2.0)
- [X] T212 [US3] Create `packages/ml-inference/triton-models/lilnet-classify/{config.pbtxt,1/model.pt}` per contracts/triton-stages.md §Stage 4 (Tier-B lazy-load)
- [X] T213 [US3] Create `packages/ml-inference/src/tasks/lesion_detection.py` Celery task — calls Triton `liverra-stunet-lesions` cropped to parenchyma, emits N bboxes + binary lesion mask per lesion
- [X] T214 [US3] Create `packages/ml-inference/src/tasks/classification.py` Celery task — for each lesion, calls Triton `liverra-lilnet-classify` on 4-phase 96³ crop; applies temperature scaling; fires abstention if `max(probs) < tenant.abstention_threshold` per research §C.7
- [X] T215 [US3] Create `packages/ml-inference/src/services/calibration/temperature_scaling.py` — per-tenant learned temperature calibration param; default T=1.5 until per-tenant fit available
- [X] T216 [US3] Extend `cascade.py` — add `lesion_detection` + `classification` (once per lesion); sanity: lesion masks ≥95% inside parenchyma; classification vector sums 1.0 ±0.01
- [X] T217 [US3] [frontend-designer] Create `packages/app/src/emr/components/liver/LesionList.tsx` — virtualized `EMRTable` with columns thumbnail/Couinaud/diameter/class/confidence; paginate beyond 50 entries per NFR-001; screen-reader `role=grid` with row announcement per NFR-002
- [X] T218 [US3] [frontend-designer] Create `packages/app/src/emr/components/liver/LesionBadge.tsx` — class badge with tenant-color, confidence bar, "Uncertain — radiologist review recommended" state per FR-011
- [X] T219 [US3] [frontend-designer] Create `packages/app/src/emr/components/liver/LesionDetailPanel.tsx` — click-lesion centres 3D + all slice views per FR-010 + FR-020
- [X] T220 [US3] [frontend-designer] Create `packages/app/src/emr/components/liver/LesionLayer.tsx` — lesion mask overlays with class-colored outlines using `--liverra-lesion-marker` token
- [X] T221 [P] [US3] Create `packages/app/src/emr/hooks/useLesions.ts` — TanStack Query keyed `['analysis', analysisId, 'lesions']`
- [X] T222 [US3] Add translation keys for 6 tumor classes + "Uncertain" state + abstention help text to `translations/{en,de,ka}/lesions.json` (medical-term-locked)
- [X] T223 [W] [US3] Wire `LesionLayer` into `LiverViewer3D` — conditionally render via `ViewerStateContext.activeLayers.lesions`
- [X] T224 [W] [US3] Wire `LesionList` + `LesionDetailPanel` into `AnalysisDetailView` drawer — tab in the resizable drawer alongside Segments
- [X] T225 [W] [US3] Wire `useLesions` into `LesionList` + `useAnalysis` SSE → invalidates `['analysis', id, 'lesions']` on `stage: 'classification'` complete
- [X] T226 [P] [US3] Create `packages/ml-inference/tests/regression/test_lesion_sens.py` — asserts sensitivity ≥0.78 on lesions ≥10 mm + Dice ≥0.65 per SC-005
- [X] T227 [P] [US3] Create `packages/ml-inference/tests/regression/test_lilnet_accuracy.py` — asserts Top-1 accuracy ≥0.82 on `ct-lesions-labeled-pack` per plan §ML regression gate
- [X] T228 [P] [US3] Create `packages/ml-inference/tests/unit/test_temperature_scaling.py` — verifies softmax sum invariant + abstention trigger at threshold
- [X] T229 [P] [US3] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us3-lesions.ts` — 3 scenarios (happy list + class + confidence, failure low-confidence abstention, edge reviewer-prompt appends lesion — partially tested here; fully in US4)
- [X] T417 [P] [US3] E2E test for radiologist MedSAM-2 missed-lesion append scenario (spec §US3 Edge) — radiologist drops marker on AI-missed lesion in viewer → MedSAM-2 one-prompt runs → new `Lesion` row appears in list with `discovery_source='reviewer_prompted'` tag + audit event, at `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us3-lesion-append.ts`
- [X] T418 [W] [US3] Wire `TemperatureScaler(tenant_id).apply(logits)` into `packages/ml-inference/src/tasks/classification.py` — load per-tenant T from config (default 1.5), apply pre-softmax, then compute `max(probs) < threshold` abstention; on abstention set `Classification.suggested_class='abstained'` per FR-011 + research §C.7

**Checkpoint 5**: US3 done. Lesion detection + classification + abstention working.

---

## Phase 6: User Story 4 — Interactive refinement (Priority: P4)

**Goal**: VISTA3D click-to-refine any mask; MedSAM-2 one-prompt tumor re-seg; reviewer-seat lock; offline-durable edits with conflict resolution.

**Independent Test**: Median time-to-acceptable-mask reduced ≥50% vs full manual re-seg (SC-006).

**Spec refs**: US4, FR-015, FR-016, FR-017/017a/017b, FR-018/018a/018b/018c.

- [X] T230 [US4] Create `packages/ml-inference/triton-models/vista3d-refine/{config.pbtxt,1/model.pt}` per contracts/triton-stages.md §Stage 5 (Tier-B)
- [X] T231 [US4] Create `packages/ml-inference/triton-models/medsam2-track/{config.pbtxt,1/model.pt}` per contracts/triton-stages.md §Stage 6 (Tier-B)
- [X] T232 [US4] Create `packages/ml-inference/src/api/review.py` — `POST /api/v1/reviews` (seat acquire), `POST /api/v1/reviews/{id}/heartbeat`, `POST /api/v1/reviews/{id}/mask-refine` (VISTA3D call), `POST /api/v1/reviews/{id}/lesion-prompt` (MedSAM-2), `POST /api/v1/reviews/{id}/classification-override`, `POST /api/v1/reviews/{id}/flr` per contracts/api-openapi.yaml §review
- [X] T233 [US4] Create `packages/ml-inference/src/services/review/seat_manager.py` — seat TTL 60s, heartbeat extension, `SurgeonReview` UNIQUE partial idx enforcement, takeover-request flow per FR-017a
- [X] T234 [US4] Create `packages/ml-inference/src/services/review/refinement_local_recompute.py` — composites VISTA3D 128³ crop output back into full-res mask, writes new `Segmentation` row with `generation_source=reviewer_edited` + `parent_segmentation_id`; target ≤30s per FR-015
- [X] T235 [W] [US4] Wire `@require_permission('review.refine_mask')` + `review.reprompt_lesion` + `review.override_classification` onto review routes
- [X] T236 [W] [US4] Wire `AuditChainWriter` into every review endpoint — emit `mask_edit`, `lesion_reprompt`, `classification_override`, `review.seat_taken`, `review.seat_released`
- [X] T237 [US4] [frontend-designer] Create `packages/app/src/emr/components/liver/RefineTools.tsx` — click-tool palette (add/subtract/lesion-prompt), bound to Cornerstone3D tool modes from `cornerstoneInit.ts`
- [X] T238 [US4] [frontend-designer] Create `packages/app/src/emr/components/liver/ClassificationOverride.tsx` — dropdown to override AI class with reason textarea per spec edge case
- [X] T239 [US4] Create `packages/app/src/emr/contexts/ReviewSeatContext.tsx` — encapsulates seat acquire + 20s heartbeat + release on unmount per plan §Review seat concurrency
- [X] T240 [US4] Create `packages/app/src/emr/contexts/RefinementUndoContext.tsx` — per-click undo stack mirrored to IndexedDB `offline_reviewer_edits` per research §C.6
- [X] T241 [P] [US4] Create `packages/app/src/emr/hooks/useReviewSeat.ts` — wraps `ReviewSeatContext` + takeover-request toast flow
- [X] T242 [P] [US4] Create `packages/app/src/emr/services/offline/offlineQueue.ts` — IndexedDB schema `{id ULID, analysis_id, edit_type, payload, created_at, client_version, attempt_count, last_error}` per plan §Offline durability
- [X] T243 [P] [US4] Create `packages/app/src/emr/services/offline/conflictResolver.ts` — server-wins default, opens merge modal on 409 per plan §Offline
- [X] T244 [US4] Create `packages/app/src/emr/services/offline/syncWorker.ts` — plain-JS periodic flush every 15s when online + immediate on `online` event
- [X] T245 [US4] [frontend-designer] Create `packages/app/src/emr/components/offline/ConflictResolutionModal.tsx` — keep-mine / keep-theirs / manual-merge choices (audited)
- [X] T246 [US4] [frontend-designer] Create `packages/app/src/emr/components/nav/SyncIndicator.tsx` — top-bar pill (online/offline/syncing/queue-depth-N) + click opens pending-entries panel
- [X] T247 [US4] Create `packages/app/src/emr/contexts/SyncContext.tsx` — exposes online status + queue depth
- [X] T248 [W] [US4] Wire `RefineTools` + `ClassificationOverride` into `AnalysisDetailView` — render in Review drawer tab; read-only gate via `useReviewSeat().hasSeat`
- [X] T249 [W] [US4] Wire `RefinementUndoContext` + `offlineQueue` + `syncWorker` into `AnalysisDetailView` — dispatch refine actions through undo stack → queue → POST to `/mask-refine`; optimistic update
- [X] T250 [W] [US4] Wire `SyncIndicator` + `SyncContext` into app shell — add to `EMRPage.tsx` top bar
- [X] T251 [W] [US4] Wire `RecordLockBanner` into `AnalysisDetailView` — render when seat held by another user per plan §Review seat concurrency
- [X] T252 [P] [US4] Create `packages/ml-inference/tests/regression/test_vista3d_delta_dice.py` — asserts Δ-Dice ≥+0.05 after 3 clicks per SC-006 threshold
- [X] T253 [P] [US4] Create `packages/ml-inference/tests/regression/test_medsam2_iou.py` — asserts slice-to-slice IoU ≥0.85 per plan §ML regression
- [X] T254 [P] [US4] Create `packages/app/src/emr/hooks/__tests__/useReviewSeat.test.ts` — concurrent-edit collision returns merge-UI state
- [X] T255 [P] [US4] Create `packages/app/src/emr/services/offline/__tests__/conflictResolver.test.ts` — induced 409 from MockClient triggers modal
- [X] T256 [P] [US4] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us4-refinement.ts` — 3 scenarios (happy click-to-refine ≤30 s, failure empty-region click rejected cleanly, edge offline→reconnect auto-sync)
- [X] T419 [P] [US4] Integration test FHIR Bundle transaction rollback for reviewer-edits batch (FR-017b) — POST Bundle transaction with N `Segmentation` edits + 1 `AuditEvent` addendum; inject failure on entry N-1; assert ALL entries rolled back (zero side effects) at `packages/ml-inference/tests/integration/fhir/test_bundle_transaction_rollback.py`
- [X] T420 [P] [US4] E2E session-expiry mid-edit replay (FR-018a) — reviewer opens case, starts mask-refine, JWT `exp` passes, writes are queued to IndexedDB; user re-authenticates via silent-renew or prompt; queued writes replay with toast "Resumed after reauthentication" at `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-session-expiry-replay.ts`
- [X] T421 [P] [US4] E2E undo restores AI mask + timeline intact (spec §US4 Edge) — reviewer performs 3 refine clicks → undo stack pops each → original AI mask restored exactly (pixel-diff) AND `SurgeonReview` timeline still shows all 3 edit + undo events (append-only per FR-017b); append as 4th scenario to `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us4-refinement.ts`
- [X] T422 [W] [US4] Wire `seat_manager.acquire/heartbeat/release` + `refinement_local_recompute.composite()` into `packages/ml-inference/src/api/review.py` handlers — POST /reviews (acquire), POST /reviews/{id}/heartbeat (extend), mask-refine (composite back into full-res mask writing new Segmentation with `generation_source=reviewer_edited`) per FR-017a + FR-015
- [X] T423 [frontend-designer] [US4] Extend T241 `useReviewSeat.ts` + T251 `RecordLockBanner.tsx` with holder-side takeover-request toast — when another user requests takeover, server pushes via SSE/WS; holder sees 15-second countdown toast "Another reviewer requests this case — release now?" with Release/Keep buttons; on Release → immediate seat release + redirect; on Keep or timeout → requester notified; wire tenant-scoped SSE endpoint `/api/v1/reviews/{id}/takeover-events` in T232
- [X] T424 [US4] Extend T239 `ReviewSeatContext.tsx` with `beforeunload` + `pagehide` listeners firing `navigator.sendBeacon('/api/v1/reviews/{id}/release')` for guaranteed release on tab close; add heartbeat-failure policy (2 missed heartbeats → degraded state + 60-s warning banner; recovery within 60s → silent resume; else seat-taken error via errorClient) per FR-017a

**Checkpoint 6**: US4 done. Reviewer can refine masks + handle concurrent edits + survive offline.

---

## Phase 7: User Story 5 — Finalize + export + PACS push (Priority: P5)

**Goal**: Finalize Report → PDF + DICOM-SEG + DICOM-SR with RUO watermark → optional PACS push with retry state machine.

**Independent Test**: SC-009 RUO on every artifact (0/20 spot-check misses); PACS push transactional per artifact; re-finalize produces new SOP UIDs.

**Spec refs**: US5, FR-023..027, FR-026a/b/c, FR-027a, FR-028a.

- [X] T257 [US5] Create `packages/ml-inference/src/services/seg_sr/seg_builder.py` — `highdicom.seg.Segmentation` MULTI_SEGMENT_BINARY (parenchyma + 8 Couinaud + 2 vessels + N lesions), SNOMED codes from `fhir-codesystems.ts` ported Python-side, fresh SOP Instance UID per finalize (FR-026b) per contracts/dicom-artifacts.md
- [X] T258 [US5] Create `packages/ml-inference/src/services/seg_sr/sr_builder.py` — `highdicom.sr` TID 1500 Measurement Report referencing SEG (no duplicated geometry), RUO disclaimer as leading `TextContentItem`, qualitative FLR adequacy (25/30/40% thresholds) per contracts/dicom-artifacts.md
- [X] T259 [US5] Create `packages/ml-inference/src/services/export/pdf_builder.py` — WeasyPrint rendering with Noto Sans + Noto Sans Georgian embedded; `@page` + `::before` RUO watermark; OCR-verified per T275 test
- [X] T260 [US5] Create `packages/ml-inference/src/services/export/pdf_templates/{en,de,ka}/report.html` — surgeon-facing report with 3D screenshots, volumes table, FLR summary, lesion list
- [X] T261 [US5] Create `packages/ml-inference/src/services/pacs_push/storescu.py` — `pynetdicom` C-STORE client; transactional per-artifact delivery per research §B.6
- [X] T262 [US5] Create `packages/ml-inference/src/services/pacs_push/retry_state_machine.py` — pending→sending→acknowledged/failed→manual-fallback with exponential backoff 1→32 min ×6 attempts; PHI-scrubbed `last_error` per FR-026a/c
- [X] T263 [US5] Create `packages/ml-inference/src/services/pacs_push/cecho.py` — pre-flight C-ECHO for PACS config save (US6 consumer) per FR-039
- [X] T264 [US5] Create `packages/ml-inference/src/tasks/push_to_pacs.py` Celery task — idempotency key `(report_id, destination_id, attempt_n)`, invokes `retry_state_machine`
- [X] T265 [US5] Create `packages/ml-inference/src/api/export.py` — `POST /api/v1/reviews/{id}/finalize` (step-up), `GET /api/v1/reports/{id}`, `POST /api/v1/reports/{id}/pacs-push`, `POST /api/v1/reports/{id}/pacs-push/{delivery_id}/retry`, `POST /api/v1/reports/{id}/retract` per contracts/api-openapi.yaml §export
- [X] T266 [W] [US5] Wire `@require_permission('report.finalize', step_up=True)` on finalize + `report.retract` (step-up) + `report.pacs_push` + `report.pacs_retry`
- [X] T267 [W] [US5] Wire `AuditChainWriter` into finalize/retract/push — emit `report_finalize`, `report_retract`, `pacs_push_attempt/success/failure`, `artifact_export` with chain sequence
- [X] T268 [US5] [frontend-designer] Create `packages/app/src/emr/components/report/FinalizeWizard.tsx` — 5-step `EMRWizardStepper` (check → watermark → pacs → review → ship); step-up MFA on submit via `<PermissionButton stepUp />`
- [X] T269 [US5] [frontend-designer] Create `packages/app/src/emr/components/report/PDFPreview.tsx` — iframe-embed of server-rendered PDF with `frame-ancestors 'none'` CSP per FR-028a
- [X] T270 [US5] [frontend-designer] Create `packages/app/src/emr/components/report/PACSPushPanel.tsx` — delivery-state timeline with per-artifact status + retry button + "Download for manual push" fallback per FR-026c
- [X] T271 [US5] [frontend-designer] Create `packages/app/src/emr/components/report/RetractModal.tsx` — confirmation + reason textarea + step-up
- [X] T272 [US5] [frontend-designer] Create `packages/app/src/emr/views/reports/ReportView.tsx` — finalized-report landing page with "Superseded by Report X" banner if retracted
- [X] T273 [P] [US5] Create `packages/app/src/emr/hooks/useFinalize.ts` + `useReport.ts` + `usePacsDelivery.ts` — TanStack Query + invalidation matrix per plan §Data Fetching
- [X] T274 [W] [US5] Wire finalize invalidation — on successful `finalizeReport`, invalidate `['analysis', id]`, `['analysis', id, 'report']`, `['reports', id]`, `['audit', tenantId, '*']`
- [X] T275 [P] [US5] Create `packages/ml-inference/src/services/export/tests/test_pdf_watermark.py` — WeasyPrint render + OCR extract via pytesseract; asserts "Research Use Only" text present on every page + every sample language
- [X] T276 [P] [US5] Create `packages/ml-inference/tests/integration/test_pacs_push_retry.py` — induces failures at sending state; asserts exponential backoff; asserts `last_error` PHI-scrubbed
- [X] T277 [P] [US5] Create `packages/ml-inference/tests/integration/test_seg_sr_roundtrip.py` — generated SEG+SR loads in ephemeral Orthanc; asserts all SNOMED codes present + `AlgorithmIdentificationSequence.name` prefixed `liverra-`
- [X] T278 [P] [US5] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us5-export.ts` — 3 scenarios (happy finalize + 3 artifacts RUO-watermarked, failure PACS push retry succeeds, edge superseded-report banner on older view)
- [X] T425 [P] [US5] Contract test DICOM-SEG/SR golden-file diff against `contracts/dicom-artifacts.md` — render finalize on fixture ct-002; diff generated SEG + SR against expected fields (SNOMED codes, `AlgorithmIdentificationSequence.name` prefix `liverra-`, leading RUO `TextContentItem`, MULTI_SEGMENT_BINARY layout) at `packages/ml-inference/tests/contracts/test_dicom_artifacts_golden.py`
- [X] T426 [US5] Create `packages/ml-inference/src/tasks/finalize_report.py` Celery task — orchestrates `seg_builder.build()` → `sr_builder.build(seg_uid)` → `pdf_builder.build(report_html, locale)`; persists `Report` + `ReportDelivery` rows; writes artifacts to `s3://liverra-imaging-eu-central-1/<tenant>/reports/<report_id>/`; emits `report_finalize` AuditEvent; idempotency key `(analysis_id, finalize_version)` per FR-023..027
- [X] T427 [W] [US5] Wire `finalize_report.delay()` into `packages/ml-inference/src/api/export.py` `POST /api/v1/reviews/{id}/finalize` — enqueue Celery task, return 202 Accepted with polling URL; import builders via the Celery task rather than inline
- [X] T428 [W] [US5] Wire `retry_state_machine.advance()` + `storescu.send()` into `packages/ml-inference/src/tasks/push_to_pacs.py` — state machine owns transitions; storescu is the effect; PHI-scrub exceptions via `phi_scrubber.scrub(str(exc))` before writing `ReportDelivery.last_error` per FR-026a
- [X] T429 [W] [US5] Wire `useFinalize()` into `FinalizeWizard.tsx` submit handler, `useReport(reportId)` into `ReportView.tsx` + `PDFPreview.tsx`, `usePacsDelivery(reportId)` into `PACSPushPanel.tsx` (polling + retry mutation) — required for T278 E2E to pass
- [X] T430 [US5] Extend T262 `retry_state_machine.py` + T265 `POST /api/v1/reports/{id}/pacs-push` with demo-case server invariant — load `report.analysis.demo_case_id`; if `DemoCase.sample_case_flag=true`, reject with `problem+json` slug `demo-case-no-pacs-push` (HTTP 409) + AuditEvent `outcome=minor-failure`; unit + integration test that guard fires even if frontend `SampleDataBadge` (T310) is bypassed per FR-042 invariant
- [X] T431 [P] [US5] Add translation keys for finalize wizard steps, PDF/SEG/SR artifact labels, PACS push statuses, retract modal to `packages/app/src/emr/translations/{en,de,ka}/report.json` (CODEOWNERS-gated for medical terminology in de/ka)

**Checkpoint 7**: US5 done. Full clinical workflow demoable: upload → view → refine → finalize → PDF/SEG/SR → PACS.

---

## Phase 8: User Story 6 — Hospital admin onboarding (Priority: P2)

**Goal**: Admin self-serve tenant onboarding: invite users, assign roles, configure + C-ECHO-test PACS, suspend users, approve deletions, review tenant-scoped audit log.

**Independent Test**: Three DPAs signed + MFA-active per site (SC-007); red-team admin-view-PHI denied (SC-015).

**Spec refs**: US6, FR-039, FR-046, FR-047.

- [X] T279 [US6] Create `packages/ml-inference/src/api/admin.py` — `GET /api/v1/admin/tenants/me`, `GET /api/v1/admin/users`, `POST /api/v1/admin/users/invite`, `POST /api/v1/admin/users/{id}/suspend`, `PUT /api/v1/admin/pacs-destination`, `POST /api/v1/admin/pacs-destination/echo`, `POST /api/v1/admin/studies/{id}/delete-request`, `GET /api/v1/admin/audit` per contracts/api-openapi.yaml §admin
- [X] T280 [US6] Create `packages/ml-inference/src/services/admin/invite_service.py` — 72-hour signed JWT invite token; email via SES (Jinja2 template `notifications/templates/{en,de,ka}/invite.html`)
- [X] T281 [US6] Create `packages/ml-inference/src/services/notifications/ses_adapter.py` — boto3 SES client, DKIM-signed, PHI-clean templates per research §A.5
- [X] T282 [US6] Create email Jinja2 templates `packages/ml-inference/src/services/notifications/templates/{en,de,ka}/{invite,analysis_complete,analysis_failed,queued_long,pacs_failed,mfa_reset,invite_accepted,erasure_confirmed,phi_incident}.html` (9 templates × 3 locales = 27 files; batch 9 tasks of 3 files — too many; collapse to 3 tasks of 9 files each since templates have no regex-touchable structure)
- [X] T283 [US6] Create `packages/ml-inference/src/services/admin/case_deletion.py` — user-submitted deletion requires admin approval; soft-delete only; hard-delete reserved to DPO per FR-046
- [X] T284 [W] [US6] Wire `@require_permission` on admin routes — `admin.invite_user`, `admin.assign_role`, `admin.suspend_user`, `admin.configure_pacs`, `admin.cecho_pacs`, `admin.approve_deletion`, `admin.view_audit`
- [X] T285 [W] [US6] Wire `AuditChainWriter` into admin routes — emit `admin_invite`, `admin_suspend_user`, `admin_configure_pacs`, `admin_approve_deletion`
- [X] T286 [US6] [frontend-designer] Create `packages/app/src/emr/views/admin/UserManagementView.tsx` — `EMRTable` with invite button + per-row suspend
- [X] T287 [US6] [frontend-designer] Create `packages/app/src/emr/components/admin/UserInviteModal.tsx` — `EMRFormFields` form (email + role + display_name + locale) inside `EMRModal`
- [X] T288 [US6] [frontend-designer] Create `packages/app/src/emr/views/admin/PacsConfigView.tsx` — `EMRFormFields` form (ae_title, host, port, use_tls, cert_fingerprint) + "Test with C-ECHO" button showing round_trip_ms
- [X] T289 [US6] [frontend-designer] Create `packages/app/src/emr/views/admin/AuditBrowserView.tsx` — filterable `EMRTable` of AuditEvents (date range + category + actor) with PHI-free summaries
- [X] T290 [US6] [frontend-designer] Create `packages/app/src/emr/components/admin/DeleteRequestApprovalPanel.tsx` — approve/reject user-submitted deletion
- [X] T291 [P] [US6] Create `packages/app/src/emr/hooks/{useAdminUsers,usePacsConfig,useAdminAudit}.ts` — TanStack Query hooks
- [X] T292 [W] [US6] Wire admin views into routes + nav registry — `/admin/users`, `/admin/pacs-config`, `/admin/audit` visible only to admin role per plan §Route registration
- [X] T293 [P] [US6] Create `packages/ml-inference/tests/integration/test_admin_cecho.py` — mock PACS → C-ECHO success/fail + sanitized error
- [X] T294 [P] [US6] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us6-admin-onboarding.ts` — 3 scenarios (happy invite+role+pacs+audit, failure C-ECHO rejected with technician-friendly error, edge suspended user preserves historical attribution)
- [X] T432 [W] [US6] Wire `cecho.ping(ae_title, host, port, tls_cert)` into `packages/ml-inference/src/api/admin.py` `POST /admin/pacs-destination/echo` — return `{ok, round_trip_ms, scanner_ae_responded}` or sanitized error per FR-039 (required for T293 integration test)
- [X] T433 [W] [US6] Wire `invite_service.create_invite()` + `ses_adapter.send(template='invite', locale, ctx)` into `admin.py` `POST /admin/users/invite` — invite_service issues 72-hour JWT, ses_adapter renders Jinja2 template, SES sends DKIM-signed; return `{invite_id, expires_at}` per FR-039
- [X] T434 [W] [US6] Wire `case_deletion.approve(request_id, approver_id)` into `admin.py` `POST /admin/studies/{id}/delete-request` approval path — soft-deletes Study+Analysis rows, emits `admin_approve_deletion` AuditEvent per FR-046
- [X] T435 [W] [US6] Wire `NotificationPreference` opt-out check into `ses_adapter.send()` — before SES call, query `notification_preference WHERE user_id=? AND event_type=? AND opted_out=true`; if opted out, log `notification_suppressed` metric and skip send; unit test at `packages/ml-inference/tests/integration/test_ses_adapter_opt_out.py`
- [X] T436 [W] [US6] Wire admin hooks into admin views — `useAdminUsers()` into `UserManagementView.tsx` (list + invite + suspend mutations), `usePacsConfig()` into `PacsConfigView.tsx` (read + update + cecho), `useAdminAudit()` into `AuditBrowserView.tsx` (filterable AuditEvent list with invalidation on mutations)
- [X] T437 [frontend-designer] [US6] Create `packages/app/src/emr/components/admin/CoverageOverridePanel.tsx` — admin-only via `useHasPermission('admin.coverage_override')`; lets tenant-admin toggle per-tenant flag `allow_partial_coverage_override` + for specific blocked analysis invoke `POST /api/v1/analyses/{id}/override-coverage` with typed reason + step-up MFA; renders warning banner on resulting analysis; wire into admin console per FR-006a
- [X] T438 [P] [US6] Add translation keys for user-management actions, invite modal, PACS config form, audit browser column headers to `packages/app/src/emr/translations/{en,de,ka}/admin.json` (CODEOWNERS-gated)

**Checkpoint 8**: US6 done. Admin can self-serve tenant onboarding end-to-end.

---

## Phase 9: User Story 7 — First-time clinician onboarding (Priority: P2)

**Goal**: Mandatory wizard: password/SSO → MFA enrol + backup codes → RUO terms acceptance (signed) → guided tour → optional sample case. Cannot upload real patient studies until complete.

**Independent Test**: ≤15 min completion, ≥80% first-invite completion via PostHog funnel (SC-014).

**Spec refs**: US7, FR-041, FR-042, FR-031.

- [X] T295 [US7] Create `packages/ml-inference/src/api/onboarding.py` — `POST /auth/ruo-accept` (records RUO acceptance with signed event per FR-031), `POST /auth/mfa-enrol` (wraps Cognito TOTP + backup-codes Lambda), `GET /auth/me/onboarding-status`
- [X] T296 [US7] Create `packages/ml-inference/src/services/onboarding/signed_ruo.py` — HMAC-SHA256 signature `(user_id, timestamp, tenant_genesis)` per data-model §2
- [X] T297 [US7] Create `packages/ml-inference/src/services/onboarding/sample_case_runner.py` — invokes `bootstrap-medplum-project.py` demo-seed for the user's tenant if not already seeded per FR-042
- [X] T298 [W] [US7] Wire `AuditChainWriter` into onboarding endpoints — emit `ruo_acceptance`, `mfa_challenge`, `onboarding_completed`
- [X] T299 [US7] [frontend-designer] Create `packages/app/src/emr/views/onboarding/OnboardingWizard.tsx` — 5-step `EMRWizardStepper`: password/SSO, MFA, RUO, tour, sample case
- [X] T300 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/PasswordStep.tsx` — password form OR hospital SSO link button
- [X] T301 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/MFAEnrolStep.tsx` — TOTP QR code + backup-codes download + confirmation
- [X] T302 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/RUOAcceptStep.tsx` — multilingual RUO text (read locale from `User.locale_preference`) + explicit accept button with signed submission
- [X] T303 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/GuidedTourStep.tsx` — 5-tooltip walkthrough over upload/viewer/finalize; skip + replay support
- [X] T304 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/SampleCaseStep.tsx` — "Run demo case" button → monitors analysis → "Sample data — not real patient" badge throughout
- [X] T305 [US7] [frontend-designer] Create `packages/app/src/emr/views/demo/DemoCaseRunner.tsx` — re-runnable demo from Help menu per SC-013
- [X] T306 [P] [US7] Create `packages/app/src/emr/hooks/useOnboardingStatus.ts` — gates access across app: if `ruo_accepted_at IS NULL` OR `mfa_enrolled_at IS NULL`, redirect to `/onboarding` (except `/onboarding/*` + `/auth/*`)
- [X] T307 [W] [US7] Wire `useOnboardingStatus` into `ProtectedRoute` — redirect incomplete-onboarding users
- [X] T308 [W] [US7] Wire PostHog events `onboarding.*` into each wizard step — fires `onboarding_step_started` + `onboarding_step_completed` per plan §Telemetry event catalog
- [X] T309 [US7] Implement `scripts/seed-demo-case.sh` full version — copies fixture CT `ct-demo-rh.dcm` + pre-computed masks into tenant's demo case, marks `DemoCase.sample_case_flag=true`
- [X] T310 [US7] [frontend-designer] Create `packages/app/src/emr/components/onboarding/SampleDataBadge.tsx` — persistent banner + watermark when viewing a `DemoCase`-derived analysis; blocks PACS push per FR-042 invariant
- [X] T311 [P] [US7] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us7-clinician-onboarding.ts` — 3 scenarios (happy ≤15 min completion, failure MFA-browser-close resumes at MFA step, edge demo case outputs cannot push to real PACS)
- [X] T439 [W] [US7] Wire `signed_ruo.sign(user_id, tenant_genesis)` into `packages/ml-inference/src/api/onboarding.py` `POST /auth/ruo-accept` — persist HMAC signature as `User.ruo_accepted_signature` + `ruo_accepted_at`; wire `sample_case_runner.ensure_seeded(tenant_id)` into the sample-case step + into `scripts/seed-demo-case.sh` (T309) so script + wizard share the same idempotent path per FR-031 + FR-042
- [X] T440 [W] [US7] Wire `/demo-case` route into `packages/app/src/AppRoutes.tsx` + `nav-registry.ts` — add lazy-loaded route entry pointing at `DemoCaseRunner.tsx` (T305); add nav item under Help menu for all roles per SC-013 (re-runnable demo from Help)
- [X] T441 [W] [US7] Wire `SampleDataBadge` (T310) into `AnalysisDetailView.tsx` (top-of-view banner when `analysis.is_demo`) + `PACSPushPanel.tsx` (disable push button with tooltip) + burn sample-data marker into `PDFPreview.tsx` watermark layer per FR-042 invariant
- [X] T442 [P] [US7] Add translation keys for onboarding wizard steps, MFA QR helper, RUO acceptance body, guided-tour tooltip text, sample-case badge to `packages/app/src/emr/translations/{en,de,ka}/onboarding.json` — DPO + native-speaker joint approval required for RUO disclaimer wording per plan §i18n wiring

**Checkpoint 9**: US7 done. Every new clinician passes through onboarding; RUO + MFA enforced before first upload.

---

## Phase 10: User Story 8 — Ops stuck-case recovery (Priority: P3)

**Goal**: Ops engineer monitors cross-tenant queue, identifies stuck cases, re-queues/cancels/marks-blocked. Never sees PHI.

**Independent Test**: Recovery action audited + no PHI visible at any point (SC-010 + SC-015).

**Spec refs**: US8, FR-033a/b/c.

- [X] T312 [US8] Create `packages/ml-inference/src/api/ops.py` — `GET /api/v1/ops/queue`, `POST /api/v1/ops/analyses/{id}/mark-blocked` per contracts/api-openapi.yaml §ops
- [X] T313 [US8] Create `packages/ml-inference/src/services/ops/queue_aggregator.py` — cross-tenant view with `{queued, running, stuck_over_15min, gpu_utilization_pct, cold_start_rate_last_hour}` from Postgres + Prometheus
- [X] T314 [W] [US8] Wire `@require_permission('ops.view_queue'|'ops.cancel_analysis'|'ops.retry_analysis'|'ops.mark_blocked')` on ops routes; AccessPolicy **MUST hide all PHI fields** per plan §RBAC
- [X] T315 [W] [US8] Wire `AuditChainWriter` into ops mutations — `ops_retry`, `ops_cancel`, `ops_mark_blocked`
- [X] T316 [US8] [frontend-designer] Create `packages/app/src/emr/views/ops/OpsQueueView.tsx` — live dashboard with queue depth, GPU panel, p50/p95 latencies, stuck-case table
- [X] T317 [US8] [frontend-designer] Create `packages/app/src/emr/components/ops/StuckCasePanel.tsx` — per-case detail (case_id, model_versions, stage timings, error signatures — NO PHI) + Retry / Cancel / Mark-Blocked actions
- [X] T318 [US8] [frontend-designer] Create `packages/app/src/emr/components/ops/QueueDepthGauge.tsx` — visual gauge per tenant + alarm coloring above threshold
- [X] T319 [P] [US8] Create `packages/app/src/emr/hooks/{useOpsQueue,useOpsAnalysis}.ts`
- [X] T320 [W] [US8] Wire Ops view into routes (`/ops/queue` lazy) + nav-registry (visible only to `ops` role)
- [X] T321 [P] [US8] Create `packages/ml-inference/tests/integration/test_ops_no_phi.py` — asserts every field in `/api/v1/ops/queue` responses passes PHI scrubber (no names, no MRNs, no study UIDs in free text)
- [X] T322 [P] [US8] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us8-ops-stuck-case.ts` — 3 scenarios (happy identify+requeue completes, failure requeue-still-broken → mark-blocked notifies clinician, edge no PHI visible anywhere)
- [X] T443 [W] [US8] Wire `queue_aggregator.build_view(tenant_filter=None)` into `packages/ml-inference/src/api/ops.py` `GET /api/v1/ops/queue` — return aggregator output; assert every field passes `phi_scrubber.is_clean()` before serializing (fail-closed per NFR-007; required for T321 integration test)
- [X] T444 [W] [US8] Wire `useOpsQueue()` into `OpsQueueView.tsx` (polling every 5 s) + `QueueDepthGauge.tsx`; wire `useOpsAnalysis(id)` into `StuckCasePanel.tsx` (detail + retry/cancel/mark-blocked mutations); mutation `onSuccess` invalidates `['ops', 'queue']`
- [X] T445 [P] [US8] Add translation keys for ops queue statuses, stuck-case states, retry/cancel/mark-blocked actions to `packages/app/src/emr/translations/{en,de,ka}/ops.json`

**Checkpoint 10**: US8 done. Ops role can unblock the pipeline without ever touching PHI.

---

## Phase 11: User Story 9 — GDPR erasure (Priority: P3)

**Goal**: DPO executes Art. 17 erasure: ≤60 s crypto-shred, audit residual-identifier rewrite, confirmation PDF, subsequent 404 (not 403) per FR-032a.

**Independent Test**: p99 ≤60 s, 404-on-search verified (SC-016), clinician cannot initiate.

**Spec refs**: US9, FR-040, FR-002a fallback.

- [X] T323 [US9] Create `packages/ml-inference/src/api/erasure.py` — `POST /api/v1/erasure/requests` (DPO, step-up), `GET /api/v1/erasure/requests/{id}` per contracts/api-openapi.yaml §erasure
- [X] T324 [US9] Create `packages/ml-inference/src/services/erasure/orchestrator.py` — erasure flow: validate DPO + justification + fresh MFA → crypto-shred via `kms:ScheduleKeyDeletion` synchronous → hard-delete Postgres rows (Study/Series/Analysis/Segmentation/Lesion/Classification/FLR/Review/Report/Delivery) → AuditEvent residual-identifier rewrite → generate confirmation PDF → persist tombstone per research §X.1
- [X] T325 [US9] Create `packages/ml-inference/src/services/erasure/audit_rewriter.py` — walks AuditEvents referencing erased case; substitutes residual identifiers with `sha256(orig || tombstone_hash)` placeholders **without rewriting hashed rows** (chain integrity preserved per research §A.3)
- [X] T326 [US9] Create `packages/ml-inference/src/services/erasure/confirmation_pdf.py` — WeasyPrint render with justification + DPO + timestamp + tombstone hash
- [X] T327 [W] [US9] Wire `@require_permission('erasure.execute', step_up=True)` on erasure endpoints
- [X] T328 [W] [US9] Wire `AuditChainWriter` into erasure — emit `erasure_requested` + `tenant_data_deletion` with `rbac.denied=true` tag on any unauthorized attempt
- [X] T329 [US9] [frontend-designer] Create `packages/app/src/emr/views/erasure/ErasureRequestList.tsx` — DPO-only list of erasure requests with status
- [X] T330 [US9] [frontend-designer] Create `packages/app/src/emr/views/erasure/ErasureWizard.tsx` — 5-step wizard (select → justify → MFA → review → confirm) with step-up gate
- [X] T331 [US9] [frontend-designer] Create `packages/app/src/emr/components/erasure/ErasureConfirmation.tsx` — confirmation PDF download + tombstone reference
- [X] T332 [W] [US9] Wire `/erasure/*` routes into router + nav-registry (DPO role only)
- [X] T333 [US9] Implement `scripts/gdpr-erasure-sim.sh` full version — provisions disposable tenant, runs erasure, asserts ≤60 s + 404 on subsequent search
- [X] T334 [P] [US9] Create `packages/ml-inference/src/services/erasure/tests/test_crypto_shred.py` — mock KMS, assert `ScheduleKeyDeletion` called + p99 <60 s over 100 iterations
- [X] T335 [P] [US9] Create `packages/ml-inference/src/services/erasure/tests/test_audit_rewriter.py` — verifies chain integrity preserved post-erasure + residual identifiers hashed
- [X] T336 [P] [US9] Create `packages/ml-inference/tests/integration/test_erasure_404_disclosure.py` — post-erasure clinician search returns 404 not 403 per FR-032a
- [X] T337 [P] [US9] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us9-gdpr-erasure.ts` — 3 scenarios (happy ≤60 s + confirmation PDF, failure clinician attempt blocked, edge compliance reviewer sees erasure + hashed prior identifiers)
- [X] T446 [W] [US9] Wire `erasure.orchestrator.execute(request_id)` into `packages/ml-inference/src/api/erasure.py` `POST /api/v1/erasure/requests` handler — handler validates payload, enqueues Celery task `erasure_execute(request_id)` which calls `orchestrator.execute()` → `audit_rewriter.rewrite()` → `confirmation_pdf.build()`; GET streams confirmation PDF from S3 per FR-040 + SC-016
- [X] T447 [P] [US9] Add translation keys for erasure wizard, justification labels, confirmation-PDF strings, "case not found" empty state (FR-032a) to `packages/app/src/emr/translations/{en,de,ka}/erasure.json`

**Checkpoint 11**: US9 done. GDPR Art. 17 workflow operational end-to-end.

---

## Phase 12: User Story 10 — Compliance reviewer (Priority: P3)

**Goal**: Read-only compliance dashboard: MBoM viewer, audit summary (chain-validated), RUO spot-check tool, RegulatoryClaimRegistry toggle (step-up).

**Independent Test**: Compliance can complete SC-009 (20-artifact RUO audit) + SC-010 (chain reconciliation) without DB access.

**Spec refs**: US10, FR-028b, FR-038.

- [X] T338 [US10] Create `packages/ml-inference/src/api/compliance.py` — `GET /api/v1/compliance/mbom`, `GET /api/v1/compliance/audit-summary`, `POST /api/v1/compliance/ruo-spot-check`, `GET`+`PUT /api/v1/compliance/claim-registry` per contracts/api-openapi.yaml §compliance
- [X] T339 [US10] Create `packages/ml-inference/src/services/compliance/chain_verifier.py` — walks audit chain for a window, recomputes leaf hashes, returns `{chain_valid, first_invalid_sequence_no, merkle_root_for_window, s3_anchor_uris}` per research §A.3
- [X] T340 [US10] Create `packages/ml-inference/src/services/compliance/mbom_reader.py` — reads current build's `MBoM.json` + historical rows from `model_bill_of_materials` table
- [X] T341 [US10] Create `packages/ml-inference/src/services/compliance/ruo_spot_check.py` — samples N random exported artifacts (PDF, SEG, SR); renders PDF pages + OCRs watermark region; marks pass/fail
- [X] T342 [US10] Create `packages/ml-inference/src/services/compliance/claim_registry.py` — CRUD on `RegulatoryClaimRegistry` with step-up enforcement on `PUT`
- [X] T343 [W] [US10] Wire `@require_permission` on compliance routes — `compliance.view_mbom`, `compliance.generate_audit_summary`, `compliance.spot_check_ruo`, `compliance.toggle_claim_registry` (step-up)
- [X] T344 [W] [US10] Wire `AuditChainWriter` into claim-registry writes — emit `model_version_update` on toggle
- [X] T345 [US10] [frontend-designer] Create `packages/app/src/emr/views/compliance/MBoMView.tsx` — read-only table of integrated models with license hash, source URL, commit, approver
- [X] T346 [US10] [frontend-designer] Create `packages/app/src/emr/views/compliance/AuditSummaryView.tsx` — date-range picker, tenant selector (from `ComplianceAssignment`), chain-verification badge, downloadable tamper-evident report
- [X] T347 [US10] [frontend-designer] Create `packages/app/src/emr/components/compliance/AuditChainVerifier.tsx` — renders first-invalid event highlight on chain break + links to adjacent S3 Merkle anchor
- [X] T348 [US10] [frontend-designer] Create `packages/app/src/emr/views/compliance/RUOSpotCheckView.tsx` — runs sample + renders per-artifact thumbnail with watermark region highlighted + pass/fail marker
- [X] T349 [US10] [frontend-designer] Create `packages/app/src/emr/views/compliance/ClaimRegistryView.tsx` — 7 rows per tenant; each with status toggle (`<PermissionButton stepUp>`), effective-from timestamp, regulatory reference
- [X] T350 [P] [US10] Create `packages/app/src/emr/hooks/{useMBoM,useAuditSummary,useRUOSpotCheck,useClaimRegistry}.ts`
- [X] T351 [W] [US10] Wire compliance views into routes + nav-registry (compliance role only) + ComplianceAssignment scope filter
- [X] T352 [US10] [frontend-designer] Refactor `RUODisclaimer` + `burnWatermark` to consume `useRUOClaim` — disclaimer scope narrows when `RegulatoryClaimRegistry.status='cleared'` per plan §Claim Registry as feature-flag source + FR-028b
- [X] T353 [P] [US10] Create `packages/app/src/emr/components/compliance/__tests__/AuditChainVerifier.test.tsx` — feed synthetic corrupted chains; assert UI highlights first invalid event
- [X] T354 [P] [US10] Create `packages/ml-inference/tests/integration/test_compliance_audit_window.py` — 7-day window returns chain-valid + matches S3 Merkle anchor
- [X] T355 [P] [US10] Create `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-us10-compliance.ts` — 3 scenarios (happy audit summary + chain valid + RUO spot-check pass 20/20, failure simulated tampered chain breaks at first invalid event, edge claim toggle narrows disclaimer)
- [X] T448 [W] [US10] Wire compliance services into `packages/ml-inference/src/api/compliance.py` handlers — `GET /mbom` → `mbom_reader.load()`; `GET /audit-summary` → `chain_verifier.verify(tenant_id, from, to)`; `POST /ruo-spot-check` → `ruo_spot_check.sample_and_verify(n)`; `GET`+`PUT /claim-registry` → `claim_registry.read()` / `claim_registry.update(key, status, actor)` (required for T354 integration test)
- [X] T449 [W] [US10] Wire compliance hooks into corresponding views 1:1 — `useMBoM()` into `MBoMView.tsx`, `useAuditSummary()` into `AuditSummaryView.tsx` + `AuditChainVerifier.tsx`, `useRUOSpotCheck()` into `RUOSpotCheckView.tsx`, `useClaimRegistry()` into `ClaimRegistryView.tsx`; wire `useClaimRegistry().update(key, status)` through `<PermissionButton stepUp permission='compliance.toggle_claim_registry'>` so step-up challenge precedes mutation
- [X] T450 [P] [US10] Add translation keys for MBoM columns, audit summary, RUO spot-check status, claim registry toggle labels to `packages/app/src/emr/translations/{en,de,ka}/compliance.json`
- [X] T451 [W] Cross-cutting: wire `<PermissionButton stepUp>` into `RetractModal.tsx` (T271) submit button (permission=`report.retract`) + `ErasureWizard.tsx` (T330) final-step submit (permission=`erasure.execute`) — unit test asserts step-up challenge fires before mutation POST; complements T266/T349 existing step-up paths

**Checkpoint 12**: US10 done. Compliance officer can sign off SC-009 + SC-010 + prep for partial CE clearance via claim registry.

---

## Phase 13: Polish & Cross-Cutting Concerns

**Purpose**: Testing pyramid completion, CI gate wiring, production-readiness verification, docs, brand, performance.

### Testing strategy completion

- [X] T356 [P] Create `packages/ml-inference/tests/regression/fixtures/` with `ct-001-normal`, `ct-002-cirrhotic`, `ct-003-post-resection`, `ct-004-tumor-replacement`, `ct-005-partial-coverage` fixture CT + GT mask sets
- [X] T357 [P] Create `packages/ml-inference/tests/regression/thresholds.yaml` per plan §ML regression gate (maps each stage to Dice/IoU/sensitivity threshold + MBoM version binding)
- [X] T358 [P] Create `packages/ml-inference/tests/contracts/test_triton_stage_shapes.py` — per-stage tensor shape/dtype/axis-order assertions vs `contracts/triton-stages.md`
- [X] T359 [P] Create `packages/ml-inference/tests/rbac/fixtures/role_crossing_catalog.yaml` — 15 canonical named role-crossing actions per plan §RBAC red-team
- [X] T360 [P] Create `packages/ml-inference/tests/rbac/test_role_crossing.py` — parametrized on (role × permission) cartesian from `matrix.yaml`; asserts 404 + `liverra:not-found` type + audit written + no PHI per SC-015
- [X] T361 [P] Create `packages/ml-inference/src/services/audit/tests/test_chain_of_hashes.py` — tamper-detection at start/middle/end positions of chain
- [X] T362 [P] Create `packages/ml-inference/src/services/anon/tests/test_presidio_fixtures.py` — 10 FP + 10 FN fixtures
- [X] T363 [P] Create `packages/app/src/emr/services/__tests__/fhir-integration.test.ts` — MockClient FHIR roundtrips (AuditEvent chain, Bundle transaction rollback, tenant 404 non-disclosure, AccessPolicy matrix)
- [X] T364 [P] Create `packages/ml-inference/tests/integration/fhir/test_tenant_isolation.py` — search in tenant A returns 0 hits for tenant B resource
- [X] T365 [P] Create `packages/app/lighthouse.config.js` — budgets LCP ≤2.5 s, TBT ≤300 ms, CLS ≤0.1, TTI ≤4 s per plan §Load & performance
- [X] T366 [P] Create `packages/ml-inference/tests/load/k6-pipeline.js` — 3 tenants × 5 users × 5 studies/week; p95 e2e ≤300 s (SC-002); p99 ≤600 s
- [X] T367 [P] Create `packages/app/tests/performance/viewer-fps.spec.ts` — Playwright+CDP recorded FPS during 3D rotation asserts ≥30 desktop / ≥20 tablet per NFR-001
- [X] T368 [P] Create `packages/app/tests/performance/slice-scroll-latency.spec.ts` — keydown-to-paint ≤100 ms p95
- [X] T369 [P] Create `packages/app/tests/visual/locales.spec.ts` — i18n visual-diff across en/de/ka at mobile+desktop per plan §i18n wiring
- [X] T370 [P] Create `packages/app/tests/visual/mobile-smoke.spec.ts` — 390×844 smoke-run every route, asserts no horizontal scrollbar
- [X] T371 [P] Create `packages/app/tests/a11y/axe-sweep.spec.ts` — `@axe-core/playwright` every route in light+dark; WCAG 2.1 AA violations fail per NFR-002

### CI job wiring

- [X] T372 Update `.github/workflows/ci.yml` — enable all CI jobs: `ci-unit-ts`, `ci-unit-py`, `ci-lint`, `ci-typecheck`, `ci-contract`, `ci-ml-regression`, `ci-rbac-red-team`, `ci-fhir-integration`, `ci-bundle-check`, `ci-i18n`, `ci-i18n-visual`, `ci-forbidden-colors`, `ci-palette-cvd-check`, `ci-ui-agent-check`, `ci-lighthouse`, `ci-viewer-fps`
- [X] T373 [P] Create `.github/workflows/e2e-cpu.yml` — runs 27 parallelizable E2E scenarios (`test-us2/us3/us5/us6/us7/us9/us10`) blocking on main PRs
- [X] T374 [P] Create `.github/workflows/e2e-gpu.yml` — runs 3 GPU-serial scenarios (`test-us1/us4/us8`) blocking on release branches + nightly on main
- [X] T375 [P] Create `.github/workflows/k6-nightly.yml` — runs k6 load test against staging with SC-002 + FR-013 assertions
- [X] T376 [P] Create `scripts/i18n-check.ts` — AST walk for `t('...')` calls, asserts every key in `{en,de,ka}.json`
- [X] T377 [W] Wire `i18n-check` into CI `ci-i18n` job
- [X] T378 [P] Create `scripts/forbidden-colors-scan.sh` — grep `#(3b82f6|60a5fa|2563eb|4267B2)` across `.ts,.tsx,.css,.module.css` → fail on any hit
- [X] T379 [W] Wire `forbidden-colors-scan` into CI `ci-forbidden-colors` job

### Observability + DR completion

- [X] T380 [P] Implement `scripts/dr-restore-dryrun.sh` full version — restores latest RDS PITR + S3 snapshot into sandbox VPC, runs chain verifier, asserts RTO <8 h
- [X] T381 [P] Create `deploy/grafana/dashboards/` JSON fully populated (fill T131 stubs with queries against CloudWatch + Prometheus + Tempo)
- [X] T382 [P] Create PagerDuty escalation policy + alert routing in `deploy/terraform/pagerduty.tf` per plan §Alerts
- [X] T383 [P] Write `docs/runbooks/dr-restore.md` — step-by-step DR playbook
- [X] T384 [P] Write `docs/runbooks/erasure-execution.md` — DPO operational guide
- [X] T385 [P] Write `docs/runbooks/phi-incident-response.md` — FR-002a incident playbook (detect → quarantine → notify DPO → crypto-shred → post-mortem)
- [X] T386 [P] Write `docs/runbooks/breach-tabletop-2026.md` — annual tabletop template per NFR-009

### Brand rebrand + documentation

- [X] T387 Create `specs/001-zero-training-mvp/brand-tokens.md` — `status: pending` artifact blocking pilot release until founder + design lead sign off per plan §Brand rebrand deliverables
- [X] T388 Create `specs/001-zero-training-mvp/a11y-matrix.md` — per-component ARIA matrix from plan §Accessibility matrix (14 components)
- [X] T389 Create `packages/app/ResponsiveMatrix.md` — per-screen breakpoint behavior table per plan §Mobile & touch strategy
- [X] T390 [P] Create `docs/architecture/overview.md` — high-level architecture diagram + ADR index
- [X] T391 [P] Create `docs/architecture/adr/0001-cascaded-not-ensemble.md` — ADR for rejecting Triton ensemble (research §C.2)
- [X] T392 [P] Create `docs/architecture/adr/0002-medplum-self-hosted.md` — ADR per research §A.2
- [X] T393 [P] Create `docs/architecture/adr/0003-per-tenant-linear-hash-chain.md` — ADR per research §A.3
- [X] T394 [P] Create `docs/architecture/adr/0004-custom-cornerstone3d-not-ohif.md` — ADR per research §C.4
- [X] T395 [P] Create `docs/architecture/adr/0005-per-case-kms-crypto-shred.md` — ADR per research §X.1

### Production-readiness verification

- [X] T396 Create `docs/runbooks/readiness-matrix.md` — live-tracking version of plan §Production-Readiness Matrix; regenerated from CI artifacts nightly
- [X] T397 Create `.github/workflows/readiness-matrix.yml` — nightly job aggregating CI-job outcomes → updates `readiness-matrix.md` status column
- [X] T398 Create `.github/workflows/release-gate.yml` — blocks release tag creation if any of: (a) `ci-dr-drill` >90 days old, (b) breach-tabletop-YYYY.md missing for current year, (c) SC-001..SC-016 row red
- [X] T399 Run `npm run bootstrap:dev` on fresh clone; validate quickstart.md end-to-end per quickstart §1-8
- [X] T400 Execute `scripts/verify-ruo-watermark.py` against all demo case artifacts; assert all carry watermark per SC-009
- [X] T401 Execute `scripts/verify-audit-chain.py` against each tenant's chain; assert chain integrity per SC-010
- [X] T402 Assemble release-readiness report mapping every SC-001..SC-016 to its CI-green evidence; archive to `docs/releases/v1.0.0/readiness.md`

### Polish merged via /upgradeTasks — security-critical tests, production gates, brand rebrand

- [X] T452 [P] Unit test `@require_permission` decorator step-up + tenant scope — assert (a) missing permission → 404 `liverra:not-found`, (b) `step_up=True` with stale `auth_time` (>5 min) → 401 `liverra:step-up-required`, (c) cross-tenant resource → 404, (d) audit emitted with `rbac.denied=true`, at `packages/ml-inference/tests/security/test_require_permission_decorator.py` — plan §Mandatory security-critical suites
- [X] T453 [P] Unit test PHI scrubber fail-closed drop + counter — assert (a) scrubber crash in `before_send` → event dropped (0 outbound), (b) `phi_scrubber_failed_total` counter increments, (c) fallback never surfaces raw event, at `packages/ml-inference/tests/security/test_phi_scrubber_fail_closed.py` — NFR-007 release-blocker
- [X] T454 [P] E2E frontend permission enforcement per role (7 roles from matrix.yaml) — for every permission NOT granted: (a) UI control NOT in DOM (not just hidden), (b) direct URL navigation renders 404 via `ProtectedRoute`, at `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/test-frontend-permission-matrix.ts` — double-sided twin of T360 per SC-015
- [X] T455 [P] Integration test AccessPolicy per role × tenant matches `matrix.yaml` intent — load RBAC generator output (`deploy/medplum/access-policies/*.json`), POST each role's policy to Medplum, assert read/write scope matches `matrix.yaml` for Patient/ImagingStudy/Observation/AuditEvent/DiagnosticReport, at `packages/ml-inference/tests/integration/fhir/test_access_policy_matrix.py`
- [X] T456 [P] Integration test FHIR extension URL roundtrip integrity — create AuditEvent with all 4 LiverRa extensions + Observation with ruo-claim-key extension; round-trip via Medplum GET; assert URLs verbatim and values lossless, at `packages/ml-inference/tests/integration/fhir/test_extension_url_roundtrip.py`
- [X] T457 [P] Integration test AuditEvent + chain-of-hashes roundtrip through FHIR layer — emit 10 sequential domain events; assert Medplum AuditEvent rows AND `audit_event_chain` have linear `leaf_hash(prev)`; recompute chain from FHIR GET and verify matches Postgres, at `packages/ml-inference/tests/integration/fhir/test_audit_chain_fhir_roundtrip.py` — SC-010
- [X] T458 [P] A11y: keyboard-only navigation for LiverViewer3D + ResectionPlaneTool — no mouse; Tab to viewer → arrow rotates, +/- zoom, L toggles layers; Tab to ResectionPlaneTool slider → Left/Right 1 mm, PageUp/Down 10 mm; assert `aria-valuenow` updates + live-region announces, at `packages/app/tests/a11y/viewer-keyboard-nav.spec.ts` — NFR-002 WCAG 2.1 AA
- [X] T459 [P] E2E i18n runtime switching en ↔ de ↔ ka — on `AnalysisDetailView` with populated data, switch locale via `localeService` between en/de/ka; assert (a) medical-glossary terms render in target locale (no raw keys), (b) Georgian Noto Sans renders without `.notdef` boxes, (c) number-format + date-format respect locale, at `packages/app/tests/i18n/locale-switching.spec.ts`
- [X] T460 [P] Unit test TanStack Query retry + 5xx jittered backoff — induce 5xx on 2 consecutive requests + success on 3rd; assert 100 ms → 6.4 s backoff with jitter; assert user-actionable incident reference after 3 failures, at `packages/app/src/emr/services/__tests__/errorClient-retry.test.ts`
- [X] T461 [P] GPU concurrent-load test — spawn 3 concurrent analysis jobs against warmed Triton; assert queue depth ≤ 3, no OOM, VRAM peak ≤ 23.5 GB, all complete within SC-002 p95 budget, at `packages/ml-inference/tests/load/test_gpu_concurrent_load.py` (CI job `ci-gpu-load`)
- [X] T462 [P] [frontend-designer] Dark-mode + CVD palette visual sweep — `packages/app/tests/visual/dark-mode-sweep.spec.ts` Playwright visual-diff every route at `data-mantine-color-scheme='dark'`; assert (a) no hardcoded hex leaks, (b) 8 Couinaud tokens pass chroma-js CVD in dark variant, (c) 16 overlay tokens meet 4.5:1 contrast on viewer's black background, (d) RUO watermark legible
- [X] T463 [W] Wire `palette-cvd-check` into `.github/workflows/ci.yml` as blocking job `ci-palette-cvd-check` (T411 implements the script; T005 turbo task slot)
- [X] T464 [frontend-designer] Apply LiverRa brand gradient to `packages/app/src/emr/styles/theme.css` — replace placeholder warm-gray `--emr-primary-*` ramp with approved gradient + `--emr-primary-50..900` values + `--emr-accent-*` ramp from signed-off `brand-tokens.md`; gated by `brand-tokens.md.status='approved'` (depends on T387)
- [X] T465 [P] [frontend-designer] Per-component ARIA matrix compliance test — `packages/app/tests/a11y/component-aria.spec.ts` asserts every row of `a11y-matrix.md` is satisfied (ResectionPlaneSlider, LiverViewer3D, LesionList, FLRPanel, CouinaudLegend, FinalizeWizard, MBoMTable, etc.) — complements T371 route-level sweep with per-component assertions
- [X] T466 [P] Alembic migration reversibility test — for every revision T052-T058 test `upgrade() → downgrade() → upgrade()` on ephemeral Postgres Testcontainer; assert final schema matches target + no data loss on round-trip of seed data; add CI job `ci-alembic-migrations` blocking on PRs touching `alembic/versions/`, at `packages/ml-inference/tests/migrations/test_alembic_reversibility.py` — Constitution §Data Migration
- [X] T467 Create `packages/ml-inference/src/tasks/recalibrate_temperature.py` Celery task — triggered on MBoM version bump per tenant; re-fits per-tenant temperature on held-out validation subset (add `ClassificationValidationSample` table to T054); writes new value to `Tenant.abstention_threshold_context`; emits `model_recalibrated` AuditEvent; wire invocation into T342 `claim_registry.py` MBoM-bump flow per research §C.7
- [X] T468 [P] FHIR CapabilityStatement validation test — query Medplum `/metadata`; assert (a) every LiverRa-defined extension URL from T040-T041 appears in `CapabilityStatement.rest.resource.*.extension.url`, (b) AuditEvent+ImagingStudy+DiagnosticReport+Patient+Practitioner+Observation declared with proper interactions, (c) supported profiles include LiverRa StructureDefinitions, at `packages/app/src/emr/services/__tests__/capability-statement.test.ts` — Constitution §FHIR Conformance
- [X] T469 Update `docs/runbooks/readiness-matrix.md` (T396) + `release-gate.yml` (T398) to include upgraded SC gates — append rows for new CI jobs (`ci-palette-cvd-check`, `ci-gpu-load`, `ci-alembic-migrations`, `ci-dicom-uid-present`, `ci-bundle-check`) to the Production-Readiness Matrix live dashboard

**Checkpoint 13**: All stories complete, all gates green. Ready for design-partner pilot deployment + SC-007 DPA signing + SC-008 tumor-board use + SC-011 conference abstract.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no deps — start immediately (25 tasks, mostly parallel)
- **Phase 2 (Foundational)**: depends on Phase 1 — BLOCKS all user stories (114 tasks, ~60% parallel)
- **Phase 3 (US1 P1)**: depends on Phase 2 complete — MVP slice
- **Phases 4-12 (US2-US10)**: depend on Phase 2; once Phase 2 done, all stories can proceed in parallel if staffed
- **Phase 13 (Polish)**: depends on all desired stories

### User story dependencies

- **US1 (P1)** — no deps on other stories (standalone MVP)
- **US2 (P2)** — depends on US1 parenchyma output (stage 3 consumes stage 1 mask); can proceed in parallel with US1 development after T162 stub shipped
- **US3 (P3)** — depends on US1 parenchyma + US2 Couinaud (for lesion Couinaud-location); can begin model-integration in parallel
- **US4 (P4)** — depends on US1-US3 outputs to have something to refine; model work parallelizable
- **US5 (P5)** — depends on US1-US4 to have Report content; export services parallelizable
- **US6 (P2)** — depends on Phase 2 auth + Cognito; independent of US1-US5 clinical flow
- **US7 (P2)** — depends on Phase 2 + US6 invite flow; otherwise independent
- **US8 (P3)** — depends on US1 cascade existing (there must be queued analyses to recover); ops UI parallelizable
- **US9 (P3)** — depends on Phase 2 KMS + Phase 12 compliance audit rewriter for chain integrity; otherwise standalone
- **US10 (P3)** — depends on Phase 2 audit chain + US9 erasure events existing; dashboard UI standalone

### Within each user story

- Triton model + orchestrator Celery task → service layer → API endpoint → `@require_permission` wiring → `AuditChainWriter` wiring → Frontend hook + view → integration wiring → tests
- **Every Create task has a matching [W] wire task** in the consumer phase — see Wiring Checklist below

### Parallel opportunities summary

- Phase 1: ~17 of 25 tasks `[P]`
- Phase 2: ~70 of 114 tasks `[P]` (port batches, context scaffolding, FHIR constants)
- Each US phase: ~40% `[P]` typical
- Phase 13: ~30 of 47 tasks `[P]`
- **Max wall-clock reduction**: 3-dev team can complete in ~55% of serial time (per-phase bottlenecks are the [W] wire tasks + tests that depend on producers)

---

## Parallel Example: US1 kickoff

After Phase 2 checkpoint, a 3-developer team could start US1 with these parallel batches:

```bash
# Backend dev A — ingestion + anonymization stack
Task: "T140 Create pacs/orthanc/orthanc.json"
Task: "T142 Create pacs/ctp/pipeline.xml"
Task: "T143 Create pacs/anon-sidecar/main.py"

# Backend dev B — Triton + orchestrator
Task: "T155 Create triton-models/stunet-parenchyma/config.pbtxt"
Task: "T157 Create services/triton/client.py"
Task: "T159 Create orchestrator/sanity.py"

# Frontend dev C (frontend-designer agent)
Task: "T171 [frontend-designer] Create upload/DicomDropzone.tsx"
Task: "T173 [frontend-designer] Create views/cases/CasesListView.tsx"
Task: "T180 Create contexts/AnalysisContext.tsx"
```

Wire tasks (T147, T153, T154, T165, T166, T169, T170, T186-T189) come after their producers.

---

## Wiring Checklist *(verify each phase before checkpoint)*

- [ ] Every `Create [service]` task has a `[W] Wire` task in a consumer phase
- [ ] Every `Create [hook]` task is called by at least one component task
- [ ] Every `Create [component]` task is referenced by a route or parent component task
- [ ] Every `@require_permission`-protected endpoint has a matching wire task
- [ ] Every `AuditEvent`-emitting endpoint has a chain-writer wire task
- [ ] Every new Context has a wire task adding provider to `main.tsx` or parent view
- [ ] Orphan detection: grep `T0?(\d+) Create` against `T0?(\d+).*Wire .*T0?(\d+)` — every create should have a matching wire reference

---

## Implementation Strategy

### MVP First (US1 only)

1. **Week 0-1**: Phase 1 Setup (parallel across team)
2. **Week 1-2**: Phase 2 Foundational — **CRITICAL blocker** for everything
3. **Week 2-3**: Phase 3 US1 only
4. **STOP**: Demo US1 at `app.liverra.ai` to design-partner surgeons (SC-013 recording)
5. Validate SC-002 + SC-003 on real-ish data

### Incremental delivery (6-week sprint per plan.md + mvp-strategy)

- **Week 1**: Phase 1 + 60% of Phase 2 (ports in parallel)
- **Week 2**: Phase 2 complete + Phase 3 US1 started
- **Week 3**: US1 finalized + US2 Couinaud started (stage 3 model)
- **Week 4**: US2 + US3 Lesion done + US6 admin parallel track
- **Week 5**: US4 refinement + US5 export + US7 onboarding
- **Week 6**: US8 ops + US9 erasure + US10 compliance + Phase 13 polish + SC-013 demo recording

### Parallel team strategy (recommended staffing)

- **Backend ML engineer** (1): Phase 2 Triton + all cascade stages (US1/US2/US3/US4 model integration)
- **Backend platform engineer** (1): Phase 2 Medplum + Cognito + RBAC + audit + Phase 8 admin + Phase 11 erasure + Phase 12 compliance
- **Full-stack engineer** (1): Phase 2 ports + Phase 3 viewer shell + Phase 6 refinement frontend + Phase 9 onboarding
- **Clinical validator + QA** (shared): Phase 13 regression fixtures + E2E + ML thresholds + SC-007 DPA + SC-008 tumor-board case
- **frontend-designer agent** (on-demand): all UI tasks marked `[frontend-designer]` — delegated per-task by humans above

---

## Notes

- `[P]` = different files, no cross-task dependencies
- `[W]` = integration wiring; MUST run after producer task completes; specifies exact import + call site
- `[USn]` = maps task to user story for traceability + SC coverage
- Tests are REQUIRED for this feature (Class IIb SaMD; IEC 62304 verification evidence requires 1:1 spec→test trace)
- Commit after each task or logical group
- Checkpoint after each phase to validate independence
- **Never batch >3 files in one PR** (Constitution §No Bulk File Edits)
- **UI work MUST use frontend-designer agent** (CLAUDE.md)
- **FHIR work MUST invoke fhir-developer skill first**
- **Chain-of-hashes + audit writes must be in same Postgres txn as business action** (FR-029b fail-closed)
- **Cross-tenant resource access returns 404, not 403** (FR-032a)
- **Every exported artifact MUST carry RUO watermark** (SC-009)

**Total tasks: 469** (402 baseline + 67 upgrade merged 2026-04-19) · **User story phases: 10** · **Wire tasks: 77** (53 baseline + 24 wiring audit) · **Parallel-safe tasks: ~185** · **[frontend-designer]-annotated tasks: 100+** · **Orphan check: all Create tasks matched to a Wire task** · **SC coverage: all 16 SCs bound to a named CI job in §Production-Readiness Matrix**
