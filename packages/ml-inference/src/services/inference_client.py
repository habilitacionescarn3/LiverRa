# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""HTTP client for the GPU inference microservice.

Drop-in replacement for ``totalsegmentator(...)`` calls. The cascade
runs on the laptop (FastAPI/Celery) but TotalSegmentator needs a GPU,
so it lives on Irakli's RTX 3090 box behind Tailscale. The default
endpoint is ``http://<gpu-host>:9101`` — see CLAUDE.md "Current Dev
Setup" for the live host. ``packages/ml-inference-gpu/`` holds the
service code and deployment notes.

Each call:

1. Streams the CT NIfTI bytes up via multipart POST (Bearer-auth'd).
2. Receives a ZIP of mask NIfTIs in the response body.
3. Safely extracts the ZIP into ``dest_dir`` (per-member, validated
   name — never ``extractall``).
4. Captures the ``X-LiverRa-Model-Version`` + ``X-LiverRa-Model-Weights-SHA``
   response headers and returns them alongside the extracted paths
   so the cascade can persist them onto ``Analysis.model_versions``.

The legacy ``infer_total`` / ``infer_liver_vessels`` callers continue
to get a ``{stem: Path}`` dict for backward compatibility; the new
``*_with_provenance`` variants return ``(paths, provenance)`` for
callers that want to persist the headers.

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
from typing import Any, Callable, TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Transient HTTP errors worth retrying. 4xx is NOT retryable
# (the request is structurally wrong); 5xx + connection failures are.
_RETRYABLE_HTTPX_EXC: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.RemoteProtocolError,
    httpx.ReadError,
)


# ---------------------------------------------------------------------------
# Configuration helpers — read env at CALL time so long-running Celery
# workers see rotated tokens / URLs without a restart (M-INFER-3).
# ---------------------------------------------------------------------------


def _inference_url() -> str:
    url = os.environ.get("LIVERRA_INFERENCE_URL", "").strip().rstrip("/")
    if not url:
        raise RuntimeError(
            "LIVERRA_INFERENCE_URL is not set. Point it at the GPU service, "
            "e.g. http://<gpu-host>:9101 (see CLAUDE.md 'Current Dev Setup')."
        )
    return url


def _timeout_s() -> float:
    # Default 30 min (1800s). Two-call pattern (~12 min total) + Tailscale
    # blips + slow weight downloads all fit comfortably; faster failure
    # modes (mis-routed Tailscale, container crash) still surface quickly
    # via ConnectError.
    return float(os.environ.get("LIVERRA_INFERENCE_TIMEOUT_S", "1800"))


def _auth_headers() -> dict[str, str]:
    token = os.environ.get("LIVERRA_GPU_SHARED_TOKEN", "").strip()
    env = os.environ.get("LIVERRA_ENV", "development").lower()
    if not token:
        if env in {"staging", "production"}:
            raise RuntimeError(
                "LIVERRA_GPU_SHARED_TOKEN is not set. The GPU service requires "
                "Bearer auth; refusing to send unauthenticated requests."
            )
        # Dev mode: tolerate missing token so local cascades run against
        # a GPU service that hasn't enabled auth yet. Production env always
        # fail-closes per Agent 2.4 audit fix.
        return {}
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Retry — small built-in exponential backoff so we don't add tenacity as
# a new top-level dep. Three attempts, base delay 2s, doubles each retry,
# capped at 30s. Only retries on transient exceptions + 5xx status codes;
# 4xx errors are non-retryable client mistakes.
# ---------------------------------------------------------------------------


def _retry(fn: Callable[[], T], *, what: str) -> T:
    max_attempts = int(os.environ.get("LIVERRA_INFERENCE_RETRY_ATTEMPTS", "3"))
    base_delay = float(os.environ.get("LIVERRA_INFERENCE_RETRY_BASE_S", "2"))
    max_delay = float(os.environ.get("LIVERRA_INFERENCE_RETRY_MAX_S", "30"))
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except _RETRYABLE_HTTPX_EXC as exc:
            last_exc = exc
            if attempt == max_attempts:
                break
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            logger.warning(
                "%s: transient %s on attempt %d/%d — retrying in %.1fs",
                what, type(exc).__name__, attempt, max_attempts, delay,
            )
            time.sleep(delay)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 500 <= status < 600 and attempt < max_attempts:
                last_exc = exc
                delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
                logger.warning(
                    "%s: server %d on attempt %d/%d — retrying in %.1fs",
                    what, status, attempt, max_attempts, delay,
                )
                time.sleep(delay)
                continue
            raise
    assert last_exc is not None  # noqa: S101 — _RETRYABLE_HTTPX_EXC always sets this
    raise last_exc


# ---------------------------------------------------------------------------
# Safe ZIP extraction — refuses absolute paths, ``..`` traversal, and
# any member whose normalized destination escapes ``dest_dir``.
# ---------------------------------------------------------------------------


def _safe_extract(zip_bytes: bytes, dest_dir: Path) -> list[Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    extracted: list[Path] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename
            if not name or name.endswith("/"):
                continue  # skip directories — we mkdir on demand below
            # Hard rejects: absolute paths and any ``..`` segment.
            if name.startswith("/") or name.startswith("\\") or ".." in Path(name).parts:
                raise ValueError(f"unsafe ZIP member name rejected: {name!r}")
            target = (dest_dir / name).resolve()
            # Final containment check — defends against symlink-style
            # tricks the prefix test would miss.
            if dest_root != target and dest_root not in target.parents:
                raise ValueError(f"ZIP member escapes dest_dir: {name!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                out.write(src.read())
            extracted.append(target)
    return extracted


# ---------------------------------------------------------------------------
# Core POST helper
# ---------------------------------------------------------------------------


def _post(endpoint: str, ct_path: Path) -> tuple[bytes, dict[str, str]]:
    """POST a CT NIfTI to the inference service, return (body, headers).

    Raises ``httpx.HTTPError`` (post-retry) on hard failures. The
    caller decides whether that's fatal (the cascade treats it as
    "stage failed" and aborts the analysis).
    """
    url = f"{_inference_url()}{endpoint}"
    headers = _auth_headers()
    timeout = _timeout_s()

    def _do() -> httpx.Response:
        with httpx.Client(timeout=timeout) as client:
            with ct_path.open("rb") as fh:
                files = {"ct_nifti": (ct_path.name, fh, "application/gzip")}
                resp = client.post(url, files=files, headers=headers)
            resp.raise_for_status()
            return resp

    response = _retry(_do, what=f"POST {endpoint}")
    return response.content, dict(response.headers)


def _extract_provenance(headers: dict[str, str]) -> dict[str, str]:
    """Pull the provenance headers out of a response. Both are normalized
    to lowercase by httpx, but we look up the canonical case too as a
    defensive measure.
    """
    return {
        "model_version": (
            headers.get("x-liverra-model-version")
            or headers.get("X-LiverRa-Model-Version")
            or "unknown"
        ),
        "weights_sha": (
            headers.get("x-liverra-model-weights-sha")
            or headers.get("X-LiverRa-Model-Weights-SHA")
            or "unknown"
        ),
    }


# ---------------------------------------------------------------------------
# Public API — paths + provenance
# ---------------------------------------------------------------------------


def infer_total_with_provenance(
    ct_path: Path, dest_dir: Path | None = None
) -> tuple[dict[str, Path], dict[str, str]]:
    """Same as :func:`infer_total` but also returns provenance headers."""
    out = dest_dir or Path(tempfile.mkdtemp(prefix="ts_total_"))
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    ct_size_mb = ct_path.stat().st_size / (1 << 20)
    body, headers = _post("/infer/total", ct_path)
    extracted_paths = _safe_extract(body, out)
    extracted = {
        p.name.replace(".nii.gz", ""): p
        for p in extracted_paths
        if p.name.endswith(".nii.gz")
    }
    provenance = _extract_provenance(headers)
    logger.info(
        "inference /infer/total: ct_in=%.1fMiB zip_out=%.1fMiB masks=%d duration=%.1fs "
        "model=%s sha=%s",
        ct_size_mb, len(body) / (1 << 20), len(extracted),
        time.perf_counter() - t0, provenance["model_version"],
        provenance["weights_sha"][:18] + "..."
        if len(provenance["weights_sha"]) > 18 else provenance["weights_sha"],
    )
    return extracted, provenance


def infer_liver_vessels_with_provenance(
    ct_path: Path, dest_dir: Path | None = None
) -> tuple[dict[str, Path], dict[str, str]]:
    """Same as :func:`infer_liver_vessels` but also returns provenance."""
    out = dest_dir or Path(tempfile.mkdtemp(prefix="ts_vessels_"))
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    ct_size_mb = ct_path.stat().st_size / (1 << 20)
    body, headers = _post("/infer/liver_vessels", ct_path)
    extracted_paths = _safe_extract(body, out)
    extracted = {
        p.name.replace(".nii.gz", ""): p
        for p in extracted_paths
        if p.name.endswith(".nii.gz")
    }
    provenance = _extract_provenance(headers)
    logger.info(
        "inference /infer/liver_vessels: ct_in=%.1fMiB zip_out=%.1fMiB masks=%d "
        "duration=%.1fs model=%s",
        ct_size_mb, len(body) / (1 << 20), len(extracted),
        time.perf_counter() - t0, provenance["model_version"],
    )
    return extracted, provenance


def infer_total_and_vessels_with_provenance(
    ct_path: Path,
    *,
    total_dir: Path,
    vessels_dir: Path,
) -> tuple[dict[str, Path], dict[str, Path], dict[str, str]]:
    """Combined call — single CT upload, two TS tasks, one ZIP back.

    Returns ``(total_paths, vessels_paths, provenance)``. Kept for
    backward compatibility but the cascade no longer uses it: empirical
    measurements show the two-call pattern is ~2 min faster on Tailscale
    links (CLAUDE.md "Open decision").
    """
    total_dir.mkdir(parents=True, exist_ok=True)
    vessels_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    ct_size_mb = ct_path.stat().st_size / (1 << 20)
    body, headers = _post("/infer/total_and_vessels", ct_path)

    # Extract into a staging dir, then move members to the right place
    # based on their ZIP subdirectory prefix. The safe-extract helper
    # already rejects ``..`` and absolute paths.
    with tempfile.TemporaryDirectory(prefix="ts_combined_") as td:
        staging = Path(td)
        members = _safe_extract(body, staging)
        total_paths: dict[str, Path] = {}
        vessels_paths: dict[str, Path] = {}
        for member in members:
            rel = member.relative_to(staging)
            parts = rel.parts
            if not member.name.endswith(".nii.gz") or len(parts) < 2:
                continue
            stem = member.name.replace(".nii.gz", "")
            if parts[0] == "total":
                target = total_dir / member.name
                target.write_bytes(member.read_bytes())
                total_paths[stem] = target
            elif parts[0] == "liver_vessels":
                target = vessels_dir / member.name
                target.write_bytes(member.read_bytes())
                vessels_paths[stem] = target

    provenance = _extract_provenance(headers)
    logger.info(
        "inference /infer/total_and_vessels: ct_in=%.1fMiB zip_out=%.1fMiB "
        "total_masks=%d vessels_masks=%d duration=%.1fs model=%s",
        ct_size_mb, len(body) / (1 << 20),
        len(total_paths), len(vessels_paths),
        time.perf_counter() - t0, provenance["model_version"],
    )
    return total_paths, vessels_paths, provenance


# ---------------------------------------------------------------------------
# Backward-compatible thin wrappers — discard provenance and return only
# the paths dict. New cascade code should prefer the *_with_provenance
# variants so the model_version + weights_sha can be persisted onto
# ``Analysis.model_versions``.
# ---------------------------------------------------------------------------


def infer_total(ct_path: Path, dest_dir: Path | None = None) -> dict[str, Path]:
    """Equivalent to::

        totalsegmentator(input=ct_path, task='total',
                         roi_subset=['liver','inferior_vena_cava','gallbladder','spleen'])

    Returns ``{'liver': Path, 'inferior_vena_cava': Path, 'gallbladder': Path,
    'spleen': Path}`` — any subset may be present depending on what TS
    produced. Callers should use ``.get()`` for optional masks.

    NOTE: discards provenance headers. Prefer :func:`infer_total_with_provenance`
    in code that writes to ``Analysis.model_versions``.
    """
    paths, _provenance = infer_total_with_provenance(ct_path, dest_dir)
    return paths


def infer_liver_vessels(
    ct_path: Path, dest_dir: Path | None = None
) -> dict[str, Path]:
    """Equivalent to ``totalsegmentator(input=ct_path, task='liver_vessels')``.

    See :func:`infer_liver_vessels_with_provenance` for the variant that
    also returns the model-version + weights-SHA headers.
    """
    paths, _provenance = infer_liver_vessels_with_provenance(ct_path, dest_dir)
    return paths


def infer_total_and_vessels(
    ct_path: Path,
    *,
    total_dir: Path,
    vessels_dir: Path,
) -> tuple[dict[str, Path], dict[str, Path]]:
    """Combined call — runs both TS tasks on ONE upload of the CT.

    See :func:`infer_total_and_vessels_with_provenance` for the variant
    that also returns the model-version + weights-SHA headers.

    Cascade no longer uses this endpoint by default — the two-call
    pattern is ~2 minutes faster on Tailscale links.
    """
    total_paths, vessels_paths, _provenance = infer_total_and_vessels_with_provenance(
        ct_path, total_dir=total_dir, vessels_dir=vessels_dir,
    )
    return total_paths, vessels_paths


def health() -> dict[str, Any]:
    """Smoke-test helper. Returns the inference service's ``/health`` JSON.

    Unlike the inference endpoints, ``/health`` does not require Bearer
    auth on the server side, but we send the header anyway when the env
    var is set so deployments that gate /health behind auth work too.
    """
    headers: dict[str, str] = {}
    token = os.environ.get("LIVERRA_GPU_SHARED_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(timeout=10) as client:
        r = client.get(f"{_inference_url()}/health", headers=headers)
        r.raise_for_status()
        return r.json()
