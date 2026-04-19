# LiverRa

**AI-powered liver diagnostics & surgical planning for HPB surgeons.**

---

## What is this?

LiverRa is an AI platform that processes CT/MRI scans of the liver and produces:
- Volumetric liver segmentation
- Couinaud 8-segment parsing
- Portal + hepatic vein tracing
- Tumor detection + classification (HCC, hemangioma, metastasis, FNH, ICC, cyst)
- Future Liver Remnant (FLR) calculation
- Surgeon-ready 3D surgical plan + structured PDF report

Built for hepatobiliary (HPB) surgeons and abdominal radiologists. CE MDR Class IIb SaMD in development.

---

## Project Status

🚧 **Pre-implementation scaffold.** No application code exists yet.

The project uses a **spec-driven development workflow**. Before any code is written, a feature must be specified and planned.

---

## Getting Started

### Prerequisites
- Node.js 20+
- Python 3.11+
- Docker Desktop
- Claude Code CLI

### First-Time Setup

1. **Install dependencies** (once package.json is populated):
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Inside Claude Code, initialize the project**:
   - Run `/speckit.constitution` — define governing principles
   - Run `/speckit.specify "<feature description>"` — first feature spec

### Development Commands (placeholders — filled by first implementation)

```bash
npm run dev              # Start Vite dev server on port 3000
npm run build            # Build all packages
npm test                 # Run all tests
npm run lint             # Lint all packages
```

---

## Monorepo Structure

```
LiverRa/
├── packages/
│   ├── app/              # Vite + React 19 + Mantine 7 frontend
│   ├── core/             # Shared utilities, FHIR helpers
│   ├── imaging/          # DICOM, Cornerstone3D, PACS client
│   ├── ml-inference/     # Python: FastAPI + Triton + MONAI
│   └── fhirtypes/        # FHIR R4 types with liver extensions
├── deploy/               # Docker stacks
├── supabase/             # Edge Functions
├── pacs/                 # Orthanc + nginx edge appliance
├── specs/                # Feature specs
├── .claude/              # Claude Code config
└── .specify/             # Speckit spec system
```

---

## Tech Stack

**Frontend:** Vite · React 19 · TypeScript 5 · Mantine UI 7 · OHIF Viewer · Cornerstone3D
**Backend:** Python 3.11 · FastAPI · MONAI · PyTorch · NVIDIA Triton
**Infrastructure:** AWS (eu-central-1) · Supabase · Medplum FHIR · Orthanc PACS
**Monorepo:** Turborepo

### AI Models (all Apache 2.0)

- **STU-Net (1.4B)** — parenchyma + metastases
- **Pictorial Couinaud** — 8-segment topological parsing
- **LiLNet** — 6-class tumor classification (94.7% accuracy)
- **VISTA3D** — interactive refinement
- **MedSAM-2** — zero-shot 3D tracking

---

## Workflow

Every feature follows this sequence:

```
/speckit.specify    → spec.md
/speckit.clarify    → (optional) resolve ambiguities
/speckit.plan       → plan.md + data-model.md + research.md + contracts/
/speckit.tasks      → tasks.md (dependency-ordered)
/speckit.analyze    → consistency check
/speckit.implement  → executes the plan
```

See `CLAUDE.md` for full workflow rules.

---

## License

Proprietary. All rights reserved.

ML model weights (STU-Net, LiLNet, VISTA3D, MedSAM-2, Pictorial Couinaud) are licensed under Apache 2.0 from their respective upstream projects.

Research datasets (LiTS, MSD Task 8, 3D-IRCADb, CHAOS, etc.) are used only for evaluation/benchmarking, never for commercial training — see CLAUDE.md § Model Licensing Discipline.

---

## Contact

**Dr. Levan Gogichaishvili**
HPB & Transplant Surgeon | Head of Surgery, Geo Hospitals
President, Georgian Society of Visceral Surgery (GSVS)
Regional Lead, ESSO Membership Committee
https://www.livernet.org
