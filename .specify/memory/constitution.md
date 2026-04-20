<!--
SYNC IMPACT REPORT
==================
Version Change: 1.1.0 → 2.0.0
Rationale: MAJOR — Project identity redefined from Medplum MediMind (EHR platform) to
LiverRa (AI-powered liver diagnostics & surgical planning SaMD). Principles rewritten
for medical imaging AI, regulatory compliance (CE MDR Class IIb), and spec-driven
development. Previous MediMind-specific principles removed or redefined.

Modified Principles (MediMind v1.1.0 → LiverRa v2.0.0):
  - I. FHIR-First Architecture → IV. FHIR-First Healthcare Data (rebranded URLs, narrowed scope)
  - II. Package-Based Modularity → absorbed into III. Cascaded Inference Architecture (new)
  - III. Test-First Development → retained implicitly via Spec-Driven Development (I)
  - IV. Type Safety & Strict Mode → VIII. Type Safety & Strict Mode (retained)
  - V. Security & Compliance by Default → VII. Security, Privacy & Data Residency (GDPR focus)
  - VI. Build Order & Dependency Management → removed (Turborepo handles; no longer constitutional)
  - VII. Observability & Debugging → absorbed into V. Auditability & Regulatory Traceability
  - VIII. Unified Design System → IX. Unified Design System (rebranded, LiverRa gradient TBD)
  - IX. Internationalization & Localization → X. Internationalization (DACH-first: EN/DE/KA)

Added Principles:
  - I. Spec-Driven Development (NON-NEGOTIABLE) — enforces Speckit workflow for audit traceability
  - II. Apache 2.0 Model Licensing (NON-NEGOTIABLE) — forbids GPL/AGPL/CC-NC/commercial-restricted ML models
  - III. Cascaded Inference Architecture — zero-training v1 pipeline discipline
  - V. Auditability & Regulatory Traceability — every ML run + DICOM txn + PHI touch logged
  - VI. Research Use Only Until CE Mark — RUO disclaimer mandatory on AI outputs until CE MDR clearance

Removed Sections:
  - HIPAA-primary framing → replaced with GDPR-primary (DACH is primary market)
  - Package build order — no longer constitutional (tooling concern)

Added Sections:
  - Model Licensing & Data Provenance (new healthcare/compliance subsection)
  - Regulatory Pathway (CE MDR Class IIb → FDA 510(k))
  - Spec-Driven Workflow Gate (replaces ad-hoc code review requirements)

Templates Status:
  ✅ .specify/templates/plan-template.md — generic "Constitution Check" gate references this file, no changes needed
  ✅ .specify/templates/spec-template.md — generic requirements structure, no changes needed
  ✅ .specify/templates/tasks-template.md — generic task categories, no changes needed
  ✅ .specify/templates/checklist-template.md — generic quality dimensions, no changes needed
  ✅ .specify/templates/constitution-template.md — unchanged (upstream Speckit template)
  ⚠ CLAUDE.md (repo root) — already aligned with LiverRa (no action required, but principles here
    are the source of truth; CLAUDE.md is operational guidance)

Deferred Placeholders:
  - None. Primary brand gradient is noted as "TBD in future amendment" in Principle IX but
    does not block ratification; tracked as follow-up rather than a constitution placeholder.

Follow-up TODOs:
  - Define LiverRa primary UI gradient and amend Principle IX (patch bump).
  - When FHIR server selection is finalized (Medplum cloud vs. self-hosted), amend Principle IV
    if the base URL convention changes.
-->

# LiverRa Constitution

## Core Principles

### I. Spec-Driven Development (NON-NEGOTIABLE)

No application code, ML model integration, or infrastructure change MAY be written without
a corresponding spec artifact generated via the Speckit workflow:
`/speckit.constitution` → `/speckit.specify` → `/speckit.clarify` (if needed) →
`/speckit.plan` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`.

Every feature MUST produce `specs/NNN-feature/spec.md`, `plan.md`, `tasks.md`, and any
referenced `contracts/` + `data-model.md` artifacts. Hotfixes smaller than 20 lines MAY
skip the full cycle but MUST be retroactively documented in the nearest active spec.

**Rationale**: CE MDR Class IIb and FDA 510(k) audits demand traceable design history.
Spec artifacts ARE the audit trail — skipping them creates regulatory debt that is
expensive or impossible to reconstruct later.

### II. Apache 2.0 Model Licensing (NON-NEGOTIABLE)

Every ML model integrated into a commercially shipped LiverRa build MUST be released under
Apache 2.0 (or a functionally equivalent permissive license explicitly approved by the
project maintainers). The v1 stack is curated for this: STU-Net, LiLNet, VISTA3D, MedSAM-2,
and Pictorial Couinaud.

**Forbidden for commercial integration:** GPL, AGPL, CC-BY-NC, CC-BY-SA, research-only
licenses, models with paid commercial tiers (e.g., TotalSegmentator specialized sub-modules),
and training datasets that restrict commercial weight derivation (LiTS17, MSD Task 8,
3D-IRCADb, CHAOS, HCC-TACE-Seg, LLD-MMRI — these MAY be used for evaluation/benchmarking only).

**Allowed for training commercial weights:** proprietary data under signed DPAs, AMOS22
(CC BY 4.0), CRLM-CT-Seg (pending per-release verification), and Apache 2.0 pretrained
weights as fine-tuning starting points.

Every model integration PR MUST include a license verification note in the spec's
`research.md` or a dedicated licensing row in the Dataset/Model Bill of Materials.

**Rationale**: One GPL-infected weight can force open-sourcing the entire product or
trigger a costly retraining cycle mid-regulatory-submission. License discipline is
cheap at write time and ruinously expensive to retrofit.

### III. Cascaded Inference Architecture

LiverRa v1 MUST implement a cascaded pipeline of pretrained models — NOT an end-to-end
bespoke model. The v1 cascade: **STU-Net** (parenchyma + metastases) → **Pictorial
Couinaud** (8-segment topology) → **LiLNet** (6-class tumor classification) → **VISTA3D**
(interactive refinement) → **MedSAM-2** (zero-shot 3D tracking).

Each stage MUST:
- Expose its input/output as versioned, schema-validated contracts (DICOM or NIfTI).
- Run as an independently deployable Triton model or FastAPI endpoint.
- Emit stage-level telemetry (latency, failure mode, confidence) for audit logs.

End-to-end training of a proprietary monolithic model is explicitly out of v1 scope.
Custom fine-tuning MAY occur only after v1 ships and MUST start from an Apache 2.0
pretrained checkpoint (see Principle II).

**Rationale**: Cascaded architecture is auditable stage-by-stage, lets us swap any
component without retraining the whole system, and dramatically shortens regulatory
documentation versus defending a single black-box model.

### IV. FHIR-First Healthcare Data

All structured clinical data MUST conform to FHIR R4. TypeScript packages MUST use
generated types from `packages/fhirtypes`. Python services interacting with clinical
data MUST validate against FHIR R4 schema at boundaries.

LiverRa-specific FHIR conventions:
- **Base URL**: `http://liverra.ai/fhir`
- **Extension pattern**: `http://liverra.ai/fhir/StructureDefinition/[name]`
- Identifier systems and extension URLs MUST live in
  `packages/app/src/emr/constants/fhir-systems.ts` — hardcoded URL strings are forbidden.
- FHIR references MUST include the `reference` field (display-only is invalid).
- Search parameter prefixes (`ge`, `le`, `gt`, `lt`) MUST be placed on the value, not the key.
- `ImagingStudy`, `Observation`, `DiagnosticReport`, `AuditEvent`, and `Patient` are
  the canonical resource vocabulary for v1; new resource types require spec justification.

**Rationale**: FHIR is the only interoperability language DACH hospital IT will
integrate against. Non-FHIR data shapes create integration rewrites downstream.

### V. Auditability & Regulatory Traceability

Every ML inference run, DICOM transaction, and patient-data touchpoint MUST produce a
FHIR `AuditEvent` with at minimum: input hash (SHA-256), model identifier + version,
output hash, timestamp, actor (user/service), and study UID where applicable. PHI
exposure in logs MUST be minimized — no patient names, no free-text identifiers.

Model weights MUST be tracked via MLflow + DVC. Training datasets MUST be documented
in a Dataset Bill of Materials (DBoM) including license, source, ethics approval, and
date of acquisition. Every model release MUST produce a Model Card.

**Rationale**: Regulators will audit three years after submission. The question is not
"did we act correctly" but "can we prove it". Logging at write time is 100× cheaper
than reconstructing it under audit.

### VI. Research Use Only Until CE Mark

Until CE MDR Class IIb clearance is granted for a given clinical claim, every AI-derived
output (segmentation overlays, FLR calculations, tumor classifications, surgical plans,
PDF reports) MUST display a visible "Research Use Only — Not for Diagnostic Use"
disclaimer.

The product MUST NOT claim autonomous diagnosis, autonomous surgical planning, or
replacement of clinician judgment in any user-facing text, marketing copy, or regulatory
correspondence prior to clearance.

Clearance granted for one intended use (e.g., parenchymal volumetry) does NOT extend the
clinical-use disclaimer exemption to other outputs. Each claim carries its own
disclaimer lifecycle.

**Rationale**: Off-label clinical claims pre-clearance are both illegal under EU MDR
and create irretrievable credibility loss with HPB surgeons who are the target buyers.

### VII. Security, Privacy & Data Residency

All authentication MUST use OAuth 2.0 / OpenID Connect / SMART-on-FHIR protocols.
Access control MUST be enforced via FHIR `AccessPolicy` (or equivalent server-side
RBAC). All PHI MUST be encrypted at rest (AES-256) and in transit (TLS 1.3).

Primary data residency is **AWS eu-central-1 (Frankfurt)** for GDPR compliance.
Secondary residency for non-DACH deployments MUST be documented per tenant. Secrets
MUST NOT be committed to version control — use AWS Secrets Manager or equivalent.

All database queries MUST be parameterized. Multi-factor authentication MUST be
supported for all clinician and admin roles. Breach notification procedures MUST be
documented and tested at least annually.

**Rationale**: GDPR violations carry fines up to 4% of global revenue. Data residency
in Frankfurt is a hard contractual requirement from DACH hospitals — losing it means
losing the market.

### VIII. Type Safety & Strict Mode

TypeScript strict mode MUST be enabled across all `packages/*` TypeScript packages.
Public APIs MUST have explicit type definitions; use of `any` requires inline
justification comment. Python services MUST use type hints on all public functions
and MUST pass `mypy --strict` or equivalent.

ML inference contracts (DICOM in, segmentation out) MUST be validated against Pydantic
models at the FastAPI boundary — schema drift between a Triton model and its caller
MUST fail closed, not silently.

**Rationale**: In medical software, a type error is a patient-safety latent defect.
Static typing turns a class of runtime bugs into compile-time failures.

### IX. Unified Design System

All UI components MUST use CSS variables from `packages/app/src/emr/styles/theme.css` —
colors, typography, and spacing MUST NOT be hardcoded. All modals MUST use `EMRModal`
(ported from MediMind). All form fields MUST use the `EMR*` component family.

**Forbidden colors** (Tailwind/external blues): `#3b82f6`, `#60a5fa`, `#2563eb`,
`#4267B2`. Dark mode MUST be handled exclusively by `theme.css` variable switching
via `data-mantine-color-scheme` — component-level dark overrides are forbidden.

All interactive elements MUST have minimum 44×44px tap targets and minimum 16px font
on mobile. UI MUST be styled mobile-first, enhanced with `@media (min-width: ...)`.
Flex children that may truncate MUST declare `minWidth: 0`; buttons and badges MUST
use `flexShrink: 0` with `whiteSpace: 'nowrap'`.

The LiverRa primary brand gradient will be defined in a future patch amendment; until
then, components MAY inherit the MediMind gradient
(`linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%)`) as a placeholder
explicitly marked for replacement.

**Rationale**: A single visual source of truth prevents drift across the 3D viewer,
reporting, and admin surfaces, and guarantees light/dark mode parity without per-component
fixes. Surgeons read reports at 2 AM on phones — mobile responsiveness is clinical safety.

### X. Internationalization

All user-facing strings MUST use the `useTranslation()` hook — hardcoded UI text is
forbidden. Translation files MUST be maintained for **English (`en.json`, primary
regulatory language)**, **German (`de.json`, DACH primary market)**, and
**Georgian (`ka.json`, Geo Hospitals pilot deployment)**.

Medical terminology MUST be reviewed by a domain expert native speaker before merge.
New features MUST include translation keys for all three languages before merging.
Additional languages (French, Russian, Arabic) MAY be added per market expansion via
PR; none are constitutionally mandated in v1.

**Rationale**: DACH surgeons and nurses will not use English-only UIs in clinical
workflow. Geo Hospitals is our validation site and operates in Georgian. English is
non-negotiable for EU regulators and investor review.

## Healthcare & Compliance Standards

### Regulatory Pathway

- **Primary**: CE MDR Class IIb SaMD (Software as a Medical Device). Target: 24–30
  months to CE mark.
- **Secondary**: FDA 510(k) via substantial equivalence pathway (Phase 2).
- ISO 13485 Quality Management System adoption required before CE submission.
- ISO 14971 (risk management) and IEC 62304 (software lifecycle) compliance required
  for all ML pipeline code paths.
- Post-market surveillance plan MUST be in place before first commercial deployment.

### Model Licensing & Data Provenance

- Every integrated model MUST appear in the Model Bill of Materials with license,
  source commit/tag, integration date, and approver.
- Every training dataset MUST appear in the Dataset Bill of Materials with license,
  source, ethics approval, and retention policy.
- Evaluation-only datasets MUST be segregated from training datasets at the filesystem
  level and never commingled.
- Re-verification of model licenses MUST occur at each major release (every new model
  upload to HuggingFace / GitHub may silently change its license).

### GDPR & HIPAA Requirements

- PHI encrypted at rest (AES-256) and in transit (TLS 1.3).
- Audit logs retained for minimum 6 years (HIPAA) or per local requirement, whichever
  is longer.
- MFA supported for all clinician and admin roles; required for production access.
- Data retention policies configurable per tenant.
- Breach notification procedures documented and exercised annually.
- Right to erasure (GDPR Art. 17) supported via tenant-scoped data deletion workflows.

### FHIR Conformance

- Resource operations MUST validate against FHIR R4.
- Search parameters MUST conform to FHIR search specification.
- `CapabilityStatement` MUST accurately reflect server capabilities.
- Extensions MUST follow FHIR extension guidelines and use `http://liverra.ai/fhir/...`
  URLs.
- DICOM ↔ FHIR mapping MUST follow `ImagingStudy` / `ImagingSelection` conventions.

### Data Migration & Versioning

- Database migrations MUST run in transactions where the RDBMS supports it.
- Migrations MUST be reversible where technically possible; irreversible migrations
  require spec-level justification.
- Breaking schema changes MUST maintain backward compatibility for at least one
  minor version and be announced with a migration path.

## Development Workflow

### Spec-Driven Workflow Gate (MANDATORY)

Every code-producing PR MUST reference a `specs/NNN-feature/` artifact in its
description. PRs that do not reference a spec MUST be either (a) a ≤20-line hotfix
with justification, or (b) infrastructure/tooling changes not touching ML, FHIR, or
UI code paths.

The `/speckit.analyze` cross-artifact consistency check MUST pass before `/speckit.implement`
begins for any new feature.

### Code Review Requirements

- All PRs MUST pass automated tests (Vitest for TypeScript, pytest for Python).
- All PRs MUST pass linting + formatting (ESLint + Prettier for TS; ruff + black for Python).
- At least one approving review required for changes to `packages/core`,
  `packages/fhirtypes`, or `packages/ml-inference`.
- Security-sensitive changes (auth, PHI handling, audit logging) require a second
  reviewer with explicit security sign-off.
- Model integration PRs require license verification sign-off by a project maintainer.

### Testing Gates

- Unit tests MUST achieve ≥80% line coverage for new code in `packages/core`,
  `packages/fhirtypes`, `packages/imaging`, and `packages/ml-inference`.
- Integration tests required for any FHIR endpoint change.
- End-to-end tests required for user-facing clinical workflows (upload → inference →
  report).
- ML inference regression tests MUST include golden-case CT volumes with expected
  Dice/IoU thresholds; regressions below threshold block merge.

### Deployment Standards

- On-prem and cloud deployments MUST run the same container images (only config differs).
- Database migrations MUST run before application code deployment.
- Breaking API changes MUST be versioned (`/fhir/R4` vs `/fhir/R5` path prefix) with
  deprecation notices.
- Health check endpoints MUST verify database, Redis, and Triton inference server
  connectivity before reporting healthy.

### Documentation Requirements

- New FHIR resources or extensions MUST include usage examples in `packages/docs` or
  inline JSDoc.
- New ML models MUST ship with a Model Card (intended use, training data summary,
  performance metrics, known limitations).
- Breaking changes MUST be documented in `CHANGELOG.md`.
- Quickstart guide for a feature MUST live in `specs/NNN-feature/quickstart.md`.

## Governance

This constitution supersedes all other development practices within the LiverRa
project. All pull requests and code reviews MUST verify compliance with these
principles.

### Amendment Process

1. Proposed amendments MUST be submitted as a PR to `.specify/memory/constitution.md`.
2. Amendment rationale MUST be documented in the PR description, including a Sync
   Impact Report identifying downstream template and documentation updates.
3. Template consistency impacts MUST be assessed and addressed in the same PR or
   linked follow-ups.
4. Approval requires consensus from project maintainers (founder + at least one
   clinical lead + at least one engineering lead).
5. Migration plan MUST be provided for breaking governance changes.

### Version Increment Rules

- **MAJOR**: Backward-incompatible governance changes, principle removals or
  redefinitions, or project identity changes.
- **MINOR**: New principles added, or materially expanded guidance within existing
  principles.
- **PATCH**: Clarifications, wording improvements, typo fixes, non-semantic
  refinements.

### Compliance Review

- Constitution compliance MUST be checked during PR review (automated via spec
  `Constitution Check` gate and manual via reviewer sign-off).
- Complexity violations MUST be justified in the spec's `Complexity Tracking` section
  with simpler alternatives documented and rejection reasons recorded.
- New principles MUST include enforcement mechanisms (lint rule, test, review
  checklist item).
- Annual review MUST assess principle effectiveness and relevance; principles that
  have not prevented a single defect in 12 months are candidates for retirement.

### Runtime Development Guidance

For day-to-day development commands, tooling setup, MediMind-to-LiverRa reusable
asset map, and common troubleshooting patterns, refer to `CLAUDE.md` at the repository
root. CLAUDE.md is operational guidance; this constitution is the source of truth
for principles.

**Version**: 2.0.0 | **Ratified**: 2026-04-19 | **Last Amended**: 2026-04-19
