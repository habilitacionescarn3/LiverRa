"""Phase 4 smoke test — run STU-Net parenchyma on a real CT directly.

Bypasses Triton, FastAPI, and Celery. Loads the TorchScript at
``triton-models/stunet-parenchyma/1/model.pt`` directly and runs sliding-
window inference over a 3D volume reconstructed from the sample DICOM
series in ``fixtures/dicom/``. Saves the predicted parenchyma mask as a
NIfTI file in ``tmp/``.

Notes for ``--mode stub`` runs:
- The stub model is a 1×1×1 conv + sigmoid, not real STU-Net. The output
  mask reflects whichever voxels happened to land above 0.5 after the
  trivial transform — it is NOT a real liver. This script's purpose is to
  validate the orchestrator → model.pt call path, NOT clinical accuracy.

Usage:
    conda activate liverra-ml
    python packages/ml-inference/scripts/smoke_stunet_parenchyma.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import torch
from monai.inferers import sliding_window_inference
from monai.transforms import (
    EnsureChannelFirst,
    LoadImage,
    ScaleIntensityRange,
    Spacing,
)

REPO = Path(__file__).resolve().parents[3]
DICOM_DIR = REPO / "fixtures/dicom"
MODEL_PT = REPO / "packages/ml-inference/triton-models/stunet-parenchyma/1/model.pt"
OUT_NII = REPO / "tmp/parenchyma_pred.nii.gz"


def load_volume(dicom_dir: Path) -> tuple[torch.Tensor, dict]:
    """Load the DICOM series as a single 3D volume tensor.

    Returns ``(volume[1, D, H, W], meta)``. The ensure-channel-first transform
    yields one channel because the source is single-phase grayscale CT.
    """
    print(f"  loading DICOM series from {dicom_dir.relative_to(REPO)} …")
    loader = LoadImage(image_only=False, ensure_channel_first=True)
    volume, meta = loader(str(dicom_dir))
    return volume, meta


def preprocess(volume: torch.Tensor) -> torch.Tensor:
    """Resample to 1.5 mm isotropic, window HU to (-150, 250) → (0, 1)."""
    print(f"  raw volume shape: {tuple(volume.shape)}")
    resample = Spacing(pixdim=(1.5, 1.5, 1.5), mode="bilinear")
    window = ScaleIntensityRange(a_min=-150, a_max=250, b_min=0, b_max=1, clip=True)
    volume = resample(volume)
    volume = window(volume)
    print(f"  resampled + windowed shape: {tuple(volume.shape)}")
    return volume


def to_4channel(volume: torch.Tensor, device: torch.device) -> torch.Tensor:
    """Build a (1, 4, D, H, W) FP16 tensor.

    Sample DICOM is single-phase. STU-Net's 4-channel input expects
    ``[non_contrast, arterial, portal_venous, delayed]``. We replicate the
    single phase across the 4 channel slots — the upstream model tolerates
    this, and our stub averages the channels anyway.
    """
    # volume: (1, D, H, W) → (4, D, H, W) → (1, 4, D, H, W)
    four = volume.repeat(4, 1, 1, 1).unsqueeze(0)
    return four.to(device=device, dtype=torch.float16)


def main() -> int:
    if not MODEL_PT.exists():
        print(f"!! MODEL_PT missing: {MODEL_PT}", file=sys.stderr)
        print("   Run download_and_convert_models.py first.", file=sys.stderr)
        return 1
    if not DICOM_DIR.exists() or not any(DICOM_DIR.iterdir()):
        print(f"!! DICOM_DIR empty: {DICOM_DIR}", file=sys.stderr)
        print("   Run scripts/fetch-sample-dicom.sh first.", file=sys.stderr)
        return 1

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"=== STU-Net parenchyma smoke test (device={device}) ===")
    print(f"  model: {MODEL_PT.relative_to(REPO)} "
          f"({MODEL_PT.stat().st_size:,} B)")

    volume, _ = load_volume(DICOM_DIR)
    volume = preprocess(volume)

    # The stub was traced at fixed shape (1, 4, 128, 128, 128). Sliding-window
    # inference handles the size mismatch by tiling the input and averaging
    # overlapping patches.
    volume_4ch = to_4channel(volume, device)
    print(f"  4-channel input shape: {tuple(volume_4ch.shape)}, "
          f"dtype: {volume_4ch.dtype}")

    model = torch.jit.load(str(MODEL_PT)).to(device)
    model.eval()

    print("  running sliding-window inference (roi=128³, overlap=0.5) …")
    with torch.inference_mode():
        pred = sliding_window_inference(
            volume_4ch,
            roi_size=(128, 128, 128),
            sw_batch_size=1,
            predictor=model,
            overlap=0.5,
        )
    print(f"  prediction shape: {tuple(pred.shape)}, dtype: {pred.dtype}")

    # Output is already in (0, 1) sigmoid space (per stub's trace). Threshold.
    mask_np = (pred.float() > 0.5).cpu().numpy().astype(np.uint8)
    mask_np = mask_np.squeeze()  # (D, H, W)

    OUT_NII.parent.mkdir(parents=True, exist_ok=True)
    nib.save(nib.Nifti1Image(mask_np, np.eye(4)), str(OUT_NII))
    positive = int(mask_np.sum())
    total = int(mask_np.size)
    print(f"\n✓ wrote {OUT_NII.relative_to(REPO)}")
    print(f"  mask shape: {mask_np.shape}")
    print(f"  positive voxels: {positive:,} / {total:,} "
          f"({100 * positive / total:.2f}%)")
    print("\nNote: stub model — predictions are not clinically meaningful.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
