# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""View-only role capture — clipboard-export AuditEvent
(002-acr-structured-readout T086).

Plain-English:
    A view-only auditor (no edit / no append rights) opens a finalised
    analysis and clicks Copy. The audit row must record their role
    accurately — auditors care that "anonymous" never appears in the
    role slot when a known user performed the action.

Acceptance:
    - POST /analyses/{id}/report/clipboard-export with
      actor_role='view_only' returns 200.
    - The persisted canonical_json carries
      ``agent[0].role[0].coding[0].code == 'view_only'``.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest

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


@pytest.fixture(scope="module")
async def app_client(pg_container):
    """Build the FastAPI app pointed at the test Postgres.

    A fake auth middleware injects ``request.state.tenant_id`` +
    a permissions-bearing user so the ``@require_permission`` decorator
    on the route accepts the request.
    """
    if _SKIP:
        pytest.skip(SKIP_REASON)

    os.environ["DATABASE_URL"] = pg_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://"
    )

    # Run alembic migrations so the analysis + audit_event_chain tables exist.
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    try:
        alembic_cfg = Config(
            str(Path(__file__).parents[2] / "alembic.ini")
        )
        alembic_cfg.set_main_option("sqlalchemy.url", os.environ["DATABASE_URL"])
        command.upgrade(alembic_cfg, "head")
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"Alembic migrations unavailable: {exc!r}")

    tenant_id = uuid4()
    actor_id = uuid4()

    from starlette.middleware.base import BaseHTTPMiddleware

    from src.main import create_app

    class _FakeAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.tenant_id = tenant_id
            request.state.user = type(
                "U",
                (),
                {
                    "id": actor_id,
                    "permissions": {"analysis.view"},
                },
            )()
            return await call_next(request)

    app = create_app()
    app.add_middleware(_FakeAuth)
    app.state.test_tenant_id = tenant_id
    app.state.test_actor_id = actor_id

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client, tenant_id, actor_id


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_view_only_role_captured_in_audit_row(app_client) -> None:
    client, tenant_id, _actor_id = app_client

    # Seed an analysis row this tenant owns. We use raw SQL so this test
    # doesn't depend on the analysis service module being fully wired.
    from sqlalchemy import text as sql_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    analysis_id = uuid4()
    study_id = uuid4()
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        try:
            await s.execute(
                sql_text(
                    """
                    INSERT INTO analysis (id, tenant_id, study_id, status)
                    VALUES (:id, :tid, :sid, 'completed')
                    """
                ),
                {"id": str(analysis_id), "tid": str(tenant_id), "sid": str(study_id)},
            )
            await s.commit()
        except Exception as exc:  # pragma: no cover
            pytest.skip(f"analysis table shape differs from expected: {exc!r}")
    await engine.dispose()

    client_action_id = str(uuid4())
    resp = await client.post(
        f"/api/v1/analyses/{analysis_id}/report/clipboard-export",
        json={
            "client_action_id": client_action_id,
            "actor_role": "view_only",
            "locale": "en",
            "action_timestamp": datetime.now(timezone.utc).isoformat(),
            "outcome": "success",
        },
    )
    assert resp.status_code == 200, resp.text

    # Look up the audit row and inspect the captured role.
    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        row = await s.execute(
            sql_text(
                """
                SELECT canonical_json
                  FROM audit_event_chain
                 WHERE tenant_id = :tid
                   AND canonical_json LIKE :pat
                """
            ),
            {
                "tid": str(tenant_id),
                "pat": f'%"valueUuid": "{client_action_id}"%',
            },
        )
        canonical = row.scalar_one()
    await engine.dispose()

    body = json.loads(canonical)
    captured_role = body["agent"][0]["role"][0]["coding"][0]["code"]
    assert captured_role == "view_only"
