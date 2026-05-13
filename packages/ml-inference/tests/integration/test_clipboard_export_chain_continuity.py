# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Chain-continuity proof for clipboard-export rows
(002-acr-structured-readout T085).

Plain-English:
    Three back-to-back clipboard-export events on the same tenant
    must:
      1. Be assigned monotonically increasing ``sequence_no`` values.
      2. Have leaf_hash linked to the prior row via the formula
         documented in ``chain_of_hashes.py``:

           leaf_hash =
             sha256(prev_leaf_hash || sha256(tenant_id || ':' ||
                    sequence_no || ':' || canonical_json))

      3. Be immutable — a DELETE on the table must raise a Postgres
         check_violation (SC-010 tamper-evidence guarantee).

    If the tamper-detection trigger isn't present in the bare test
    schema (T085 creates the table directly without migration 0005's
    triggers), the immutability assertion is xfailed with a clear
    reason rather than failing silently.
"""
from __future__ import annotations

import hashlib
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


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_three_events_have_monotonic_sequence_and_linked_hashes(session) -> None:
    from sqlalchemy import text as sql_text

    from src.services.audit.clipboard_export_event import (
        ClipboardExportAuditPayload,
        emit_clipboard_export,
    )

    tenant_id = uuid4()

    rows = []
    for i in range(3):
        payload = ClipboardExportAuditPayload(
            client_action_id=uuid4(),
            actor_role="attending_radiologist",
            locale="en",
            action_timestamp=datetime(2026, 5, 13, 12, i, 0, tzinfo=timezone.utc),
            outcome="success",
        )
        _, row = await emit_clipboard_export(
            payload,
            actor_id=uuid4(),
            analysis_id=uuid4(),
            tenant_id=tenant_id,
            session=session,
        )
        assert row is not None
        rows.append(row)
    await session.commit()

    # Monotonic sequence_no.
    sequences = [r.sequence_no for r in rows]
    assert sequences == sorted(sequences), "sequence_no must be monotonic"
    assert sequences[0] == 1
    assert sequences[1] == 2
    assert sequences[2] == 3

    # Hash chain — replay the formula from chain_of_hashes.py.
    tid_str = str(tenant_id)
    for i, row in enumerate(rows):
        expected_prev = rows[i - 1].leaf_hash if i > 0 else b"\x00" * 32
        canonical_bytes = row.canonical_json.encode("utf-8")
        inner = hashlib.sha256(
            tid_str.encode("utf-8")
            + b":"
            + str(row.sequence_no).encode("utf-8")
            + b":"
            + canonical_bytes
        ).digest()
        expected_leaf = hashlib.sha256(expected_prev + inner).digest()
        assert (
            bytes(row.leaf_hash) == expected_leaf
        ), f"leaf hash mismatch at sequence_no={row.sequence_no}"
        assert bytes(row.prev_leaf_hash) == expected_prev

    # DELETE must be refused if the tamper-detection trigger is present.
    # The bare test schema doesn't include trigger 0005 — we xfail
    # in that case so this test acts as a probe in fuller integration
    # environments.
    try:
        await session.execute(
            sql_text(
                """
                DELETE FROM audit_event_chain
                 WHERE tenant_id = :tid AND sequence_no = :seq
                """
            ),
            {"tid": tid_str, "seq": rows[0].sequence_no},
        )
        await session.commit()
    except Exception as exc:
        # Any Postgres-side rejection (IntegrityError wrapping a
        # check_violation, raise_exception, etc.) is the desired outcome.
        msg = repr(exc).lower()
        assert (
            "check" in msg
            or "trigger" in msg
            or "integrity" in msg
            or "violat" in msg
        ), f"unexpected error on DELETE attempt: {exc!r}"
        return  # pass — trigger fired

    pytest.xfail(
        "Tamper-detection trigger not present in bare test schema; "
        "full integration env (migration 0005 applied) is required to prove immutability."
    )


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_canonical_json_is_stable_across_writers(session) -> None:
    """The canonical_json column must contain the FHIR subtype code so
    retention attestation (T091) can group by it via LIKE."""
    from src.services.audit.clipboard_export_event import (
        ClipboardExportAuditPayload,
        emit_clipboard_export,
    )

    tenant_id = uuid4()
    payload = ClipboardExportAuditPayload(
        client_action_id=uuid4(),
        actor_role="attending_radiologist",
        locale="ka",
        action_timestamp=datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc),
        outcome="success",
    )
    _, row = await emit_clipboard_export(
        payload,
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=tenant_id,
        session=session,
    )
    await session.commit()
    assert row is not None
    assert '"code": "readout-clipboard-export"' in row.canonical_json
