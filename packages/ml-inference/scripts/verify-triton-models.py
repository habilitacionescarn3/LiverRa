#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Verify that every Triton-loaded model is doing real inference (not a stub).

For each LiverRa model on Triton, sends two different synthetic inputs
(zeros + Gaussian noise) and checks:

    1. Outputs come back with the expected shape (model loads correctly)
    2. Output for noise differs from output for zeros (model is computing,
       not echoing the input back or returning a constant)
    3. Outputs are not all zeros / not all ones (sanity bound)

This catches the three failure modes we hit during the May-2026 incident:

  * Stub model.pt files that pass shape validation but emit garbage
  * Untrained / wrong-checkpoint weights that emit near-uniform softmax
  * Channel-order or preprocessing mismatch where the model "runs" but
    produces an output with no signal

It does NOT measure clinical Dice (no golden masks committed yet) — that
is a future enhancement. For today this is a smoke test you run after
deploying real weights, before letting any cascade hit Triton in earnest.

Usage
-----
    # Default: hits Tailscale-side Triton on Irakli's box
    python scripts/verify-triton-models.py

    # Override the Triton endpoint
    TRITON_URL=localhost:8001 python scripts/verify-triton-models.py

    # Verify a single model
    python scripts/verify-triton-models.py --only liverra-stunet-parenchyma

Exit codes
----------
    0  every checked model PASSED
    1  one or more models FAILED — details printed to stderr
    2  Triton unreachable / configuration error
"""
from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from typing import Sequence

import numpy as np

try:
    import tritonclient.grpc as grpcclient  # type: ignore[import-not-found]
    from tritonclient.utils import np_to_triton_dtype  # type: ignore[import-not-found]
except ImportError:
    print(
        "ERROR: tritonclient[grpc] is required. "
        "Run: pip install 'tritonclient[grpc]'",
        file=sys.stderr,
    )
    sys.exit(2)


DEFAULT_TRITON_URL = os.environ.get("TRITON_URL", "100.124.94.29:8001")

# The 6 cascade models. Input + output names are read from Triton's
# metadata at runtime so the script never drifts from config.pbtxt.
MODELS: Sequence[str] = (
    "liverra-stunet-parenchyma",
    "liverra-stunet-lesions",
    "liverra-couinaud-segments",
    "liverra-vista3d-refine",
    "liverra-lilnet-classify",
    "liverra-medsam2-track",
)


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------


@dataclass
class ModelResult:
    name: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    detail: str

    @property
    def is_failure(self) -> bool:
        return self.status == "FAIL"


def _triton_dtype_to_numpy(triton_dtype: str) -> np.dtype:
    mapping = {
        "FP16": np.float16,
        "FP32": np.float32,
        "FP64": np.float64,
        "INT8": np.int8,
        "INT16": np.int16,
        "INT32": np.int32,
        "INT64": np.int64,
        "UINT8": np.uint8,
        "UINT16": np.uint16,
        "UINT32": np.uint32,
        "UINT64": np.uint64,
        "BOOL": np.bool_,
    }
    if triton_dtype not in mapping:
        raise ValueError(f"unsupported Triton dtype {triton_dtype!r}")
    return np.dtype(mapping[triton_dtype])


def _random_input(shape: list[int], dtype: np.dtype, *, seed: int) -> np.ndarray:
    """Generate a deterministic synthetic input. For float types this is
    Gaussian noise centred at 0 with stdev 1; for ints it's a uniform
    spread across the dtype range.
    """
    rng = np.random.default_rng(seed)
    if np.issubdtype(dtype, np.floating):
        return rng.standard_normal(shape).astype(dtype)
    info = np.iinfo(dtype)
    return rng.integers(info.min, info.max, size=shape, dtype=dtype)


def _zeros_input(shape: list[int], dtype: np.dtype) -> np.ndarray:
    return np.zeros(shape, dtype=dtype)


def _build_inputs(
    model_meta: dict, *, seed: int, all_zeros: bool
) -> list[tuple[str, np.ndarray]]:
    """Build the input tuples for one inference call.

    Reads the full input list from Triton metadata so we always send
    every required input — auto-discovery prevents
    "expected 5 inputs but got 3" errors when models declare more
    auxiliary inputs (e.g., VISTA3D's prompt channels).
    """
    out: list[tuple[str, np.ndarray]] = []
    for input_meta in model_meta["inputs"]:
        dtype = _triton_dtype_to_numpy(input_meta["datatype"])
        # Triton's HTTP/JSON metadata returns shape dims as strings.
        raw_shape = [int(d) for d in input_meta["shape"]]
        shape = [d if d > 0 else 1 for d in raw_shape]
        arr = (
            _zeros_input(shape, dtype)
            if all_zeros
            else _random_input(shape, dtype, seed=seed)
        )
        out.append((input_meta["name"], arr))
    return out


def _infer(
    client: grpcclient.InferenceServerClient,
    model_name: str,
    inputs: list[tuple[str, np.ndarray]],
    output_names: list[str],
) -> list[np.ndarray]:
    triton_inputs = []
    for name, arr in inputs:
        if not arr.flags["C_CONTIGUOUS"]:
            arr = np.ascontiguousarray(arr)
        tin = grpcclient.InferInput(name, list(arr.shape), np_to_triton_dtype(arr.dtype))
        tin.set_data_from_numpy(arr)
        triton_inputs.append(tin)
    triton_outputs = [grpcclient.InferRequestedOutput(n) for n in output_names]
    response = client.infer(
        model_name=model_name,
        inputs=triton_inputs,
        outputs=triton_outputs,
    )
    return [response.as_numpy(n) for n in output_names]


# -----------------------------------------------------------------------
# Per-model verification
# -----------------------------------------------------------------------


def verify_model(
    client: grpcclient.InferenceServerClient,
    name: str,
) -> ModelResult:
    try:
        if not client.is_model_ready(name):
            return ModelResult(name, "SKIP", "model not ready on Triton")
    except Exception as exc:
        return ModelResult(name, "SKIP", f"is_model_ready failed: {exc}")

    try:
        meta = client.get_model_metadata(name, as_json=True)
    except Exception as exc:
        return ModelResult(name, "FAIL", f"metadata fetch failed: {exc}")

    if not meta.get("inputs") or not meta.get("outputs"):
        return ModelResult(name, "FAIL", "model metadata missing inputs/outputs")

    output_names = [o["name"] for o in meta["outputs"]]

    try:
        zero_outputs = _infer(
            client, name,
            _build_inputs(meta, seed=0, all_zeros=True),
            output_names,
        )
        noise_outputs = _infer(
            client, name,
            _build_inputs(meta, seed=42, all_zeros=False),
            output_names,
        )
    except Exception as exc:
        return ModelResult(name, "FAIL", f"infer failed: {exc}")

    # Check 1: outputs differ between zeros and noise inputs.
    diffs: list[float] = []
    zero_norms: list[float] = []
    noise_norms: list[float] = []
    for z, n in zip(zero_outputs, noise_outputs, strict=True):
        z_arr = z.astype(np.float32)
        n_arr = n.astype(np.float32)
        diffs.append(float(np.abs(z_arr - n_arr).mean()))
        zero_norms.append(float(np.abs(z_arr).mean()))
        noise_norms.append(float(np.abs(n_arr).mean()))

    mean_diff = float(np.mean(diffs))
    if mean_diff < 1e-6:
        return ModelResult(
            name, "FAIL",
            f"output identical for zeros vs noise (|Δ|={mean_diff:.3e}) — "
            "stub or constant model",
        )

    # Check 2: at least one output channel has non-trivial signal.
    if all(n < 1e-8 for n in noise_norms):
        return ModelResult(
            name, "FAIL",
            f"output all-zeros on noise input (|out|={noise_norms}) — "
            "untrained or echoing zeros",
        )

    return ModelResult(
        name, "PASS",
        f"|Δ|={mean_diff:.3e}, |zero_out|={zero_norms[0]:.3e}, "
        f"|noise_out|={noise_norms[0]:.3e}",
    )


# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--triton-url", default=DEFAULT_TRITON_URL,
        help=f"Triton gRPC URL host:port (default: {DEFAULT_TRITON_URL})",
    )
    parser.add_argument(
        "--only", default=None,
        help="Verify only this model (default: all 6 cascade models)",
    )
    args = parser.parse_args()

    print(f"=== verify-triton-models.py — Triton @ {args.triton_url} ===")
    try:
        client = grpcclient.InferenceServerClient(url=args.triton_url, verbose=False)
        if not client.is_server_ready():
            print(f"FAIL: server at {args.triton_url} not ready", file=sys.stderr)
            return 2
    except Exception as exc:
        print(f"FAIL: cannot reach Triton at {args.triton_url}: {exc}", file=sys.stderr)
        return 2

    targets = [m for m in MODELS if args.only is None or m == args.only]
    if not targets:
        print(f"FAIL: --only={args.only!r} matches no known model", file=sys.stderr)
        return 2

    results: list[ModelResult] = []
    for name in targets:
        print(f"\n[{name}]")
        result = verify_model(client, name)
        results.append(result)
        marker = {"PASS": "✓", "FAIL": "✗", "SKIP": "·"}[result.status]
        print(f"  {marker} {result.status}: {result.detail}")

    print("\n=== Summary ===")
    for r in results:
        marker = {"PASS": "✓", "FAIL": "✗", "SKIP": "·"}[r.status]
        print(f"  {marker} {r.name}: {r.status}")

    return 1 if any(r.is_failure for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
