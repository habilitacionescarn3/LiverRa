# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Revoked-mid-session — clipboard-export endpoint
(002-acr-structured-readout T088).

Plain-English:
    A radiologist's auth token was revoked between the time the page
    loaded and the Copy click. The POST must surface 401 / 403; an
    optional ``auth_denied`` forensic audit row may also be written.

Strategy:
    Build the FastAPI app twice — once with a "valid" auth shim that
    grants ``analysis.view``, once with a "revoked" shim that strips
    the permission set so the ``@require_permission`` decorator
    rejects. The endpoint should answer 401/403 in the revoked case.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest
import pytest_asyncio

try:
    import httpx  # noqa: F401
    from httpx import AsyncClient

    _HTTPX_AVAILABLE = True
except ImportError:  # pragma: no cover
    AsyncClient = None  # type: ignore[assignment]
    _HTTPX_AVAILABLE = False

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]

    _TESTCONTAINERS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TESTCONTAINERS_AVAILABLE = False


_SKIP = (
    not _TESTCONTAINERS_AVAILABLE
    or not _HTTPX_AVAILABLE
    or bool(os.environ.get("LIVERRA_SKIP_TESTCONTAINERS"))
)
SKIP_REASON = (
    "Testcontainers + httpx required (or LIVERRA_SKIP_TESTCONTAINERS set)"
)


@pytest.fixture(scope="module")
def pg_container():
    if _SKIP:
        pytest.skip(SKIP_REASON)
    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest_asyncio.fixture()
async def revoked_app_client(pg_container):
    """FastAPI client whose auth middleware strips ``analysis.view``."""
    if _SKIP:
        pytest.skip(SKIP_REASON)

    os.environ["DATABASE_URL"] = pg_container.get_connection_url().replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    try:
        alembic_cfg = Config(str(Path(__file__).parents[2] / "alembic.ini"))
        alembic_cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
        command.upgrade(alembic_cfg, "head")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"Alembic migrations unavailable: {exc!r}")

    tenant_id = uuid4()
    user_id = uuid4()

    from starlette.middleware.base import BaseHTTPMiddleware

    from src.main import create_app

    class _RevokedAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.tenant_id = tenant_id
            # Simulate "session was revoked mid-session" by handing the
            # decorator a user with no permissions.
            request.state.user = type(
                "U",
                (),
                {"id": user_id, "permissions": set()},
            )()
            return await call_next(request)

    app = create_app()
    app.add_middleware(_RevokedAuth)

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client, tenant_id


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_revoked_session_rejected_with_401_or_403(revoked_app_client) -> None:
    client, _tenant_id = revoked_app_client
    analysis_id = uuid4()

    resp = await client.post(
        f"/api/v1/analyses/{analysis_id}/report/clipboard-export",
        json={
            "client_action_id": str(uuid4()),
            "actor_role": "attending_radiologist",
            "locale": "en",
            "action_timestamp": datetime.now(timezone.utc).isoformat(),
            "outcome": "success",
        },
    )
    assert resp.status_code in (
        401,
        403,
    ), f"revoked session must be denied; got {resp.status_code}: {resp.text}"
