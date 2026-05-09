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


def _run_ts(ct_bytes: bytes, *, task: str, roi_subset: list[str] | None) -> bytes:
    """Run TotalSegmentator on the uploaded CT, return a ZIP of every NIfTI.

    Pure CPU/GPU work — caller decides what to do with the masks.
    """
    if len(ct_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"CT exceeds {MAX_UPLOAD_BYTES // 1024 // 1024} MB limit"
        )
    if len(ct_bytes) < 1024:
        raise HTTPException(400, "CT NIfTI is suspiciously small (<1 KB)")

    from totalsegmentator.python_api import totalsegmentator

    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        ct_path.write_bytes(ct_bytes)
        out_dir = Path(td) / "out"
        out_dir.mkdir()
        kwargs: dict = {
            "input": str(ct_path),
            "output": str(out_dir),
            "task": task,
            "device": "gpu",
            "ml": False,
            "quiet": True,
        }
        if roi_subset:
            kwargs["roi_subset"] = roi_subset
        try:
            totalsegmentator(**kwargs)
        except Exception as exc:  # noqa: BLE001
            logger.exception("TS task=%s failed", task)
            raise HTTPException(500, f"TotalSegmentator failed: {exc}") from exc

        nii_files = sorted(out_dir.glob("*.nii.gz"))
        if not nii_files:
            raise HTTPException(500, f"TS task={task} produced no masks")

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
            for nii in nii_files:
                zf.write(nii, arcname=nii.name)
        body = buf.getvalue()

    duration_s = time.perf_counter() - t0
    logger.info(
        "task=%s ct_in=%.1fMB masks=%d zip_out=%.1fMB duration=%.1fs",
        task, len(ct_bytes) / 1e6, len(nii_files), len(body) / 1e6, duration_s,
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
