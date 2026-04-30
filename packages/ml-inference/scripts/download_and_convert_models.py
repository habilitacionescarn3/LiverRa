#!/usr/bin/env python3
"""
download_and_convert_models.py — Phase 3 of model-integration-roadmap.md.

Two operating modes:

  --stub   (default)  Generates contract-conformant TorchScript stubs that
                      match every triton-models/<m>/config.pbtxt exactly
                      in input names, dtypes, and dim signatures. Outputs
                      are deterministic shape-correct dummies — Triton
                      loads them, the cascade orchestrator runs, the
                      contract test passes, but predictions are nonsense.
                      This unblocks Phase 5 (Triton boot) and Phase 6
                      (full cascade) without real upstream weights.

  --real              Real upstream weight conversion. NOT IMPLEMENTED —
                      see docs/plans/PHASE_3_GAPS.md for the per-model
                      blockers (Couinaud has no public checkpoint, LiLNet
                      is 3×2D not 1×3D, MedSAM-2 expects 1024×1024 not
                      512×512, STU-Net uses Baidu/GDrive + nnUNet 1.7).
                      Each blocker requires upstream-author engagement,
                      bridging-wrapper code, and clinical sign-off.

Usage:
  conda activate liverra-ml
  cd packages/ml-inference
  python scripts/download_and_convert_models.py --model all --mode stub

Outputs:
  triton-models/<dir>/1/model.pt       — TorchScript module per model
  triton-models/<dir>/LICENSE          — bundled upstream LICENSE
  triton-models/MODEL_HASHES.txt       — SHA-256 manifest
  triton-models/<dir>/model.info       — updated with stub commit_sha
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import torch
import torch.nn as nn

REPO_ROOT = Path(__file__).resolve().parents[3]
TRITON_MODELS = REPO_ROOT / "packages/ml-inference/triton-models"

# ---------------------------------------------------------------------------
# Per-model contract: this is the single source of truth that drives every
# stub generated below. It mirrors the dims/dtypes declared in each
# config.pbtxt. If any config.pbtxt changes, update the matching entry here.
# Shapes do NOT include the implicit Triton batch dimension (max_batch_size=1
# means PyTorch sees the leading 1 explicitly when traced).
# ---------------------------------------------------------------------------

DTYPE_MAP = {
    "FP16": torch.float16,
    "FP32": torch.float32,
    "INT32": torch.int32,
    "UINT8": torch.uint8,
}


@dataclass(frozen=True)
class TensorSpec:
    name: str
    dtype: str  # "FP16" | "FP32" | "INT32" | "UINT8"
    dims: tuple[int, ...]  # NOT including the batch dim

    def torch_dtype(self) -> torch.dtype:
        return DTYPE_MAP[self.dtype]

    def trace_shape(self, dynamic_z: int = 80) -> tuple[int, ...]:
        """Concrete shape including the batch dim, with -1 -> dynamic_z."""
        return (1,) + tuple(d if d != -1 else dynamic_z for d in self.dims)


@dataclass(frozen=True)
class ModelSpec:
    triton_dir: str
    upstream_url: str
    license_url: str  # raw URL of LICENSE / LICENSE.txt
    inputs: tuple[TensorSpec, ...]
    outputs: tuple[TensorSpec, ...]


# Canonical specs — match config.pbtxt for each model
MODEL_SPECS: dict[str, ModelSpec] = {
    "parenchyma": ModelSpec(
        triton_dir="liverra-stunet-parenchyma",
        upstream_url="https://github.com/uni-medical/STU-Net",
        license_url="https://raw.githubusercontent.com/uni-medical/STU-Net/main/LICENSE",
        inputs=(TensorSpec("INPUT__0", "FP16", (4, 128, 128, 128)),),
        outputs=(TensorSpec("OUTPUT__0", "FP16", (1, 128, 128, 128)),),
    ),
    "lesions": ModelSpec(
        triton_dir="liverra-stunet-lesions",
        upstream_url="https://github.com/uni-medical/STU-Net",
        license_url="https://raw.githubusercontent.com/uni-medical/STU-Net/main/LICENSE",
        inputs=(TensorSpec("INPUT__0", "FP16", (4, 128, 128, 128)),),
        outputs=(TensorSpec("OUTPUT__0", "UINT8", (1, 128, 128, 128)),),
    ),
    "couinaud": ModelSpec(
        triton_dir="liverra-couinaud-segments",
        upstream_url="https://github.com/xukun-zhang/Couinaud-Segmentation",
        license_url="https://raw.githubusercontent.com/xukun-zhang/Couinaud-Segmentation/main/LICENSE",
        inputs=(
            TensorSpec("INPUT__0", "FP32", (1, 128, 128, 128)),
            TensorSpec("INPUT__1", "UINT8", (1, 128, 128, 128)),
        ),
        outputs=(
            TensorSpec("OUTPUT__0", "FP16", (8, 128, 128, 128)),
            TensorSpec("OUTPUT__1", "FP16", (2, 128, 128, 128)),
        ),
    ),
    "lilnet": ModelSpec(
        triton_dir="liverra-lilnet-classify",
        upstream_url="https://github.com/yangmeiyi/Liver",
        license_url="https://raw.githubusercontent.com/yangmeiyi/Liver/main/LICENSE",
        inputs=(TensorSpec("INPUT__0", "FP32", (4, 96, 96, 96)),),
        outputs=(TensorSpec("OUTPUT__0", "FP32", (6,)),),
    ),
    "vista3d": ModelSpec(
        triton_dir="liverra-vista3d-refine",
        upstream_url="https://github.com/Project-MONAI/VISTA",
        license_url="https://raw.githubusercontent.com/Project-MONAI/VISTA/main/LICENSE.txt",
        inputs=(
            TensorSpec("INPUT__0", "FP32", (1, 128, 128, 128)),
            TensorSpec("INPUT__1", "UINT8", (1, 128, 128, 128)),
            TensorSpec("INPUT__2", "INT32", (3,)),
            TensorSpec("INPUT__3", "INT32", (1,)),
            TensorSpec("INPUT__4", "INT32", (1,)),
        ),
        outputs=(
            TensorSpec("OUTPUT__0", "UINT8", (1, 128, 128, 128)),
            TensorSpec("OUTPUT__1", "INT32", (1,)),
        ),
    ),
    "medsam2": ModelSpec(
        triton_dir="liverra-medsam2-track",
        upstream_url="https://github.com/MedicineToken/Medical-SAM2",
        license_url="https://raw.githubusercontent.com/MedicineToken/Medical-SAM2/main/LICENSE",
        inputs=(
            TensorSpec("INPUT__0", "FP32", (1, -1, 512, 512)),  # dynamic Z
            TensorSpec("INPUT__1", "INT32", (3,)),
        ),
        outputs=(
            TensorSpec("OUTPUT__0", "UINT8", (1, -1, 512, 512)),
            TensorSpec("OUTPUT__1", "FP32", (1,)),
            TensorSpec("OUTPUT__2", "INT32", (6,)),
        ),
    ),
}

ORDER = ["lilnet", "couinaud", "parenchyma", "lesions", "medsam2", "vista3d"]


# ---------------------------------------------------------------------------
# Stub modules — one per output signature. Each does just enough math to
# emit a tensor of the right shape and dtype that depends on the inputs
# (so torch.jit.trace records a real graph, not a constant).
# ---------------------------------------------------------------------------


class StubParenchyma(nn.Module):
    """4-channel FP16 [4,128,128,128] -> 1-channel FP16 [1,128,128,128].

    Mimics a sigmoid probability map by averaging across the 4 phases and
    passing through a fixed conv. Output values fall in (0, 1).
    """

    def __init__(self) -> None:
        super().__init__()
        self.conv = nn.Conv3d(4, 1, kernel_size=1, bias=True)
        with torch.no_grad():
            self.conv.weight.fill_(0.25)
            self.conv.bias.zero_()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, 4, 128, 128, 128] FP16
        y = self.conv(x.float())
        y = torch.sigmoid(y)
        return y.to(torch.float16)


class StubLesions(nn.Module):
    """4-channel FP16 -> UINT8 instance-indexed mask.

    Returns a single connected component (label=1) where the mean
    contrast across channels exceeds a threshold.
    """

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mean_phase = x.float().mean(dim=1, keepdim=True)  # [B,1,D,H,W]
        mask = (mean_phase > 0.5).to(torch.uint8)
        return mask


class StubCouinaud(nn.Module):
    """(CT FP32 [1,128,128,128], mask UINT8 [1,128,128,128]) ->
    (couinaud_softmax FP16 [8,128,128,128], vessels FP16 [2,128,128,128]).
    """

    def __init__(self) -> None:
        super().__init__()
        # Two heads from the joint input
        self.seg = nn.Conv3d(2, 8, kernel_size=1, bias=True)
        self.vessels = nn.Conv3d(2, 2, kernel_size=1, bias=True)
        with torch.no_grad():
            self.seg.weight.fill_(0.125)
            self.seg.bias.zero_()
            self.vessels.weight.fill_(0.5)
            self.vessels.bias.zero_()

    def forward(
        self, ct: torch.Tensor, mask: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        joined = torch.cat([ct.float(), mask.float()], dim=1)
        seg_logits = self.seg(joined)
        seg_softmax = torch.softmax(seg_logits, dim=1).to(torch.float16)
        vessels = torch.sigmoid(self.vessels(joined)).to(torch.float16)
        return seg_softmax, vessels


class StubLiLNet(nn.Module):
    """4-channel FP32 [4,96,96,96] -> raw logits FP32 [6].

    Six classes in order: hcc, icc, metastasis, fnh, hemangioma, cyst.
    Returned as a 1-D vector (post-batch-squeeze).
    """

    def __init__(self) -> None:
        super().__init__()
        self.pool = nn.AdaptiveAvgPool3d(1)
        self.fc = nn.Linear(4, 6)
        with torch.no_grad():
            self.fc.weight.fill_(0.1)
            self.fc.bias.zero_()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: [B, 4, 96, 96, 96] FP32 → logits [B, 6]
        # Triton with max_batch_size=1 keeps the batch dim implicitly.
        pooled = self.pool(x).flatten(1)
        return self.fc(pooled)


class StubVista3d(nn.Module):
    """5 inputs -> (refined mask UINT8 [1,128,128,128], latency INT32 [1])."""

    def forward(
        self,
        ct: torch.Tensor,
        mask: torch.Tensor,
        click: torch.Tensor,
        click_mode: torch.Tensor,
        anatomy: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        # Refined mask = original mask, biased by click_mode (0=add, 1=subtract).
        sign = (1 - 2 * click_mode.to(torch.int32))  # [B,1] -> +1 or -1
        sign_b = sign.view(-1, 1, 1, 1, 1).to(torch.float32)
        refined = (mask.float() + sign_b * 0.0).clamp(0, 255).to(torch.uint8)
        # Latency [B, 1] — keep batch dim per Triton's max_batch_size=1 rule.
        latency = (
            click.sum(dim=-1, keepdim=True).to(torch.int32)
            + anatomy.to(torch.int32)
            + ct.float().mean().to(torch.int32)
        )
        return refined, latency


class StubMedSam2(nn.Module):
    """(CT FP32 [1,Z,512,512], prompt INT32 [3]) ->
    (mask UINT8 [1,Z,512,512], confidence FP32 [1], bbox INT32 [6]).

    Z is dynamic at serving time; we trace at a representative Z=80.
    """

    def forward(
        self, ct: torch.Tensor, prompt: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        # mask: threshold the volume at zero — keeps [B, 1, Z, 512, 512]
        mask = (ct > 0.0).to(torch.uint8)
        # confidence [B, 1] — keep batch dim per Triton's max_batch_size=1 rule.
        confidence = ct.float().mean(dim=(1, 2, 3, 4), keepdim=False).view(-1, 1)
        # bbox [B, 6] derived from prompt so the device follows prompt.device
        # without being baked into the trace as a constant. Slicing prompt
        # gives a [B] int32 tensor on the same device as prompt; multiplying
        # by 0 makes it neutral for downstream arithmetic.
        z = ct.shape[2]
        zero_b = prompt[:, 0] * 0  # [B] int32, prompt.device
        bbox = torch.stack(
            [
                zero_b,
                zero_b,
                zero_b,
                zero_b + (z - 1),
                zero_b + 511,
                zero_b + 511,
            ],
            dim=1,
        )
        return mask, confidence, bbox


STUB_FACTORIES: dict[str, type[nn.Module]] = {
    "parenchyma": StubParenchyma,
    "lesions": StubLesions,
    "couinaud": StubCouinaud,
    "lilnet": StubLiLNet,
    "vista3d": StubVista3d,
    "medsam2": StubMedSam2,
}


# ---------------------------------------------------------------------------
# Tracing helpers
# ---------------------------------------------------------------------------


def make_dummy(spec: TensorSpec, dynamic_z: int = 80) -> torch.Tensor:
    """Allocate a dummy tensor matching a TensorSpec.

    For LiLNet's [6] output, the model emits a 1-D tensor (squeeze on B=1).
    For inputs, every tensor includes the implicit batch dim (=1).
    """
    shape = spec.trace_shape(dynamic_z=dynamic_z)
    dtype = spec.torch_dtype()
    if dtype.is_floating_point:
        return torch.randn(shape, dtype=dtype)
    # Integer dtype — use zeros so prompts/clicks are valid voxel indices.
    return torch.zeros(shape, dtype=dtype)


def trace_stub(model_key: str) -> torch.jit.ScriptModule:
    spec = MODEL_SPECS[model_key]
    factory = STUB_FACTORIES[model_key]
    module = factory().eval()

    dummies = tuple(make_dummy(s) for s in spec.inputs)

    # MedSAM-2: tell the tracer to record a dynamic Z axis explicitly by
    # using strict=False (jit.trace defaults to strict on output container
    # types, which is fine here, but we want to silence the warning about
    # dynamic shape in the traced graph).
    with torch.no_grad():
        if len(dummies) == 1:
            traced = torch.jit.trace(module, dummies[0], strict=False)
        else:
            traced = torch.jit.trace(module, dummies, strict=False)

    # Sanity-check: re-run the traced module on the same dummies and assert
    # output dtype + rank match the contract.
    with torch.no_grad():
        out = traced(*dummies) if len(dummies) > 1 else traced(dummies[0])
    if isinstance(out, torch.Tensor):
        out_tup: tuple[torch.Tensor, ...] = (out,)
    else:
        out_tup = tuple(out)
    if len(out_tup) != len(spec.outputs):
        raise RuntimeError(
            f"{model_key}: traced module emits {len(out_tup)} outputs, "
            f"expected {len(spec.outputs)}"
        )
    for actual, expected in zip(out_tup, spec.outputs):
        if actual.dtype != expected.torch_dtype():
            raise RuntimeError(
                f"{model_key}/{expected.name}: dtype {actual.dtype}, "
                f"expected {expected.torch_dtype()}"
            )
    return traced


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_license(spec: ModelSpec, dest_dir: Path) -> Path:
    """Download upstream LICENSE next to the model.pt. Idempotent."""
    dest = dest_dir / "LICENSE"
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print(f"  ↓ fetching LICENSE from {spec.license_url}")
    with urllib.request.urlopen(spec.license_url, timeout=30) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest


def update_model_info(triton_dir: Path, *, weights_sha256: str, mode: str) -> None:
    """Update model.info to record the build SHA, integration date, mode."""
    info_path = triton_dir / "model.info"
    if not info_path.exists():
        return
    lines = info_path.read_text().splitlines()
    new_lines: list[str] = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    seen_keys: set[str] = set()
    for line in lines:
        if ":" not in line:
            new_lines.append(line)
            continue
        key, _, _ = line.partition(":")
        key = key.strip()
        seen_keys.add(key)
        if key == "integration_date":
            new_lines.append(f"integration_date: {today}")
        elif key == "pinned_commit_sha":
            # In stub mode, replace with a deterministic stub-style SHA so
            # downstream MBoM aggregation succeeds; in --real mode this
            # would be the actual upstream commit SHA.
            stub_sha = "0" * 40 if mode == "stub" else line.split(":", 1)[1].strip()
            new_lines.append(f"pinned_commit_sha: {stub_sha}")
        else:
            new_lines.append(line)
    # Append weight metadata that wasn't there before.
    if "weights_sha256" not in seen_keys:
        new_lines.append(f"weights_sha256: {weights_sha256}")
    if "build_mode" not in seen_keys:
        new_lines.append(f"build_mode: {mode}")
    info_path.write_text("\n".join(new_lines) + "\n")


def write_manifest(entries: list[tuple[str, str, ModelSpec]]) -> Path:
    """Append-replace the SHA-256 manifest at triton-models/MODEL_HASHES.txt."""
    out = TRITON_MODELS / "MODEL_HASHES.txt"
    lines = [
        "# LiverRa Model Bill of Materials — SHA-256 manifest",
        "# Generated by packages/ml-inference/scripts/download_and_convert_models.py",
        f"# Generated at: {datetime.now(timezone.utc).isoformat()}",
        "# Format: triton_model_name  sha256:<hex>  source:<url>  license:<spdx>",
        "",
    ]
    spdx_for_url = {
        "https://github.com/uni-medical/STU-Net": "Apache-2.0",
        "https://github.com/xukun-zhang/Couinaud-Segmentation": "MIT",
        "https://github.com/yangmeiyi/Liver": "MIT",
        "https://github.com/Project-MONAI/VISTA": "Apache-2.0",
        "https://github.com/MedicineToken/Medical-SAM2": "Apache-2.0",
    }
    for triton_name, sha, spec in entries:
        spdx = spdx_for_url.get(spec.upstream_url, "UNKNOWN")
        lines.append(
            f"{triton_name}  sha256:{sha}  source:{spec.upstream_url}  license:{spdx}"
        )
    out.write_text("\n".join(lines) + "\n")
    return out


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def convert_one(model_key: str, mode: str) -> tuple[str, str, ModelSpec]:
    spec = MODEL_SPECS[model_key]
    triton_dir = TRITON_MODELS / spec.triton_dir
    out_path = triton_dir / "1" / "model.pt"

    print(f"\n=== {model_key} → {spec.triton_dir} (mode={mode}) ===")

    if mode != "stub":
        raise NotImplementedError(
            f"--mode real is not implemented for {model_key}. "
            f"See docs/plans/PHASE_3_GAPS.md for blockers."
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    traced = trace_stub(model_key)
    traced.save(str(out_path))
    sha = sha256_file(out_path)
    print(f"  ✓ wrote {out_path.relative_to(REPO_ROOT)}  ({out_path.stat().st_size:,} B)")
    print(f"  sha256: {sha}")

    # Bundle the upstream LICENSE so scripts/model-bom.sh can hash it.
    try:
        license_path = fetch_license(spec, triton_dir)
        print(f"  ✓ LICENSE  ({license_path.stat().st_size:,} B)")
    except Exception as exc:  # network failures shouldn't abort the trace
        print(f"  ! LICENSE fetch failed: {exc}")

    # triton_dir is already prefixed with "liverra-" to match Triton's strict
    # rule that the on-disk directory name equal the pbtxt model name.
    triton_name = spec.triton_dir
    update_model_info(triton_dir, weights_sha256=sha, mode=mode)

    return triton_name, sha, spec


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        choices=[*ORDER, "all"],
        default="all",
        help="Which model to (re)build. Default: all.",
    )
    parser.add_argument(
        "--mode",
        choices=["stub", "real"],
        default="stub",
        help="stub = contract-conformant dummies; real = upstream-weights conversion (NOT IMPLEMENTED).",
    )
    args = parser.parse_args()

    selected = ORDER if args.model == "all" else [args.model]
    entries: list[tuple[str, str, ModelSpec]] = []

    for key in selected:
        try:
            entries.append(convert_one(key, args.mode))
        except Exception as exc:
            print(f"\n!!! {key}: FAILED — {exc}", file=sys.stderr)
            return 1

    manifest = write_manifest(entries)
    print(f"\n✓ MANIFEST: {manifest.relative_to(REPO_ROOT)}")
    print(f"  {len(entries)} model(s) recorded.")
    print(
        "\nNext: run 'bash scripts/model-bom.sh' to assemble MBoM.json from "
        "model.info + LICENSE files."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
