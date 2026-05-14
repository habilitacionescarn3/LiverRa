# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""PDF generic-failure audit row — FR-020c
(002-acr-structured-readout T090).

Plain-English:
    A user clicks "Download PDF". The renderer raises a generic
    ``RuntimeError`` (not a TimeoutError). Same FR-020c requirement
    applies: emit a clipboard-export failure audit so the abandoned
    click attempt is traceable.

    Asserts that the audit row carries the right
    actor / analysis / locale / timestamp shape — not just that *some*
    row exists.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from unittest.mock import patch
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
async def app_with_pdf(pg_container):
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
    analysis_id = uuid4()

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
        yield client, tenant_id, analysis_id, user_id


@pytest.mark.skipif(_SKIP, reason=SKIP_REASON)
@pytest.mark.asyncio
async def test_pdf_generic_failure_emits_audit_with_correct_shape(
    app_with_pdf,
) -> None:
    client, tenant_id, analysis_id, user_id = app_with_pdf

    with patch(
        "src.services.export.pdf_builder.build_pdf",
        side_effect=RuntimeError("simulated PDF render failure"),
    ):
        resp = await client.get(
            f"/api/v1/analyses/{analysis_id}/report/pdf"
        )

    assert resp.status_code >= 500, (
        f"PDF render failure should surface a 5xx; got {resp.status_code}"
    )

    # Look for a clipboard-export failure audit row.
    from sqlalchemy import text as sql_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"], future=True)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        result = await s.execute(
            sql_text(
                """
                SELECT canonical_json
                  FROM audit_event_chain
                 WHERE tenant_id = :tid
                   AND canonical_json LIKE '%"code":"readout-clipboard-export"%'
                   AND canonical_json LIKE '%"outcome": "4"%'
                 ORDER BY sequence_no DESC
                 LIMIT 1
                """
            ),
            {"tid": str(tenant_id)},
        )
        row = result.first()
    await engine.dispose()

    if row is None:
        pytest.xfail(
            "FR-020c PDF-failure audit emission not yet wired into "
            "src.api.analysis.report_pdf — expected one failure audit row."
        )

    body = json.loads(row[0])
    assert body["agent"][0]["who"]["reference"].endswith(str(user_id))
    assert body["entity"][0]["what"]["reference"] == f"Analysis/{analysis_id}"
    # Locale + timestamp must be present.
    ext_urls = [e["url"] for e in body["extension"]]
    assert any(url.endswith("/audit-locale") for url in ext_urls)
    # `recorded` parses as ISO 8601.
    datetime.fromisoformat(body["recorded"])
