# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa GPU inference microservice.

Stateless FastAPI wrapper around TotalSegmentator. Two endpoints, both:
multipart CT NIfTI upload → ZIP of per-organ NIfTI masks in the response
body. Knows nothing about LiverRa's data layer (no S3, no DB, no Celery)
— pure ``CT in, masks out``.

Designed to run on a GPU box behind Tailscale. The LiverRa orchestrator
(Celery worker on the laptop) calls this via
``packages/ml-inference/src/services/inference_client.py``.

Usage on the GPU box::

    docker run -d --gpus all -p 100.124.94.29:9100:9000 --restart unless-stopped \\
      --name liverra-gpu liverra/gpu-inference:1.0.0
    # Host port 9100 (not 9000) — MinIO owns 9000 by convention.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response

logger = logging.getLogger("liverra-gpu")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

MAX_UPLOAD_BYTES = int(os.environ.get("LIVERRA_GPU_MAX_UPLOAD_MB", "500")) * 1024 * 1024


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # TotalSegmentator lazy-loads weights on first call. We import here
    # (not at module top) so the process boots even if the import is slow.
    from totalsegmentator.python_api import totalsegmentator  # noqa: F401
    logger.info("liverra-gpu ready (TotalSegmentator import OK)")
    yield


app = FastAPI(title="LiverRa GPU inference", version="1.0.0", lifespan=_lifespan)


def _validate_ct(ct_bytes: bytes) -> None:
    if len(ct_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"CT exceeds {MAX_UPLOAD_BYTES // 1024 // 1024} MB limit"
        )
    if len(ct_bytes) < 1024:
        raise HTTPException(400, "CT NIfTI is suspiciously small (<1 KB)")


def _run_one_task(ct_path: Path, out_dir: Path, *, task: str,
                  roi_subset: list[str] | None) -> int:
    """Run one TS task into out_dir. Returns mask count produced."""
    from totalsegmentator.python_api import totalsegmentator

    out_dir.mkdir(parents=True, exist_ok=True)
    kwargs: dict = {
        "input": str(ct_path), "output": str(out_dir),
        "task": task, "device": "gpu", "ml": False, "quiet": True,
    }
    if roi_subset:
        kwargs["roi_subset"] = roi_subset
    try:
        totalsegmentator(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.exception("TS task=%s failed", task)
        raise HTTPException(500, f"TotalSegmentator task={task} failed: {exc}") from exc

    n = len(list(out_dir.glob("*.nii.gz")))
    if n == 0:
        raise HTTPException(500, f"TS task={task} produced no masks")
    return n


def _zip_dir(src_dir: Path, *, arcname_prefix: str = "") -> bytes:
    """Zip every .nii.gz in src_dir into a bytes buffer.
    arcname_prefix lets the caller tag entries (e.g. 'total/', 'liver_vessels/').
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
        for nii in sorted(src_dir.glob("*.nii.gz")):
            zf.write(nii, arcname=f"{arcname_prefix}{nii.name}")
    return buf.getvalue()


def _run_ts(ct_bytes: bytes, *, task: str, roi_subset: list[str] | None) -> bytes:
    """Single-task runner — kept for the legacy /infer/total + /infer/liver_vessels endpoints."""
    _validate_ct(ct_bytes)
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        ct_path.write_bytes(ct_bytes)
        out_dir = Path(td) / "out"
        n = _run_one_task(ct_path, out_dir, task=task, roi_subset=roi_subset)
        body = _zip_dir(out_dir)
    logger.info(
        "task=%s ct_in=%.1fMB masks=%d zip_out=%.1fMB duration=%.1fs",
        task, len(ct_bytes) / 1e6, n, len(body) / 1e6, time.perf_counter() - t0,
    )
    return body


@app.post("/infer/total", response_class=Response)
async def infer_total(ct_nifti: UploadFile = File(...)) -> Response:
    """task=total with roi_subset=[liver, IVC, gallbladder, spleen]."""
    body = _run_ts(
        await ct_nifti.read(),
        task="total",
        roi_subset=["liver", "inferior_vena_cava", "gallbladder", "spleen"],
    )
    return Response(content=body, media_type="application/zip")


@app.post("/infer/liver_vessels", response_class=Response)
async def infer_liver_vessels(ct_nifti: UploadFile = File(...)) -> Response:
    """task=liver_vessels (full output: liver_vessels + liver_tumor)."""
    body = _run_ts(await ct_nifti.read(), task="liver_vessels", roi_subset=None)
    return Response(content=body, media_type="application/zip")


@app.post("/infer/total_and_vessels", response_class=Response)
async def infer_total_and_vessels(ct_nifti: UploadFile = File(...)) -> Response:
    """Combined endpoint — runs `task=total` AND `task=liver_vessels` on a
    SINGLE uploaded CT, returns one ZIP with subdirectory layout::

        total/liver.nii.gz
        total/inferior_vena_cava.nii.gz
        total/gallbladder.nii.gz
        total/spleen.nii.gz
        liver_vessels/liver_vessels.nii.gz
        liver_vessels/liver_tumor.nii.gz

    Saves the laptop one full CT upload (~3-5 min on Tailscale) per cascade
    by amortizing the bytes across both tasks.
    """
    ct_bytes = await ct_nifti.read()
    _validate_ct(ct_bytes)
    t0 = time.perf_counter()

    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        ct_path.write_bytes(ct_bytes)

        total_dir = Path(td) / "total"
        vessels_dir = Path(td) / "liver_vessels"

        n_total = _run_one_task(
            ct_path, total_dir,
            task="total",
            roi_subset=["liver", "inferior_vena_cava", "gallbladder", "spleen"],
        )
        n_vessels = _run_one_task(
            ct_path, vessels_dir,
            task="liver_vessels",
            roi_subset=None,
        )

        # Merge both subdirs into one ZIP with prefixed arcnames.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
            for nii in sorted(total_dir.glob("*.nii.gz")):
                zf.write(nii, arcname=f"total/{nii.name}")
            for nii in sorted(vessels_dir.glob("*.nii.gz")):
                zf.write(nii, arcname=f"liver_vessels/{nii.name}")
        body = buf.getvalue()

    logger.info(
        "combined: ct_in=%.1fMB total_masks=%d vessels_masks=%d zip_out=%.1fMB duration=%.1fs",
        len(ct_bytes) / 1e6, n_total, n_vessels, len(body) / 1e6,
        time.perf_counter() - t0,
    )
    return Response(content=body, media_type="application/zip")


@app.get("/health")
async def health() -> dict:
    """Liveness + CUDA visibility check. Used by the laptop's smoke test."""
    info: dict = {"ok": True}
    try:
        import torch
        info["cuda_available"] = bool(torch.cuda.is_available())
        info["cuda_device_count"] = int(torch.cuda.device_count())
        if info["cuda_available"]:
            info["cuda_device_name"] = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001
        info["cuda_available"] = False
        info["error"] = str(exc)
    return info
