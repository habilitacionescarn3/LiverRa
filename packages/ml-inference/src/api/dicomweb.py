# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DICOMweb proxy router — `liverra-api.fly.dev/dicom-web/*` → private Orthanc.

Plain-English:
    The browser thinks it's talking DICOMweb (STOW-RS/QIDO/WADO) to the
    same origin it gets the React app from. In reality, every request
    lands here first. We validate the user's permission, then forward
    the request body verbatim to Orthanc over the Fly internal 6PN
    network with HTTP Basic auth (Orthanc's own credentials).

    The proxy never reads or rewrites the DICOM payload — it streams
    bytes through, which matters for STOW-RS POSTs that can be 100s of
    MB per request. Memory footprint stays constant regardless of
    upload size.

Auth posture:
    - Browser → proxy: Cognito JWT (validated by @require_permission)
    - Proxy → Orthanc: HTTP Basic (private credentials, never seen by browser)

This module is loaded conditionally — if ``ORTHANC_URL`` isn't set in
the environment (e.g. local dev where Vite proxies directly to
``localhost:8042``), the router still mounts but every request returns
503 with a clear "Orthanc not configured" message instead of crashing
at import time.
"""
from __future__ import annotations

import logging
import os
from base64 import b64encode
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from src.middleware.require_permission import require_permission

logger = logging.getLogger(__name__)

router: Optional[APIRouter] = APIRouter()


# ---------------------------------------------------------------------------
# Configuration — read at call-time so rotated secrets pick up without a
# worker restart (same convention as inference_client.py).
# ---------------------------------------------------------------------------


def _orthanc_url() -> str:
    """Internal Orthanc base URL. Empty string → router returns 503."""
    return os.environ.get("ORTHANC_URL", "").strip().rstrip("/")


def _orthanc_basic_auth() -> Optional[str]:
    user = os.environ.get("ORTHANC_USERNAME", "").strip()
    pw = os.environ.get("ORTHANC_PASSWORD", "").strip()
    if not user or not pw:
        return None
    raw = f"{user}:{pw}".encode("utf-8")
    return f"Basic {b64encode(raw).decode('ascii')}"


# Hop-by-hop headers that MUST NOT be forwarded per RFC 7230 §6.1.
# Plus a few we strip because we're re-injecting them ourselves.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    # We replace these on each direction:
    "host",
    "authorization",
    "content-length",
}


def _filter_request_headers(src: dict[str, str]) -> dict[str, str]:
    """Forward most headers; strip hop-by-hop + ones we override."""
    out: dict[str, str] = {}
    for k, v in src.items():
        if k.lower() in _HOP_BY_HOP:
            continue
        out[k] = v
    return out


def _filter_response_headers(src: httpx.Headers) -> list[tuple[str, str]]:
    """Same idea on the way back. Returned as list because httpx preserves
    duplicate header names (matters for `Set-Cookie`, etc.)."""
    out: list[tuple[str, str]] = []
    for k, v in src.multi_items():
        if k.lower() in _HOP_BY_HOP:
            continue
        out.append((k, v))
    return out


# ---------------------------------------------------------------------------
# Single proxy handler — wired to GET/POST/PUT/DELETE below with different
# permission decorators.
# ---------------------------------------------------------------------------


async def _proxy(request: Request, subpath: str) -> Response:
    target_base = _orthanc_url()
    if not target_base:
        # 503 is the right shape — the service is configured-out, not
        # missing. The frontend treats this as a transient issue and
        # surfaces "PACS unavailable" rather than crashing.
        raise HTTPException(
            status_code=503,
            detail="Orthanc proxy is not configured (ORTHANC_URL unset)",
        )

    basic = _orthanc_basic_auth()
    if not basic:
        raise HTTPException(
            status_code=503,
            detail="Orthanc proxy credentials missing "
            "(ORTHANC_USERNAME / ORTHANC_PASSWORD)",
        )

    # The mounted prefix is /dicom-web, but Orthanc's DICOMweb root is
    # also /dicom-web/, so we forward the subpath as-is.
    target_url = f"{target_base}/dicom-web/{subpath}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    fwd_headers = _filter_request_headers(dict(request.headers))
    fwd_headers["Authorization"] = basic

    # Stream body forward — STOW-RS POSTs can be huge.
    body_iter = request.stream()

    timeout = httpx.Timeout(
        connect=10.0,
        # DICOM uploads + downloads can be long. 5 min covers
        # multi-hundred-MB studies on residential uplinks.
        read=300.0,
        write=300.0,
        pool=10.0,
    )

    client = httpx.AsyncClient(timeout=timeout)
    try:
        upstream = await client.request(
            method=request.method,
            url=target_url,
            headers=fwd_headers,
            content=body_iter,
        )
    except httpx.ConnectError as exc:
        await client.aclose()
        logger.error("orthanc proxy unreachable: %s", exc)
        raise HTTPException(
            status_code=502, detail="Orthanc backend unreachable"
        ) from exc
    except Exception as exc:  # noqa: BLE001
        await client.aclose()
        logger.exception("orthanc proxy error")
        raise HTTPException(
            status_code=502, detail=f"Orthanc proxy failure: {exc}"
        ) from exc

    # Stream the response body back to the browser. We MUST close the
    # httpx client after the stream is fully consumed — wrap it in a
    # generator that closes on exit.
    async def _iter() -> object:
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response_headers = dict(_filter_response_headers(upstream.headers))
    return StreamingResponse(
        _iter(),
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Method-specific endpoints. Permissions:
#   - GET (QIDO/WADO reads)    → study.read
#   - POST (STOW-RS upload)    → study.upload
#   - PUT/DELETE (mgmt)        → study.upload (admin tier)
# Single shared handler; FastAPI requires distinct decorators per method.
# ---------------------------------------------------------------------------


@router.get("/{subpath:path}")
@require_permission("study.view")
async def proxy_get(request: Request, subpath: str) -> Response:
    return await _proxy(request, subpath)


@router.post("/{subpath:path}")
@require_permission("study.upload")
async def proxy_post(request: Request, subpath: str) -> Response:
    return await _proxy(request, subpath)


@router.put("/{subpath:path}")
@require_permission("study.upload")
async def proxy_put(request: Request, subpath: str) -> Response:
    return await _proxy(request, subpath)


@router.delete("/{subpath:path}")
@require_permission("study.upload")
async def proxy_delete(request: Request, subpath: str) -> Response:
    return await _proxy(request, subpath)
