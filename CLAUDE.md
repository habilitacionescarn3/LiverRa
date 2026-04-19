# CLAUDE.md

This file provides guidance to Claude Code when working in the LiverRa repository.

---

## 🫀 Project Overview

**LiverRa** is an AI-powered liver diagnostics and surgical planning platform for hepatobiliary (HPB) surgeons and abdominal radiologists.

**Mission:** Automated analysis of liver CT/MRI to produce surgical-grade 3D plans, FLR (Future Liver Remnant) calculations, and tumor characterization — empowering HPB surgeons to plan complex hepatectomies with confidence.

**Founder:** Dr. Levan Gogichaishvili (HPB & Transplant Surgeon, Head of Surgery at Geo Hospitals, President of Georgian Society of Visceral Surgery, ESSO Regional Lead).

**Core team:** Zviad Giorgadze (Radiology), Irakli Giorgadze (AI/ML), Lika Svanadze (Data Science), Clinical Validation team at Geo Hospitals.

**Academic partners:** Prof. Hans Schlitt (University Hospital Regensburg, ALPPS originator), Prof. Lukas Beyer (Ernst von Bergmann Clinic Potsdam).

**Target markets:** DACH (primary), CEE, Middle East. US + UK as Phase 2.

**Regulatory path:** CE MDR Class IIb SaMD → FDA 510(k). Timeline: 24-30 months to CE mark.

---

## 🎯 Product Scope (v1)

**In scope for v1 (zero-training MVP):**
- Integrated pipeline of pretrained models: **STU-Net** (parenchyma + lesions), **Pictorial Couinaud** (segments), **LiLNet** (6-class tumor classification), **VISTA3D** (interactive refinement), **MedSAM-2** (zero-shot tracking)
- Web application with DICOM upload, 3D viewer, FLR calculator, structured PDF report
- Cascaded inference architecture (NOT end-to-end)
- Research Use Only disclaimer on all outputs

**Out of scope for v1 (deferred to later features):**
- Custom model training / fine-tuning
- Multi-tenancy (single hospital per deployment)
- FDA submission artifacts
- Full EHR integration
- Mobile app
- Autonomous diagnosis claims

---

## 🛠️ Tech Stack

**Frontend (packages/app):**
- Vite 7 + React 19 + TypeScript 5 (strict ESM)
- Mantine UI 7.x
- OHIF Viewer v3.9+ + Cornerstone3D 2.0 (medical imaging)
- React Router v7

**Shared libraries:**
- `packages/core` — utilities, types, FHIR helpers
- `packages/imaging` — DICOM + Cornerstone3D wrappers
- `packages/fhirtypes` — FHIR R4 TypeScript types with LiverRa extensions

**ML inference (packages/ml-inference):**
- Python 3.11 + FastAPI
- MONAI 1.4+ (medical imaging AI framework)
- PyTorch 2.3
- NVIDIA Triton Inference Server
- Models: STU-Net (1.4B), Pictorial Couinaud, LiLNet, VISTA3D, MedSAM-2 — all Apache 2.0

**Infrastructure:**
- AWS (eu-central-1 Frankfurt for GDPR residency)
- Supabase (auth, Postgres, Edge Functions) OR Medplum FHIR Cloud
- Orthanc + CTP anonymizer + MONAI Informatics Gateway (edge appliance)
- Docker Compose (local dev + on-prem deployments)
- Kubernetes/EKS (Phase 2 when 3+ paying customers)

**Dev tools:**
- Turborepo (monorepo orchestration)
- GitHub Actions (CI/CD)
- Weights & Biases (ML experiment tracking)
- Sentry (error monitoring)
- PostHog (product analytics)

---

## 📁 Monorepo Structure

```
LiverRa/
├── packages/
│   ├── app/              # Vite + React 19 + Mantine 7 frontend
│   ├── core/             # Shared utilities, FHIR helpers, types
│   ├── imaging/          # DICOM, Cornerstone3D, PACS client
│   ├── ml-inference/     # Python: FastAPI + Triton + MONAI
│   └── fhirtypes/        # FHIR R4 types with liver-imaging extensions
├── deploy/               # Docker stacks (local, production, on-prem)
├── supabase/functions/   # Supabase Edge Functions (inference proxy, email)
├── pacs/                 # Orthanc + nginx edge appliance config
├── specs/                # Feature specs (auto-populated by /speckit.specify)
├── tasks/                # Task collection (auto-populated by /speckit.tasks)
├── scripts/              # Dev scripts (careful-guard.sh, switch-env.sh, etc.)
├── .claude/              # Claude Code config (agents, skills, commands)
└── .specify/             # Speckit spec system (templates, bash scripts, memory)
```

---

## 🚦 WORKFLOW RULE (MANDATORY)

**Before writing application code, ALWAYS:**

1. Run `/speckit.constitution` (if not already done for this project) — defines governing principles
2. Run `/speckit.specify <feature>` — creates `specs/NNN-feature/spec.md`
3. Run `/speckit.clarify` (if spec has ambiguities)
4. Run `/speckit.plan` — generates `plan.md`, `data-model.md`, `research.md`, `contracts/`
5. Run `/speckit.tasks` — breaks plan into ordered, dependency-tracked tasks
6. Run `/speckit.analyze` — cross-artifact consistency check
7. Run `/speckit.implement` — executes tasks

**DO NOT write app code directly without a spec.** The spec-driven workflow is how LiverRa maintains regulatory traceability (required for CE MDR + FDA audit trails) and architectural coherence.

---

## 🎨 Development Commands (placeholders — filled by first implementation)

```bash
npm install                 # Install all workspace deps
npm run dev                 # Start Vite dev server on port 3000
npm run build               # Build all packages
npm test                    # Run all tests
npm run lint                # Lint all packages

# ML inference (separate Python toolchain)
cd packages/ml-inference
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn src.main:app --reload --port 8000
```

**Starting Dev Server (CRITICAL):** Always run on port 3000:
```bash
cd packages/app && npx vite --port 3000
```

---

## ⚠️ Critical Rules (Carried Over from MediMind)

### No Bulk File Edits (ZERO TOLERANCE)
- NEVER perform global regex find-and-replace across >3 files
- Max 3 files per batch; read full file before editing; use Edit tool, not sed/scripts
- Past incident in MediMind: 377 files corrupted by regex — required full revert

### No Unnecessary Type Checking
- DO NOT run `tsc --noEmit` after code changes (slow, unnecessary)
- VS Code + Vite already catch type errors in real time
- Only run type checking when explicitly requested

### All UI Work via `frontend-designer` Agent
- Creating/modifying components, views, pages, CSS — MUST use the `frontend-designer` agent
- Ensures production-ready quality + design system compliance
- Do NOT write UI code directly

### FHIR Development
- Before writing FHIR-related code, invoke `/fhir-developer` skill
- All identifier systems + extension URLs centralized in `packages/app/src/emr/constants/fhir-systems.ts` (to be created)
- NEVER hardcode FHIR URLs
- FHIR base URL: `http://liverra.ai/fhir`
- Extension pattern: `http://liverra.ai/fhir/StructureDefinition/[name]`

### Unified Color System (CRITICAL — to be created)
- Theme variables in `packages/app/src/emr/styles/theme.css` (port from MediMind, rebrand colors)
- NEVER hardcode colors in component files
- FORBIDDEN: Tailwind blues (#3b82f6, #60a5fa, #2563eb), Facebook blue (#4267B2)
- Light/dark mode via `data-mantine-color-scheme` attribute
- Semantic variables only: `--emr-bg-page`, `--emr-bg-card`, NEVER `--emr-gray-N` for backgrounds

### EMR Component Library (to be ported)
- ALL modals → `EMRModal` from `components/common/`
- ALL form fields → `EMRTextInput`, `EMRSelect`, `EMRDatePicker`, `EMRCheckbox`
- ALL primary buttons → `EMRButton` with gradient `linear-gradient(135deg, #1a365d 0%, #2b6cb0 50%, #3182ce 100%)` (LiverRa may override — TBD in constitution)

### Mobile-First Responsive (CRITICAL)
- Style for mobile first, enhance with media queries
- Min 44×44px tap targets, min 16px font on mobile
- Mantine breakpoints: xs 576, sm 768, md 992, lg 1200, xl 1400

### Flexbox Text Overflow (CRITICAL)
- Buttons/badges/pills: `flexShrink: 0` + `whiteSpace: 'nowrap'`
- Flex children with truncation: `minWidth: 0`
- `Group` with mixed content: `wrap="wrap"`, never `wrap="nowrap"` unless all children fit

### Mantine Button Styling (CRITICAL)
- NEVER override `padding` on Mantine Button `root` — breaks internal label height
- Use `EMRButton` for standard cases
- For inline/compact: Mantine `size="compact-sm"` or `"sm"` — NEVER `"compact-xs"`
- Custom Button: always include `label: { overflow: 'visible', height: 'auto' }` in styles

---

## 📋 Model Licensing Discipline (NON-NEGOTIABLE)

**ALL ML models used commercially MUST be Apache 2.0 licensed.** Our v1 stack is curated for this:

| Model | License | Role |
|---|---|---|
| STU-Net (1.4B) | Apache 2.0 | Liver parenchyma + metastases |
| Pictorial Couinaud | Open source (verify per release) | 8-segment topological parsing |
| LiLNet | Apache 2.0 | 6-class tumor classification |
| VISTA3D | Apache 2.0 | Interactive refinement (127 classes) |
| MedSAM-2 | Apache 2.0 | Zero-shot 3D tracking |

**FORBIDDEN (license risk):**
- TotalSegmentator specialized sub-modules (paid commercial license required)
- LiTS17, MSD Task 8, 3D-IRCADb, CHAOS datasets for TRAINING commercial weights (research-only)
- Models with GPL/AGPL/CC-NC/CC-SA licenses

**ALLOWED for training commercial weights:**
- Own proprietary data (via DPAs with hospitals)
- AMOS22 (CC BY 4.0)
- CRLM-CT-Seg April 2026 (verify Zenodo license — likely CC BY)
- Pretrained Apache 2.0 weights (STU-Net etc.) as starting point for fine-tuning

**ALLOWED for evaluation/benchmarking only (NOT training):**
- LiTS17, MSD Task 8, 3D-IRCADb, CHAOS, HCC-TACE-Seg, LLD-MMRI

---

## 🗺️ MediMind → LiverRa Reusable Asset Map

When a feature spec calls for functionality that already exists in MediMind, port it from these paths rather than reinventing. All paths relative to `/Users/toko/Desktop/medplum_medimind/`.

### PACS & DICOM
| Need | Source path |
|---|---|
| Cornerstone3D init + tools | `packages/app/src/emr/services/pacs/cornerstoneInit.ts` |
| DICOM viewer with layouts | `packages/app/src/emr/components/pacs/PACSViewer.tsx` |
| DICOMweb client (QIDO/WADO) | `packages/app/src/emr/services/pacs/dicomwebClient.ts` |
| DICOM tag parser | `packages/app/src/emr/services/pacs/dicomParserService.ts` |
| DICOM-SR export/import | `packages/app/src/emr/services/pacs/dicomSRService.ts` |
| Progressive DICOM loading | `packages/app/src/emr/services/pacs/progressiveLoader.ts` |
| Annotation service | `packages/app/src/emr/services/pacs/annotationService.ts` |
| Hanging protocols | `packages/app/src/emr/services/pacs/hangingProtocolEngine.ts` |
| Window/level presets | `packages/app/src/emr/components/pacs/WindowPresets.tsx` |
| Study list + filters | `packages/app/src/emr/components/pacs/StudyList.tsx` + `StudyListFilters.tsx` |
| DICOM tag browser | `packages/app/src/emr/components/pacs/DicomTagBrowser.tsx` |
| Key image gallery | `packages/app/src/emr/components/pacs/KeyImageGallery.tsx` |
| Comparison view | `packages/app/src/emr/components/pacs/ComparisonView.tsx` |
| Critical alert modal | `packages/app/src/emr/components/pacs/CriticalAlertModal.tsx` |
| PACS error boundary | `packages/app/src/emr/components/pacs/PACSErrorBoundary.tsx` |

### Infrastructure (Orthanc + nginx + bridge)
| Need | Source path |
|---|---|
| Docker PACS stack | `docker-compose.pacs.yml` (root) |
| Orthanc config | `pacs/orthanc/` |
| Nginx reverse proxy | `pacs/nginx/nginx.conf` |
| PACS bridge pattern | `pacs/bridge/` (Python webhook sync) |

### FHIR Layer
| Need | Source path |
|---|---|
| FHIR systems + URLs | `packages/app/src/emr/constants/fhir-systems.ts` |
| FHIR extensions | `packages/app/src/emr/constants/fhir-extensions.ts` |
| FHIR identifiers | `packages/app/src/emr/constants/fhir-identifiers.ts` |
| FHIR CodeSystems | `packages/app/src/emr/constants/fhir-codesystems.ts` |
| FHIR helpers | `packages/app/src/emr/services/fhirHelpers.ts` |
| ImagingStudy service | `packages/app/src/emr/services/pacs/imagingStudyService.ts` |
| Audit service (AuditEvent) | `packages/app/src/emr/services/pacs/auditService.ts` |

### UI Components (EMR library)
| Need | Source path |
|---|---|
| Form fields (Text/Select/Date/etc.) | `packages/app/src/emr/components/shared/EMRFormFields/` |
| Data table | `packages/app/src/emr/components/shared/EMRTable/` |
| Stat card | `packages/app/src/emr/components/shared/EMRInfoCard/` |
| Rich text editor | `packages/app/src/emr/components/shared/EMRRichText/` |
| Status badge | `packages/app/src/emr/components/shared/StatusBadge.tsx` |
| Modal | `packages/app/src/emr/components/common/EMRModal.tsx` |
| Button | `packages/app/src/emr/components/common/EMRButton.tsx` |

### Theme & Translations
| Need | Source path |
|---|---|
| Theme CSS (variables) | `packages/app/src/emr/styles/theme.css` |
| Translation context | `packages/app/src/emr/contexts/TranslationContext.tsx` |
| Locale service | `packages/app/src/emr/services/localeService.ts` |
| Translation files | `packages/app/src/emr/translations/` |

### AI / Inference Patterns
| Need | Source path |
|---|---|
| Supabase Edge Function (AI proxy) | `supabase/functions/mediscribe-generator/` |
| SSE streaming parser | `packages/app/src/emr/services/ai-assistant/streamingService.ts` |
| Streaming helpers | `packages/app/src/emr/services/ai-assistant/streamingHelpers.ts` |
| AI draft service (HTTP client pattern) | `packages/app/src/emr/services/messaging/aiDraftService.ts` |
| Environment switching script | `scripts/switch-env.sh` |

### Routing / Auth
| Need | Source path |
|---|---|
| Protected route wrapper | `packages/app/src/emr/components/ProtectedRoute/ProtectedRoute.tsx` |
| Layout shell pattern | `packages/app/src/emr/EMRPage.tsx` |

**DO NOT copy blindly.** Port one component at a time, under a specific spec's `/implement` phase, with testing.

---

## 🔧 Credentials Placeholder

**To be configured in `.env` when ready** (see `.env.example`):
- AWS: `AWS_REGION=eu-central-1`, access key + secret
- Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (TBD)
- Medplum: `MEDPLUM_CLIENT_ID`, `MEDPLUM_PROJECT_ID` (TBD — may use self-hosted FHIR instead)
- Orthanc: `ORTHANC_URL=http://localhost:8042` (local dev)

---

## 📚 Claude Code Assets Available

### Agents (general-purpose, carried over from MediMind)
- **coder** — feature implementation with project conventions
- **frontend-designer** — production-ready UI (MANDATORY for all UI work)
- **deep-web-researcher** — pre-implementation research (codebase + web)
- **code-refactorer** — clean up + improve structure
- **tech-doc-writer** — technical documentation

### Skills
- **deep-research** — 6-parallel-agent investigation before building features
- **fhir-developer** — FHIR R4 endpoints, validation, SMART-on-FHIR
- **testing-pipeline** — 10-agent QA orchestration with auto-fix loop
- **playwright** / **playwright-cli** — browser automation
- **frontend-design** — distinctive frontend interfaces
- **ui-ux-pro-max** — 50+ styles, 161 palettes, 57 font pairings, component search

### Speckit Commands
- `/speckit.constitution` — Project governance (RUN THIS FIRST)
- `/speckit.specify` — Feature specification
- `/speckit.clarify` — Targeted clarification questions
- `/speckit.plan` — Implementation design
- `/speckit.tasks` — Dependency-ordered task list
- `/speckit.implement` — Execute tasks
- `/speckit.analyze` — Cross-artifact consistency check
- `/speckit.checklist` — Custom checklist for feature
- `/speckit.taskstoissues` — Convert tasks → GitHub issues
- `/upgradeSpec` / `/upgradePlan` / `/upgradeTasks` — Parallel-agent upgraders
- `/promptOptimizer` — Lyra master prompt optimization
- `/updateCalude` — Auto-update this file

---

## 🚀 First-Time Setup Checklist

For a fresh clone or new team member:

1. Clone the repo
2. Install deps: `npm install` (at root)
3. Configure `.env` (copy from `.env.example`, fill real values)
4. **If contributing code for the first time, run `/speckit.constitution`** — align with project principles
5. Pick a feature from `specs/` or create a new one with `/speckit.specify`
6. Follow the workflow: plan → tasks → implement

---

## 🔗 External References

- **Medplum Docs:** https://www.medplum.com/docs
- **FHIR R4 Spec:** https://hl7.org/fhir/R4/
- **MONAI Framework:** https://monai.io/
- **Cornerstone3D:** https://www.cornerstonejs.org/
- **STU-Net repo:** https://github.com/uni-medical/STU-Net
- **LiLNet repo:** https://github.com/yangmeiyi/Liver
- **VISTA3D repo:** https://github.com/Project-MONAI/VISTA
- **MedSAM-2 repo:** https://github.com/MedicineToken/Medical-SAM2
- **Pictorial Couinaud:** https://github.com/xukun-zhang/Couinaud-Segmentation
- **CRLM-CT-Seg dataset:** Zenodo DOI 10.5281/zenodo.17574862 (April 2026)

---

## ⚖️ Compliance Discipline

**Every piece of code in this repo must assume future regulatory audit.** That means:

- Every ML model run logged (input hash, model version, output hash, timestamp) → AuditEvent
- Every DICOM transaction logged (study UID, who, when, from/to)
- Every patient-data touchpoint logged with minimum PHI exposure
- Model weights tracked via MLflow + DVC (data version control)
- All training datasets documented in SBOM-equivalent "dataset bill of materials"
- Apache 2.0 models only; verify license on every model before integration

If in doubt: ask. License mistakes + audit-trail gaps are expensive to fix later.

---

## 📚 Pre-Implementation Research Archive (READ THIS FIRST)

Comprehensive research was completed BEFORE this scaffold was built. Consolidated findings live in `docs/research/`. Every Claude Code session in this repo should treat these as authoritative context for the product, technical, regulatory, and commercial strategy.

**Read order:**
1. `docs/research/00-executive-brief.md` — one-page verdict + go/no-go
2. `docs/research/10-mvp-strategy.md` — zero-training cascaded pipeline plan
3. `docs/research/11-model-and-dataset-choices.md` — exact Apache 2.0 model stack
4. `docs/research/07-technical-architecture.md` — hybrid edge/cloud + AWS + stack

**Full index:** `docs/README.md`

**For the first `/speckit.specify`:** paste the prompt from `docs/research/12-spec-input-prompt.md`.
**For `/speckit.constitution`:** reference answers in `docs/CONSTITUTION-DRAFT.md`.

---

## 🎬 Next Steps (User Workflow After Scaffold)

1. Open this folder in Claude Code
2. Run `/speckit.constitution` — define LiverRa governing principles using `docs/CONSTITUTION-DRAFT.md` as reference
3. Run `/speckit.specify` with the prompt from `docs/research/12-spec-input-prompt.md` — first feature spec
4. Run `/upgradeSpec` to harden first draft with parallel analysis agents
5. Follow plan → tasks → analyze → implement cycle

**Remember:** First line of code gets written AFTER the constitution and the first feature spec are complete. Not before.
