# Implementation Plan: Zero-Training Cascaded Pretrained Liver AI Pipeline (v1 MVP)

<!-- UPGRADED -->

**Branch**: `001-zero-training-mvp` | **Date**: 2026-04-19 · upgraded 2026-04-19 via `/upgradePlan` (45 findings merged) | **Spec**: [`spec.md`](./spec.md)
**Input**: Feature specification at `/Users/toko/Desktop/LiverRa/specs/001-zero-training-mvp/spec.md`

---

## Summary

Deliver the LiverRa v1 MVP — a web application at `app.liverra.ai` where HPB surgeons at three design-partner hospitals (Regensburg, Potsdam, Geo Hospitals) upload a 4-phase contrast liver CT and, within 5 minutes, obtain a 3D interactive view with parenchyma + 8 Couinaud segments + vessel trunks + lesion list + FLR calculator + finalized PDF/DICOM-SEG/DICOM-SR exports.

The pipeline is a **cascaded orchestration of five Apache-2.0 pretrained models** (STU-Net → Pictorial Couinaud → LiLNet → VISTA3D → MedSAM-2) — **no custom training in v1**. The platform around the AI is full-featured: auth + MFA + RBAC + admin onboarding + clinician onboarding + compliance dashboard + ops dashboard + GDPR erasure + chain-of-hashes audit + PACS push + i18n (en/de/ka) + WCAG 2.1 AA + dark mode + mobile-responsive. Research Use Only disclaimer is a first-class regulatory primitive (per-claim registry, pixel-burn watermarking, fail-closed audit).

The plan deliberately decouples the **AI stages behind versioned Triton contracts** so that later work only needs to swap model weights behind the same I/O shape — frontend, audit, review, and export flows do not need to change.

---

## Technical Context

**Language/Version**:
- Frontend: TypeScript 5.x strict ESM + React 19 (Vite 7)
- Backend API: Python 3.11 (FastAPI)
- Background workers: Python 3.11 (Celery)
- ML inference: Python 3.11 + NVIDIA Triton 24.x

**Primary Dependencies**:
- UI: Mantine UI 7.x, OHIF Viewer 3.9+, Cornerstone3D 2.0, React Router 7, TanStack Query 5
- API: FastAPI, Pydantic 2, SQLAlchemy 2, Alembic
- ML: MONAI 1.4+, PyTorch 2.3, Triton Inference Server 24.x
- DICOM: `pydicom`, `highdicom` (DICOM-SEG + DICOM-SR), Orthanc, CTP anonymizer
- FHIR: generated types from `packages/fhirtypes` (R4)
- Auth: OAuth 2.0 / OIDC (specific provider — see research)

**Storage**:
- PostgreSQL 16 — domain (Analyses, Segmentations, SurgeonReviews, Reports, AuditEvents)
- Redis 7 — Celery queue + per-session cache + rate limits
- S3 (eu-central-1) — DICOM (encrypted with per-case KMS keys), derived masks, exported artifacts
- Orthanc — transient DICOM staging + DIMSE endpoints
- FHIR server (see research — Medplum self-hosted vs HAPI FHIR vs native Postgres)

**Testing**:
- Frontend: Vitest (unit) + Playwright (E2E per spec §End-to-End Test Scenarios)
- Backend: pytest + pytest-asyncio + httpx; schema tests with `schemathesis`
- ML regression: pytest with golden CT fixtures; Dice/IoU thresholds block merge (constitution testing gate)
- Contract tests: OpenAPI schema conformance + Triton model I/O schema validation

**Target Platform**:
- Web browser (Chrome/Edge 120+, Safari 17+, Firefox 121+)
- Mobile-responsive down to 390 px wide
- Backend + Triton: Linux containers on AWS (eu-central-1)
- GPU: NVIDIA L4 24 GB (g5.xlarge) for production inference, on-demand start/stop
- Deployment: Docker Compose for MVP; Amazon EKS deferred to Phase 2

**Project Type**: Web application (monorepo) + ML inference service + DICOM edge appliance

**Performance Goals**:
- End-to-end pipeline ≤5 min on warm infra (SC-002)
- Inference stage total ≤2 min on L4 (FR-014)
- FLR readout ≤1 s during plane drag (FR-013)
- 3D view ≥30 fps on workstation, ≥20 fps on tablet (NFR-001)
- Slice scroll response ≤100 ms (NFR-001)
- Queue 1–3 concurrent analyses on MVP hardware (FR-036)

**Constraints**:
- Data residency AWS eu-central-1 Frankfurt (Constitution VII)
- Apache 2.0 licensing for all integrated ML models (Constitution II)
- TLS 1.3 in transit, AES-256 at rest, KMS-managed keys
- PHI never leaves hospital network un-anonymized (FR-002)
- Audit writes MUST fail-closed (FR-029b)
- RUO disclaimer mandatory on every AI-derived output (Constitution VI + FR-028)
- Cost envelope €800–€1,500 / month pilot (NFR-008)

**Scale/Scope**:
- v1: 3 tenants × ~5 clinicians each × 1–5 studies/week ≈ 75 studies/month
- Storage: raw DICOM ~500 MB–2 GB per study × 90-day retention ≈ 150 GB active
- Frontend screens: ~25 (upload, viewer, lesions, refine, finalize, cases list, admin, onboarding, compliance, ops, help, glossary, erasure, settings, notifications, profile, audit log, user management, PACS config, demo case runner, etc.)
- ~47 FRs + 10 NFRs + 10 user stories + 18 key entities

---

## Constitution Check *(GATE — must pass before Phase 0)*

Evaluated against `.specify/memory/constitution.md` v2.0.0. All ten principles assessed.

| # | Principle | Gate | Plan Status |
|---|-----------|------|------------|
| I | Spec-Driven Development (NON-NEGOTIABLE) | Spec artifacts exist | ✅ `spec.md` upgraded (v2); `plan.md` = this file; `tasks.md` produced in Phase 2 |
| II | Apache 2.0 Model Licensing (NON-NEGOTIABLE) | All models verified Apache 2.0 | ✅ STU-Net, Pictorial Couinaud, LiLNet, VISTA3D, MedSAM-2 all Apache 2.0; MBoM automation planned (FR-038) |
| III | Cascaded Inference Architecture | Pipeline cascaded, not end-to-end; each stage versioned contract | ✅ 5-stage cascade; per-stage Triton endpoints + OpenAPI contracts in `/contracts` |
| IV | FHIR-First Healthcare Data | FHIR R4; central constants file; `http://liverra.ai/fhir/...` URLs | ✅ `packages/fhirtypes`; `packages/app/src/emr/constants/fhir-systems.ts` (port from MediMind) |
| V | Auditability & Regulatory Traceability | Every ML run + DICOM txn + PHI touch logged; chain-of-hashes; MBoM + DBoM | ✅ FHIR AuditEvent FR-029a; chain-of-hashes research task; MBoM build step FR-038 |
| VI | Research Use Only Until CE Mark | RUO disclaimer on every AI output; per-claim registry | ✅ FR-028 + FR-028a + FR-028b pixel-burn + per-claim RUO registry |
| VII | Security, Privacy & Data Residency | OAuth/OIDC; MFA; AccessPolicy / RBAC; Frankfurt residency; secrets in AWS SM | ✅ OIDC (provider decided in research); MFA + step-up (NFR-006); eu-central-1; AWS Secrets Manager |
| VIII | Type Safety & Strict Mode | TS strict, Python type hints + mypy strict, Pydantic at FastAPI boundary | ✅ TS strict in all packages; `mypy --strict` on Python; Pydantic v2 models |
| IX | Unified Design System | theme.css + EMR component library; mobile-first; tap targets 44×44; `frontend-designer` only | ✅ Port theme.css + EMR lib from MediMind; NFR-002 + NFR-004 + NFR-005; all UI via `frontend-designer` |
| X | Internationalization | en / de / ka translations; native-speaker review | ✅ NFR-003 + translation system port from MediMind |

**Gate outcome**: PASS (no violations to justify; Complexity Tracking section empty).

Additional compliance hooks:
- **Healthcare standards**: IEC 62304 software-lifecycle documentation flows from spec → plan → tasks → implement; ISO 14971 risk management addressed via edge-cases + NFR-009; ISO 13485 QMS scaffolding begins with the Compliance Dashboard (US10).
- **Spec-Driven Workflow Gate**: every code-producing PR references this spec; `/speckit.analyze` run before `/speckit.implement`.
- **Model Licensing Discipline**: FR-038 MBoM + license-hash drift detection operationalizes Constitution II.
- **GDPR Art. 17**: FR-040 erasure workflow + FR-032a existence-disclosure hardening.

---

## Project Structure

### Documentation (this feature)

```text
specs/001-zero-training-mvp/
├── spec.md                   # Feature specification (upgraded)
├── plan.md                   # This file
├── research.md               # Phase 0 — resolved unknowns
├── data-model.md             # Phase 1 — entity ERD + field specs
├── quickstart.md             # Phase 1 — dev bootstrap
├── contracts/                # Phase 1 — OpenAPI + Triton I/O + DICOM-SEG/SR schemas
│   ├── api-ingest.yaml
│   ├── api-analysis.yaml
│   ├── api-review.yaml
│   ├── api-export.yaml
│   ├── api-admin.yaml
│   ├── api-ops.yaml
│   ├── api-compliance.yaml
│   ├── api-auth.yaml
│   ├── triton-stu-net.md
│   ├── triton-couinaud.md
│   ├── triton-lilnet.md
│   ├── triton-vista3d.md
│   ├── triton-medsam2.md
│   ├── dicom-seg-schema.md
│   └── dicom-sr-tid1500.md
├── checklists/
│   └── requirements.md       # Spec quality checklist (already present)
└── tasks.md                  # Phase 2 — /speckit.tasks output (NOT created here)
```

### Source Code (repository root)

The repository is a **Turborepo monorepo**. Two execution domains: the web platform (TypeScript) and the ML inference service (Python). DICOM edge appliance sits between them.

```text
LiverRa/
├── packages/
│   ├── app/                          # Web frontend — Vite + React 19 + Mantine 7
│   │   └── src/
│   │       ├── emr/                  # Naming convention ported from MediMind
│   │       │   ├── components/
│   │       │   │   ├── common/       # EMRModal, EMRButton, EMRCard …
│   │       │   │   ├── shared/       # EMRFormFields, EMRTable, EMRRichText …
│   │       │   │   ├── pacs/         # Viewer, StudyList, Comparison, WindowPresets
│   │       │   │   ├── liver/        # Parenchyma3DView, SegmentsLayer, VesselsLayer,
│   │       │   │   │                 # LesionList, FLRPanel, ResectionPlane, RefineTools
│   │       │   │   ├── upload/       # DicomDropzone, UploadProgress, PHIDetectWarning
│   │       │   │   ├── report/       # FinalizeWizard, PDFPreview, PACSPushPanel
│   │       │   │   ├── admin/        # UserInvite, RoleAssign, PacsConfig, AuditBrowser
│   │       │   │   ├── onboarding/   # MFAEnrol, RUOAccept, Tour, SampleCaseRunner
│   │       │   │   ├── compliance/   # MBoMView, AuditSummary, RUOWatermarkSpotCheck,
│   │       │   │   │                 # ClaimRegistryEditor
│   │       │   │   ├── ops/          # StuckCases, QueueDepth, RetryPanel
│   │       │   │   ├── erasure/      # DPOErasureWizard, ErasureConfirmation
│   │       │   │   └── nav/          # MainMenu, Breadcrumbs, SessionRecoveryBanner
│   │       │   ├── routes/           # React Router 7 route table (to be created)
│   │       │   ├── contexts/         # Auth, Translation, Theme, RUOClaimRegistry
│   │       │   ├── services/
│   │       │   │   ├── auth/         # OIDC client + MFA + step-up
│   │       │   │   ├── pacs/         # Cornerstone3D init, DICOMweb client,
│   │       │   │   │                 # DICOM-SR service, annotation, audit, hanging protocols
│   │       │   │   ├── analysis/     # API clients for ingest/analysis/review/export
│   │       │   │   ├── admin/
│   │       │   │   ├── compliance/
│   │       │   │   ├── ops/
│   │       │   │   └── notifications/
│   │       │   ├── hooks/            # useAnalysis, useReviewSeat, useRUOClaim …
│   │       │   ├── translations/     # en.json / de.json / ka.json
│   │       │   ├── styles/
│   │       │   │   └── theme.css     # Design-system CSS variables (port + rebrand)
│   │       │   └── constants/
│   │       │       ├── fhir-systems.ts
│   │       │       ├── fhir-extensions.ts
│   │       │       ├── fhir-identifiers.ts
│   │       │       └── routes.ts
│   │       └── main.tsx              # Already exists as stub
│   ├── core/                         # Cross-package utilities + types
│   ├── imaging/                      # DICOM + Cornerstone3D wrappers
│   ├── fhirtypes/                    # FHIR R4 TypeScript types + LiverRa extensions
│   └── ml-inference/                 # Python — FastAPI orchestrator + Triton configs
│       ├── src/
│       │   ├── main.py               # FastAPI app
│       │   ├── api/                  # ingest / analysis / review / export / admin / ops routers
│       │   ├── orchestrator/         # Cascaded pipeline; stage queue; partial-results;
│       │   │                         # sanity checks; timeout; cold-start detector
│       │   ├── models/               # SQLAlchemy ORM + Pydantic schemas
│       │   ├── services/
│       │   │   ├── dicom/            # Orthanc client; DICOMweb; anonymization pipeline
│       │   │   ├── anon/             # CTP wrapper + pixel-PHI detector
│       │   │   ├── triton/           # Triton client; per-stage inference wrappers
│       │   │   ├── seg_sr/           # highdicom DICOM-SEG / DICOM-SR generation
│       │   │   ├── fhir/             # FHIR AuditEvent emitter + chain-of-hashes
│       │   │   ├── audit/            # Audit log writer (fail-closed)
│       │   │   ├── export/           # PDF builder (WeasyPrint); PACS C-STORE
│       │   │   ├── erasure/          # GDPR Art. 17 workflow
│       │   │   ├── notifications/    # Email (SES / Postmark) adapter
│       │   │   └── ruo/              # Per-claim registry + disclaimer assembler
│       │   ├── tasks/                # Celery task definitions per stage
│       │   └── workers/              # Celery worker entry points
│       ├── triton-models/            # Triton repo layout (weights + config.pbtxt)
│       │   ├── stunet-parenchyma/
│       │   ├── stunet-lesions/
│       │   ├── couinaud-segments/
│       │   ├── lilnet-classify/
│       │   ├── vista3d-refine/
│       │   └── medsam2-track/
│       ├── tests/                    # pytest + golden CT fixtures
│       └── pyproject.toml
├── pacs/                             # Orthanc + CTP anonymizer + nginx edge appliance
│   ├── orthanc/orthanc.json
│   ├── ctp/pipeline.xml
│   ├── nginx/nginx.conf
│   └── bridge/                       # Webhook sync (port pattern from MediMind)
├── deploy/
│   ├── local/docker-compose.yml      # Dev stack
│   ├── production/docker-compose.yml # Single-node AWS production
│   └── onprem/docker-compose.yml     # Future on-prem edge deployment
├── scripts/
│   ├── careful-guard.sh              # Already present
│   ├── switch-env.sh
│   ├── seed-demo-case.sh             # Provision FR-042 demo fixture per tenant
│   ├── model-bom.sh                  # FR-038 MBoM generator + license hash check
│   └── gdpr-erasure-sim.sh           # Test erasure flows against a fixture
├── specs/                            # Feature specs (auto-populated)
├── tasks/                            # Task collections (auto-populated)
├── docs/
│   ├── research/                     # Strategic research (already present)
│   ├── architecture/                 # Generated architecture overview
│   └── runbooks/                     # Ops runbooks (incident response, erasure, retrain)
├── .claude/                          # Agents, skills, commands
└── .specify/                         # Speckit (templates, bash scripts, memory)
```

**Structure Decision**: Monorepo with **web-frontend + ml-inference** execution domains, plus **DICOM edge appliance** (Orthanc + CTP) and **infra-as-code** in `deploy/`. This matches Constitution III (cascaded, independently deployable stages), Constitution IV (FHIR types centralized in `packages/fhirtypes`), and Constitution IX (UI unified in `packages/app`). The MediMind → LiverRa port is realized inside `packages/app/src/emr/**` preserving the original component naming so ported code works drop-in; new LiverRa-specific surfaces (`liver/`, `admin/`, `compliance/`, `ops/`, `erasure/`, `onboarding/`) are added as distinct directories.

---

## Phase 0: Research *(resolve all NEEDS CLARIFICATION)*

Unknowns extracted from the spec's "Clarifications Needed" and the Technical Context. Each is dispatched to a parallel research agent; outputs consolidated into `research.md`.

### Research task map

1. **Identity / auth stack**: OIDC provider choice (AWS Cognito vs Supabase Auth vs self-hosted Keycloak); MFA + backup codes + step-up re-auth; per-tenant IdP vs shared IdP; hospital SSO integration pattern.
2. **FHIR server**: Medplum self-hosted vs HAPI FHIR vs native Postgres schema; AuditEvent ingestion rate; multi-tenant isolation; LiverRa extension registration.
3. **Audit chain-of-hashes**: linear hash chain vs Merkle tree; tamper-evidence proof format; tenant-scoped chains vs global; storage backend.
4. **Anonymization pipeline**: CTP (Java) vs `dicomanonymizer` (Python) vs `pydicom-deid`; burned-in pixel PHI detector choice; edge-vs-cloud execution; post-upload PHI quarantine (FR-002a).
5. **DICOM ingest & PACS push**: Orthanc configuration (DIMSE + DICOMweb QIDO/WADO); `highdicom` for DICOM-SEG + DICOM-SR; C-STORE client for PACS push; SOP Instance UID re-minting per finalization.
6. **Viewer strategy**: Port MediMind `PACSViewer` vs adopt upstream OHIF v3 plugin system; Cornerstone3D hanging protocols for 3D + axial/coronal/sagittal; resection-plane 3D geometry (voxel boolean vs marching-cubes); interactive refinement UX (VISTA3D + MedSAM-2 click-to-segment).
7. **Triton orchestration**: Model loading policy (eager vs lazy vs priority); 24 GB VRAM budget allocation across 5 models; cold-start mitigation; inter-stage data passing (shared pinned memory vs NIfTI on disk); partial-result serialization.
8. **ML sanity checks + physiological bounds**: FR-007a enforcement (cascade location); monotonic volume constraints; classification confidence calibration.
9. **RUO pixel-burn watermark**: browser capture interception (Clipboard API, print-CSS `@page`, Screen Capture API); canvas-burn strategy; iframe embed blocking via CSP `frame-ancestors`.
10. **GDPR crypto-shred**: envelope encryption with per-case KMS keys; key deletion as tombstoning; audit residual-identifier hashing.
11. **Email notifications**: SES vs Postmark vs SMTP relay; EU-region-compliant provider; templating + i18n.
12. **Cost controls**: GPU auto-shutdown; S3 lifecycle; spend alerts.
13. **Observability stack**: Sentry (with PHI scrubbing filters) + PostHog (anonymous events) + CloudWatch + Grafana / Prometheus for queue/GPU dashboards.
14. **DR backups**: Postgres PITR + in-region AZ redundancy; Celery job state persistence for in-flight recovery (FR-014b + NFR-009).

### Dispatch plan

Three parallel research agents, each owning a coherent bundle:

- **Research Agent A — Platform backbone**: auth, FHIR server, chain-of-hashes, RBAC enforcement, notifications, observability.
- **Research Agent B — Clinical imaging pipeline**: anonymization, Orthanc/CTP/MIG edge, `highdicom` SEG/SR, PACS push, RUO pixel-burn.
- **Research Agent C — ML orchestration & UX**: Triton cascaded orchestration, VRAM budget, viewer strategy (OHIF vs custom), refinement UX, resection-plane geometry, sanity checks.

Each agent writes its section directly into `research.md` via staged partials in `.research/` then merged.

---

## Phase 1: Design & Contracts *(prerequisite: `research.md` complete)*

### `data-model.md`

Derived from spec §Key Entities (18 entities). Will include:
- Entity name, fields (type + nullable + FHIR mapping where relevant), relationships, lifecycle, RLS/tenant scope.
- Core tables: `Study`, `Series`, `Analysis`, `Segmentation`, `Lesion`, `Classification`, `FLRCalculation`, `SurgeonReview`, `Report`, `AuditEvent`, `User`, `Tenant`, `PermissionGrant`, `ModelBillOfMaterials`, `RegulatoryClaimRegistry`, `ErasureRequest`, `DemoCase`, `NotificationPreference`.
- State machines for `Analysis.status` (queued → running → complete | failed | cancelled | partial-result) and `Report.status` (draft → finalized → superseded | retracted).
- Chain-of-hashes invariants for `AuditEvent`.

### `contracts/`

OpenAPI 3.1 files for the eight public APIs (per the route groups in `packages/ml-inference/src/api`), plus per-stage Triton I/O contracts (markdown with tensor shapes + dtypes + anatomy-code dictionaries), plus DICOM-SEG + DICOM-SR TID-1500 schema notes.

### `quickstart.md`

Developer bootstrap: clone → install Turborepo deps → bring up `deploy/local/docker-compose.yml` (Postgres + Redis + Orthanc + Triton CPU stub) → run demo case → validate RUO watermark on export. Includes the "first PR checklist" referencing the constitution gates.

### Agent context update

Run `.specify/scripts/bash/update-agent-context.sh claude` after Phase 1 to refresh CLAUDE.md agent context with this plan's tech-stack decisions.

---

## Reference Architecture *(canonical pattern juniors MUST mirror)*

LiverRa's Analysis view — upload → viewer → refinement → finalize → PACS push — is **structurally identical** to MediMind's `emr/views/pacs/ImagingTabView.tsx`. That view implements lazy-loaded `PACSViewer` + `PACSErrorBoundary` + resizable drawer + `StudyImporter` upload + `EmergencyAccessModal` step-up pattern + Suspense shell + `useResizablePanel`. **Copy that shape.**

**Canonical file**: `/Users/toko/Desktop/medplum_medimind/packages/app/src/emr/views/pacs/ImagingTabView.tsx` (+ siblings `AdminImagingView.tsx`, `ReadingWorklistView.tsx`, `PACSPatientCard.tsx`).

**Data flow (applied to LiverRa Analysis view)**:

1. Route `/cases/:analysisId` renders `AnalysisRouteView.tsx` → `AnalysisDetailView.tsx`
2. View uses hooks: `useAnalysis(analysisId)`, `useReviewSeat(analysisId)`, `useRUOClaim()`, `useHasPermission('review.take_seat')`
3. Hooks call services in `services/analysis/` (TanStack Query keys `['analysis', analysisId]`) and `services/pacs/` (DICOMweb)
4. Heavy viewer (`LiverViewer3D`) imported via `React.lazy` + `<Suspense fallback={<ViewerSkeleton />}>` + `<LiverErrorBoundary>`
5. Side drawer pattern (ported `useResizablePanel`) hosts Lesion list / Segments list / FLR panel
6. Types in `types/analysis.ts`; translations in `translations/{en,de,ka}/analysis.json`

**Port mode**: `PACSErrorBoundary`, `useResizablePanel`, `StudyImporter` (→ `DicomDropzone`), `EmergencyAccessModal` (→ `StepUpAuthModal`), lazy-load wrapper pattern = **drop-in/re-wire**. `LiverViewer3D`, `ResectionPlaneTool`, `LesionListPanel`, `FLRPanel`, `RefineTools` (VISTA3D/MedSAM-2 wrappers) = **rewrite** (LiverRa-specific).

---

## Port Manifest *(MediMind → LiverRa, drop-in / re-wire / rewrite)*

CLAUDE.md asset map points at directories; this manifest enumerates the **60+ individual files** so `/speckit.tasks` generates one port task per row and `§No Bulk File Edits` (max 3 files/batch) is honored automatically. Port mode: **drop-in** (copy + rename only) / **re-wire** (copy + rebind to LiverRa services/types/URLs) / **rewrite** (LiverRa-specific; reference only).

### Services — `packages/app/src/emr/services/pacs/` (22 files)

| MediMind file | LiverRa target | Mode |
|---|---|---|
| `cornerstoneInit.ts` | `services/pacs/cornerstoneInit.ts` | re-wire |
| `dicomwebClient.ts` | `services/pacs/dicomwebClient.ts` | re-wire (Cognito JWT) |
| `dicomParserService.ts` | `services/pacs/dicomParserService.ts` | drop-in |
| `dicomSRService.ts` | `services/pacs/dicomSRService.ts` | re-wire |
| `annotationService.ts` | `services/pacs/annotationService.ts` | re-wire |
| `auditService.ts` | `services/pacs/auditService.ts` | re-wire (chain-of-hashes) |
| `hangingProtocolEngine.ts` | `services/pacs/hangingProtocolEngine.ts` | drop-in |
| `imagingStudyService.ts` | `services/pacs/imagingStudyService.ts` | re-wire |
| `progressiveLoader.ts` | `services/pacs/progressiveLoader.ts` | drop-in |
| `pacsPerformance.ts` | `services/pacs/pacsPerformance.ts` | drop-in |
| `calibrationService.ts` / `criticalAlertService.ts` / `keyImageService.ts` / `macroService.ts` / `markAsReadService.ts` / `notificationHelpers.ts` / `radiologyReportService.ts` / `readingWorklistService.ts` | analogous | re-wire |

### Hooks — `packages/app/src/emr/hooks/` (18+ files)

`usePACSViewer.ts`, `useDicomWebClient.ts`, `useDicomSR.ts`, `useAnnotations.ts`, `useProgressiveLoader.ts`, `useStudyList.ts`, `useResizablePanel.ts`, `useKeyboardShortcuts.ts`, `useReadingWorklist.ts`, `useCinePlayback.ts`, `useSegmentation.ts`, `useImagingBreakGlass.ts`, `useDraftRecovery.ts`, `useAutoSave.ts`, `useSessionTimeout.ts`, `useRealTimeUpdates.ts`, `useAsyncData.ts`, `useBulkOperations.ts` → **re-wire** (bind to LiverRa TanStack Query keys).

### Components — `packages/app/src/emr/components/pacs/` (32 files)

`PACSViewer.tsx` (→ `LiverViewer3D` shell), `PACSErrorBoundary.tsx`, `StudyList.tsx`, `StudyListFilters.tsx`, `StudyImporter.tsx` (→ `DicomDropzone`), `ComparisonView.tsx`, `WindowPresets.tsx`, `DicomTagBrowser.tsx`, `KeyImageGallery.tsx`, `CriticalAlertModal.tsx`, `ReportPanel.tsx`, `SegmentationPanel.tsx`, `SeriesBrowser.tsx`, `ViewportOverlay.tsx`, `PACSToolbar.tsx`, `MeasurementPanel.tsx`, `CineControls.tsx` → **re-wire**.

### EMR component library — `packages/app/src/emr/components/common/` (98 files)

`EMRModal.tsx`, `EMRButton.tsx`, `EMRCard.tsx`, `EMRErrorBoundary.tsx`, `EMRPageHeader.tsx`, `EMRConfirmationModal.tsx`, `EMREmptyState.tsx`, `EMRSkeleton.tsx`, `EMRToast.tsx`, `EMRProgressStepper.tsx`, `EMRNotificationCenter.tsx`, `EMRDropzone.tsx`, `EMRBreadcrumbs.tsx`, `EMRWizardStepper.tsx`, `EMRAlert.tsx`, `EMRFAB.tsx`, `SessionTimeoutModal.tsx`, `FormErrorBoundary.tsx`, `FailClosedErrorStates.tsx`, `FormLoadingSkeleton.tsx`, `MobileFormWrapper.tsx`, `EMRBottomSheet.tsx`, `EMRTableSkeleton.tsx`, `EMRTableEmptyState.tsx` → **drop-in** (constitution-required; just copy + rebrand).

### Form fields — `packages/app/src/emr/components/shared/EMRFormFields/` (18 files)

`EMRTextInput`, `EMRSelect`, `EMRDatePicker`, `EMRCheckbox`, `EMRNumberInput`, `EMRTextarea`, `EMRSwitch`, `EMRMultiSelect`, `EMRRadioGroup`, `EMRAutocomplete`, `EMRColorInput`, `EMRDateTimePicker`, `EMRTimeInput`, `EMRVirtualSelect`, `EMRFormRow`, `EMRFormSection`, `EMRFormActions`, `EMRFieldWrapper`, `index.ts`, `EMRFieldTypes.ts` → **drop-in**.

### Access control — `packages/app/src/emr/components/access-control/` (7 files)

`RequirePermission.tsx`, `PermissionButton.tsx`, `PermissionGate.tsx`, `SensitiveDataGate.tsx`, `EmergencyAccessBanner.tsx`, `EmergencyAccessModal.tsx` (→ `StepUpAuthModal`), `RecordLockBanner.tsx` → **re-wire** to LiverRa `rbac_matrix.yaml`.

### Routing / auth

- `packages/app/src/AppRoutes.tsx` (~2000 lines) → **re-wire** (strip EMR-irrelevant routes; port LiverRa's 25 screens).
- `packages/app/src/emr/constants/routes.ts` (PATIENT_HUB_ROUTES pattern) → **re-wire** to `LIVERRA_ROUTES` typed export.
- `packages/app/src/emr/components/ProtectedRoute/ProtectedRoute.tsx` → **drop-in**.

### Navigation — `packages/app/src/emr/components/{EMRMainMenu,HorizontalSubMenu}/`

All 6 files → **re-wire**. Replace MediMind labels; drive by `NavRegistry` indexed by LiverRa role (HPB surgeon / radiologist / fellow / admin / ops / compliance / DPO).

### Theme + i18n

- `packages/app/src/emr/styles/theme.css` (~4000 lines) → **re-wire** (preserve `--emr-font-*` + `--emr-spacing-*` tokens for API compatibility; rebrand `--emr-primary-*` ramp — see §Brand Rebrand).
- `packages/app/src/emr/contexts/TranslationContext.tsx` + `services/localeService.ts` + `translations/` → **re-wire**, replace ka/en/ru with en/de/ka. Russian explicitly forbidden (Constitution X).

### AI / Inference patterns

- `packages/app/src/emr/services/ai-assistant/{streamingService,streamingHelpers,sseClient}.ts` → **re-wire** to `/api/v1/analyses/:id/stream` SSE endpoint.
- `packages/app/src/emr/services/messaging/aiDraftService.ts` → **re-wire** (HTTP client pattern for refinement mutations).

**Port discipline**: max 3 files per PR; read full file before editing; use Edit tool (never sed/scripts); no bulk regex find-and-replace across >3 files (Constitution §No Bulk File Edits — MediMind incident caused a 377-file corruption).

---

## Frontend Architecture *(state, data-fetching, error boundaries, lazy-loading, RBAC, codegen)*

### Contexts graph

The plan's existing `contexts/` list (`Auth`, `Translation`, `Theme`, `RUOClaimRegistry`) is insufficient. Add:

- `PermissionContext` — RBAC matrix from research X.3, exposes `permissions: string[]` + `useHasPermission()`
- `AnalysisContext` — selected analysis + partial-results SSE stream handle
- `ViewerStateContext` — camera, layers, plane pose, tool mode (shared across `LiverViewer3D` + panels)
- `ReviewSeatContext` — seat holder + heartbeat + takeover-request flow
- `RefinementUndoContext` — per-click undo stack + IndexedDB mirror (FR-018c)
- `MobileContext` — breakpoint + touch-mode detection
- `AccessibilityContext` — `prefers-reduced-motion` + ARIA live-region router
- `SyncContext` — online/offline state + pending-operation count (binds to `SyncIndicator` nav component)

### Data fetching strategy

**Query key hierarchy** (hierarchical, TanStack Query v5):

```
['tenant', tenantId]
['tenant', tenantId, 'analyses', filters?]
['analysis', analysisId]
['analysis', analysisId, 'segmentation']
['analysis', analysisId, 'lesions']
['analysis', analysisId, 'review']
['analysis', analysisId, 'report']
['reports', analysisId]
['audit', tenantId, window]
['mbom']
['claims', tenantId]
['rbac', 'me']
['ops', 'queue']
```

**Medplum SDK boundary**: FHIR reads (AuditEvent search, ImagingStudy metadata, Practitioner lookup) flow through Medplum SDK wrapped by a TanStack Query adapter `useFhirQuery(resourceType, search)`. **Writes flow through the FastAPI orchestrator** (never direct Medplum) so the orchestrator can co-write the audit chain atomically.

**SSE streaming** (port `services/ai-assistant/streamingService.ts` + `sseClient.ts`): pipeline-progress events stream from `GET /api/v1/analyses/:id/stream`. On each stage-complete event, call `queryClient.setQueryData(['analysis', id], …)` with partial checkpoint data (research X.2 `PipelineCheckpoint`) so partial-result UX works without a full re-fetch.

**Optimistic updates**: VISTA3D click-refine + MedSAM-2 one-prompt writes to local undo stack + IndexedDB first (research C.6), then POSTs the mutation; on error, roll back from undo stack.

**Invalidation matrix**:

| Mutation | Invalidated keys |
|---|---|
| `finalizeReport` | `['analysis', id]`, `['analysis', id, 'report']`, `['reports', id]`, `['audit', tenantId, '*']` |
| `refineMask` | `['analysis', id, 'segmentation']` |
| `repromptLesion` | `['analysis', id, 'lesions']` |
| `overrideClassification` | `['analysis', id, 'lesions']` |
| `retractReport` | `['reports', id]`, `['audit', tenantId, '*']` |
| `executeErasure` | every key under `['tenant', tenantId, *]` |
| `updateClaimRegistry` | `['claims', tenantId]` |
| `suspendUser` | `['tenant', tenantId, 'users']` |

**Staleness windows**: analyses list 30 s; analysis detail during `running` 2 s; after `complete` 5 min; MBoM / claims 10 min; audit read-through on each open.

### Route-level lazy-loading policy

Heavy surfaces MUST be `React.lazy(...)` + `<Suspense fallback={<ViewerSkeleton|PageSkeleton />}>`:

- `/cases/:id` viewer components (`LiverViewer3D`, `ResectionPlaneTool`, `LesionListPanel`, `RefineTools`, `ComparisonView`)
- `/admin/*` (user invite, role assign, PACS config, audit browser)
- `/compliance/*` (MBoM, audit summary, RUO spot-check, claim registry)
- `/ops/*` (queue, retry panel)
- `/erasure/*` (DPO workflow)
- `/help/*` + glossary

**Eager (hot-path)**: auth, cases list, upload, session-recovery banner.

**Bundle budget** (Vite + `rollup-plugin-visualizer` in CI, job `ci-bundle-check`):

- Initial JS ≤ 350 KB gzip (auth + list + theme)
- Viewer chunk ≤ 2 MB gzip (Cornerstone3D + WASM)
- Each admin/ops/compliance chunk ≤ 200 KB gzip

### Error boundary topology

```
<AppErrorBoundary>                           (root; Sentry-reported; PHI-scrubbed; RUO-safe fallback)
  ├── <AuthErrorBoundary>                    (sign-in / MFA failures; never logs credentials)
  ├── <AnalysisErrorBoundary>                (case view; preserves IndexedDB draft on crash)
  │     └── <ViewerErrorBoundary>            (Cornerstone-specific recovery; resets viewport)
  ├── <AdminErrorBoundary> / <ComplianceErrorBoundary> / <OpsErrorBoundary>   (domain-scoped)
  └── <AuditFailClosedBoundary>              (audit write failure → blocks action + full-page explainer)
```

Port `FailClosedErrorStates.tsx` as the rendering primitive for `AuditFailClosedBoundary`.

### Frontend RBAC wiring

- `AuthContext` fetches `/auth/me` on session start; exposes `{ user, tenant, permissions: string[] }`.
- `useHasPermission(perm: LiverraPermission)` hook — `LiverraPermission` is a string-literal union **generated at build time** from `rbac_matrix.yaml` into `packages/app/src/emr/constants/permissions.gen.ts`.
- `<RequirePermission perm="report.finalize" fallback={<ReadOnly />}>…</RequirePermission>`
- `<PermissionButton perm="report.finalize" stepUp />` — opens `StepUpAuthModal` before dispatching mutation.
- `<ProtectedRoute requires={['admin.view_audit']}>` at route level; unauthorized users redirect to **404 (not 403)** per FR-032a.
- Port `PermissionContext`, `usePermissionCheck`, `useStepUpAuth`, `RequirePermission`, `PermissionButton`, `PermissionGate`, `SensitiveDataGate`, `EmergencyAccessModal` → `StepUpAuthModal` from MediMind.

### Contract-first codegen

OpenAPI 3.1 (`contracts/api-openapi.yaml`) is the source of truth. Build steps:

1. `openapi-typescript contracts/api-openapi.yaml -o packages/app/src/emr/services/api-schema.gen.ts` (types only)
2. `openapi-fetch` typed client wrapped in `packages/app/src/emr/services/api-client.ts` with `Authorization: Bearer` (Cognito access token) + `X-LiverRa-Tenant` headers.
3. `schemathesis` contract tests in CI hit the FastAPI dev instance and diff vs YAML — drift blocks merge.
4. Pre-commit hook regenerates `.gen.ts` on `contracts/api-openapi.yaml` edit; hand-edited `.gen.ts` rejected by CI.

Turbo task `generate:openapi-client` wired to the build graph.

### Session recovery + offline

- `services/session/draftStorage.ts` — IndexedDB wrapper keyed `analysis:{id}:{userId}`.
- `services/session/sessionRecovery.ts` — on login, enumerates drafts, produces banner queue.
- `services/session/autoSave.ts` — debounced write into IndexedDB + PATCH `/analyses/{id}/draft`.
- Hooks: `useDraftRecovery(analysisId)`, `useAutoSave(key, value, opts)` (ports), `useSessionTimeout()`.
- `SessionRecoveryBanner` subscribes via `SessionContext`; banner action navigates to `/cases/{id}?resume=1` which restores `ViewerStateContext` + `RefinementUndoContext` from IndexedDB in a single transaction.

### Review seat concurrency

- `POST /api/v1/reviews` acquires seat; heartbeat `POST /api/v1/reviews/{id}/heartbeat` every 20 s; server TTL 60 s.
- `GET /api/v1/reviews?analysis={id}` returns current holder.
- UI: second-reviewer opens case held by another user → render `RecordLockBanner` with holder name + "Request seat" button (sends tenant-scoped notification; toast offers release).
- Seat release audited as `review.seat_released`.
- `useReviewSeat(analysisId)` hook encapsulates acquire + heartbeat + release-on-unmount + takeover-request.
- Refinement controls (`<RefineTools>`) render read-only if seat not held.

### Claim Registry as feature-flag source

The per-claim `RegulatoryClaimRegistry` is a **first-class feature flag source** — not just an export-time PDF filter. `useRUOClaim(claimKey)` returns:

```ts
{
  status: 'ruo' | 'under_conformity_assessment' | 'cleared',
  disclaimerVariant: 'full' | 'narrowed' | 'none',
  watermark: { ui: boolean, export: boolean },
  uiGate: 'none' | 'step-up' | 'denied',
}
```

UI reads this to (a) toggle DOM overlay + canvas burn layers (research B.7), (b) gate the finalize button's step-up requirement, (c) show "Cleared" badge next to outputs whose claim has been cleared. Single source = `RUOClaimRegistryContext`; changes propagate via TanStack Query invalidation. Compliance dashboard toggle (US10 scenario 3) writes through this path.

### Telemetry event catalog

Typed event names as a string-literal union in `packages/app/src/emr/services/telemetry/events.ts`:

**PostHog (anonymous; super-properties `tenant_id`, `user_role`, `locale`; NEVER `user_email`, `patient_*`, `mrn`, `study_uid`)**:

- `onboarding.invite_accepted`, `onboarding.mfa_enrolled`, `onboarding.ruo_accepted`, `onboarding.tour_completed`, `onboarding.sample_case_run` → SC-014
- `upload.started`, `upload.completed` → SC-002
- `analysis.viewed`, `refinement.click`, `refinement.accepted` → SC-006
- `report.finalized`, `report.pacs_pushed` → SC-002 tail, SC-009
- `erasure.initiated` → SC-016
- `ruo_spot_check.completed` → SC-009

PHI scrubber wraps the PostHog client; fail-closed (drop event on scrub error).

---

## UI Conventions *(component discipline, view states, theme, mobile, a11y, i18n, brand)*

### UI Implementation Protocol *(CLAUDE.md mandate)*

Every task targeting `packages/app/src/emr/components/**`, `packages/app/src/emr/styles/**`, or any `.module.css` file **MUST be executed by the `frontend-designer` agent** (CLAUDE.md mandate). `/speckit.tasks` MUST prefix every such task with `[agent: frontend-designer]`. PRs touching UI without that annotation MUST be rejected by the CI `ui-agent-check` job.

Component subdirectories tagged **[frontend-designer]**: `common/`, `shared/`, `pacs/`, `liver/`, `upload/`, `report/`, `admin/`, `onboarding/`, `compliance/`, `ops/`, `erasure/`, `nav/`, `errors/`, `access-control/`, `auth/`.

### Component library discipline

**FORBIDDEN**: direct `@mantine/core` imports of `Modal`, `Button`, `TextInput`, `Select`, `DatePicker`, `Checkbox`, `NumberInput`, `Textarea`, `Switch`, `MultiSelect`, `Radio`, `Autocomplete` anywhere under `emr/components/{viewer,liver,upload,report,admin,onboarding,compliance,ops,erasure,nav}/**`. Use the EMR wrapper.

**ALLOWED exceptions**: only inside `emr/components/{common,shared}/**` (the wrappers themselves).

**CI enforcement**: ESLint rule `liverra/no-raw-mantine-inputs` errors on violations. Must-port targets: full `EMRFormFields/` barrel, `EMRModal`, `EMRButton`, `EMRConfirmationModal`, `StepUpAuthModal`, `SessionTimeoutModal`, `EMRWizardStepper`, `EMRProgressStepper`, `EMRBottomSheet`, `MobileFormWrapper`.

### View state matrix *(Loading / Empty / Error per screen)*

Every route has all three states. Use ported `EMRSkeleton` / `EMREmptyState` / `EMRErrorBoundary` + `EMRErrorCard`.

| Route | Loading | Empty | Error |
|---|---|---|---|
| `/cases` | `EMRTableSkeleton` | `EMREmptyState` + `no-cases.svg` | `EMRErrorCard` + retry |
| `/cases/:id` | `ViewerSkeleton` | n/a (case always exists if route resolves) | `<ViewerErrorBoundary>` |
| `/cases/:id/lesions` | `LesionListSkeleton` | `EMREmptyState` + `no-lesions.svg` | `<AnalysisErrorBoundary>` |
| `/cases/:id/finalize` | `FinalizeWizardSkeleton` | n/a | `<AuditFailClosedBoundary>` on audit-write failure |
| `/admin/users` | `EMRTableSkeleton` | `EMREmptyState` + `no-users.svg` | `<AdminErrorBoundary>` |
| `/admin/audit` | `EMRTableSkeleton` | `EMREmptyState` + `no-audit-events.svg` | `<AdminErrorBoundary>` |
| `/admin/pacs-config` | `FormLoadingSkeleton` | `EMREmptyState` "Not configured" | inline error on C-ECHO fail |
| `/ops/queue` | `EMRTableSkeleton` | `EMREmptyState` + `no-stuck-cases.svg` | `<OpsErrorBoundary>` |
| `/compliance/mbom` | `EMRTableSkeleton` | `EMREmptyState` + `no-mbom.svg` | `<ComplianceErrorBoundary>` |
| `/compliance/audit-summary` | spinner | `EMREmptyState` "No events in window" | chain-break alert panel |
| `/compliance/ruo-spot-check` | spinner | `EMREmptyState` + `no-artifacts.svg` | inline |
| `/compliance/claim-registry` | skeleton | n/a (seeded at tenant creation) | inline |
| `/erasure` | `FormLoadingSkeleton` | `EMREmptyState` + `no-erasure-requests.svg` | inline + audit log |
| `/onboarding/*` | step progress | n/a | step-level recoverable |
| `/help` + `/glossary` | spinner | `EMREmptyState` | inline |
| `/settings/notifications` | `FormLoadingSkeleton` | n/a | inline |
| `/profile` | `FormLoadingSkeleton` | n/a | inline |
| GDPR-erased case direct-link | n/a | `EMREmptyState` + `erased-case.svg` "Not found" (NOT "access denied" — FR-032a) | n/a |

ESLint rule `liverra/require-state-triplet` scans every `*Page.tsx` for Suspense boundary + EmptyState fallback + ErrorBoundary wrap.

### Route registration

**Create** `packages/app/src/emr/constants/routes.ts` exporting typed `LIVERRA_ROUTES` constant (port MediMind's `PATIENT_HUB_ROUTES` pattern). **Create** `packages/app/src/AppRoutes.tsx` with React Router v7 `createBrowserRouter` + `lazy()` per the lazy-loading policy above.

| Path | Route Component | Lazy | Role Guard | Spec ref |
|---|---|---|---|---|
| `/` | `LandingPage` | no | public | — |
| `/auth/callback` | `AuthCallback` | no | public | US7 |
| `/onboarding` | `OnboardingWizard` | yes | any authenticated w/ `ruo_accepted_at IS NULL` | US7 |
| `/cases` | `CasesListView` | no | `study.upload` OR `admin.view_audit` | US1 |
| `/cases/:id` | `AnalysisDetailView` | yes | `study.upload` + tenant match | US1/US2/US3/US4 |
| `/cases/:id/lesions` | `LesionsPanelView` | yes | `study.upload` | US3 |
| `/cases/:id/refine` | `RefinementView` | yes | `review.refine_mask` | US4 |
| `/cases/:id/finalize` | `FinalizeWizard` | yes | `report.finalize` + step-up | US5 |
| `/reports/:id` | `ReportView` | yes | `study.upload` | US5 |
| `/admin/users` | `UserManagementView` | yes | `admin.invite_user` | US6 |
| `/admin/pacs-config` | `PacsConfigView` | yes | `admin.configure_pacs` | US6 |
| `/admin/audit` | `AuditBrowserView` | yes | `admin.view_audit` | US6 |
| `/ops/queue` | `OpsQueueView` | yes | `ops.view_queue` | US8 |
| `/compliance/mbom` | `MBoMView` | yes | `compliance.view_mbom` | US10 |
| `/compliance/audit-summary` | `AuditSummaryView` | yes | `compliance.generate_audit_summary` | US10 |
| `/compliance/ruo-spot-check` | `RUOSpotCheckView` | yes | `compliance.spot_check_ruo` | US10 |
| `/compliance/claim-registry` | `ClaimRegistryView` | yes | `compliance.view_mbom` | US10 |
| `/erasure` | `ErasureRequestList` | yes | `erasure.execute` | US9 |
| `/erasure/new` | `ErasureWizard` | yes | `erasure.execute` + step-up | US9 |
| `/help` | `HelpIndex` | yes | authenticated | FR-045 |
| `/help/glossary` | `GlossaryView` | yes | authenticated | FR-045 |
| `/settings/notifications` | `NotificationPreferences` | no | self | FR-043 |
| `/profile` | `ProfileView` | no | self | — |
| `/demo-case` | `DemoCaseRunner` | yes | any authenticated (sample data only) | FR-042 |

Every non-public route wrapped in ported `<ProtectedRoute requiredPermissions={[...]}>`.

### Navigation port

Port `EMRMainMenu` + `HorizontalSubMenu` verbatim; rebrand labels. Main nav driven by `NavRegistry` indexed by role:

```ts
// emr/constants/nav-registry.ts
{
  hpb_surgeon:  [Upload, MyCases, Help, SignOut],
  radiologist:  [Upload, MyCases, AllCases, Help, SignOut],
  fellow:       [MyCases, Help, SignOut],
  admin:        [Admin.Users, Admin.PacsConfig, Admin.Audit, Help, SignOut],
  ops:          [Ops.Queue, Help, SignOut],
  compliance:   [Compliance.MBoM, Compliance.Audit, Compliance.Spotcheck, Compliance.ClaimRegistry, Help, SignOut],
  dpo:          [Erasure.Requests, Admin.Audit, Help, SignOut],
}
```

Breadcrumbs derive from React Router `useMatches()` + each route's `handle.breadcrumb` function (MediMind pattern). Session-recovery banner reads `SurgeonReview.seat_held_until` (data-model §11) + IndexedDB draft queue.

### Theme port + overlay palette

Port `theme.css` verbatim (preserve `--emr-font-*`, `--emr-spacing-*`, `--emr-bg-*` tokens — they're the EMR library's public CSS API and ported components depend on them), then:

1. Replace MediMind brand gradient with LiverRa gradient (see §Brand Rebrand below).
2. Add **16 new overlay tokens**: `--liverra-seg-couinaud-{I..VIII}` and `-dark` counterparts, `--liverra-lesion-marker` + `-dark`, `--liverra-plane-handle` + `-dark`, `--liverra-overlay-text` + `-dark`, `--liverra-vessel-portal` + `-dark`, `--liverra-vessel-hepatic` + `-dark`.
3. All 8 Couinaud colors MUST pass Coblis simulation for deuteranopia / protanopia / tritanopia in both themes — CI task `ci-palette-cvd-check` runs `chroma-js` simulation against the 8 tokens and blocks on failure.
4. Theme wired via `<html data-mantine-color-scheme={mode}>`, controlled by `ThemeContext` reading `User.theme_preference` (data-model §2) with OS-preference fallback via `matchMedia('(prefers-color-scheme: dark)')`.

### Mobile & touch strategy

**Responsive matrix** artifact (`packages/app/ResponsiveMatrix.md`): `Screen | 390 px | 768 px | 1200 px | Portrait-only? | Landscape-only? | Touch-gesture set`.

**Cornerstone3D touch bindings** in `services/pacs/cornerstoneInit.ts`:

- `ZoomTool → PinchGesture`
- `TrackballRotateTool → TwoFingerRotateGesture`
- `PlanarFreehandROITool → DragGesture` for resection plane
- `ProbeTool → TapGesture` for lesion select

`EMRBottomSheet` for all mobile modal overlays (390 px-friendly). `MobileFormWrapper` wraps every admin + onboarding + erasure form.

CI: Playwright test at 390 × 844 viewport smoke-runs every route; any horizontal scrollbar fails. ESLint rule blocks `fontSize` < 16px inside mobile selectors.

### Accessibility matrix

New artifact **`a11y-matrix.md`** in the feature directory — per-component table:

| Component | Focusable elements | ARIA role | ARIA attributes | Keyboard shortcuts | SR announcement |
|---|---|---|---|---|---|
| `ResectionPlaneSlider` | slider handle | slider | `aria-valuenow/min/max`, `aria-orientation=vertical` | ↑↓ = 1 mm; Shift+↑↓ = 5 mm | FLR% on each stop |
| `LiverViewer3D` | viewport | application | `aria-label` | arrow = rotate; +/- = zoom; L = toggle layers | orientation changes via live region |
| `LesionList` | row, class cell | grid | `aria-rowcount`, `aria-sort` | Up/Down nav; Enter select | `{class} · {Couinaud} · {diameter} · confidence {n}` |
| `FLRPanel` | readout | (none) | `aria-live=polite` on readout | — | FLR% spoken during plane drag |
| `CouinaudLegend` | swatches | (none) | `aria-label` per swatch (name + hex) | — | — |
| `FinalizeWizard` | step markers | list | `aria-current=step` | Tab = next; Shift+Tab = prev | step title spoken |
| `MBoMTable` | row | grid | standard | — | — |

CI: `@axe-core/playwright` runs against every route in light + dark mode; WCAG 2.1 AA violations fail.

### i18n wiring

- Port `TranslationContext.tsx` from MediMind; replace `ka/en/ru` locale set with **`en/de/ka`**.
- Files at `packages/app/src/emr/translations/{en,de,ka}/` organized by namespace: `common`, `auth`, `nav`, `upload`, `analysis`, `lesions`, `refine`, `report`, `admin`, `onboarding`, `compliance`, `ops`, `erasure`, `help`, `glossary`, `errors`, `ruo`. Lazy-loaded on route entry.
- Font loading: `packages/app/index.html` preloads Noto Sans (Latin + Cyrillic + Greek) + **Noto Sans Georgian** via `<link rel="preload" as="font" crossorigin>` with `font-display: swap`. `html[lang='ka']` forces Georgian-fallback stack.
- Fallback chain: `de → en`, `ka → en` (never silent English for known domain — show missing-key placeholder in dev, log to telemetry in prod).
- **CI `ci-i18n`**: `scripts/i18n-check.ts` walks all `t('...')` calls, asserts every key resolves in `{en,de,ka}.json`; missing keys fail. **CI `ci-i18n-visual`**: Playwright screenshot matrix across locales at mobile + desktop; visual diff blocks.
- **Medical-terminology lock**: PRs touching `de.json` / `ka.json` with keys under `glossary.medical.*`, `viewer.*`, or `report.*` require CODEOWNERS approval from designated German HPB specialist (de) / Georgian HPB specialist (ka). Approval captured as AuditEvent at release.
- **RUO disclaimer wording** in de/ka requires DPO + native-speaker joint approval (research §"Decisions still open" item 3).
- **Russian explicitly forbidden**: ESLint rule `liverra/no-russian-locale` bans `ru` keys or `ru.json` files.

### Brand rebrand deliverables

CLAUDE.md: MediMind gradient `linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%)` is a **placeholder**. Before any UI task runs, founder (Dr. Gogichaishvili) + design lead must sign off on:

1. LiverRa primary brand gradient (2 or 3 stops, 135deg)
2. `--emr-primary-50` through `--emr-primary-900` ramp
3. `--emr-accent-*` ramp
4. Logo asset + favicon + PWA icon set

Captured in new artifact `brand-tokens.md` with `status: pending` flag that blocks pilot release until filled. Default brand tokens pending sign-off = placeholder neutral warm-gray ramp (NOT MediMind blue), so `ci-forbidden-colors` lint passes.

### UI critical rules *(CLAUDE.md §Critical Rules — repeated here for visibility)*

- **Flexbox text overflow**: flex children with truncation: `minWidth: 0` + `overflow: 'hidden'` + `textOverflow: 'ellipsis'`. Buttons/badges/pills in flex rows: `flexShrink: 0` + `whiteSpace: 'nowrap'`. `Group` with mixed content: `wrap='wrap'` never `wrap='nowrap'`.
- **Mantine Button padding**: NEVER override `padding` on Mantine Button `root` (breaks internal label height). Use `EMRButton`. If custom Button unavoidable, include `label: { overflow: 'visible', height: 'auto' }`.
- **No `--emr-gray-N` as backgrounds**: use semantic `--emr-bg-page`, `--emr-bg-card` only (Constitution IX).

---

## Monorepo & Guardrails

### Import graph rules

**Allowed**: `app → {core, imaging, fhirtypes}` · `imaging → {core, fhirtypes}` · `fhirtypes → {}` · `core → {}`. Python `ml-inference` is its own world (uv); communicates via OpenAPI contracts only.

**Enforcement**: ESLint `eslint-plugin-boundaries` + `no-restricted-imports` in root `.eslintrc.cjs` (port from MediMind) forbidding reverse edges.

### Turbo pipeline additions (to `turbo.json`)

- `check-types` — per package, `dependsOn: ["^check-types"]`
- `generate:openapi-client` — outputs `packages/app/src/emr/services/api-schema.gen.ts` + `api-client.gen.ts`
- `generate:fhir-types` — outputs to `packages/fhirtypes/src/gen/`
- `generate:permissions` — runs `rbac/generator.py` → `permissions.gen.ts`
- `model-bom` — reads `triton-models/*` + `requirements.txt` → `MBoM.json`
- `license-check` — fails on non-Apache-2.0 drift (FR-038)
- `bundle-analyze` — Vite + rollup-plugin-visualizer report
- `palette-cvd-check` — chroma-js simulation on Couinaud palette
- `i18n-check` — translation-key completeness across en/de/ka
- `rbac:generate` — yaml → Medplum AccessPolicy JSON + Python decorator registry

**Remote cache**: Turbo + self-hosted Turbo remote cache in `eu-central-1` (Constitution VII residency). Vercel remote cache rejected on residency.

### Guardrail lint rules (root ESLint + pre-commit)

- `liverra/no-hardcoded-fhir-url` — regex `http://liverra\.ai/fhir|http://hl7\.org/fhir` outside `emr/constants/fhir-*.ts` = error.
- `liverra/no-hardcoded-color` — any `#[0-9a-f]{3,8}` / `rgb(` / `hsl(` outside `emr/styles/theme.css` + `emr/constants/theme-colors.ts` = error.
- `liverra/no-forbidden-hex` — any of `#3b82f6`, `#60a5fa`, `#2563eb`, `#4267B2` anywhere = error (Constitution IX).
- `liverra/no-russian-locale` — any `ru.json` or `ru/*.json` added = error.
- `liverra/require-emr-button` — `import { Button } from '@mantine/core'` in `emr/**` outside `common/shared/` = error.
- `liverra/no-raw-mantine-inputs` — direct `@mantine/core` form primitives in `emr/components/{viewer,liver,upload,report,admin,onboarding,compliance,ops,erasure,nav}/**` = error.
- `liverra/no-any-without-justification` — `: any` or `as any` without adjacent `// eslint-disable-next-line` + `TODO|HACK` reason = error.
- `liverra/no-bulk-regex-touch` — pre-commit hook rejects a commit touching >3 files with identical line-level diff (Constitution §No Bulk File Edits, MediMind incident).
- `liverra/no-hardcoded-font-size` — numeric `font-size` in `.tsx`/`.module.css` outside `theme.css` = error.
- `liverra/mantine-button-padding-check` — direct-Mantine-Button files with `padding` overrides = warn.
- `liverra/require-state-triplet` — every `*Page.tsx` missing Suspense / EmptyState / ErrorBoundary wrap = error.

### Health aggregator

`/api/v1/system/health` — aggregate of 5 deps. JSON shape:

```ts
{
  status: 'ok' | 'degraded' | 'down',
  dependencies: {
    postgres: 'ok' | 'down',
    redis: 'ok' | 'down',
    triton: 'ok' | 'warming' | 'down',
    medplum: 'ok' | 'degraded' | 'down',
    orthanc: 'ok' | 'down',
    pacs: Record<tenant, 'ok' | 'unreachable'>,
  },
  tripwires: string[],
  gpu: { loaded_models: string[], idle_since: string | null, predicted_warm_s: number | null }
}
```

State machine:

- Postgres `down` → `down` (nothing works)
- Redis `down` → `down` (Celery queue offline)
- Medplum `down` → `degraded` (new AuditEvents queued in outbox; chain-break tripwire fires if queue age > N min)
- Triton unloaded (cold) → `degraded` with ETA (auto-start invoked)
- Orthanc unreachable → `degraded` (can't ingest; existing cases viewable)

Ops dashboard (US8) binds directly to this endpoint; Grafana `liverra-health` dashboard visualizes.

---

## Testing Strategy

### E2E (Playwright) — 30 addressable scenarios

File layout: `packages/app/src/emr/views/__e2e__/liver-ai-pipeline/` — one file per user story:

| File | Scenarios | Fixture type | Parallelizable | SC mapping |
|---|---|---|---|---|
| `test-us1-upload-flr.ts` | happy / failure / edge | GPU fixture CT × 1 | no (GPU serial) | SC-002 |
| `test-us2-couinaud.ts` | happy / failure / edge | derived-mask stub (CPU) | yes | SC-004 |
| `test-us3-lesions.ts` | happy / failure / edge | derived-mask stub (CPU) | yes | SC-005 |
| `test-us4-refinement.ts` | happy / failure / edge | GPU fixture CT × 1 | no (GPU serial) | SC-006 |
| `test-us5-export.ts` | happy / failure / edge | derived-mask stub + fake PACS | yes | SC-009 |
| `test-us6-admin-onboarding.ts` | happy / failure / edge | fresh tenant per test | yes | SC-007 |
| `test-us7-clinician-onboarding.ts` | happy / failure / edge | fresh user per test | yes | SC-014 |
| `test-us8-ops-stuck-case.ts` | happy / failure / edge | failure-injection fixture | no (shared queue) | SC-010 |
| `test-us9-gdpr-erasure.ts` | happy / failure / edge | disposable tenant | yes | SC-016 |
| `test-us10-compliance.ts` | happy / failure / edge | pre-seeded audit chain | yes | SC-010 + SC-015 |

Shared helpers in `__e2e__/liver-ai-pipeline/helpers.ts`: tenant seeding, demo-case mount, MFA-bypass token for test tenant only, GPU-fixture-server URL resolver. Fixture CT volumes: `packages/ml-inference/tests/regression/fixtures/` mounted read-only into the E2E stack.

**CI lanes**:

- `ci-e2e-cpu` (blocking on PRs to main): 27 CPU-parallelizable scenarios
- `ci-e2e-gpu` (blocking on `release/*`; nightly on main): 3 GPU-serial scenarios against warmed Triton container

### ML regression gate (golden-case CT volumes)

Location: `packages/ml-inference/tests/regression/` · Fixtures: `fixtures/ct-001..005/` · Thresholds: `thresholds.yaml`.

| Stage | Metric | Threshold | Fixtures |
|---|---|---|---|
| STU-Net parenchyma | Dice (liver vs GT) | ≥ 0.92 | ct-001..005 |
| STU-Net lesions | Dice + sens ≥10 mm | ≥ 0.65 Dice, ≥ 0.78 sens | ct-001..004 |
| Pictorial Couinaud | mean IoU per segment | ≥ 0.70 | ct-001..003 |
| LiLNet classification | Top-1 acc on 6 classes | ≥ 0.82 | ct-lesions-labeled-pack |
| VISTA3D refine | Δ-Dice after 3 clicks | ≥ +0.05 over baseline | ct-002 |
| MedSAM-2 track | IoU slice-to-slice | ≥ 0.85 | ct-003 |

- Runner: `pytest tests/regression/test_stage_regression.py -m regression`
- Every threshold row references an `mbom_version`; runner refuses to execute if MBoM mismatches → forces explicit re-approval on weight swap.
- CI job `ci-ml-regression` on every PR touching `triton-models/**` or `orchestrator/**`, plus nightly.
- Threshold lowering requires spec amendment + second reviewer (Constitution Code Review for security-sensitive changes extended to clinical-safety).
- SC binding: SC-003 (FLR ±5%), SC-004 (Couinaud surgically usable), SC-005 (lesion sens ≥78% @ ≥10 mm).

### Contract tests

- **OpenAPI**: `schemathesis run contracts/api-openapi.yaml --base-url=http://localhost:8000 --hypothesis-max-examples=50 --checks=all --junit-xml=contract-results.xml`. PR trigger on `api/**` or `contracts/api-openapi.yaml`. Ephemeral dev stack (`deploy/local/docker-compose.yml`) with Triton stubbed. Fuzz budget: 50/endpoint on PR (~5 min); 500/endpoint nightly. Failures → auto-labeled `contract-drift` GitHub issues.
- **Triton stage I/O**: `pytest packages/ml-inference/tests/contracts/test_triton_stage_shapes.py` — loads each model, submits synthetic-shaped payload, asserts dtype/shape/axis-order matches `contracts/triton-stages.md`. Blocking on PRs touching `triton-models/**`.
- **DICOM-SEG / DICOM-SR**: golden-file diff of a fixture finalization against `contracts/dicom-artifacts.md` expected fields (SNOMED codes, algorithm ID, RUO disclaimer presence).

### Unit tests — per-package coverage floor

| Package | Floor | Tool | CI job |
|---|---|---|---|
| `packages/core` | 90% lines, 85% branches | vitest + c8 | `ci-unit-ts` |
| `packages/fhirtypes` | 90% lines | vitest + c8 | `ci-unit-ts` |
| `packages/imaging` | 85% lines | vitest + c8 | `ci-unit-ts` |
| `packages/ml-inference` | 85% lines (constitution ≥80%) | pytest + coverage.py | `ci-unit-py` |
| `packages/app` | 75% lines (non-presentational) | vitest + c8 | `ci-unit-ts` |

Coverage floors CI-blocking (PR coverage-diff; floor hard-checked nightly).

**Mandatory security-critical suites** (not just coverage quota):

- `packages/ml-inference/src/services/audit/tests/test_chain_of_hashes.py` — tamper detection at start / middle / end positions
- `packages/ml-inference/src/services/anon/tests/test_presidio_fixtures.py` — 10 FP + 10 FN (wrong-language names, UID-like IDs, Cyrillic/Mkhedruli/German diacritics)
- `packages/ml-inference/src/services/export/tests/test_pdf_watermark.py` — WeasyPrint render + OCR extract, assert "Research Use Only" on every page
- `packages/ml-inference/src/services/erasure/tests/test_crypto_shred.py` — mock KMS, assert `ScheduleKeyDeletion` + p99 <60 s over 100 iterations
- `packages/app/src/emr/hooks/__tests__/useReviewSeat.test.ts` — concurrent-edit collision returns merge-UI state
- `packages/imaging/src/__tests__/watermark.test.ts` — canvas burn-in via jsdom-canvas or headless Chromium screenshot diff
- `packages/app/src/emr/components/compliance/__tests__/AuditChainVerifier.test.tsx` — synthetic corrupted chains; UI highlights first invalid event
- `packages/ml-inference/tests/security/test_require_permission_decorator.py` — honors step-up + tenant scope
- `packages/ml-inference/tests/security/test_phi_scrubber_fail_closed.py` — scrubber failure drops event, counter increments

### FHIR integration tests

- **Python** against ephemeral Medplum: `packages/ml-inference/tests/integration/fhir/`
- **TypeScript** against `@medplum/mock` MockClient: `packages/app/src/emr/services/__tests__/fhir-integration.test.ts` (port MediMind's `test-utils.tsx` pattern)

**Required roundtrip tests**:

- AuditEvent create → chain-of-hashes writer reads → recomputes hash → asserts linearity with previous event in same tenant
- Bundle transaction for reviewer-edits batch save: N segmentation edits + 1 addendum in one transaction; failure of any entry rolls all back (FR-017b)
- Search-parameter coverage: tenant scoping (search in tenant A returns 0 hits for tenant B resource even with known resource ID); 404 existence non-disclosure (search for other tenant's ImagingStudy by UID returns empty Bundle, indistinguishable from "doesn't exist"); FR-032a unguessable-ID + tenant-scoped AccessPolicy verified
- AccessPolicy per role × tenant: load RBAC generator output, assert each role's Medplum AccessPolicy matches `rbac_matrix.yaml` intent
- Extension URL integrity: every LiverRa extension round-trips through Medplum without URL rewriting
- CI job: `ci-fhir-integration` blocking on PRs touching FHIR code or `rbac_matrix.yaml`

### RBAC red-team test (SC-015)

Test: `packages/ml-inference/tests/rbac/test_role_crossing.py` — parametrized on cartesian product of (role, permission) loaded from `rbac_matrix.yaml` (generator is authoritative; test consumes generated output).

For every (role, permission) pair NOT granted:

- HTTP status **404** (FR-032a — NOT 403)
- RFC 7807 `type: liverra:not-found` (NOT `liverra:forbidden`)
- AuditEvent written with `outcome: minor-failure` + `rbac.denied=true` tag
- No PHI in error body

**15 canonical "named" role-crossing actions** per SC-015 in `tests/rbac/fixtures/role_crossing_catalog.yaml`:

1. `fellow_finalize` — fellow attempts report.finalize
2. `admin_view_phi` — admin attempts to read clinical content
3. `ops_view_phi` — ops attempts to read clinical content
4. `clinician_execute_erasure` — any clinician attempts GDPR erasure
5. `radiologist_approve_deletion` — non-admin attempts case-deletion approval
6. `compliance_modify_claim_registry_unauth` — compliance toggle without step-up
7. `cross_tenant_study_access` — user tenant A reads study tenant B
8. `cross_tenant_report_access` — user tenant A reads report tenant B
9. `cross_tenant_audit_access` — user tenant A reads audit tenant B
10. `deep_link_across_tenants` — shared link from tenant A opened by user of tenant B
11. `unguessable_id_brute_force` — sequential ID scan
12. `step_up_bypass_finalize` — finalize without fresh MFA
13. `step_up_bypass_erasure` — erasure without fresh MFA
14. `suspended_user_login` — suspended Cognito user attempts sign-in
15. `tenant_idp_impersonation` — SAML assertion with wrong `custom:tenant_id`

CI job `ci-rbac-red-team` blocking on every PR. When `rbac_matrix.yaml` changes, test auto-picks up new pairs.

### Frontend permission enforcement (double-sided with SC-015)

Per role, E2E test asserts: for every permission NOT granted, corresponding UI control is NOT visible AND direct URL navigation lands on 404. Paired with server-side `ci-rbac-red-team` gives double-sided enforcement.

### Load & performance

- **Lighthouse CI** (`ci-lighthouse`): LCP ≤ 2.5 s, TBT ≤ 300 ms, CLS ≤ 0.1, TTI ≤ 4 s on `/cases`, `/cases/:demo`, `/admin/users`. PR-blocking.
- **k6 API load** (`ci-k6-nightly`): 3 tenants × 5 users × 5 studies/week concurrent on staging; p95 end-to-end ≤ 300 s (SC-002); p99 ≤ 600 s; FLR compute p95 ≤ 1 s (FR-013).
- **GPU load** (`ci-gpu-load`): 3 concurrent studies on L4 24 GB; queue depth ≤ 3, no OOM, VRAM peak ≤ 23.5 GB (research C.1 working set).
- **Viewer FPS** (`ci-viewer-fps`): Playwright + CDP records fps while rotating 3D view; sustained ≥ 30 fps desktop, ≥ 20 fps tablet (NFR-001).
- **Slice-scroll latency**: Playwright-measured keydown-to-paint ≤ 100 ms p95.

### Security scanning

| Scan | Tool | Trigger | Block |
|---|---|---|---|
| DAST | OWASP ZAP baseline vs staging | nightly + release | ≥1 High fail, Medium alert |
| SCA (JS) | `npm audit --audit-level=high` + Dependabot | every PR | High/Critical fail |
| SCA (Py) | `pip-audit` + Dependabot | every PR | High/Critical fail |
| Secret scan | `gitleaks` pre-commit + CI | every commit | any finding fail |
| Container scan | `trivy image` + `trivy config` | every image build | High/Critical OS/config fail |
| SAST (TS) | ESLint security + `semgrep --config p/typescript` | every PR | High fail |
| SAST (Py) | `bandit` + `semgrep --config p/python` | every PR | High fail |
| TLS check | `testssl.sh` against public endpoints | weekly + release | <TLS 1.3 or weak ciphers fail |

All scan results archived to `ci-security-results` S3 bucket with 6-yr retention for audit re-inspection.

---

## Error Handling & Resilience

### Server-side (RFC 7807 Problem Details)

Every FastAPI error path emits `application/problem+json`:

```json
{
  "type": "https://liverra.ai/errors/{slug}",
  "title": "Short summary",
  "status": 404,
  "detail": "PHI-scrubbed explanation",
  "instance": "audit-event-uuid",
  "tenant_id": "uuid",
  "claim_key": "optional"
}
```

**15+ canonical slugs** registered in `packages/ml-inference/src/services/errors/catalog.py`:

`not-found`, `forbidden` (internal only — externally rendered as `not-found`), `validation`, `step-up-required`, `seat-taken`, `analysis-expired`, `analysis-failed`, `analysis-timeout`, `analysis-implausible-output`, `pacs-unreachable`, `pacs-rejected`, `ruo-acceptance-required`, `license-hash-drift`, `audit-write-failed`, `scrubber-failed`, `erasure-in-progress`, `erasure-mfa-stale`.

### Frontend error hierarchy

- `GlobalErrorBoundary` at app root — render crashes → Sentry (PHI-scrubbed) → branded fallback with error reference code.
- `FeatureErrorBoundary` wrapping each route group (upload / viewer / admin / ops / compliance / erasure).
- Typed error handler in `errorClient.ts` axios interceptor maps HTTP → UX:
  - **401** → step-up modal via OIDC `prompt=login max_age=0`, replays failed request after refresh.
  - **403** → "You do not have permission" with link to request access from admin.
  - **404** → rendered as "Not found" per FR-032a — **NEVER hints at cross-tenant existence**.
  - **409** (reviewer-seat conflict) → merge/takeover modal.
  - **410** (analysis erased) → "This case is no longer available."
  - **422** (validation) → inline field errors from `detail.errors[]`.
  - **429** → exponential back-off toast.
  - **5xx** → retry-with-backoff banner; after 3 failures, escalate to user-actionable incident reference.
- Reads retry automatically (TanStack Query jittered exponential backoff 100 ms → 6.4 s, max 6 attempts).
- Write failures → enqueue to IndexedDB `offline_reviewer_edits`; toast "Saved locally, will sync when online".
- All error UX strings translated en/de/ka; tested per §i18n CI.

### Offline reviewer-edit durability (FR-018c)

**IndexedDB schema** (db `liverra-offline`, v1):

- Store `offline_reviewer_edits`: `{ id (ULID), analysis_id, edit_type: 'refine'|'reprompt'|'classify'|'plane', payload, created_at, client_version, attempt_count, last_error }`, indexed on `(analysis_id, created_at)`.
- Store `offline_metadata`: `{ analysis_id, last_server_version, last_sync_at }`.

**Sync worker**: plain-JS periodic flush every 15 s when online + immediate on `online` event (no service worker in v1). Uses ULID-ordered queue + axios client's 401 step-up path. On success → remove entry + bump `last_server_version`. On 409 → `ConflictResolutionModal` (keep-mine / keep-theirs / manual-merge); conflicting entries retained with status `needs-user`.

**Conflict resolution**: server wins by default. If server `last_modified_version` > local `last_server_version`, sync worker pauses queue for that analysis and opens modal. User's choice audited.

**Health indicator**: `SyncIndicator` in top bar (online/offline/syncing/queue-depth). Click shows pending entries with per-entry retry or discard.

**Tests**: unit (conflictResolver), integration (sync worker against MockClient with induced 409s), E2E (test-us4 edge scenario exercises induced offline → reconnect → auto-sync).

### Permission-gate frontend enforcement

See §Frontend RBAC wiring above.

---

## Observability Event Catalogue

### PostHog product events (anonymous; EU-hosted)

Super-properties: `tenant_id`, `user_role`, `locale`. **Never** `user_email`, `patient_*`, `mrn`, `study_uid`.

- `onboarding_step_started` / `onboarding_step_completed` `{step: password|mfa|ruo|tour|sample}` → **SC-014 funnel**
- `demo_case_run_started` / `demo_case_run_completed` → **SC-013**
- `analysis_upload_started` / `analysis_completed` `{duration_s, stage_breakdown}` → **SC-002**
- `refinement_click` `{stage, accepted_latency_s}` → **SC-006**
- `report_finalized` `{duration_since_upload_s}` → SC-002 tail
- `ruo_spot_check_completed` `{artifacts_reviewed, misses}` → **SC-009**

### Sentry captures (EU tenant, PHI-scrubbed)

- Every uncaught exception (server + client) via PHI-scrubbing `before_send`.
- Dedicated counter `phi_scrubber_failed_total` — non-zero → PagerDuty + release block.
- Dedicated counter `audit_chain_fail_closed_total` — non-zero = P1.

### Grafana dashboards (EU-hosted; dashboards-as-code in `deploy/grafana/dashboards/`)

- `liverra-queue` — queue depth by tenant, cold-start occurrences, stuck cases >15 min
- `liverra-latency` — p50/p95 per stage (stu-net/couinaud/lilnet/vista3d/medsam2), end-to-end p50/p95
- `liverra-gpu` — utilization %, VRAM, Tier-A vs Tier-B residency
- `liverra-errors` — errors by stage, PACS push retry counts, scrubber fails
- `liverra-users` — active users per tenant (24 h rolling)
- `liverra-audit-chain` — binary panel: chain valid / broken for last 24 h per tenant
- `liverra-cost` — monthly spend vs NFR-008 envelope; 70% + 90% alarm state
- `liverra-health` — binds `/system/health` state machine output

### OpenTelemetry traces

One span per Celery stage (`stage.stu-net`, `stage.couinaud`, …), parent span `pipeline.analysis`. Each span attribute links to its `AuditEvent.id`. Exported to Grafana Tempo EU.

### Alerts (PagerDuty EU)

- Queue depth >5 for any tenant for 10 min
- PACS push retry >3 on same report
- GPU cold-start rate >1/h
- `phi_scrubber_failed_total` >0
- Audit chain break detected
- Monthly cost projection >90% envelope

---

## DR & Ops Drills

- `ci-dr-drill` **monthly scheduled**: runs `scripts/dr-restore-dryrun.sh` against sandbox VPC from latest Postgres PITR + S3 snapshot; asserts RTO <8 h + restored AuditEvent chain verifies; posts result to status page + Slack.
- `ci-erasure-simulation` **weekly**: runs `scripts/gdpr-erasure-sim.sh` against fixture tenant; asserts ≤60 s SC-016 threshold.
- Release **blocked** if most recent `ci-dr-drill` older than 90 days (NFR-009 annual exercise operationalized with margin).
- **Breach-notification tabletop**: annual, documented in `docs/runbooks/breach-tabletop-YYYY.md`; absence of current year's entry blocks the annual release tag.

---

## Production-Readiness Matrix

The user asked: "make sure everything is well tested, interconnected, and fully production ready when built." This table is the answer. Every Success Criterion from spec §Success Criteria is bound to a test type, a CI job, and a blocking threshold. A release tag cannot be cut until every row is green.

| SC | Claim | Test type | CI job | Blocking threshold |
|---|---|---|---|---|
| SC-001 | 20-scan zero-crashes | E2E + regression + manual | `ci-pilot-validation` (pre-go-live) | 0 crashes across 20 scans |
| SC-002 | ≥95% ≤5 min on warm infra | k6 load + regression | `ci-k6-nightly` | p95 e2e ≤ 300 s |
| SC-003 | FLR ±5% vs expert | ML regression | `ci-ml-regression` | mean abs error ≤ 5% on ct-001..005 |
| SC-004 | Couinaud "surgically usable" ≥80% | ML regression + human panel | `ci-ml-regression` + offline | mean IoU ≥ 0.70 + manual sign-off |
| SC-005 | Lesion sens ≥78% @ ≥10 mm | ML regression | `ci-ml-regression` | sens ≥ 0.78 |
| SC-006 | Refinement ≥50% time reduction | E2E timing + user study | `test-us4-refinement` + offline | p50 refine-accept ≤ 0.5 × baseline |
| SC-007 | 3 DPAs + MFA-active users | Manual checklist | `ci-go-live-gate` | signed docs + MFA enrol event exists |
| SC-008 | ≥1 real tumor-board case | Manual | n/a | recorded AuditEvent |
| SC-009 | RUO on every artifact | Visual-diff + unit + OCR | `ci-ruo-watermark` | 0/20 spot-check misses; pixel-diff passes |
| SC-010 | AuditEvent + chain valid | Integration + chain verifier | `ci-audit-chain` | zero gaps + `verify-chain.py` exit 0 |
| SC-011 | Conference abstract submitted | Manual | n/a | submission receipt |
| SC-012 | Cost €800–1,500/mo | CloudWatch alarm | `ci-cost-budget` monthly | alarm silent at 70% + 90% |
| SC-013 | 5-min uninterrupted demo | Scripted E2E + screen record | `test-demo-record` | video succeeds without errors |
| SC-014 | ≤15 min onboarding, ≥80% first-invite completion | E2E + PostHog funnel | `test-us7` + `ci-analytics-check` | funnel ≥ 80% |
| SC-015 | 15 role-crossing actions, 0 success | RBAC fuzz | `ci-rbac-red-team` | 15/15 return 404 |
| SC-016 | Erasure ≤60 s, 404 afterward | E2E + integration | `test-us9` + erasure integration | p99 ≤ 60 s + assertion 404 |

Every SC has an owner, a test artifact, and a named CI job that must be green before a release tag. Live-tracking dashboard at `docs/runbooks/readiness-matrix.md`, regenerated from CI artifacts nightly.

---

## Complexity Tracking

> Empty — Constitution Check gate passed with no violations to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | *(none)*   | *(none)*                            |

---

## Post-Design Constitution Re-check *(Phase 1 complete — 2026-04-19)*

All ten principles re-evaluated against the **actual design** produced in `research.md` + `data-model.md` + `contracts/`. No violations; Complexity Tracking remains empty.

| # | Principle | Design evidence | Outcome |
|---|-----------|-----------------|---------|
| I | Spec-Driven Development | `spec.md` v2 + `plan.md` this file + `research.md` + `data-model.md` + `contracts/` all present; `tasks.md` will be generated next via `/speckit.tasks` | PASS |
| II | Apache 2.0 Model Licensing | `ModelBillOfMaterials` entity (data-model §16) + build-time license-hash drift check (research C.8) + FR-038 enforcement | PASS |
| III | Cascaded Inference Architecture | Triton priority-tier loading (research C.1) explicitly rejects ensemble model; `PipelineCheckpoint` per-stage (data-model §6); `triton-stages.md` declares 6 independent stage contracts | PASS |
| IV | FHIR-First Healthcare Data | Medplum self-hosted (research A.2); `AuditEvent` Medplum-managed with LiverRa extension URLs at `http://liverra.ai/fhir/StructureDefinition/*` (data-model §14); `packages/app/src/emr/constants/fhir-systems.ts` is the sole URL source | PASS |
| V | Auditability & Regulatory Traceability | Per-tenant SHA-256 chain + daily Merkle root to S3 Object Lock (research A.3); `AuditEventChain` schema (data-model §14); chain-fail-closed triggers; MBoM binding to every audit event (research X.4) | PASS |
| VI | Research Use Only Until CE Mark | 5-layer pixel-burn watermark (research B.7); `RegulatoryClaimRegistry` per-claim lifecycle (data-model §17); SEG+SR RUO disclaimers (`dicom-artifacts.md`); UI `x-step-up` on retract/finalize | PASS |
| VII | Security, Privacy & Data Residency | Cognito `eu-central-1` (research A.1); Medplum + RDS + Elasticache + S3 all in Frankfurt (research A.2/A.7); per-case KMS crypto-shred (research X.1); tenant isolation at Medplum Project + Postgres RLS (data-model); existence-disclosure 404s via Medplum AccessPolicy + FastAPI middleware (research A.4) | PASS |
| VIII | Type Safety & Strict Mode | TypeScript strict in all `packages/*` (plan Technical Context); Python `mypy --strict` + Pydantic v2 at FastAPI boundary; OpenAPI 3.1 schema validation via `schemathesis` in CI (contracts/README.md) | PASS |
| IX | Unified Design System | theme.css + EMR component library port from MediMind (plan Project Structure); mobile-first + 44×44 tap targets + dark mode verified (NFR-002/004/005); all UI work routed via `frontend-designer` agent (quickstart §"Port a MediMind component") | PASS |
| X | Internationalization | Translation files `{en,de,ka}.json` (Tenant entity `primary_locale`; User `locale_preference`); WeasyPrint Noto Sans + Noto Sans Georgian embedded (research B.8); Jinja2 email templates per locale (research A.5); Russian explicitly out of scope (NFR-003) | PASS |

**Gate outcome: PASS.** No Complexity Tracking entries required. Ready for `/speckit.tasks`.

### Phase 1 artifacts produced

- [`research.md`](./research.md) — consolidated index of 22+ resolved unknowns across 3 parallel research agents + cross-cutting merge layer
- [`.research/A-platform-backbone.md`](./.research/A-platform-backbone.md) — 3,000-word detail on auth / FHIR / audit / RBAC / email / observability / DR
- [`.research/B-imaging-pipeline.md`](./.research/B-imaging-pipeline.md) — 2,900-word detail on anonymization / Orthanc / DICOM-SEG-SR / PACS push / RUO watermark / Unicode
- [`.research/C-ml-viewer.md`](./.research/C-ml-viewer.md) — 2,900-word detail on Triton VRAM budget / cascade orchestration / viewer strategy / resection plane / refinement UX / sanity / MLflow
- [`data-model.md`](./data-model.md) — 21 entities (18 from spec + 3 cross-cutting) with fields, FKs, FHIR projections, RLS, state machines, invariants
- [`contracts/README.md`](./contracts/README.md) — index + design choices
- [`contracts/api-openapi.yaml`](./contracts/api-openapi.yaml) — single OpenAPI 3.1 document with 11 tags (`auth`, `ingest`, `analysis`, `review`, `export`, `admin`, `onboarding`, `ops`, `compliance`, `erasure`, `system`) and ~30 endpoints
- [`contracts/triton-stages.md`](./contracts/triton-stages.md) — 6 Triton model I/O contracts (STU-Net ×2, Couinaud, LiLNet, VISTA3D, MedSAM-2) with tensor shapes, dtypes, sanity gates, timeouts
- [`contracts/dicom-artifacts.md`](./contracts/dicom-artifacts.md) — DICOM-SEG MULTI_SEGMENT_BINARY + DICOM-SR TID 1500 wire contracts with SNOMED-CT codes, algorithm identification, RUO disclosure
- [`quickstart.md`](./quickstart.md) — developer bootstrap (clone → demo case → first PR) + Constitution compliance checklist

### Next step

Run `/speckit.tasks` to break this plan into dependency-ordered, parallelizable implementation tasks.
