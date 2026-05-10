# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""HTTP client for the GPU inference microservice.

Drop-in replacement for ``totalsegmentator(...)`` calls. The cascade
runs on the laptop (FastAPI/Celery) but TotalSegmentator needs a GPU,
so it lives on Irakli's RTX 3090 box behind Tailscale at
``http://100.124.94.29:9101`` (port 9101 — 9100 silently failed via Tailscale,
9000 is MinIO; see CLAUDE.md "Current Dev Setup"). See ``packages/ml-inference-gpu/`` for
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
    "LIVERRA_INFERENCE_URL", "http://100.124.94.29:9101"
).rstrip("/")
# Default 30 min (1800s). The combined endpoint can take ~10 min on a slow
# Tailscale link (5-6 min upload + 1-2 min TS×2 + 1-2 min download).
# 5 min is too tight; 30 min gives headroom for true network blips while
# still failing in reasonable time when the server is genuinely stuck.
TIMEOUT_S = float(os.environ.get("LIVERRA_INFERENCE_TIMEOUT_S", "1800"))


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


def infer_total_and_vessels(
    ct_path: Path,
    *,
    total_dir: Path,
    vessels_dir: Path,
) -> tuple[dict[str, Path], dict[str, Path]]:
    """Combined call — runs both TS tasks on ONE upload of the CT.

    Saves a full CT upload (~3-5 min on Tailscale) vs the two-call
    pattern. Server endpoint returns a ZIP with two subdirectories:
    ``total/*.nii.gz`` and ``liver_vessels/*.nii.gz``. This helper
    extracts each subdir into its respective ``total_dir`` /
    ``vessels_dir`` so existing cascade code that reads files by path
    continues to work unchanged.

    Returns ``(total_paths, vessels_paths)`` — each a ``{stem: Path}``
    dict identical in shape to what ``infer_total`` and
    ``infer_liver_vessels`` would have returned individually.
    """
    total_dir.mkdir(parents=True, exist_ok=True)
    vessels_dir.mkdir(parents=True, exist_ok=True)
    url = f"{INFERENCE_URL}/infer/total_and_vessels"
    t0 = time.perf_counter()
    ct_size_mb = ct_path.stat().st_size / 1e6

    with httpx.Client(timeout=TIMEOUT_S) as client:
        with ct_path.open("rb") as fh:
            files = {"ct_nifti": (ct_path.name, fh, "application/gzip")}
            response = client.post(url, files=files)
        response.raise_for_status()

    body = response.content
    total_paths: dict[str, Path] = {}
    vessels_paths: dict[str, Path] = {}
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        for member in zf.namelist():
            if member.startswith("total/") and member.endswith(".nii.gz"):
                target = total_dir / Path(member).name
                target.write_bytes(zf.read(member))
                total_paths[Path(member).name.replace(".nii.gz", "")] = target
            elif member.startswith("liver_vessels/") and member.endswith(".nii.gz"):
                target = vessels_dir / Path(member).name
                target.write_bytes(zf.read(member))
                vessels_paths[Path(member).name.replace(".nii.gz", "")] = target

    duration_s = time.perf_counter() - t0
    logger.info(
        "inference combined: ct_in=%.1fMB zip_out=%.1fMB total_masks=%d vessels_masks=%d duration=%.1fs",
        ct_size_mb, len(body) / 1e6,
        len(total_paths), len(vessels_paths), duration_s,
    )
    return total_paths, vessels_paths


def health() -> dict:
    """Smoke-test helper. Returns the inference service's ``/health`` JSON."""
    with httpx.Client(timeout=10) as client:
        r = client.get(f"{INFERENCE_URL}/health")
        r.raise_for_status()
        return r.json()
