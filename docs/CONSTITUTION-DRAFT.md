# LiverRa Constitution — Draft Answers for `/speckit.constitution`

> **Purpose:** When `/speckit.constitution` prompts you for principles, paste the relevant answers from this document. The command will interactively ask questions and fold your answers into `.specify/memory/constitution.md`.

---

## Project Identity

**Project name:** LiverRa

**Purpose (one sentence):** AI-powered liver diagnostics and surgical planning platform for hepatobiliary surgeons, delivering automated segmentation, Future Liver Remnant calculation, and tumor characterization from standard CT/MRI in under 5 minutes per case.

**Founder:** Dr. Levan Gogichaishvili (HPB & Transplant Surgeon, Head of Surgery Geo Hospitals, President Georgian Society of Visceral Surgery, ESSO Regional Lead)

**Business entity:** Georgian HQ + EU subsidiary (Estonia or Germany, TBD) for GDPR data residency

**Regulatory path:** CE MDR Class IIb SaMD (primary) → FDA 510(k) (Phase 2)

---

## Core Principles (Draft — customize during `/speckit.constitution`)

### Principle I: Safety & Clinical Validity First
LiverRa outputs influence surgical decisions. Every feature must:
- Include human-in-the-loop review (surgeon approves before plan is finalized)
- Display "Research Use Only" or "Decision Support Only" disclaimer (until CE mark issued)
- Log every inference with input hash + model version + output hash + timestamp + user ID (for audit trail)
- Default to conservative thresholds (false positives over false negatives for surgical planning — safer to over-flag than miss)
- Never claim autonomous diagnosis

### Principle II: Regulatory Readiness From Day One
Every line of code must assume future Class IIb SaMD audit:
- **ISO 13485** QMS from Month 1 (document control, design history file, CAPA)
- **IEC 62304 Class B/C** software lifecycle (Class C for anything classifying cancer)
- **ISO 14971** risk management with AAMI TIR 34971 for AI hazards
- **IEC 81001-5-1** cybersecurity activities
- **FDA Predetermined Change Control Plan (PCCP)** for AI updates
- Model provenance (MLflow + DVC) from first commit
- No retrofit — retrofitting QMS is 3-5x more expensive than building in

### Principle III: Open-Source Apache 2.0 Model Discipline
All ML models used commercially MUST be Apache 2.0 licensed. Our stack is curated for this:
- STU-Net (1.4B) — parenchyma + metastases — Apache 2.0
- Pictorial Couinaud — 8-segment topology — Apache 2.0 (verify per release)
- LiLNet — 6-class tumor classification — Apache 2.0
- VISTA3D — interactive refinement — Apache 2.0
- MedSAM-2 — zero-shot 3D tracking — Apache 2.0

**FORBIDDEN:** TotalSegmentator specialized sub-modules (paid commercial license), any GPL/AGPL/CC-NC/CC-SA model, research-only dataset weights for commercial training.

**Training datasets:** own DPA-protected data + CC BY / CC0 public datasets (AMOS22, CRLM-CT-Seg) + Apache 2.0 pretrained weights as starting point.

**Evaluation datasets:** any license (inference only, no training) — LiTS, MSD Task 8, 3D-IRCADb, CHAOS allowed for benchmarking.

### Principle IV: FHIR R4 Compliance
- FHIR base URL: `http://liverra.ai/fhir`
- Extension pattern: `http://liverra.ai/fhir/StructureDefinition/[name]`
- All FHIR URLs centralized in `packages/app/src/emr/constants/fhir-systems.ts`
- Never hardcode FHIR URLs in components
- ImagingStudy, DiagnosticReport, Observation for clinical data
- AuditEvent for every access + inference event
- Before writing FHIR code, invoke `/fhir-developer` skill

### Principle V: DICOM Standards Adherence
- DICOM PS3.15 Annex E Basic Confidentiality Profile for anonymization (header + pixel)
- DICOMweb (QIDO-RS, WADO-RS, STOW-RS) for modern PACS integration
- DICOM-SEG for segmentation output with SNOMED-CT coded classes
- DICOM-SR TID 1500 for structured reports
- Never process non-anonymized DICOM in cloud (anonymization happens at hospital edge appliance)

### Principle VI: Privacy by Design
- GDPR + HIPAA dual-mode from day 1 (don't retrofit US)
- Georgia lacks EU adequacy → EU subsidiary OR federated architecture mandatory
- All patient data in AWS eu-central-1 (Frankfurt) for EU customers
- Pseudonymization at edge appliance; only anonymized data in cloud
- BAA/DPA with every cloud dependency before production use
- DPIA (Data Protection Impact Assessment) for each new data flow
- Right to erasure implemented end-to-end

### Principle VII: Surgeon-First UX
LiverRa targets HPB surgeons, not radiologists. Every UI decision:
- HPB surgeon workflow drives design (not radiology reading workflow)
- Touch-friendly (40%+ of OR case review happens on tablet/touchscreen)
- Accessibility: WCAG 2.1 AA minimum (color blindness, keyboard nav)
- Multi-language: English primary, Georgian + German + Russian as needed
- All UI work via `frontend-designer` agent (no ad-hoc UI code)
- Use EMRModal / EMRButton / EMRTable / EMRFormFields (carried from MediMind) for consistency
- Unified color system via `packages/app/src/emr/styles/theme.css` (CSS variables, never hardcoded hex)
- Mobile-first responsive (Mantine breakpoints: xs 576, sm 768, md 992, lg 1200, xl 1400)

### Principle VIII: Spec-Driven Development
Before any application code, a feature must pass the workflow:
```
/speckit.constitution  (once, upfront)
/speckit.specify       → spec.md
/speckit.clarify       → (if ambiguities)
/speckit.plan          → plan.md + data-model.md + research.md + contracts/
/speckit.tasks         → tasks.md (dependency-ordered)
/speckit.analyze       → cross-artifact consistency
/speckit.implement     → executes
```

No "quick fixes" that bypass spec workflow. Regulatory traceability demands it — every code change must trace back to a spec, which traces to constitution principles.

### Principle IX: Monorepo Hygiene
- Turborepo with packages: app, core, imaging, ml-inference, fhirtypes
- TypeScript 5 strict ESM everywhere
- Python 3.11 for ml-inference (separate toolchain)
- NO bulk file edits (>3 files per batch, always targeted Edits, never regex scripts)
- NO `tsc --noEmit` in dev loop (VS Code + Vite handle type checking)
- NEVER add comments that explain WHAT (well-named code does that); only WHY (non-obvious constraints)
- Don't add features/abstractions beyond task requirements

### Principle X: Clinical Safety and Compliance
- Clinical safety case maintained alongside technical design
- Severity classification (IEC 62304 A/B/C) for every module
- Post-market surveillance plan from v1 (not deferred to CE submission)
- Vulnerability disclosure process with coordinated disclosure
- Every deployed model signed (Sigstore/Cosign), verified at runtime
- No unsigned model weights in production
- Drift monitoring (Evidently AI) with alerts on distribution shift

---

## Technology Stack (Locked)

### Frontend
- Vite 7 + React 19 + TypeScript 5 strict ESM
- Mantine UI 7.x
- OHIF Viewer v3.9+ + Cornerstone3D 2.0
- React Router v7

### Backend
- Python 3.11 + FastAPI
- PostgreSQL 16 + Redis + Celery
- MONAI 1.4+ + PyTorch 2.3 + NVIDIA Triton

### DICOM + Imaging
- Orthanc + CTP anonymizer + MONAI Informatics Gateway (edge)
- pydicom + highdicom + dcm2niix

### Infrastructure
- AWS eu-central-1 (Frankfurt primary)
- Docker + Docker Compose (dev + simple prod)
- EKS/Kubernetes (Phase 2)
- AWS HealthImaging, S3, Cognito, Secrets Manager, KMS

### Dev tools
- GitHub + GitHub Actions
- Weights & Biases (ML experiments)
- Sentry (errors)
- PostHog (analytics)
- Turborepo (orchestration)

---

## Target Markets (Priority Order)

1. DACH (Germany primary — Schlitt + Beyer network, KHZG funding, largest EU HPB volume)
2. Turkey (Acibadem, Koç; 2,000+ transplants/yr)
3. Georgia (home, proof-of-value)
4. CEE (Poland, Czech, Hungary, Romania via distributors)
5. Middle East (UAE, KSA via distributors)
6. UK + France + Nordics (Year 2+)
7. US (deferred to post-Series A)

---

## Governance

- **Version:** 1.0.0 (reset from MediMind seed)
- **Date:** 2026-04-19
- **Amendment process:** constitution changes require `/speckit.constitution` re-run with documented rationale
- **Compliance check:** every `/speckit.plan` output validated against constitution; failures block `/speckit.implement`

---

## How to Use This Document

1. In the LiverRa Claude Code session, run `/speckit.constitution`
2. As the command asks clarifying questions (project name, principles, tech stack, etc.), reference the relevant section above
3. The command will produce `.specify/memory/constitution.md` — review and commit
4. After constitution is established, run `/speckit.specify` with the prompt from `docs/research/12-spec-input-prompt.md`

**Do NOT copy-paste this entire document into `/speckit.constitution` at once.** The command is interactive — answer questions as they come, using this as your reference answer sheet.
