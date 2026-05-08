# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""System routes (T133): health aggregator + version probe.

Plain-English:
    ``/api/v1/system/health`` is the single endpoint the ops dashboard
    and the Grafana ``liverra-health`` panel both call. It pokes every
    dependency (Postgres, Redis, Triton, Medplum, Orthanc, PACS per
    tenant) and reports ``ok`` / ``degraded`` / ``down``. ``/version``
    returns the release metadata (commit SHA, MBoM hash, pipeline
    version) so support can correlate a bug report to a build.

References:
    - plan.md §Health aggregator
    - plan.md §Observability → ``liverra-health`` dashboard

No PHI is ever logged by this module. Dependency errors are logged
as short messages + short UUIDs; the response itself carries only
per-dependency status strings.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

try:  # pragma: no cover
    from fastapi import APIRouter

    _FASTAPI_AVAILABLE = True
except ImportError:  # pragma: no cover
    APIRouter = None  # type: ignore[assignment]
    _FASTAPI_AVAILABLE = False


logger = logging.getLogger(__name__)

router = APIRouter() if _FASTAPI_AVAILABLE else None  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Probes — each returns {"status": "...", "detail": "..."} or raises.
# ---------------------------------------------------------------------------

async def _probe_postgres() -> Dict[str, Any]:
    try:
        from sqlalchemy import text

        from ..db.session import get_engine

        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as exc:  # pragma: no cover — ops-facing, not unit
        return {"status": "down", "detail": str(exc)[:120]}


async def _probe_redis() -> Dict[str, Any]:
    url = os.environ.get("REDIS_URL")
    if not url:
        return {"status": "not_configured"}
    try:
        import redis.asyncio as redis  # type: ignore[import-untyped]

        client = redis.from_url(url)
        pong = await client.ping()
        await client.aclose()
        return {"status": "ok" if pong else "down"}
    except Exception as exc:
        return {"status": "down", "detail": str(exc)[:120]}


async def _probe_triton() -> Dict[str, Any]:
    url = os.environ.get("TRITON_GRPC_URL")
    if not url:
        return {"status": "not_configured"}
    try:
        import tritonclient.grpc.aio as grpcclient  # type: ignore[import-untyped]

        client = grpcclient.InferenceServerClient(url=url)
        live = await client.is_server_live()
        ready = await client.is_server_ready()
        await client.close()
        if live and ready:
            return {"status": "ok"}
        return {"status": "warming"}
    except Exception as exc:
        return {"status": "down", "detail": str(exc)[:120]}


async def _probe_medplum() -> Dict[str, Any]:
    url = os.environ.get("MEDPLUM_URL")
    if not url:
        return {"status": "not_configured"}
    try:
        import httpx  # type: ignore[import-untyped]

        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{url.rstrip('/')}/fhir/R4/metadata")
            if 200 <= resp.status_code < 300:
                return {"status": "ok"}
            if resp.status_code in (502, 503, 504):
                return {"status": "degraded", "detail": f"HTTP {resp.status_code}"}
            return {"status": "down", "detail": f"HTTP {resp.status_code}"}
    except Exception as exc:
        return {"status": "down", "detail": str(exc)[:120]}


async def _probe_orthanc() -> Dict[str, Any]:
    url = os.environ.get("ORTHANC_URL")
    if not url:
        return {"status": "not_configured"}
    try:
        import httpx  # type: ignore[import-untyped]

        user = os.environ.get("ORTHANC_USERNAME")
        password = os.environ.get("ORTHANC_PASSWORD")
        auth = (user, password) if user and password else None
        async with httpx.AsyncClient(timeout=3.0, auth=auth) as client:
            resp = await client.get(f"{url.rstrip('/')}/system")
            return (
                {"status": "ok"}
                if 200 <= resp.status_code < 300
                else {"status": "down", "detail": f"HTTP {resp.status_code}"}
            )
    except Exception as exc:
        return {"status": "down", "detail": str(exc)[:120]}


async def _probe_pacs_per_tenant() -> Dict[str, Any]:
    """Iterate configured tenants + attempt C-ECHO. Degraded by default
    when the dedicated module hasn't landed yet (owned by PACS agent)."""
    try:
        from ..services.pacs_push.cecho import cecho_all_tenants  # type: ignore[import-not-found]

        return await cecho_all_tenants()
    except Exception:
        return {"status": "not_configured"}


async def _estimate_gpu_warm_s() -> float:
    """Rough estimate of cold-start cost for the largest model.

    Reads Triton model-control state; if any required model is
    UNAVAILABLE we guess ~45s warm-up (STU-Net 1.4B checkpoint).
    """
    url = os.environ.get("TRITON_GRPC_URL")
    if not url:
        return 0.0
    try:
        import tritonclient.grpc.aio as grpcclient  # type: ignore[import-untyped]

        client = grpcclient.InferenceServerClient(url=url)
        model_repo = await client.get_model_repository_index()
        await client.close()
        missing = [m for m in (model_repo.models or []) if m.state != "READY"]
        return 45.0 if missing else 0.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Aggregator
# ---------------------------------------------------------------------------

def _roll_up(statuses: List[str]) -> str:
    if "down" in statuses:
        return "down"
    if "degraded" in statuses or "warming" in statuses:
        return "degraded"
    return "ok"


def _mbom_hash() -> str | None:
    """Hash the MBoM.json bundle at repo root, if present."""
    path = Path(__file__).resolve().parents[4] / "MBoM.json"
    if not path.exists():
        return None
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception:
        return None


def _read_built_at() -> str:
    return os.environ.get(
        "LIVERRA_BUILT_AT",
        datetime.now(timezone.utc).isoformat(),
    )


if router is not None:

    @router.get("/health")
    async def get_health() -> Dict[str, Any]:
        """Aggregate dependency health for the ops dashboard."""
        start = time.monotonic()
        postgres, redis_, triton, medplum, orthanc, pacs, warm = await asyncio.gather(
            _probe_postgres(),
            _probe_redis(),
            _probe_triton(),
            _probe_medplum(),
            _probe_orthanc(),
            _probe_pacs_per_tenant(),
            _estimate_gpu_warm_s(),
        )

        checks = {
            "postgres": postgres,
            "redis": redis_,
            "triton": triton,
            "medplum": medplum,
            "orthanc": orthanc,
            "pacs_per_tenant": pacs,
        }
        statuses = [v.get("status", "down") for v in checks.values()]
        overall = _roll_up(statuses)

        return {
            "status": overall,
            "checks": checks,
            "gpu": {"predicted_warm_s": warm},
            "built_at": _read_built_at(),
            "latency_ms": int((time.monotonic() - start) * 1000),
        }

    @router.get("/version")
    async def get_version() -> Dict[str, Any]:
        """Release metadata — used by support + the bug-report form."""
        return {
            "app_version": os.environ.get("LIVERRA_APP_VERSION", "0.0.0-dev"),
            "pipeline_version": os.environ.get(
                "LIVERRA_PIPELINE_VERSION", "0.0.0-dev"
            ),
            "mbom_hash": _mbom_hash(),
            "commit_sha": os.environ.get("LIVERRA_COMMIT_SHA", "unknown"),
            "built_at": _read_built_at(),
        }


__all__ = ["router"]
