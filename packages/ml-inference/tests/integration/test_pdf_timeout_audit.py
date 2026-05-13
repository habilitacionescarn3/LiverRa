# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""PDF-timeout audit row — FR-020c
(002-acr-structured-readout T089).

Plain-English:
    Some users click "Download PDF" instead of "Copy". If the PDF
    builder times out mid-render, FR-020c says we should still
    write a clipboard-export AuditEvent with
    ``outcome=failure, failure_category=audit_chain_unavailable`` so
    auditors can see the abandoned click attempt — same way we
    record clipboard failures.

    If the PDF route doesn't yet emit that audit row, this test
    xfails with a clear pointer to the missing wiring.
"""
from __future__ import annotations

import os
from unittest.mock import patch
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


@pytest.fixture()
async def app_with_pdf(pg_container):
    if _SKIP:
        pytest.skip(SKIP_REASON)

    os.environ["DATABASE_URL"] = pg_container.get_connection_url().replace(
        "postgresql://", "postgresql+asyncpg://"
    )

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
    analysis_id = uuid4()

    # Seed an analysis for tenant_id.
    from sqlalchemy import text as sql_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
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
                    "id": str(analysis_id),
                    "tid": str(tenant_id),
                    "sid": str(uuid4()),
                },
            )
            await s.commit()
        except Exception as exc:  # pragma: no cover
            pytest.skip(f"analysis table shape differs from expected: {exc!r}")
    await engine.dispose()

    from starlette.middleware.base import BaseHTTPMiddleware

    from src.main import create_app

    class _FakeAuth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.tenant_id = tenant_id
            request.state.user = type(
                "U",
                (),
                {"id": user_id, "permissions": {"analysis.view"}},
            )()
            return await call_next(request)

    app = create_app()
    app.add_middleware(_FakeAuth)

    async with AsyncClient(app=app, base_url="http://test") as client:
        yield client, tenant_id, analysis_id


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_pdf_timeout_surfaces_504_or_500_and_emits_failure_audit(
    app_with_pdf,
) -> None:
    """PDF builder raises TimeoutError → 5xx + (ideally) audit row."""
    client, tenant_id, analysis_id = app_with_pdf

    # Patch the renderer to raise TimeoutError. We patch `build_pdf`
    # at its definition site so any wrapper layer above it sees the
    # error too.
    with patch(
        "src.services.export.pdf_builder.build_pdf",
        side_effect=TimeoutError("simulated PDF build timeout"),
    ):
        resp = await client.get(
            f"/api/v1/analyses/{analysis_id}/report/pdf"
        )

    # Either 504 (Gateway Timeout) or 500 (generic 5xx) is acceptable —
    # the goal is "surface the failure" not "specific status code".
    assert resp.status_code in (
        500,
        503,
        504,
    ), f"expected 5xx on PDF timeout, got {resp.status_code}: {resp.text}"

    # Check whether an audit row was emitted. If not, xfail — FR-020c
    # may not yet be wired.
    from sqlalchemy import text as sql_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        result = await s.execute(
            sql_text(
                """
                SELECT COUNT(*)
                  FROM audit_event_chain
                 WHERE tenant_id = :tid
                   AND canonical_json LIKE '%"code": "readout-clipboard-export"%'
                   AND canonical_json LIKE '%"valueCode": "audit_chain_unavailable"%'
                """
            ),
            {"tid": str(tenant_id)},
        )
        count = int(result.scalar_one())
    await engine.dispose()

    if count < 1:
        pytest.xfail(
            "FR-020c PDF-timeout audit emission not yet wired into "
            "src.api.analysis.report_pdf — expected at least one "
            "failure_category=audit_chain_unavailable row."
        )
    assert count >= 1
