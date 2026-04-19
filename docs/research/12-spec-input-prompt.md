# Spec Input Prompt for `/speckit.specify`

> **Instructions:** After running `/speckit.constitution` in the LiverRa Claude Code session, paste the block below into `/speckit.specify`. The generated spec will reference all the other `docs/research/*.md` files for deep context.

---

## THE PROMPT (copy everything between the triple-hash lines)

```
### LiverRa Feature 001 — Zero-Training MVP: Cascaded Pretrained Liver AI Pipeline with Web Viewer

Build the LiverRa v1 MVP as defined in docs/research/10-mvp-strategy.md. This is the inaugural feature of the LiverRa platform — an AI-powered liver diagnostics and surgical planning web application for hepatobiliary (HPB) surgeons. The full strategic context is in docs/research/00-executive-brief.md. Architecture details are in docs/research/07-technical-architecture.md. Exact model and dataset decisions are in docs/research/11-model-and-dataset-choices.md. ML feasibility and published benchmarks are in docs/research/04-ml-feasibility.md. Regulatory framing is in docs/research/02-regulatory-pathway.md. Please reference these documents throughout the spec.

## Product Scope (v1 MVP)

A standalone web application at app.liverra.ai where HPB surgeons at design-partner hospitals (Regensburg University Hospital, Ernst von Bergmann Potsdam, Geo Hospitals Tbilisi) upload a 4-phase contrast liver CT and receive, within 3-5 minutes:
1. Volumetric liver parenchyma mask (Dice target ≥0.92 zero-trained)
2. Eight Couinaud segments with vascular scaffold overlay
3. Portal + hepatic vein trunks and primary branches
4. Tumor detection with 6-class classification (HCC / ICC / metastasis / FNH / hemangioma / cyst) with per-lesion confidence score and abstention when uncertain
5. Future Liver Remnant (FLR) volume in mL and percentage, with user-selectable resection plane simulation
6. Interactive surgeon edit workflow (VISTA3D click-to-refine, MedSAM-2 one-prompt tumor re-segmentation)
7. Structured PDF report + DICOM-SEG + DICOM-SR output returned to hospital PACS

All outputs carry a prominent "Research Use Only — not for autonomous clinical decision-making" disclaimer. All inference uses pretrained Apache 2.0 models with NO custom training or fine-tuning in v1.

## Users

- **Primary:** HPB surgeon. Decision-maker and primary user. 5-20 years experience, 50-200 hepatectomies/year. Currently uses manual ROI drawing in PACS or sends scans to Visible Patient for 48h turnaround.
- **Secondary:** Abdominal radiologist. Validates the AI output, flags small-lesion misses. Uses LI-RADS for cirrhotic surveillance.
- **Tertiary:** Clinical fellow / resident. Power user for case review and learning.

## Model Stack (all Apache 2.0, locked in — see 11-model-and-dataset-choices.md)

1. STU-Net (1.4B) — parenchyma + metastases — https://github.com/uni-medical/STU-Net
2. Pictorial Couinaud Segmentation — 8-segment topology — https://github.com/xukun-zhang/Couinaud-Segmentation
3. LiLNet — 6-class tumor classification — https://github.com/yangmeiyi/Liver
4. VISTA3D — interactive refinement — https://github.com/Project-MONAI/VISTA
5. MedSAM-2 — zero-shot 3D tracking — https://github.com/MedicineToken/Medical-SAM2

Pipeline is cascaded, NOT end-to-end. See architecture diagram in 07-technical-architecture.md and pipeline-stage description in 10-mvp-strategy.md.

## Technical Stack

- Frontend (packages/app): Vite 7 + React 19 + TypeScript 5 strict ESM + Mantine UI 7 + OHIF Viewer 3.9+ + Cornerstone3D 2.0
- Backend: Python 3.11 + FastAPI + Celery + Redis + PostgreSQL 16
- ML inference (packages/ml-inference): MONAI 1.4 + PyTorch 2.3 + NVIDIA Triton Inference Server
- DICOM: Orthanc + CTP anonymizer + MONAI Informatics Gateway + highdicom
- Cloud: AWS eu-central-1 (Frankfurt) for GDPR residency
- GPU: NVIDIA L4 24GB (g5.xlarge) for production inference; on-demand start/stop for MVP cost control
- Deployment: Docker Compose for MVP; Amazon EKS deferred to Phase 2

Monorepo structure already scaffolded: packages/app, core, imaging, ml-inference, fhirtypes (Turborepo).

## Input/Output Contract

**Input:**
- 4-phase contrast-enhanced liver CT as DICOM series (non-contrast, arterial, portal venous, delayed phases)
- Ingestion via: (a) drag-drop web upload (MVP default), (b) DIMSE C-STORE from hospital PACS to Orthanc on cloud (Phase 2)
- Anonymization: header + burned-in pixel de-identification via CTP before cloud upload
- Minimum requirements: portal venous phase required; others strongly recommended; system gracefully degrades with missing phases

**Output:**
- 3D visualization in web browser (OHIF + Cornerstone3D viewer)
- DICOM-SEG file (segmentation volumes with SNOMED-CT codes for liver parenchyma, 8 segments, vessels, lesions by type)
- DICOM-SR structured report (TID 1500 template with volumes, FLR %, lesion measurements, classifications)
- Structured PDF report (surgeon-facing, with 3D screenshots, volumes table, lesion list, resection simulation)
- FHIR Observation + DiagnosticReport (Phase 2 — not required for MVP)

## Success Criteria

1. End-to-end pipeline runs on 20 representative Geo Hospital scans without crashes
2. Inference time <2 min per scan on single L4 GPU
3. FLR calculation within ±5% of expert manual volumetry on 20-scan validation set
4. HPB surgeon review rates ≥80% of Couinaud segmentations as "surgically usable"
5. Three design partner Data Processing Agreements signed (Regensburg, Potsdam, Geo Hospitals)
6. First clinical case documented in tumor board usage
7. Abstract submitted to one of: ECR 2027, ESGAR 2026, IHPBA Singapore 2026

## Out of Scope for v1 (see 10-mvp-strategy.md)

- MRI modality (HCC gadoxetic-acid MRI deferred to v2)
- Biliary tree segmentation (requires MRCP — defer)
- Hepatic artery segmentation (research-grade — defer)
- Multi-tenancy (one hospital per deployment)
- Full HIPAA/GDPR audit logging (basic logging only for MVP)
- LI-RADS auto-classification (decision support only)
- FDA submission artifacts (pathway documented in 02-regulatory-pathway.md for planning; actual submission is Phase 3)
- Custom model training or fine-tuning (zero-training MVP is the whole point)
- Mobile app
- EHR integration beyond FHIR basics
- ALPPS multi-stage planning
- Living donor matching

## Regulatory Framing

- v1 is Research Use Only (RUO). Not a medical device; not for autonomous clinical use.
- CE MDR Class IIb pathway is Phase 3 (24-30 months) — v1 accumulates clinical evidence for the submission.
- Full regulatory context in docs/research/02-regulatory-pathway.md.
- Every inference must be logged with: input hash, model version, output hash, timestamp, user ID. This is the audit-trail foundation for eventual Class IIb submission.
- Data provenance (MLflow + DVC) from day 1. Dataset licensing discipline: every training dataset audited, split into /data/train_commercial/ vs /data/eval_research_only/ folders (see 11-model-and-dataset-choices.md § Licensing Discipline).

## Performance & Non-Functional Requirements

- Inference latency: <2 min end-to-end per scan
- Concurrent scans: 1-3 at MVP (single GPU); scale-out deferred
- Uptime: 95% during design-partner pilot (not 99.9%; this is MVP)
- Security: TLS 1.3 end-to-end, AES-256 at rest, KMS-managed keys, anonymization before cloud upload
- Error monitoring: Sentry
- Product analytics: PostHog (anonymized events only; no PHI)
- Model experiment tracking: Weights & Biases
- All secrets in AWS Secrets Manager (never .env)

## Reusable Assets from MediMind

See CLAUDE.md § Reusable Asset Map — MediMind → LiverRa and docs/research/07-technical-architecture.md § MediMind → LiverRa Reusable Components. Key candidates for port under this spec:

- Cornerstone3D init: packages/app/src/emr/services/pacs/cornerstoneInit.ts
- DICOM viewer skeleton: packages/app/src/emr/components/pacs/PACSViewer.tsx (simplify, remove EMR-specific tools)
- DICOMweb client: packages/app/src/emr/services/pacs/dicomwebClient.ts (swap auth from Medplum JWT to LiverRa tokens)
- DICOM-SR service: packages/app/src/emr/services/pacs/dicomSRService.ts
- Annotation service: packages/app/src/emr/services/pacs/annotationService.ts
- Audit service: packages/app/src/emr/services/pacs/auditService.ts
- Theme CSS: packages/app/src/emr/styles/theme.css (rebrand LiverRa colors)
- Translation system: packages/app/src/emr/contexts/TranslationContext.tsx + services/localeService.ts
- EMR component library: EMRModal, EMRButton, EMRTable, EMRFormFields (carry as-is)
- Docker PACS stack: docker-compose.pacs.yml (customize nginx auth, keep Orthanc)

Port one component at a time, with test coverage, under the corresponding task in /speckit.tasks.

## Deliverables This Spec Must Produce

- `spec.md` — this functional specification
- `plan.md` — implementation architecture with library choices, data model, API contracts
- `research.md` — open technical questions resolved (phase detection algorithm, OHIF customization scope, Triton model loading strategy, etc.)
- `data-model.md` — domain entities: Study, Series, Analysis, Segmentation, Lesion, Classification, FLRCalculation, SurgeonReview, Report, AuditEvent
- `contracts/` — OpenAPI specs for ingest, analysis, results APIs; Triton model I/O contracts; DICOM-SEG/SR schema
- `tasks.md` — dependency-ordered tasks across: infrastructure, data layer, inference pipeline, viewer, reporting, DevOps, documentation

## Ship Target

6 weeks from team hire to first working demo at app.liverra.ai accessible to design-partner hospitals, per the sprint plan in 10-mvp-strategy.md § 6-Week Sprint Plan.
```

---

## How to Use This Prompt

1. Make sure `/speckit.constitution` has already been run in the LiverRa folder — constitution defines the principles this spec will anchor to.
2. Open Claude Code in `/Users/toko/Desktop/LiverRa/`.
3. Paste the prompt above verbatim into `/speckit.specify`.
4. When the command asks clarifying questions (typical for novel features), answer them referencing the relevant `docs/research/*.md` file.
5. After `spec.md` is generated, run `/speckit.clarify` if any questions remain, then `/speckit.plan`.

## Expected Output Path

The spec will land at `/Users/toko/Desktop/LiverRa/specs/001-zero-training-mvp/spec.md` (or similar feature number/name chosen by `/speckit.specify`).

## Tip — Iterating on the Spec

After `/speckit.specify` produces the initial spec.md, run `/upgradeSpec` to spawn 3 parallel agents that strengthen the spec with edge cases, production requirements, and missing user scenarios. This is one of the highest-ROI actions in the speckit workflow and costs ~5 minutes.
