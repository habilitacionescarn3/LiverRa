# LiverRa — Model Integration Roadmap (v1)

> **Read me first.** This is the **single document** you (or a future Claude
> session) need to take the LiverRa codebase from "scaffold with empty model
> slots" to "real AI runs end-to-end on a powerful local PC, system is
> demo-ready."
>
> **Audience:** A Claude Code session on a powerful Linux/macOS PC with an
> NVIDIA GPU. The user is non-technical and will copy/paste the commands you
> tell them.
>
> **Scope:** Local-only execution. No AWS, no cloud, no production deploy —
> we just want the cascade to run on a real CT scan on this PC.
>
> **Authoritative source files** referenced by this roadmap (for cross-check):
> - `specs/001-zero-training-mvp/spec.md` (what we're building)
> - `specs/001-zero-training-mvp/plan.md` (how)
> - `specs/001-zero-training-mvp/tasks.md` (the 883-line task list — this
>   roadmap collapses the model-integration subset into a runnable order)
> - `specs/001-zero-training-mvp/contracts/triton-stages.md` (the I/O
>   contract every model.pt must conform to)
> - `docs/research/10-mvp-strategy.md` + `11-model-and-dataset-choices.md`
>   (model URLs, expected accuracy, licensing)

---

## TL;DR — The whole picture in 60 seconds

The factory is built. The robots are installed. **What's missing is the AI
"brains" that go into the robots, plus the gas line (GPU) to power them.**

| Layer | State | What's missing |
|---|---|---|
| Frontend (`packages/app`) | Real | Nothing — already speaks to the backend |
| FastAPI + Celery cascade | Real | Nothing — orchestration code is complete |
| Triton config files | Real | Nothing — 6 `config.pbtxt` files declare exact I/O shapes |
| **Model weights (`model.pt` files)** | Missing | **Download + convert from 5 upstream GitHub repos** |
| **PyTorch + MONAI installed** | Missing | They are commented out in `requirements.txt` |
| **GPU runtime** | Local CPU stub only | Need `docker-compose.gpu.override.yml` + NVIDIA Container Toolkit |
| FHIR persistence | Stubbed | `fhirClient.ts` is a `console.warn` — backend Supabase tables don't exist |

After you finish this roadmap:
1. You'll be able to drag-and-drop a real CT into the web app.
2. You'll watch a progress stream as 7 cascade stages run on your GPU.
3. You'll see liver volume, Couinaud segments, lesions, classifications, and
   FLR rendered in the 3D viewer.
4. You'll have a smoke-tested system you can demo to clinicians.

---

## How to use this document

1. **Open this file in a fresh Claude Code session on the powerful PC.**
2. Paste this initial prompt to Claude:

   > "Open `docs/plans/model-integration-roadmap.md` and walk me through it
   > step by step. Stop after each phase, show me the expected output, and
   > only proceed when I confirm. Treat me as non-technical — I will copy
   > and paste your commands."

3. Claude will execute one phase at a time. Each phase has:
   - **Goal** (plain English)
   - **Why** (the reason this step matters)
   - **Commands** (copy-paste)
   - **Verify** (how you know it worked)
   - **If broken** (the most common failure modes)

---

## Phase 0 — Hardware + OS prerequisites (no code yet)

### 0.1 What kind of PC do you need?

| Resource | Minimum | Recommended | Why |
|---|---|---|---|
| OS | Ubuntu 22.04 LTS or macOS 14+ | Ubuntu 22.04 LTS | NVIDIA Container Toolkit is Linux-first |
| GPU | NVIDIA, 16 GB VRAM | NVIDIA L4 or RTX 4090 (24 GB) | STU-Net 1.4 B params + Couinaud + LiLNet need ~14 GB warm |
| RAM | 32 GB | 64 GB | DICOM volumes + model preprocessing |
| Disk | 200 GB free | 500 GB SSD | Models ≈ 30 GB; sample DICOM ≈ 5 GB; weights cache; container layers |
| CUDA driver | 535+ | 550+ | Triton 24.10 wants CUDA 12.4 runtime |
| Network | 100 Mbps | 1 Gbps | First-time model download is ~25 GB |

**On macOS Apple Silicon:** the NVIDIA stack does not work. You can run
the FastAPI + Celery layer for development, but Triton inference must
happen on a Linux/NVIDIA box. If your "powerful PC" is an M-series Mac,
you can still complete Phases 1–4 (smoke tests on CPU/MPS) but Phases
5–8 require Linux + NVIDIA.

### 0.2 Verify the GPU works (Linux)

```bash
nvidia-smi
```

Expected: a table showing your GPU model, driver version (≥535), and
CUDA version (≥12.4). If this fails, install NVIDIA drivers first:

```bash
# Ubuntu 22.04
sudo apt update
sudo ubuntu-drivers autoinstall
sudo reboot
# After reboot, run nvidia-smi again.
```

### 0.3 Install Docker + NVIDIA Container Toolkit (Linux only)

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect.

# NVIDIA Container Toolkit (lets Docker see the GPU)
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify GPU is visible to Docker:
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

Expected: same `nvidia-smi` table as before, but now running inside a
container. **If this fails, do not proceed — Triton will not work.**

### 0.4 Install Node.js, Python, and other tooling

```bash
# Node.js 20 LTS (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20

# Python 3.11
sudo apt install -y python3.11 python3.11-venv python3.11-dev
# Verify: python3.11 --version

# uv (fast Python package manager — used by ml-inference)
curl -LsSf https://astral.sh/uv/install.sh | sh

# git, build tools, image libraries
sudo apt install -y git build-essential libgl1 libglib2.0-0 \
  libpostgresql-dev tesseract-ocr poppler-utils
```

---

## Phase 1 — Clone the codebase and verify the baseline scaffold

### 1.1 Clone

```bash
cd ~  # or wherever you want the project
git clone <YOUR_REPO_URL> LiverRa
cd LiverRa
```

(If the user already has the repo, just `cd` into it.)

### 1.2 Install JavaScript workspaces

```bash
npm install
```

Expected: turborepo installs deps for `packages/app`, `packages/core`,
`packages/imaging`, `packages/fhirtypes`. ~3 minutes on first run.

### 1.3 Set up the environment file

```bash
cp .env.example .env
```

For local dev, the defaults in `.env.example` already work. **Do not
fill AWS / Cognito / Sentry / KMS values** — those are for production.
Confirm these specific lines exist and are uncommented:

```
ML_INFERENCE_URL=http://localhost:8000
TRITON_URL=http://localhost:8001
MODEL_REGISTRY_PATH=./packages/ml-inference/triton-models
ORTHANC_URL=http://localhost:8042
DATABASE_URL=postgresql://liverra:liverra@localhost:5432/liverra
REDIS_URL=redis://localhost:6379/0
```

### 1.4 Bring up the local Docker stack (CPU mode for now)

```bash
./scripts/switch-env.sh local
docker compose -f deploy/local/docker-compose.yml up -d postgres redis orthanc minio mailhog
```

We deliberately **skip Triton** here — its image is huge and we'll
launch it with GPU support in Phase 5.

**Verify each container is healthy:**

```bash
docker compose -f deploy/local/docker-compose.yml ps
```

All five services should show `(healthy)`.

### 1.5 Start the frontend (sanity check)

```bash
cd packages/app
VITE_LIVERRA_DEV_BYPASS=true npx vite --port 5173
```

Open `http://localhost:5173`. You should see the LiverRa landing page.
The PACS page (`/pacs/studies`) will load but have zero studies — that's
fine. **Stop the dev server with Ctrl+C** and move on. We're just
proving the scaffold compiles.

---

## Phase 2 — Set up the Python ML environment

### 2.1 Uncomment the missing dependencies

Open `packages/ml-inference/requirements.txt` and **add these three
lines at the top** (they are currently commented out around line 8):

```
torch==2.4.1
torchvision==0.19.1
monai==1.4.0
```

> **Why these versions?** Triton 24.10 ships PyTorch 2.4.1 internally.
> Mismatched versions = silent kernel crashes. MONAI 1.4 is the latest
> stable line that supports PyTorch 2.4.

### 2.2 Create the Python virtual environment

```bash
cd packages/ml-inference

# Create venv with Python 3.11
python3.11 -m venv .venv
source .venv/bin/activate

# Install with CUDA 12.4 PyTorch wheels
pip install --upgrade pip
pip install torch==2.4.1 torchvision==0.19.1 \
  --index-url https://download.pytorch.org/whl/cu124

# Install the rest
pip install -r requirements.txt
```

This will take 5–15 minutes (PyTorch is ~2 GB).

### 2.3 Verify PyTorch sees the GPU

```bash
python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"
```

Expected:
```
CUDA available: True
GPU: NVIDIA L4   (or whatever GPU you have)
```

If `False`: torch was installed without CUDA. Re-run the `pip install
torch` line with the `--index-url` flag.

### 2.4 Verify MONAI imports cleanly

```bash
python -c "import monai; from monai.transforms import LoadImage, Resampled; print('MONAI', monai.__version__, 'OK')"
```

Expected: `MONAI 1.4.0 OK`.

---

## Phase 3 — Download model weights and convert to TorchScript

This is **the longest and most error-prone phase**. Plan ~4 hours.

### 3.1 Understand the goal

Triton (the inference server) needs each model packaged as
**TorchScript** — a serialized `.pt` file containing both the
architecture and weights.

The five upstream repos ship models in different formats. Our job:
1. **Download** the upstream checkpoint (`.pth` or `.pt` from GitHub releases).
2. **Load** it in PyTorch with the correct architecture class.
3. Switch the model into **inference mode** (`model.train(False)` —
   this is PyTorch's standard way to disable dropout/batchnorm updates;
   most upstream repos call the equivalent built-in method on the model
   object before tracing).
4. **Trace** it with `torch.jit.trace` to produce TorchScript.
5. **Save** at the exact path Triton expects.
6. **Hash** the file (SHA-256) for the audit trail.

Triton expects this layout (already in repo):

```
packages/ml-inference/triton-models/
├── stunet-parenchyma/
│   ├── config.pbtxt        ← already exists
│   └── 1/
│       └── model.pt        ← we create this
├── stunet-lesions/1/model.pt
├── couinaud-segments/1/model.pt
├── lilnet-classify/1/model.pt
├── vista3d-refine/1/model.pt
└── medsam2-track/1/model.pt
```

### 3.2 Reference table — exactly what to download

| Triton dir | Upstream repo | Checkpoint file | Approx size | Tier |
|---|---|---|---|---|
| `stunet-parenchyma` | https://github.com/uni-medical/STU-Net | `STU-Net-H-MR.pth` (or LiTS-finetuned) | ~5.5 GB | A (always loaded) |
| `stunet-lesions` | https://github.com/uni-medical/STU-Net | Same family, lesion-finetuned variant | ~5.5 GB | B (lazy) |
| `couinaud-segments` | https://github.com/xukun-zhang/Couinaud-Segmentation | `couinaud_best.pth` | ~400 MB | A |
| `lilnet-classify` | https://github.com/yangmeiyi/Liver | `lilnet_6class.pth` | ~200 MB | B |
| `vista3d-refine` | https://github.com/Project-MONAI/VISTA | MONAI bundle (`vista3d_*.zip`) | ~1.2 GB | B |
| `medsam2-track` | https://github.com/MedicineToken/Medical-SAM2 | `MedSAM2_pretrain.pth` | ~700 MB | B |

> **License audit:** Every one of these is **Apache 2.0** per
> `docs/research/11-model-and-dataset-choices.md`. Before downloading,
> open each repo's LICENSE file in a browser and confirm. Save a
> screenshot to `docs/compliance/dataset-licenses/<model>.png` —
> required by Constitution Principle II.

### 3.3 The download + conversion script — pattern

Create this file:

```
packages/ml-inference/scripts/download_and_convert_models.py
```

Claude in the new session should write the script. Each model follows
this 6-step pattern:

1. **Download upstream `.pth`** with `urllib.request.urlretrieve()` to
   a temp path (e.g. `/tmp/stunet_parenchyma.pth`). Skip if already
   downloaded.
2. **Clone the upstream repo** as a git submodule or sibling directory
   (only the architecture-class file is needed). Add to PYTHONPATH so
   the `import` works.
3. **Instantiate the architecture** with constructor args matching the
   shapes in `config.pbtxt`. Example for STU-Net parenchyma:
   `model = STUNet(in_channels=4, out_channels=1, ...)`.
4. **Load the state dict:**
   `model.load_state_dict(torch.load(weights_path, map_location='cpu'))`.
5. **Switch to inference mode** (the model object's standard
   inference-mode method — see PyTorch docs; all five upstream repos'
   READMEs show the call). Then convert to half-precision if the
   `config.pbtxt` requires FP16: `model = model.half()`.
6. **Trace + save:**
   ```python
   dummy = torch.randn(1, 4, 128, 128, 128, dtype=torch.float16)
   traced = torch.jit.trace(model, dummy)
   target = REPO_ROOT / "packages/ml-inference/triton-models/stunet-parenchyma/1/model.pt"
   target.parent.mkdir(parents=True, exist_ok=True)
   traced.save(str(target))
   sha = hashlib.sha256(target.read_bytes()).hexdigest()
   print(f"Saved {target} sha256={sha}")
   ```

> **Critical:** the dummy-input shape and dtype **must** match what's
> in `config.pbtxt`. If you trace with `[4, 128, 128, 128]` but the
> config says `[1, 1, Z, 512, 512]`, Triton will reject the model.
> Every config has shape comments at the top — read them first.

### 3.4 Per-model gotchas

These are the traps that trip up most integrations. **Read these
before starting Phase 3.3 for each model.**

#### STU-Net (parenchyma + lesions)
- The upstream repo uses **nnU-Net's framework** under the hood.
  Easiest path: clone the repo, install its `requirements.txt` into a
  separate sub-venv, follow their inference example to get a working
  loadable model object, then trace.
- **Patch-based inference** — STU-Net is trained on `128³` patches.
  Your input is a full liver CT (`Z × 512 × 512`). The Triton config
  expects `128³` patches; sliding-window aggregation happens in
  `src/tasks/parenchyma.py` (already implemented — see code).
- 4-channel input means `[non_contrast, arterial, portal_venous,
  delayed]`. If your sample DICOM has only 1 phase, fill the missing
  channels with the same volume copied (or zeros — STU-Net will tolerate).

#### Pictorial Couinaud
- The upstream repo's checkpoint expects **two inputs**: the CT
  volume AND the parenchyma mask from Stage 1. The trace must include
  both as a tuple: `traced = torch.jit.trace(model, (ct, mask))`.
- Outputs **two heads**: an 8-channel softmax (Couinaud regions I–VIII)
  and a 2-channel vessel mask (portal + hepatic). See
  `triton-models/couinaud-segments/config.pbtxt` for the exact tensor
  layout.

#### LiLNet
- Input is **per-lesion crop**, not whole liver — `4 phases × 96³`.
  Don't try to feed it the full volume.
- Output is **logits, not probabilities**. The temperature-scaling and
  softmax are applied task-side in `src/tasks/classification.py`.
- Class order is **fixed**: `[hcc, icc, metastasis, fnh, hemangioma,
  cyst]`. If you change this, you'll get wrong tumor labels in the report.

#### VISTA3D
- This one ships as a **MONAI Bundle** (`.zip` containing `model.pt`,
  `metadata.json`, configs). Use `monai.bundle.load_bundle()` to load,
  then export the model to TorchScript.
- Has **5 inputs** (CT crop, current mask, click point, click mode,
  anatomy class). Tracing requires all 5 dummy tensors.
- Per `triton-models/vista3d-refine/config.pbtxt`, the volume is a
  `128³` crop around the click — not the full volume. The orchestrator
  crops before sending.

#### MedSAM-2
- Variable-Z input (`[1, 1, Z, 512, 512]` where `Z` varies per scan).
  Trace with a representative `Z` (e.g., 80 slices) and rely on
  Triton's dynamic-axis handling.
- Single point prompt as second input: `[1, 3]` int32 = `(z, y, x)` in
  voxel coordinates.
- Heavy memory — keep it Tier-B.

### 3.5 Run the conversion

```bash
cd packages/ml-inference
source .venv/bin/activate
python scripts/download_and_convert_models.py --model all
```

This will take 30–90 minutes (mostly download time).

**Verify all six files exist:**

```bash
find packages/ml-inference/triton-models -name "model.pt" -exec ls -lh {} \;
```

You should see six files, sizes roughly matching the table in §3.2.

### 3.6 Save the SHA-256 manifest

The script should also write `packages/ml-inference/triton-models/MODEL_HASHES.txt`:

```
liverra-stunet-parenchyma  sha256:abc123...  source:https://...  license:Apache-2.0
liverra-stunet-lesions     sha256:def456...  ...
...
```

This is required by the **MBoM (Model Bill of Materials)** service at
`packages/ml-inference/src/services/mbom/reader.py`, which logs these
hashes into every `AuditEvent`.

---

## Phase 4 — Smoke test ONE model in isolation

**Do not skip this.** It is faster to debug a wrong shape in 10 lines
of Python than in a 7-stage Celery cascade.

### 4.1 Get a sample CT scan

```bash
./scripts/fetch-sample-dicom.sh
```

This downloads ~40 anonymized DICOM instances from a public demo
server into `fixtures/dicom/`. The CT in there is single-phase (not
the full 4-phase liver CT we ideally want), but it's enough to confirm
plumbing.

If that script fails or you need a real 4-phase liver CT:
- **CRLM-CT-Seg** dataset on Zenodo (DOI 10.5281/zenodo.17574862) is
  the canonical liver-CT-with-FLR-ground-truth dataset. License: CC BY 4.0
  (verify on Zenodo before download).
- Or: ask Dr. Gogichaishvili at Geo Hospitals for an anonymized
  4-phase scan from their archive (DPA required for any later use).

### 4.2 Write the smoke-test script

Create `packages/ml-inference/scripts/smoke_stunet_parenchyma.py` with
this skeleton:

```python
"""Run STU-Net parenchyma on a single CT, save the predicted mask as NIfTI.
Bypasses Triton, FastAPI, Celery — just torch + monai."""
from pathlib import Path
import torch
import numpy as np
import nibabel as nib
from monai.transforms import LoadImage, Spacing, ScaleIntensityRange
from monai.inferers import sliding_window_inference

REPO = Path(__file__).resolve().parents[3]
DICOM_DIR = REPO / "fixtures/dicom"
MODEL_PT = REPO / "packages/ml-inference/triton-models/stunet-parenchyma/1/model.pt"
OUT_NII = REPO / "tmp/parenchyma_pred.nii.gz"

# 1. Load DICOM series → 3D volume
loader = LoadImage(image_only=False, ensure_channel_first=True)
volume, meta = loader(str(DICOM_DIR))

# 2. Resample to 1.5mm isotropic + window HU
resample = Spacing(pixdim=(1.5, 1.5, 1.5), mode="bilinear")
window = ScaleIntensityRange(a_min=-150, a_max=250, b_min=0, b_max=1, clip=True)
volume = resample(volume)
volume = window(volume)

# 3. Build 4-channel tensor (replicate single phase across 4 channels for now)
volume_4ch = volume.repeat(4, 1, 1, 1).unsqueeze(0).half().cuda()

# 4. Load TorchScript model and switch to inference mode
model = torch.jit.load(str(MODEL_PT)).cuda()
model.train(False)  # disables dropout/batchnorm updates

# 5. Sliding-window inference (128³ patches, 50% overlap)
with torch.inference_mode():
    pred = sliding_window_inference(
        volume_4ch, roi_size=(128, 128, 128), sw_batch_size=1,
        predictor=model, overlap=0.5
    )

# 6. Threshold + save
mask = (pred.sigmoid() > 0.5).cpu().numpy().astype(np.uint8).squeeze()
OUT_NII.parent.mkdir(parents=True, exist_ok=True)
nib.save(nib.Nifti1Image(mask, np.eye(4)), str(OUT_NII))
print(f"Saved {OUT_NII} ({mask.sum()} positive voxels)")
```

### 4.3 Run it

```bash
cd packages/ml-inference
python scripts/smoke_stunet_parenchyma.py
```

Expected: a `.nii.gz` file in `tmp/`. Open it in **3D Slicer** (free
download from slicer.org) on top of the CT — you should see the liver
filled in.

**This is your first proof that AI is actually working.** Take a screenshot.

### 4.4 Repeat for the other 4 models (optional but recommended)

Same pattern, different shapes:
- `smoke_couinaud.py` — needs parenchyma mask from §4.3 as second input
- `smoke_stunet_lesions.py` — needs parenchyma mask
- `smoke_lilnet.py` — needs a lesion bbox to crop a 96³ patch
- `smoke_vista3d.py` and `smoke_medsam2.py` — interactive, can defer to Phase 7

---

## Phase 5 — Boot Triton with real weights and GPU

### 5.1 Create the missing GPU compose override

The repo references `deploy/local/docker-compose.gpu.override.yml` in
CI but the file doesn't exist locally. Create it:

```yaml
# deploy/local/docker-compose.gpu.override.yml
services:
  triton:
    image: nvcr.io/nvidia/tritonserver:24.10-py3
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    command: >
      tritonserver
      --model-repository=/models
      --model-control-mode=explicit
      --load-model=liverra-stunet-parenchyma
      --load-model=liverra-stunet-lesions
      --load-model=liverra-couinaud-segments
      --log-verbose=1
    volumes:
      - ../../packages/ml-inference/triton-models:/models:ro
    ports:
      - "8000:8000"   # HTTP
      - "8001:8001"   # gRPC
      - "8002:8002"   # metrics
```

Note: only Tier-A models are pre-loaded. Tier-B (lilnet, vista3d,
medsam2) will lazy-load on first inference call.

### 5.2 Boot Triton

```bash
docker compose \
  -f deploy/local/docker-compose.yml \
  -f deploy/local/docker-compose.gpu.override.yml \
  up -d triton

# Watch logs
docker compose -f deploy/local/docker-compose.yml logs -f triton
```

Look for these lines (one per Tier-A model):
```
Successfully loaded 'liverra-stunet-parenchyma' version 1
Successfully loaded 'liverra-stunet-lesions' version 1
Successfully loaded 'liverra-couinaud-segments' version 1
```

If you see `Failed to load 'liverra-...'`, the most common causes:
- **Shape mismatch:** the traced model.pt has different I/O than
  config.pbtxt. Re-run conversion with corrected dummy input.
- **CUDA OOM:** GPU has < 16 GB VRAM. Reduce models pre-loaded
  (remove `--load-model` lines for one of them).
- **dtype mismatch:** config.pbtxt says FP16 but model was traced as
  FP32. Re-run conversion with `model.half()`.

### 5.3 Verify Triton serves real inference

```bash
# Health check
curl http://localhost:8000/v2/health/ready
# Expected: HTTP 200, empty body

# Model status
curl http://localhost:8000/v2/models/liverra-stunet-parenchyma
# Expected: JSON with state "READY"

# From inside the venv, run the existing contract test:
cd packages/ml-inference
source .venv/bin/activate
pytest tests/contracts/triton_stage_shapes.py -v
```

This existing test sends a properly-shaped dummy tensor to each model
and asserts the output shape matches the contract. **If it passes,
your Triton is real.**

---

## Phase 6 — Run the full cascade end-to-end

### 6.1 Run database migrations

The cascade writes to Postgres (`AuditEvent`, `Analysis`,
`PipelineCheckpoint`, `Lesion`, `Segmentation`). Apply the schema:

```bash
cd packages/ml-inference
source .venv/bin/activate
alembic upgrade head
```

If `alembic upgrade head` fails with "no migrations found," run:
```bash
ls src/db/migrations/versions/
```
If empty, the migrations are part of the larger `tasks.md` work
(T044–T100). **Stop here and ask Claude to generate them**, OR
temporarily comment out DB writes by setting `LIVERRA_SKIP_PERSISTENCE=true`
in `.env` (this exists as a dev escape hatch).

### 6.2 Start the FastAPI orchestrator

```bash
# Terminal 1
cd packages/ml-inference
source .venv/bin/activate
uvicorn src.main:app --reload --port 8000 --host 0.0.0.0
```

Wait for `Application startup complete`.

### 6.3 Start the Celery worker

```bash
# Terminal 2
cd packages/ml-inference
source .venv/bin/activate
celery -A src.workers.app worker --loglevel=info --concurrency=1
```

> **Why `--concurrency=1`?** A single GPU can't run two cascade stages
> in parallel (VRAM contention). For local dev, serial is correct.

### 6.4 Start the frontend

```bash
# Terminal 3
cd packages/app
VITE_LIVERRA_DEV_BYPASS=true npx vite --port 5173
```

### 6.5 Trigger the cascade — option A: via the UI

1. Open `http://localhost:5173/cases`.
2. Click "New Case" / "Upload."
3. Drag the contents of `fixtures/dicom/` into the dropzone.
4. The upload progresses, then an SSE stream shows stage-by-stage
   progress: `anonymization → parenchyma → vessels → couinaud →
   lesion_detection → classification → flr_init`.
5. Open the case detail page. Liver volume, segments, lesions, and
   FLR should populate as stages finish.

### 6.6 Trigger the cascade — option B: via CLI (faster to debug)

```bash
# From repo root
curl -X POST http://localhost:8000/api/v1/analyses \
  -H "Content-Type: application/json" \
  -d '{"study_uid": "<paste study uid from Orthanc>"}'

# Watch the SSE stream:
curl -N http://localhost:8000/api/v1/analyses/<analysis_id>/stream
```

### 6.7 Expected timing on a single L4 GPU

| Stage | Budget (spec) | Realistic with cold weights |
|---|---|---|
| Anonymization | 15 s | 15–20 s |
| Parenchyma (STU-Net) | 35 s | 30–60 s |
| Vessels + Couinaud (parallel) | 20 s | 20–40 s |
| Lesion detection | 20 s | 20–35 s |
| Classification (per lesion) | 20 s | 5 s × N lesions |
| FLR init | 5 s | < 1 s |
| **Total** | **≤ 120 s** | **~90–180 s first run; ~60 s warm** |

If your run is much slower, suspect:
- Triton models are still on CPU (`KIND_CPU` instead of `KIND_GPU` in config.pbtxt)
- FP32 inference instead of FP16 (check the `optimization` block in config.pbtxt)
- Sliding-window overlap too high (50% is correct; 75% is 4× slower)

### 6.8 If a stage fails

The cascade has **partial-result preservation**. Check:

```bash
# Find the analysis row
psql $DATABASE_URL -c "SELECT id, status, current_stage, last_error FROM analyses ORDER BY created_at DESC LIMIT 5;"

# Check the per-stage checkpoint
psql $DATABASE_URL -c "SELECT analysis_id, stage_no, stage_name, status, error_message FROM pipeline_checkpoints WHERE analysis_id = '<id>' ORDER BY stage_no;"
```

Common failures:
- **Sanity check failed** (e.g., parenchyma volume out of range) — your
  test DICOM probably isn't a real liver CT. Try a different sample.
- **Triton timeout** — model is too slow on your GPU. Increase the
  per-stage timeout in `src/orchestrator/cascade.py:246` for dev.
- **Shape mismatch at task layer** — preprocessing in `src/tasks/<stage>.py`
  isn't producing the shape config.pbtxt expects. Run the Phase 4
  smoke script to verify the model alone works.

---

## Phase 7 — Wire interactive refinement (VISTA3D + MedSAM-2)

This is **optional for "system testable"** but required for the full
US-3/US-4 demo (surgeon edits AI masks).

### 7.1 What needs to happen

1. Triton must lazy-load `liverra-vista3d-refine` and `liverra-medsam2-track`
   on first call. Verify by clicking "Refine" in the viewer — first
   click takes ~15 s (cold load); subsequent clicks ~2 s.
2. The frontend already calls `POST /api/v1/reviews/{id}/mask-refine`
   (see `useRefinementDispatch.ts`).
3. The backend route exists (`src/api/review.py`) but verify it's
   mounted in `src/main.py:266` — there's a TODO comment indicating
   review.py may be unwired.

### 7.2 Mount the review router

If `src/main.py` shows `# TODO: mount review router`, add:

```python
from src.api import review
app.include_router(review.router, prefix="/api/v1")
```

Restart uvicorn.

### 7.3 Test interactive refinement

In the UI:
1. Open a finished case.
2. Click "Acquire review seat."
3. In the 3D viewer, click anywhere inside the parenchyma mask.
4. The mask should update within 30 s (per FR-015).

If nothing happens, check the Celery worker logs for the VISTA3D task.

---

## Phase 8 — Run the regression test suite

The repo has 28 pytest tests under `packages/ml-inference/tests/`,
with golden-fixture tests for each model (Dice, IoU, accuracy).

### 8.1 Set the fixtures path

The tests need golden fixtures. There are two options:

**Option A (recommended for first run):** point the env var at a
local mount with sample fixtures:

```bash
export LIVERRA_GOLDEN_FIXTURES_DIR=$(pwd)/fixtures/golden
mkdir -p $LIVERRA_GOLDEN_FIXTURES_DIR
# Initially empty — most regression tests will skip with "fixtures not found"
```

**Option B (full validation):** ask Dr. Gogichaishvili / clinical team
for the curated golden set. ~5 GB. Place at the same path.

### 8.2 Run the tests

```bash
cd packages/ml-inference
source .venv/bin/activate

# Contract tests (fast — verify Triton I/O shapes match configs)
pytest tests/contracts -v

# Regression tests (slow — runs each model on golden fixtures)
pytest tests/regression -v

# Integration tests (medium — full cascade on test data)
pytest tests/integration -v

# Security tests (PHI scrubber, RBAC)
pytest tests/security -v
```

### 8.3 Acceptance thresholds (from the spec)

| Test | Threshold | File |
|---|---|---|
| Parenchyma Dice | ≥ 0.92 | `tests/regression/test_parenchyma_dice.py` |
| Couinaud IoU | ≥ 0.70 | `tests/regression/test_couinaud_iou.py` |
| LiLNet Top-1 accuracy | ≥ 0.82 | `tests/regression/test_lilnet_accuracy.py` |
| VISTA3D Δ-Dice (3 clicks) | ≥ +0.05 | `tests/regression/test_vista3d_delta_dice.py` |
| MedSAM-2 slice-to-slice IoU | ≥ 0.85 | `tests/regression/test_medsam2_iou.py` |

**If a test fails by a wide margin** (e.g., Dice 0.4 instead of 0.92),
the model conversion in Phase 3 produced a broken `.pt`. Most likely
cause: dummy-input dtype/shape mismatch during tracing. Re-do that
model's conversion.

---

## Phase 9 — Demo readiness checklist

Before declaring "system testable":

- [ ] All 6 Triton models load on Triton startup (or lazy-load on first call).
- [ ] `pytest tests/contracts -v` passes (Triton I/O matches configs).
- [ ] One full DICOM upload completes the cascade end-to-end in ≤180 s.
- [ ] The case-detail page shows: liver volume, 8 Couinaud segments,
      vessel trunks, lesion list with classifications, FLR percentage.
- [ ] At least one **regression test** (parenchyma Dice) passes on golden fixtures.
- [ ] Audit events visible: `psql $DATABASE_URL -c "SELECT count(*) FROM audit_events;"` > 0.
- [ ] Refinement: clicking on a mask in the 3D viewer triggers VISTA3D
      and updates the mask within 30 s.
- [ ] All five RUO ("Research Use Only") watermarks visible:
  - [ ] Watermark on the 3D viewer
  - [ ] Watermark on the lesion list
  - [ ] Watermark on the FLR panel
  - [ ] Watermark on the finalize wizard
  - [ ] Watermark on the exported PDF report

---

## Reference: Project file map

The Claude session in the new PC should know these paths:

```
LiverRa/
├── docs/plans/model-integration-roadmap.md   ← THIS FILE
├── docs/research/                            ← model rationale, expected accuracy
│   ├── 10-mvp-strategy.md
│   └── 11-model-and-dataset-choices.md
├── specs/001-zero-training-mvp/
│   ├── spec.md              ← what we're building
│   ├── plan.md              ← how we're building
│   ├── tasks.md             ← 883-line task list (model integration ≈ T155–T253)
│   ├── quickstart.md        ← original onboarding doc (some commands outdated)
│   └── contracts/
│       ├── triton-stages.md ← I/O contract per model — ground truth for tracing shapes
│       └── api-openapi.yaml ← REST API spec
├── packages/ml-inference/
│   ├── requirements.txt              ← MUST uncomment torch/monai (Phase 2.1)
│   ├── src/
│   │   ├── main.py                   ← FastAPI entrypoint
│   │   ├── orchestrator/cascade.py   ← Celery task graph
│   │   ├── services/triton/client.py ← gRPC wrapper, Tier-A/B logic
│   │   ├── tasks/                    ← per-stage Celery tasks
│   │   └── workers/app.py            ← Celery app config
│   ├── triton-models/
│   │   ├── stunet-parenchyma/{config.pbtxt, 1/model.pt ←MISSING}
│   │   ├── stunet-lesions/{config.pbtxt, 1/model.pt ←MISSING}
│   │   ├── couinaud-segments/{config.pbtxt, 1/model.pt ←MISSING}
│   │   ├── lilnet-classify/{config.pbtxt, 1/model.pt ←MISSING}
│   │   ├── vista3d-refine/{config.pbtxt, 1/model.pt ←MISSING}
│   │   └── medsam2-track/{config.pbtxt, 1/model.pt ←MISSING}
│   ├── tests/
│   │   ├── contracts/triton_stage_shapes.py  ← Phase 5.3 verification
│   │   ├── regression/                       ← Phase 8 acceptance
│   │   └── integration/
│   └── scripts/
│       └── download_and_convert_models.py    ← TO CREATE in Phase 3.3
├── packages/app/                             ← frontend (already real)
├── deploy/local/
│   ├── docker-compose.yml                    ← base stack
│   └── docker-compose.gpu.override.yml       ← TO CREATE in Phase 5.1
├── fixtures/dicom/                           ← sample CT (Phase 4.1)
├── scripts/
│   ├── switch-env.sh
│   ├── fetch-sample-dicom.sh
│   ├── seed-orthanc.sh
│   └── model-bom.sh                          ← MBoM/license verification
└── .env                                      ← from .env.example (Phase 1.3)
```

---

## Reference: The 5 models — license, role, expected accuracy

| Model | Role | License | Expected Dice/Acc | Tier | Notes |
|---|---|---|---|---|---|
| STU-Net (parenchyma) | Liver outline | Apache 2.0 | Dice 0.92–0.94 | A | 1.4 B params, biggest VRAM |
| STU-Net (lesions) | Tumor mask | Apache 2.0 | Sensitivity 78–88% (≥10 mm) | B | Same family, lesion-finetuned |
| Pictorial Couinaud | 8 segments + vessels | Apache 2.0 | Per-seg Dice 0.82–0.88 | A | Joint output: segments + vessels |
| LiLNet | 6-class tumor | Apache 2.0 | Top-1 acc 75–82% | B | Per-lesion, 96³ crop |
| VISTA3D | Interactive edit | Apache 2.0 | +0.05 Δ-Dice / 3 clicks | B | NVIDIA + MONAI |
| MedSAM-2 | One-prompt 3D | Apache 2.0 | Slice-IoU ≥ 0.90 | B | Variable Z, full 512² |

**Forbidden** (do not substitute these in even if upstream looks better):
- TotalSegmentator's specialized sub-modules (paid commercial license)
- Any model with GPL / AGPL / CC-NC / CC-SA licensing
- Custom-trained variants on LiTS17, MSD Task 8, 3D-IRCADb, CHAOS
  (research-only datasets — using them for commercial training is a
  legal trap; see Constitution Principle II).

---

## Reference: Common error → fix table

| Symptom | Likely cause | Fix |
|---|---|---|
| `nvidia-smi: command not found` | NVIDIA driver not installed | Phase 0.2 |
| Docker can't see GPU | NVIDIA Container Toolkit missing | Phase 0.3 |
| `torch.cuda.is_available() == False` | PyTorch installed without CUDA | Phase 2.2 — use `--index-url` |
| Triton: `Failed to load 'liverra-...'` | Shape/dtype mismatch in `model.pt` | Re-trace with correct dummy tensor (Phase 3.3) |
| Triton: `CUDA out of memory` | Too many Tier-A models for VRAM | Reduce `--load-model` flags in compose |
| Cascade stage hangs | Celery worker not running, or Triton dead | `docker compose ps` + restart worker |
| `psql: command not found` | Postgres CLI missing | `sudo apt install postgresql-client` |
| Frontend "Network Error" on upload | FastAPI not running | Phase 6.2 |
| 5174 in use | Another vite running | `lsof -i :5173` then `kill <pid>` |
| Cascade returns "sanity check failed" | Sample CT isn't a liver scan | Get a real 4-phase liver CT |
| Regression test Dice < 0.5 | Bad model.pt conversion | Re-do that model's Phase 3 |

---

## What this roadmap does NOT cover (deferred)

These are real work items but **not required for "system testable" on
a local PC**. Defer until after a clean Phase 9 pass.

1. **AWS deployment** — `deploy/production/docker-compose.yml`,
   S3 weight pulls, RDS, KMS, Cognito.
2. **Supabase Edge Functions** — `supabase/functions/` is empty.
   For local dev, the FastAPI backend handles all persistence.
3. **MLflow + DVC integration** — Constitution Principle V requires
   model lineage tracking. The MBoM service stub exists; full MLflow
   wire-up is a separate spec.
4. **CE MDR audit artifacts** — DHF, risk file, clinical evaluation
   report. Not engineering work; clinical/regulatory team owns this.
5. **Custom training / fine-tuning** — explicitly out of v1 scope. The
   zero-training pipeline ships first; fine-tuning is Phase 3 (Months 4–9).
6. **Multi-tenancy** — single hospital per deployment in v1.
7. **MRI support** — CT-only in v1; HCC gadoxetic-acid MRI is v2.

---

## Appendix A — How to start a fresh Claude Code session and execute this

Once you're on the powerful PC with the repo cloned:

1. Open the project in Claude Code:
   ```bash
   cd ~/LiverRa
   claude  # if you have the CLI, otherwise open via Desktop app
   ```

2. Paste this prompt:

   ```
   Read docs/plans/model-integration-roadmap.md. Walk me through it
   phase by phase. For each phase:
   1. State the goal in one sentence.
   2. Give me the exact commands to copy-paste.
   3. Wait for me to run them and paste the output.
   4. Confirm the verify-step passed before moving on.
   5. If something failed, diagnose and fix before proceeding.

   I am non-technical. Explain in plain language. Treat the model
   weights conversion (Phase 3) as the highest-risk step and double-
   check shapes against config.pbtxt files before tracing.

   Start with Phase 0.1 — verifying my hardware.
   ```

3. From there, the new Claude session has everything it needs.

---

## Appendix B — Estimated total time

| Phase | What | Time |
|---|---|---|
| 0 | Hardware + drivers + Docker + NVIDIA Toolkit | 1–2 h |
| 1 | Clone + npm install + base stack up | 30 min |
| 2 | Python venv + torch/monai install | 30 min |
| 3 | Download + convert 5 model weights | **3–5 h** ← longest |
| 4 | Smoke-test 1 model in isolation | 1 h |
| 5 | Boot Triton with real weights | 30 min |
| 6 | Run full cascade end-to-end | 1 h |
| 7 | Wire interactive refinement | 1 h |
| 8 | Run regression tests | 1 h |
| 9 | Demo readiness checklist | 30 min |
| **Total** | | **~10–14 h** of focused work |

**Spread across 2 days is realistic.** Day 1: phases 0–4. Day 2: phases 5–9.

---

*Roadmap drafted 2026-04-30. Based on codebase inventory of LiverRa
commit `ad00963` and spec `specs/001-zero-training-mvp/` v1. If the
codebase changes substantially after this date, re-run the inventory
phase before following this guide.*
