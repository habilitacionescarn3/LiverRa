# @liverra/ml-inference

Python-based ML inference service for LiverRa.

## Architecture

- **FastAPI** — HTTP API layer
- **NVIDIA Triton Inference Server** — GPU model serving
- **MONAI** — medical imaging transforms + pipelines
- **PyTorch 2.3** — deep learning runtime

## Models (all Apache 2.0)

| Model | Role | Source |
|---|---|---|
| STU-Net (1.4B) | Parenchyma + metastases segmentation | github.com/uni-medical/STU-Net |
| Pictorial Couinaud | 8-segment topology parsing | github.com/xukun-zhang/Couinaud-Segmentation |
| LiLNet | 6-class tumor classification | github.com/yangmeiyi/Liver |
| VISTA3D | Interactive refinement | github.com/Project-MONAI/VISTA |
| MedSAM-2 | Zero-shot 3D tracking | github.com/MedicineToken/Medical-SAM2 |

## Structure

```
ml-inference/
├── src/                    # FastAPI app, inference orchestration
├── models/                 # Downloaded pretrained weights (gitignored)
├── pyproject.toml          # Python package config
└── requirements.txt        # pip install list
```

## Development (to be populated)

```bash
# Create venv
python -m venv .venv
source .venv/bin/activate

# Install deps
pip install -r requirements.txt

# Run API
uvicorn src.main:app --reload --port 8000
```

## Status

🚧 Stub. Full implementation will be driven by feature 001 spec via `/speckit.specify`.
