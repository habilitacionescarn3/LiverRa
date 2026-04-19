# LiverRa — Technical Architecture

## Architecture Choice: Standalone Web App (SaaS) + Edge Appliance

**Product = web application at `app.liverra.ai` that ingests DICOM from hospital PACS.**

### Why this over alternatives

| Option | Verdict |
|---|---|
| A. Plugin inside existing PACS | ❌ Locked to one vendor, hard to sell elsewhere |
| B. Standalone web app (SaaS) | ✅ **Do this** — modern, vendor-agnostic, scalable |
| C. Desktop software | ❌ Outdated, installation friction |

The standalone web app speaks DICOM (1993 standard) — every PACS vendor speaks DICOM, so integration is universal.

---

## High-Level Architecture

```
[Hospital Modality (CT/MRI)]
        │ DIMSE C-STORE / DICOMweb STOW-RS
        ▼
┌──────────────────────────────────────┐
│ LiverRa EDGE APPLIANCE (on-prem)     │
│ • Orthanc (mini-PACS, routing)       │
│ • MONAI Informatics Gateway          │
│ • CTP Anonymizer (header+pixel)      │
│ • Outbound TLS 1.3 to cloud          │
└──────────────────────────────────────┘
        │ HTTPS/WSS (no inbound firewall hole)
        ▼
┌──────────────────────────────────────────────────────────┐
│ LIVERRA CLOUD (AWS eu-central-1 Frankfurt)              │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐  ┌───────────────┐ │
│  │ API Gateway │──▶│ Ingest Svc    │─▶│ S3 (raw DCM) │ │
│  │ Cognito +   │   │ (DICOMweb)    │  └───────────────┘ │
│  │ SMART-FHIR  │   └──────┬────────┘                    │
│  └─────────────┘          │ SQS                         │
│                           ▼                             │
│  ┌─────────────────────────────────────────┐           │
│  │ Orchestrator (MONAI Workflow Mgr)       │           │
│  │ • Phase detection (non-con/art/PV/del)  │           │
│  │ • Protocol gating                       │           │
│  └──────┬──────────────────────────────────┘           │
│         │ gRPC                                          │
│  ┌──────▼────────────────────────────────┐             │
│  │ Triton Inference Server on KServe    │             │
│  │   (K8s, NVIDIA L4 pool; A100 burst)  │             │
│  │ • 5 models loaded (cascaded pipeline)│             │
│  └──────┬────────────────────────────────┘             │
│         ▼                                               │
│  ┌─────────────────────────────┐                       │
│  │ Post-process (highdicom)    │                       │
│  │ • DICOM-SEG + DICOM-SR      │                       │
│  │ • Mesh (marching cubes)     │                       │
│  └────┬────────────────────────┘                       │
│       │                                                 │
│  ┌────▼────────┐    ┌────────────────┐                 │
│  │ AWS          │    │ FHIR Layer    │                 │
│  │ HealthImaging│    │ (Medplum/HAPI)│                 │
│  │ (study store)│    │ ImagingStudy  │                 │
│  └────┬─────────┘    │ DiagnosticRpt │                 │
│       │              │ Observation   │                 │
│       │              └───────┬───────┘                 │
│       └──────┬───────────────┘                         │
│              ▼                                          │
│  ┌──────────────────────────────────┐                  │
│  │ LiverRa Viewer (OHIF + Cornerstone3D)│              │
│  │ 3D seg overlays, MPR, measurements │                │
│  └──────────────────────────────────┘                  │
│                                                          │
│  CROSS-CUTTING:                                         │
│  • MLflow (models) + DVC (datasets) — audit trail      │
│  • CloudTrail + OpenSearch — AuditEvent logging        │
│  • Secrets Manager + KMS envelope encryption            │
└──────────────────────────────────────────────────────────┘
        │ Results back to hospital via C-STORE/DICOMweb
        ▼
[Hospital PACS / VNA / RIS]
```

---

## The Exact Stack

### Frontend (packages/app)
- **Vite 7 + React 19 + TypeScript 5** (strict ESM)
- **Mantine UI 7.x** — component library
- **OHIF Viewer v3.9+** with **Cornerstone3D 2.0** — medical imaging viewer (MIT license)
- **React Router v7** — routing

### Backend (packages/core, packages/imaging)
- **Python 3.11** — same language as ML models
- **FastAPI** — async web framework
- **PostgreSQL 16** — metadata DB (patients, studies, jobs)
- **Redis** — caching + Celery broker
- **Celery** — async inference job orchestration

### ML Inference (packages/ml-inference)
- **NVIDIA Triton Inference Server** — production GPU serving
- **MONAI 1.4+** — medical imaging transforms
- **PyTorch 2.3** — DL runtime
- **MONAI Deploy App SDK** — packaging

### DICOM + Medical Imaging
- **Orthanc** — mini-PACS / routing (on edge appliance)
- **pydicom** — DICOM read/write
- **highdicom** — DICOM-SEG + DICOM-SR generation
- **dcm2niix** — DICOM → NIfTI conversion
- **CTP (MIRC)** — anonymization (header + burned-in pixel)

### Infrastructure
- **AWS eu-central-1 (Frankfurt)** — primary for GDPR residency
- **AWS HealthImaging** — purpose-built DICOM store (native DICOMweb, auto-tier)
- **Amazon EKS** (Kubernetes) — inference scale-out (Phase 2; Docker Compose for MVP)
- **AWS Cognito** — auth with SMART-on-FHIR
- **Secrets Manager + KMS** — encryption

### DevOps
- **Docker + Docker Compose** — containerization, dev and simple deployments
- **GitHub + GitHub Actions** — repo + CI/CD
- **Turborepo** — monorepo orchestration
- **Weights & Biases** — ML experiment tracking
- **Sentry** — error monitoring
- **PostHog** — product analytics

---

## Build vs Buy

**BUY (open-source / licensed, don't reinvent):**
- DICOM router → Orthanc
- Anonymization → CTP
- Inference server → NVIDIA Triton
- Viewer → OHIF + Cornerstone3D
- FHIR server → Medplum (managed) or HAPI FHIR
- DICOM-SEG/SR writer → highdicom
- Base models → STU-Net, LiLNet, VISTA3D, MedSAM-2, Pictorial Couinaud (all Apache 2.0)
- Auth → AWS Cognito
- Model registry → MLflow

**BUILD (this is your IP):**
- Multi-phase fusion logic (LiverRa's core differentiator)
- Clinical UI workflow (surgeon-native UX)
- Couinaud + FLR + 3D planning pipeline integration
- Reporting engine (PDF + DICOM-SR)
- Tenant/deployment config

---

## Per-Scan Infrastructure Cost

| Component | Cost per scan |
|---|---|
| GPU inference (L4 @ 30s) | ~$0.006 |
| GPU inference (A100 @ 30s, multi-phase) | ~$0.033 |
| Storage (S3 Standard, 500MB, 90-day hot) | ~$0.02 |
| AWS HealthImaging ingest | ~$0.01 |
| Egress (50MB results back) | ~$0.005 |
| Orchestration (SQS + Lambda + EKS amortized) | ~$0.05 |
| FHIR write | ~$0.01 |
| Edge appliance amortization | ~$0.10 |
| **Raw subtotal** | ~$0.18-0.25 |
| **With overprovisioning + training amortization** | **~$0.40-1.50 fully loaded** |

Commercial pricing is €300-600/case for surgical planning → **gross margin >95%**. Infra is NOT the cost bottleneck. Annotation + regulatory + clinical validation are.

---

## MVP (3-month) vs Scale (12-month) Architecture

### MVP (months 1-3)
- Single AWS region (eu-central-1)
- Docker Compose (not K8s yet)
- One g5.xlarge L4 GPU (on-demand start/stop to cut cost to ~$100/month)
- OHIF default config + LiverRa branding
- DICOM upload via web (no edge appliance yet)
- Basic auth (one password per design partner)
- No FHIR layer yet — DICOM-SEG + PDF only

### Scale (months 4-12)
- Multi-tenant (per-hospital namespace, KMS per-tenant)
- EKS + Triton autoscaling
- Edge appliance Docker kit for hospital deployments
- FHIR layer (Medplum or HAPI)
- IHE AIW-I + AIR conformance
- AWS HealthImaging (replace raw S3)
- Full audit trail (CloudTrail + OpenSearch)
- Phase 2 cloud cost: ~$2,500-3,500/month

---

## Compliance Architecture Requirements

For CE MDR Class IIb SaMD (required from day 1, hard to retrofit):
- **ISO 13485** — QMS (document control, design history file, CAPA)
- **ISO 14971** — risk management (hazard analysis with AAMI TIR 34971 for AI hazards)
- **IEC 62304** — software lifecycle (Class B/C for liver cancer detection)
- **IEC 82304-1** — health software
- **IEC 81001-5-1** — cybersecurity activities in software lifecycle
- **MDCG 2019-16** — EU cybersecurity (NIS2 healthcare critical)
- **FDA cybersecurity** — SBOM, threat model, vulnerability management
- **Predetermined Change Control Plan (PCCP)** — for AI model updates post-clearance
- **Data lineage (DVC)** from training set to deployed model — regulatory audit requirement
- **MLflow** — model versioning with full reproducibility

---

## Security Checklist

- TLS 1.3 everywhere (DICOM TLS, HTTPS, gRPC-TLS)
- AES-256 at rest with KMS customer-managed keys (tenant-scoped)
- Envelope encryption for DICOM payloads in S3
- PrivateLink / VPC endpoints (no public S3/FHIR)
- mTLS between microservices
- Secrets Manager (never env files)
- SSO via Cognito + SMART-on-FHIR scopes
- MFA for admin + clinician accounts
- Short-lived JWTs (≤15min access, refresh with rotation)
- Least-privilege IAM (one role per service)
- DICOM TLS for C-STORE at edge
- AE Title whitelist per hospital
- Pixel anonymization for burned-in PHI (CTP pixel rules)
- PHI leakage scanning in CI (CheckPixel, dicom-deid validators)
- SBOM per release (Syft/CycloneDX)
- Penetration testing annually + pre-CE
- Model signing + verification at deploy time
- Input validation (reject non-liver studies, wrong phases)
- Drift monitoring (Evidently AI) — distribution shift alerts
- Human-in-the-loop gate (decision support, not autonomous)

---

## MediMind → LiverRa Reusable Components

When a feature spec needs functionality that already exists in MediMind, port from these paths. All rooted at `/Users/toko/Desktop/medplum_medimind/`:

| Need | Source path |
|---|---|
| Cornerstone3D init + tools | `packages/app/src/emr/services/pacs/cornerstoneInit.ts` |
| DICOM viewer (PACSViewer) | `packages/app/src/emr/components/pacs/PACSViewer.tsx` |
| DICOMweb client (QIDO/WADO) | `packages/app/src/emr/services/pacs/dicomwebClient.ts` |
| DICOM tag parser | `packages/app/src/emr/services/pacs/dicomParserService.ts` |
| DICOM-SR export/import | `packages/app/src/emr/services/pacs/dicomSRService.ts` |
| Annotation service | `packages/app/src/emr/services/pacs/annotationService.ts` |
| Hanging protocols | `packages/app/src/emr/services/pacs/hangingProtocolEngine.ts` |
| Audit service | `packages/app/src/emr/services/pacs/auditService.ts` |
| FHIR systems + URLs | `packages/app/src/emr/constants/fhir-systems.ts` |
| FHIR helpers | `packages/app/src/emr/services/fhirHelpers.ts` |
| Theme CSS | `packages/app/src/emr/styles/theme.css` |
| Translation context | `packages/app/src/emr/contexts/TranslationContext.tsx` |
| EMRModal | `packages/app/src/emr/components/common/EMRModal.tsx` |
| EMRButton | `packages/app/src/emr/components/common/EMRButton.tsx` |
| EMRTable | `packages/app/src/emr/components/shared/EMRTable/` |
| EMR form fields | `packages/app/src/emr/components/shared/EMRFormFields/` |
| Docker PACS compose | `docker-compose.pacs.yml` |
| nginx config | `pacs/nginx/nginx.conf` |
| Supabase edge fn pattern | `supabase/functions/mediscribe-generator/` |
| Streaming SSE parser | `packages/app/src/emr/services/ai-assistant/streamingService.ts` |
| Env switching script | `scripts/switch-env.sh` |

**Port one at a time, under a specific spec's `/implement` phase, with tests.**
