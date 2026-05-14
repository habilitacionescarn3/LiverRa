# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Compliance audit-window integration tests (T354).

Plain-English:
    This test asserts the SC-010 reconciliation path end-to-end:

      1. Stand up a fresh Postgres (Testcontainers).
      2. Seed a 7-day audit-chain with N realistic events using the
         live ``AuditChainWriter`` — the exact same code path the hot
         path uses, so the test proves the verifier can round-trip
         real chain rows.
      3. Ask the verifier to walk the 7-day window.
      4. Assert ``chain_valid=True``, ``first_invalid_sequence_no=None``,
         and a non-empty Merkle root.
      5. Corrupt one row mid-chain + re-verify; assert the verifier
         pinpoints the exact ``sequence_no`` where the seal breaks.

    If Testcontainers isn't available (CI without Docker, or
    ``LIVERRA_SKIP_TESTCONTAINERS=1`` is set), the module collects 0
    tests so the CI doesn't fail on laptops.

Run:
    pytest packages/ml-inference/tests/integration/test_compliance_audit_window.py -v
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
import pytest_asyncio

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
    """Spin up a disposable Postgres + return an async DSN."""
    if _SKIP:
        pytest.skip("Testcontainers unavailable or skipped by env.")
    with PostgresContainer("postgres:16-alpine") as container:
        raw = container.get_connection_url().replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
        yield raw


@pytest_asyncio.fixture(scope="module")
async def seeded_session(pg_dsn: str):
    """Create the minimal schema + yield an async session."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

    engine = create_async_engine(pg_dsn, future=True)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    # Create just the audit_event_chain table — the verifier is the only
    # thing exercised here, so we don't need the full migration.
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS audit_event_chain (
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

    async with session_maker() as session:
        yield session

    await engine.dispose()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_chain(session, tenant_id: UUID, n: int, base_time: datetime) -> None:
    """Seed ``n`` chained events using the real AuditChainWriter."""
    from src.services.audit.chain_of_hashes import AuditChainWriter

    writer = AuditChainWriter()
    for i in range(n):
        event = {
            "resourceType": "AuditEvent",
            "id": f"evt-{i}",
            "category": "study_upload" if i % 2 == 0 else "inference_stage_end",
            "recorded": (base_time + timedelta(hours=i)).isoformat(),
            "agent": [{"who": {"reference": f"User/alice-{i}"}}],
            "entity": [{"what": {"reference": f"Study/s-{i}"}}],
            "outcome": "success",
        }
        await writer.write(event, tenant_id, session)
    # Stamp written_at across a 7-day window so the verifier's time
    # filter has something to bite on.
    from sqlalchemy import text as sql_text

    for i in range(n):
        stamped = base_time + timedelta(days=(i * 7) // max(1, n))
        await session.execute(
            sql_text(
                """
                UPDATE audit_event_chain
                SET written_at = :ts
                WHERE tenant_id = :tid AND sequence_no = :seq
                """
            ),
            {"tid": str(tenant_id), "seq": i + 1, "ts": stamped},
        )
    await session.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_seven_day_window_valid(seeded_session):
    """A freshly seeded 7-day chain verifies cleanly."""
    from src.services.compliance import chain_verifier

    tenant_id = uuid4()
    base_time = datetime(2026, 4, 1, tzinfo=timezone.utc)
    await _seed_chain(seeded_session, tenant_id, n=14, base_time=base_time)

    result = await chain_verifier.verify(
        session=seeded_session,
        tenant_id=tenant_id,
        frm=base_time - timedelta(days=1),
        to=base_time + timedelta(days=8),
    )

    assert result.chain_valid is True
    assert result.first_invalid_sequence_no is None
    assert len(result.events) == 14
    assert result.merkle_root_for_window  # non-empty hex
    assert len(result.s3_anchor_uris) >= 7  # one per overlapping day


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_tampered_chain_flags_first_invalid_sequence(seeded_session):
    """Corrupting one row mid-chain must pinpoint the failing sequence_no."""
    from sqlalchemy import text as sql_text

    from src.services.compliance import chain_verifier

    tenant_id = uuid4()
    base_time = datetime(2026, 4, 10, tzinfo=timezone.utc)
    await _seed_chain(seeded_session, tenant_id, n=10, base_time=base_time)

    # Tamper with row #5: rewrite its canonical_json so the stored leaf
    # hash no longer matches the recomputed hash.
    await seeded_session.execute(
        sql_text(
            """
            UPDATE audit_event_chain
            SET canonical_json = '{"resourceType":"AuditEvent","id":"tampered"}'
            WHERE tenant_id = :tid AND sequence_no = 5
            """
        ),
        {"tid": str(tenant_id)},
    )
    await seeded_session.commit()

    result = await chain_verifier.verify(
        session=seeded_session,
        tenant_id=tenant_id,
        frm=base_time - timedelta(days=1),
        to=base_time + timedelta(days=8),
    )

    assert result.chain_valid is False
    assert result.first_invalid_sequence_no == 5


@pytest.mark.skipif(_SKIP, reason="Testcontainers unavailable")
@pytest.mark.asyncio
async def test_merkle_root_stable_across_calls(seeded_session):
    """Two verifications over the same window yield the same Merkle root."""
    from src.services.compliance import chain_verifier

    tenant_id = uuid4()
    base_time = datetime(2026, 3, 1, tzinfo=timezone.utc)
    await _seed_chain(seeded_session, tenant_id, n=5, base_time=base_time)

    kwargs = dict(
        session=seeded_session,
        tenant_id=tenant_id,
        frm=base_time - timedelta(days=1),
        to=base_time + timedelta(days=8),
    )
    r1 = await chain_verifier.verify(**kwargs)
    r2 = await chain_verifier.verify(**kwargs)
    assert r1.merkle_root_for_window == r2.merkle_root_for_window
    assert r1.merkle_root_for_window != ""
