# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""HTTP client for the GPU inference microservice.

Drop-in replacement for ``totalsegmentator(...)`` calls. The cascade
runs on the laptop (FastAPI/Celery) but TotalSegmentator needs a GPU,
so it lives on Irakli's RTX 3090 box behind Tailscale at
``http://100.124.94.29:9100`` (port 9100 because MinIO uses 9000). See ``packages/ml-inference-gpu/`` for
the service code and deployment notes.

Each call:
  1. Streams the CT NIfTI bytes up via multipart POST
  2. Receives a ZIP of mask NIfTIs in the response body
  3. Extracts the ZIP into ``dest_dir`` (or a fresh temp dir)
  4. Returns ``{file_stem: Path}`` so callers can do ``paths["liver"]``

Sync API (matches ``real_cascade.py``'s synchronous psycopg style).
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
import time
import zipfile
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

INFERENCE_URL = os.environ.get(
    "LIVERRA_INFERENCE_URL", "http://100.124.94.29:9100"
).rstrip("/")
TIMEOUT_S = float(os.environ.get("LIVERRA_INFERENCE_TIMEOUT_S", "300"))


def _post_and_extract(
    endpoint: str, ct_path: Path, dest_dir: Path
) -> dict[str, Path]:
    """POST a CT NIfTI to the inference service, extract the ZIP into ``dest_dir``.

    Raises ``httpx.HTTPError`` if the service is unreachable or returns
    a non-2xx response. Caller decides whether that's fatal (the cascade
    treats it as "stage failed" and aborts the analysis).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    url = f"{INFERENCE_URL}{endpoint}"
    t0 = time.perf_counter()
    ct_size_mb = ct_path.stat().st_size / 1e6

    with httpx.Client(timeout=TIMEOUT_S) as client:
        with ct_path.open("rb") as fh:
            files = {"ct_nifti": (ct_path.name, fh, "application/gzip")}
            response = client.post(url, files=files)
        response.raise_for_status()

    body = response.content
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        zf.extractall(dest_dir)

    extracted = {p.name.replace(".nii.gz", ""): p for p in dest_dir.glob("*.nii.gz")}
    duration_s = time.perf_counter() - t0
    logger.info(
        "inference %s: ct_in=%.1fMB zip_out=%.1fMB masks=%d duration=%.1fs",
        endpoint, ct_size_mb, len(body) / 1e6, len(extracted), duration_s,
    )
    return extracted


def infer_total(ct_path: Path, dest_dir: Path | None = None) -> dict[str, Path]:
    """Equivalent to::

        totalsegmentator(input=ct_path, task='total',
                         roi_subset=['liver','inferior_vena_cava','gallbladder','spleen'])

    Returns ``{'liver': Path, 'inferior_vena_cava': Path, 'gallbladder': Path,
    'spleen': Path}`` — any subset may be present depending on what TS
    produced. Callers should use ``.get()`` for optional masks.
    """
    out = dest_dir or Path(tempfile.mkdtemp(prefix="ts_total_"))
    return _post_and_extract("/infer/total", ct_path, out)


def infer_liver_vessels(
    ct_path: Path, dest_dir: Path | None = None
) -> dict[str, Path]:
    """Equivalent to ``totalsegmentator(input=ct_path, task='liver_vessels')``.

    Returns at most ``{'liver_vessels': Path, 'liver_tumor': Path}`` — older
    TS versions may also emit ``portal_vein.nii.gz`` / ``hepatic_vein.nii.gz``.
    Callers should use ``.get()`` for every key.
    """
    out = dest_dir or Path(tempfile.mkdtemp(prefix="ts_vessels_"))
    return _post_and_extract("/infer/liver_vessels", ct_path, out)


def health() -> dict:
    """Smoke-test helper. Returns the inference service's ``/health`` JSON."""
    with httpx.Client(timeout=10) as client:
        r = client.get(f"{INFERENCE_URL}/health")
        r.raise_for_status()
        return r.json()
