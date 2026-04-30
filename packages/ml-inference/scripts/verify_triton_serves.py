"""Phase 5.3 — verify Triton actually serves inference on the stub models.

Hits each of the 6 Triton models with a properly-shaped request via the
gRPC client and asserts the response shape matches the config.pbtxt.

Usage:
    docker compose -f deploy/local/docker-compose.yml \
                   -f deploy/local/docker-compose.gpu.override.yml up -d triton
    # wait ~20 s for warm-up
    conda activate liverra-ml
    python packages/ml-inference/scripts/verify_triton_serves.py
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np
import tritonclient.grpc as grpc_client

URL = os.environ.get("TRITON_GRPC_URL", "localhost:8001")

# Each entry maps the Triton declared model name (pbtxt's `name:`) to its
# expected I/O signature. Inputs/outputs are (NAME, dtype, shape including
# batch dim). dtype strings follow tritonclient's grpc API conventions.
MODELS: dict[str, dict] = {
    "liverra-stunet-parenchyma": {
        "inputs": [("INPUT__0", "FP16", (1, 4, 128, 128, 128))],
        "outputs": [("OUTPUT__0", "FP16", (1, 1, 128, 128, 128))],
    },
    "liverra-stunet-lesions": {
        "inputs": [("INPUT__0", "FP16", (1, 4, 128, 128, 128))],
        "outputs": [("OUTPUT__0", "UINT8", (1, 1, 128, 128, 128))],
    },
    "liverra-couinaud-segments": {
        "inputs": [
            ("INPUT__0", "FP32", (1, 1, 128, 128, 128)),
            ("INPUT__1", "UINT8", (1, 1, 128, 128, 128)),
        ],
        "outputs": [
            ("OUTPUT__0", "FP16", (1, 8, 128, 128, 128)),
            ("OUTPUT__1", "FP16", (1, 2, 128, 128, 128)),
        ],
    },
    "liverra-lilnet-classify": {
        "inputs": [("INPUT__0", "FP32", (1, 4, 96, 96, 96))],
        "outputs": [("OUTPUT__0", "FP32", (1, 6))],
    },
    "liverra-vista3d-refine": {
        "inputs": [
            ("INPUT__0", "FP32", (1, 1, 128, 128, 128)),
            ("INPUT__1", "UINT8", (1, 1, 128, 128, 128)),
            ("INPUT__2", "INT32", (1, 3)),
            ("INPUT__3", "INT32", (1, 1)),
            ("INPUT__4", "INT32", (1, 1)),
        ],
        "outputs": [
            ("OUTPUT__0", "UINT8", (1, 1, 128, 128, 128)),
            ("OUTPUT__1", "INT32", (1, 1)),
        ],
    },
    "liverra-medsam2-track": {
        "inputs": [
            ("INPUT__0", "FP32", (1, 1, 80, 512, 512)),
            ("INPUT__1", "INT32", (1, 3)),
        ],
        "outputs": [
            ("OUTPUT__0", "UINT8", (1, 1, 80, 512, 512)),
            ("OUTPUT__1", "FP32", (1, 1)),
            ("OUTPUT__2", "INT32", (1, 6)),
        ],
    },
}

NUMPY_DTYPE = {
    "FP16": np.float16,
    "FP32": np.float32,
    "INT32": np.int32,
    "UINT8": np.uint8,
}


def make_input(name: str, dtype: str, shape: tuple[int, ...]) -> grpc_client.InferInput:
    inp = grpc_client.InferInput(name, list(shape), dtype)
    if dtype in {"FP16", "FP32"}:
        data = np.random.randn(*shape).astype(NUMPY_DTYPE[dtype])
    else:
        data = np.zeros(shape, dtype=NUMPY_DTYPE[dtype])
    inp.set_data_from_numpy(data)
    return inp


def main() -> int:
    client = grpc_client.InferenceServerClient(url=URL, verbose=False)

    # 0. Wait for server-ready, retrying up to 30 s.
    print(f"=== Triton verify ({URL}) ===")
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            if client.is_server_live():
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        print("!! server never went live", file=sys.stderr)
        return 1
    print("✓ server live")

    # 1. Per-model: ensure model is loaded (lazy-load Tier-B if needed) and
    #    send one inference request, validating the response.
    failures: list[str] = []
    for model_name, sig in MODELS.items():
        print(f"\n→ {model_name}")
        try:
            if not client.is_model_ready(model_name):
                print("  loading (lazy / explicit) …")
                client.load_model(model_name)
                # poll until ready
                ready_deadline = time.time() + 60
                while time.time() < ready_deadline:
                    if client.is_model_ready(model_name):
                        break
                    time.sleep(1)
                else:
                    failures.append(f"{model_name}: never became ready")
                    print("  ! never ready")
                    continue
            print("  ready ✓")

            inputs = [make_input(*spec) for spec in sig["inputs"]]
            outputs = [grpc_client.InferRequestedOutput(name) for name, *_ in sig["outputs"]]
            t0 = time.perf_counter()
            result = client.infer(model_name=model_name, inputs=inputs, outputs=outputs)
            dt_ms = (time.perf_counter() - t0) * 1000

            for out_name, out_dtype, out_shape in sig["outputs"]:
                arr = result.as_numpy(out_name)
                if arr is None:
                    failures.append(f"{model_name}/{out_name}: missing")
                    print(f"  ! {out_name} missing in response")
                    continue
                if tuple(arr.shape) != out_shape:
                    failures.append(
                        f"{model_name}/{out_name}: shape={arr.shape} expected {out_shape}"
                    )
                    print(f"  ! {out_name} shape={arr.shape} expected {out_shape}")
                    continue
                if arr.dtype != NUMPY_DTYPE[out_dtype]:
                    failures.append(
                        f"{model_name}/{out_name}: dtype={arr.dtype} expected {out_dtype}"
                    )
                    print(f"  ! {out_name} dtype={arr.dtype} expected {out_dtype}")
                    continue
                print(f"  ✓ {out_name} shape={arr.shape} dtype={arr.dtype}")
            print(f"  inference latency: {dt_ms:.1f} ms")
        except Exception as exc:
            failures.append(f"{model_name}: exception — {exc}")
            print(f"  ! exception: {exc}")

    print()
    if failures:
        print(f"!! {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("✓ ALL 6 MODELS SERVE INFERENCE CORRECTLY")
    return 0


if __name__ == "__main__":
    sys.exit(main())
