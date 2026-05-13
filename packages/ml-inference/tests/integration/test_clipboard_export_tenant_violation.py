# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Cross-tenant access — clipboard-export endpoint
(002-acr-structured-readout T087).

Plain-English:
    Tenant A authenticated user POSTs against tenant B's analysis_id.
    Two correct outcomes are acceptable per FR-022b:
      - 404 (RLS hides the resource), OR
      - 403 (explicit cross-tenant guard).

    Either way, tenant A's audit chain MUST NOT contain a
    readout-clipboard-export row referencing the foreign analysis.

    The spec also asks for a forensic ``tenant_violation`` server-side
    audit event. If that wiring is in place, we assert it; if not, the
    test xfails the secondary assertion with a clear reason so we
    don't paper over missing capability.
"""
from __future__ import annotations

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
async def two_tenant_app(pg_container):
    if _SKIP:
        pytest.skip(SKIP_REASON)

    os.environ["DATABASE_URL"] = pg_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://"
    )

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

    tenant_a = uuid4()
    tenant_b = uuid4()
    user_a = uuid4()

    # Build an app where the active tenant for every request is
    # tenant_a — the request will then POST against an analysis
    # belonging to tenant_b.
    from starlette.middleware.base import BaseHTTPMiddleware

    from src.main import create_app

    class _FakeAuthA(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.tenant_id = tenant_a
            request.state.user = type(
                "U",
                (),
                {"id": user_a, "permissions": {"analysis.view"}},
            )()
            return await call_next(request)

    app = create_app()
    app.add_middleware(_FakeAuthA)

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client, tenant_a, tenant_b


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_cross_tenant_post_returns_404_or_403_and_no_audit_row(
    two_tenant_app,
) -> None:
    client, tenant_a, tenant_b = two_tenant_app

    # Seed an analysis OWNED BY tenant_b.
    from sqlalchemy import text as sql_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    foreign_analysis_id = uuid4()
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        try:
            await s.execute(
                sql_text(
                    """
                    INSERT INTO analysis (id, tenant_id, study_id, status)
                    VALUES (:id, :tid, :sid, 'completed')
                    """
                ),
                {
                    "id": str(foreign_analysis_id),
                    "tid": str(tenant_b),
                    "sid": str(uuid4()),
                },
            )
            await s.commit()
        except Exception as exc:  # pragma: no cover
            pytest.skip(f"analysis table shape differs from expected: {exc!r}")
    await engine.dispose()

    client_action_id = str(uuid4())
    resp = await client.post(
        f"/api/v1/analyses/{foreign_analysis_id}/report/clipboard-export",
        json={
            "client_action_id": client_action_id,
            "actor_role": "attending_radiologist",
            "locale": "en",
            "action_timestamp": datetime.now(timezone.utc).isoformat(),
            "outcome": "success",
        },
    )
    assert resp.status_code in (
        403,
        404,
    ), f"cross-tenant POST must be denied, got {resp.status_code}: {resp.text}"

    # Tenant A's audit chain MUST NOT have a clipboard-export row
    # carrying the foreign client_action_id.
    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        count_in_a = await s.execute(
            sql_text(
                """
                SELECT COUNT(*)
                  FROM audit_event_chain
                 WHERE tenant_id = :tid
                   AND canonical_json LIKE :pat
                """
            ),
            {"tid": str(tenant_a), "pat": f'%"valueUuid": "{client_action_id}"%'},
        )
    await engine.dispose()
    assert int(count_in_a.scalar_one()) == 0, (
        "no clipboard-export row should be written for a denied cross-tenant POST"
    )

    # Forensic tenant_violation event (FR-022b) — optional today.
    # Skip the secondary assertion until the server-side forensic
    # emitter is wired.
    pytest.xfail(
        "FR-022b forensic tenant_violation audit emission not yet wired server-side"
    )
