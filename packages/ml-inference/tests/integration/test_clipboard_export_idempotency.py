# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Idempotency on ``client_action_id`` — clipboard-export audit emitter
(002-acr-structured-readout T084).

Plain-English:
    A flaky network or a durable-retry queue may POST the same
    clipboard-export AuditEvent multiple times with an identical
    ``client_action_id``. The emitter MUST return the same
    ``audit_event_id`` on each replay and only persist ONE chain row.

Strategy:
    Stand up a disposable Postgres via Testcontainers, create just the
    ``audit_event_chain`` table, fire ``emit_clipboard_export`` three
    times with the same UUID, then assert:
      - same ``audit_event_id`` returned every call,
      - only the first call returns a non-None ``AuditChainRow``,
      - the table has exactly ONE matching row.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

try:
    from testcontainers.postgres import PostgresContainer  # type: ignore[import-not-found]

    _TESTCONTAINERS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TESTCONTAINERS_AVAILABLE = False


_SKIP = not _TESTCONTAINERS_AVAILABLE or bool(
    os.environ.get("LIVERRA_SKIP_TESTCONTAINERS")
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pg_dsn() -> str:
    if _SKIP:
        pytest.skip("Testcontainers unavailable or skipped by env.")
    with PostgresContainer("postgres:16-alpine") as container:
        yield container.get_connection_url().replace(
            "postgresql://", "postgresql+asyncpg://"
        )


@pytest.fixture()
async def session(pg_dsn: str):
    """Per-test async session against a fresh schema.

    We DROP + CREATE the chain table before each test so the chain
    starts at sequence_no=1 and prior test rows don't bleed in.
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(pg_dsn, future=True)
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS audit_event_chain"))
        await conn.execute(
            text(
                """
                CREATE TABLE audit_event_chain (
                    tenant_id uuid NOT NULL,
                    sequence_no bigint NOT NULL,
                    leaf_hash bytea NOT NULL,
                    prev_leaf_hash bytea NOT NULL,
                    canonical_json text NOT NULL,
                    written_at timestamptz NOT NULL,
                    PRIMARY KEY (tenant_id, sequence_no)
                )
                """
            )
        )

    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    async with session_maker() as s:
        yield s

    await engine.dispose()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_three_replays_return_same_audit_event_id_and_one_row(session) -> None:
    from sqlalchemy import text as sql_text

    from src.services.audit.clipboard_export_event import (
        ClipboardExportAuditPayload,
        emit_clipboard_export,
    )

    tenant_id = uuid4()
    actor_id = uuid4()
    analysis_id = uuid4()
    client_action_id = uuid4()

    payload = ClipboardExportAuditPayload(
        client_action_id=client_action_id,
        actor_role="attending_radiologist",
        locale="en",
        action_timestamp=datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc),
        outcome="success",
    )

    # 1st call: writes a row.
    event_id_1, row_1 = await emit_clipboard_export(
        payload,
        actor_id=actor_id,
        analysis_id=analysis_id,
        tenant_id=tenant_id,
        session=session,
    )
    await session.commit()
    assert row_1 is not None, "first call must persist a chain row"
    assert isinstance(event_id_1, UUID)

    # 2nd + 3rd calls: replays must return the same id and no new row.
    event_id_2, row_2 = await emit_clipboard_export(
        payload,
        actor_id=actor_id,
        analysis_id=analysis_id,
        tenant_id=tenant_id,
        session=session,
    )
    event_id_3, row_3 = await emit_clipboard_export(
        payload,
        actor_id=actor_id,
        analysis_id=analysis_id,
        tenant_id=tenant_id,
        session=session,
    )
    await session.commit()

    assert event_id_2 == event_id_1, "replay must return original audit_event_id"
    assert event_id_3 == event_id_1, "replay must return original audit_event_id"
    assert row_2 is None, "replay must not return a new AuditChainRow"
    assert row_3 is None, "replay must not return a new AuditChainRow"

    # Exactly one chain row for that client_action_id.
    count = await session.execute(
        sql_text(
            """
            SELECT COUNT(*)
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
    assert int(count.scalar_one()) == 1
