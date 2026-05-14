# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa GPU inference microservice.

Stateless FastAPI wrapper around TotalSegmentator. Three endpoints
(``/infer/total``, ``/infer/liver_vessels``, ``/infer/total_and_vessels``),
all of which accept a multipart CT NIfTI upload and return a ZIP of
per-organ NIfTI masks. Knows nothing about LiverRa's data layer (no
S3, no DB, no Celery) — pure ``CT in, masks out``.

Designed to run on a GPU box behind Tailscale. The LiverRa orchestrator
(Celery worker on the laptop) calls this via
``packages/ml-inference/src/services/inference_client.py``.

Security & licensing
--------------------

* **Bearer auth** — every ``/infer/*`` request must carry
  ``Authorization: Bearer <LIVERRA_GPU_SHARED_TOKEN>``. The token is
  read from the env at request time so rotation works without restart.
  If the env var is unset the service refuses to start.
* **Commercial-licensing gate** — ``LIVERRA_TS_COMMERCIAL_LICENSED``
  (default ``false``). When ``false`` the ``liver_vessels`` and
  ``total_and_vessels`` endpoints reply ``HTTP 451 Unavailable For
  Legal Reasons`` because the TotalSegmentator ``liver_vessels``
  sub-task ships under a paid commercial license. The
  ``total`` endpoint remains usable (base task is Apache-2.0).
* **Streaming upload** — request bodies are streamed to a temp path
  with an explicit byte counter; the client's ``Content-Length`` is
  ignored entirely. ``MAX_UPLOAD_BYTES`` is enforced mid-stream so
  oversize bodies cannot OOM the container.

Provenance headers
------------------

Every successful inference response carries:

* ``X-LiverRa-Model-Version`` — the installed TotalSegmentator package
  version (e.g. ``2.4.0``).
* ``X-LiverRa-Model-Weights-SHA`` — SHA-256 of the resolved weights
  archive (cached at startup; ``unknown`` until first inference
  triggers a weight download).

The laptop client captures these headers and persists them onto the
``Analysis.model_versions`` JSONB column for regulatory provenance.

Usage on the GPU box::

    docker run -d --gpus all -p 100.124.94.29:9101:9101 --restart unless-stopped \\
      -e LIVERRA_GPU_SHARED_TOKEN=<long-random-string> \\
      -e LIVERRA_TS_COMMERCIAL_LICENSED=false \\
      --name liverra-gpu liverra/gpu-inference:1.0.3
    # Host port 9101 (NOT 9100 — Tailscale ACL drops 9100 silently;
    # NOT 9000 — MinIO owns that by convention).
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import secrets
import tempfile
import time
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Iterator

import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger("liverra-gpu")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------------------
# Configuration — read once at import time, except auth which re-reads at
# request time so token rotation does not require a restart.
# ---------------------------------------------------------------------------

# 1 MiB granularity, default 500 MiB. (1 << 20) for the byte conversion is
# consistent with MAX_UPLOAD_MB env-var semantics — previously we mixed
# 1e6 and 1024*1024 which produced confusing log lines (M-INFER-4).
_MIB = 1 << 20
MAX_UPLOAD_BYTES = int(os.environ.get("LIVERRA_GPU_MAX_UPLOAD_MB", "500")) * _MIB

# Chunk size for streaming uploads. 4 MiB is a sweet spot for httpx +
# uvicorn — small enough to enforce the size cap promptly, large enough
# that overhead per chunk is negligible.
_UPLOAD_CHUNK_BYTES = 4 * _MIB

# TS `task=total` ROI subset shared by /infer/total and the combined
# endpoint (L-INFER-2 — previously duplicated as a literal in two places).
_TOTAL_ROI_SUBSET: tuple[str, ...] = (
    "liver",
    "inferior_vena_cava",
    "gallbladder",
    "spleen",
)

# Module-level state populated by the lifespan hook.
_MODEL_VERSION: str = "unknown"
_WEIGHTS_SHA: str = "unknown"
_WARM_CACHE_DURATION_S: float | None = None


def _read_shared_token() -> str:
    """Re-read the shared token on every request so rotation does not
    require a restart. Raises 503 if the env var is unset (mis-deployment).
    """
    token = os.environ.get("LIVERRA_GPU_SHARED_TOKEN", "").strip()
    if not token:
        # Refuse to authenticate rather than allowing empty-string match.
        raise HTTPException(
            503, "LIVERRA_GPU_SHARED_TOKEN not configured on the GPU service"
        )
    return token


def verify_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency — validates the ``Authorization: Bearer ...`` header.

    Constant-time comparison via ``secrets.compare_digest`` to defuse
    timing-attack reconnaissance. Missing header / wrong scheme / bad
    token all return ``401 Unauthorized`` with no detail leakage.
    """
    expected = _read_shared_token()
    if not authorization:
        raise HTTPException(401, "missing Authorization header")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(401, "Authorization must be 'Bearer <token>'")
    if not secrets.compare_digest(parts[1].strip(), expected):
        raise HTTPException(401, "invalid bearer token")


def _is_ts_commercial_licensed() -> bool:
    """Whether the paid TotalSegmentator ``liver_vessels`` subtask is
    licensed for this deployment. Defaults to ``false`` so a fresh
    install refuses commercial-tier endpoints until ops opts in.
    """
    return os.environ.get("LIVERRA_TS_COMMERCIAL_LICENSED", "false").lower() == "true"


def require_commercial_license() -> None:
    """FastAPI dependency — guards endpoints that depend on the paid
    TotalSegmentator commercial license. Returns ``451 Unavailable For
    Legal Reasons`` when licensing has not been confirmed via env var.
    """
    if not _is_ts_commercial_licensed():
        raise HTTPException(
            451,
            (
                "TotalSegmentator liver_vessels subtask requires a paid commercial "
                "license. Set LIVERRA_TS_COMMERCIAL_LICENSED=true after confirming "
                "purchase with TotalSegmentator authors. See docs/research/13-..."
            ),
        )


# ---------------------------------------------------------------------------
# Provenance helpers
# ---------------------------------------------------------------------------


def _detect_model_version() -> str:
    """Resolve the installed TotalSegmentator version string."""
    try:
        from importlib.metadata import version
        return f"totalsegmentator-{version('TotalSegmentator')}"
    except Exception:  # noqa: BLE001
        return "totalsegmentator-unknown"


def _compute_weights_sha() -> str:
    """SHA-256 of TS's resolved weights archive, if locatable.

    TotalSegmentator caches weights under ``~/.totalsegmentator/``;
    we hash the largest ``.zip`` / ``.pth`` artifact in that tree.
    Returns ``"unknown"`` when weights have not yet been downloaded.
    The hash is cached after computation (it is invariant for the
    lifetime of the container).
    """
    candidates: list[Path] = []
    for base in (
        Path.home() / ".totalsegmentator",
        Path("/root/.totalsegmentator"),
    ):
        if base.exists():
            for ext in ("*.zip", "*.pth", "*.pt"):
                candidates.extend(base.rglob(ext))
    if not candidates:
        return "unknown"
    largest = max(candidates, key=lambda p: p.stat().st_size)
    hasher = hashlib.sha256()
    with largest.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def _provenance_headers() -> dict[str, str]:
    return {
        "X-LiverRa-Model-Version": _MODEL_VERSION,
        "X-LiverRa-Model-Weights-SHA": _WEIGHTS_SHA,
    }


# ---------------------------------------------------------------------------
# Warm-cache hook
# ---------------------------------------------------------------------------


def _warm_ts_cache() -> float:
    """Run TS on an 8×8×8 synthetic volume to force weight load. Returns
    seconds elapsed. Failures are logged but never crash the lifespan —
    the first real request would retry the weight download anyway.
    """
    t0 = time.perf_counter()
    try:
        import nibabel as nib  # type: ignore[import-not-found]
        from totalsegmentator.python_api import totalsegmentator

        with tempfile.TemporaryDirectory(prefix="liverra-warm-") as td:
            tmp = Path(td)
            arr = np.zeros((8, 8, 8), dtype=np.int16)
            nii_path = tmp / "warm.nii.gz"
            nib.save(nib.Nifti1Image(arr, np.eye(4)), str(nii_path))
            out_dir = tmp / "out"
            out_dir.mkdir()
            totalsegmentator(
                input=str(nii_path),
                output=str(out_dir),
                task="total",
                device="gpu" if _cuda_available() else "cpu",
                roi_subset=list(_TOTAL_ROI_SUBSET),
                ml=False,
                quiet=True,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("warm cache failed (non-fatal): %s", exc)
    return time.perf_counter() - t0


def _cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _MODEL_VERSION, _WEIGHTS_SHA, _WARM_CACHE_DURATION_S
    # Fail fast if the shared token is missing — a service with no auth
    # is worse than no service at all (B-INFER-3 root cause).
    if not os.environ.get("LIVERRA_GPU_SHARED_TOKEN", "").strip():
        raise RuntimeError(
            "LIVERRA_GPU_SHARED_TOKEN env var is required; service refuses to start"
        )
    # TotalSegmentator lazy-loads weights on first call. We import here
    # (not at module top) so the process boots even if the import is slow.
    from totalsegmentator.python_api import totalsegmentator  # noqa: F401
    _MODEL_VERSION = _detect_model_version()
    _WEIGHTS_SHA = _compute_weights_sha()
    _WARM_CACHE_DURATION_S = _warm_ts_cache()
    # Recompute weights hash post-warm in case the warm pass triggered a download.
    if _WEIGHTS_SHA == "unknown":
        _WEIGHTS_SHA = _compute_weights_sha()
    logger.info(
        "liverra-gpu ready model_version=%s weights_sha=%s warm_cache_s=%.1f",
        _MODEL_VERSION, _WEIGHTS_SHA, _WARM_CACHE_DURATION_S,
    )
    yield


app = FastAPI(title="LiverRa GPU inference", version="1.0.3", lifespan=_lifespan)


# ---------------------------------------------------------------------------
# Streaming upload + size enforcement
# ---------------------------------------------------------------------------


async def _stream_upload_to_temp(ct_nifti: UploadFile, dest: Path) -> int:
    """Stream the upload to ``dest`` in chunks, enforcing MAX_UPLOAD_BYTES
    mid-stream. Returns the actual byte count read.

    Trusts NEITHER the multipart ``Content-Length`` header NOR
    ``UploadFile.size`` — both are client-supplied and can lie
    (H-INFER-3). Once the running counter exceeds the cap we drop the
    partial file and raise 413.
    """
    total = 0
    with dest.open("wb") as out:
        while True:
            chunk = await ct_nifti.read(_UPLOAD_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                out.close()
                try:
                    dest.unlink()
                except OSError:
                    pass
                raise HTTPException(
                    413,
                    f"CT exceeds {MAX_UPLOAD_BYTES // _MIB} MiB streaming cap",
                )
            out.write(chunk)
    if total < 1024:
        try:
            dest.unlink()
        except OSError:
            pass
        raise HTTPException(400, "CT NIfTI is suspiciously small (<1 KiB)")
    return total


# ---------------------------------------------------------------------------
# TS execution helpers
# ---------------------------------------------------------------------------


def _run_one_task(
    ct_path: Path,
    out_dir: Path,
    *,
    task: str,
    roi_subset: list[str] | tuple[str, ...] | None,
) -> int:
    """Run one TS task into ``out_dir``. Returns mask count produced."""
    from totalsegmentator.python_api import totalsegmentator

    out_dir.mkdir(parents=True, exist_ok=True)
    kwargs: dict = {
        "input": str(ct_path), "output": str(out_dir),
        "task": task, "device": "gpu", "ml": False, "quiet": True,
    }
    if roi_subset:
        kwargs["roi_subset"] = list(roi_subset)
    try:
        totalsegmentator(**kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.exception("TS task=%s failed", task)
        raise HTTPException(500, f"TotalSegmentator task={task} failed: {exc}") from exc

    n = len(list(out_dir.glob("*.nii.gz")))
    if n == 0:
        raise HTTPException(500, f"TS task={task} produced no masks")
    return n


def _zip_members(members: Iterator[tuple[Path, str]]) -> bytes:
    """Zip an iterable of ``(source_path, arcname)`` pairs.

    Filenames are taken from the caller (which sanitizes to basename
    only), never from the on-disk path — so an attacker who could
    smuggle a ``..`` into the temp dir layout still cannot escape the
    archive's logical root.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as zf:
        for src_path, arcname in members:
            zf.write(src_path, arcname=arcname)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/infer/total", response_class=Response, dependencies=[Depends(verify_token)])
async def infer_total(ct_nifti: UploadFile = File(...)) -> Response:
    """task=total with roi_subset=[liver, IVC, gallbladder, spleen].

    Base TS task — Apache-2.0, no commercial license required.
    """
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        n_bytes = await _stream_upload_to_temp(ct_nifti, ct_path)
        out_dir = Path(td) / "out"
        n_masks = _run_one_task(
            ct_path, out_dir, task="total", roi_subset=_TOTAL_ROI_SUBSET,
        )
        body = _zip_members(
            (nii, nii.name) for nii in sorted(out_dir.glob("*.nii.gz"))
        )
    logger.info(
        "task=total ct_in=%.1fMiB masks=%d zip_out=%.1fMiB duration=%.1fs",
        n_bytes / _MIB, n_masks, len(body) / _MIB, time.perf_counter() - t0,
    )
    return Response(
        content=body,
        media_type="application/zip",
        headers=_provenance_headers(),
    )


@app.post(
    "/infer/liver_vessels",
    response_class=Response,
    dependencies=[Depends(verify_token), Depends(require_commercial_license)],
)
async def infer_liver_vessels(ct_nifti: UploadFile = File(...)) -> Response:
    """task=liver_vessels (full output: liver_vessels + liver_tumor).

    ⚠ Paid TS commercial license required — see
    :func:`require_commercial_license`.
    """
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        n_bytes = await _stream_upload_to_temp(ct_nifti, ct_path)
        out_dir = Path(td) / "out"
        n_masks = _run_one_task(
            ct_path, out_dir, task="liver_vessels", roi_subset=None,
        )
        body = _zip_members(
            (nii, nii.name) for nii in sorted(out_dir.glob("*.nii.gz"))
        )
    logger.info(
        "task=liver_vessels ct_in=%.1fMiB masks=%d zip_out=%.1fMiB duration=%.1fs",
        n_bytes / _MIB, n_masks, len(body) / _MIB, time.perf_counter() - t0,
    )
    return Response(
        content=body,
        media_type="application/zip",
        headers=_provenance_headers(),
    )


@app.post(
    "/infer/total_and_vessels",
    response_class=Response,
    dependencies=[Depends(verify_token), Depends(require_commercial_license)],
)
async def infer_total_and_vessels(ct_nifti: UploadFile = File(...)) -> Response:
    """Combined endpoint — runs ``task=total`` AND ``task=liver_vessels`` on a
    SINGLE uploaded CT, returns one ZIP with subdirectory layout::

        total/liver.nii.gz
        total/inferior_vena_cava.nii.gz
        total/gallbladder.nii.gz
        total/spleen.nii.gz
        liver_vessels/liver_vessels.nii.gz
        liver_vessels/liver_tumor.nii.gz

    Still available for backward compatibility, but the cascade no longer
    uses this path: empirical measurements show the two-call pattern is
    ~2 minutes faster on Tailscale links (see CLAUDE.md "Open decision").

    Requires the same commercial license gate as ``liver_vessels``.
    """
    t0 = time.perf_counter()

    with tempfile.TemporaryDirectory(prefix="liverra-gpu-") as td:
        ct_path = Path(td) / "input.nii.gz"
        n_bytes = await _stream_upload_to_temp(ct_nifti, ct_path)

        total_dir = Path(td) / "total"
        vessels_dir = Path(td) / "liver_vessels"

        n_total = _run_one_task(
            ct_path, total_dir, task="total", roi_subset=_TOTAL_ROI_SUBSET,
        )
        n_vessels = _run_one_task(
            ct_path, vessels_dir, task="liver_vessels", roi_subset=None,
        )

        def _members() -> Iterator[tuple[Path, str]]:
            for nii in sorted(total_dir.glob("*.nii.gz")):
                yield nii, f"total/{nii.name}"
            for nii in sorted(vessels_dir.glob("*.nii.gz")):
                yield nii, f"liver_vessels/{nii.name}"
        body = _zip_members(_members())

    logger.info(
        "combined ct_in=%.1fMiB total_masks=%d vessels_masks=%d zip_out=%.1fMiB duration=%.1fs",
        n_bytes / _MIB, n_total, n_vessels, len(body) / _MIB,
        time.perf_counter() - t0,
    )
    return Response(
        content=body,
        media_type="application/zip",
        headers=_provenance_headers(),
    )


@app.get("/health")
async def health() -> Response:
    """Liveness + CUDA visibility check.

    Returns ``503 Service Unavailable`` (not 200 with ``ok=false``) when
    CUDA is missing — K8s liveness probes correctly mark the pod
    unhealthy and reschedule (H-INFER-5).
    """
    info: dict = {
        "model_version": _MODEL_VERSION,
        "weights_sha": _WEIGHTS_SHA,
        "warm_cache_duration_s": _WARM_CACHE_DURATION_S,
        "commercial_licensed": _is_ts_commercial_licensed(),
    }
    try:
        import torch
        info["cuda_available"] = bool(torch.cuda.is_available())
        info["cuda_device_count"] = int(torch.cuda.device_count())
        if info["cuda_available"]:
            info["cuda_device_name"] = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001
        info["cuda_available"] = False
        info["error"] = str(exc)

    if not info.get("cuda_available"):
        info["ok"] = False
        return JSONResponse(status_code=503, content=info)
    info["ok"] = True
    return JSONResponse(status_code=200, content=info)
