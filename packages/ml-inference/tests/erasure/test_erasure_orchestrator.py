# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.services.erasure.orchestrator`.

The full ``execute()`` pipeline touches KMS, S3, WeasyPrint, and a real
Postgres session. We unit-test the safety-critical primitives:

  * ``compute_tombstone_hash`` — deterministic, study/tenant/timestamp bound.
  * ``_hard_delete_case_graph`` — runs DELETE statements in dependency
    order; missing-table errors are swallowed (dev scaffold), all other
    failures propagate (C-AUDIT-3).
  * ``_insert_tombstone`` — same fail-loud semantics.

We swap the real ``AsyncSession`` for a small in-memory recorder.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest

from src.services.erasure.orchestrator import (
    _CASCADE_TABLES,
    _hard_delete_case_graph,
    _insert_tombstone,
    compute_tombstone_hash,
)


# ---------------------------------------------------------------------------
# AsyncSession test double
# ---------------------------------------------------------------------------


class _Result:
    """Mimics SQLAlchemy ``Result.all()`` for analysis-id lookup."""

    def __init__(self, rows: list[tuple] | None = None) -> None:
        self._rows = rows or []

    def all(self):
        return list(self._rows)


class _RecordingSession:
    """Captures every SQL execution + parameters for verification.

    The orchestrator's first query is the analysis-id SELECT; subsequent
    queries are DELETEs (plus tombstone INSERT). Each call returns a
    fresh ``_Result``; the analysis-id call returns the configured rows.
    """

    def __init__(
        self,
        *,
        analysis_rows: list[tuple] | None = None,
        raise_on_table: str | None = None,
        raise_with: Exception | None = None,
    ) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._analysis_rows = analysis_rows or []
        self._raise_on_table = raise_on_table
        self._raise_with = raise_with or RuntimeError("boom")
        self._first_select_done = False

    async def execute(self, stmt, params=None):  # noqa: ANN001
        sql = str(stmt).strip()
        self.calls.append((sql, dict(params or {})))

        if not self._first_select_done and sql.startswith("SELECT id FROM analysis"):
            self._first_select_done = True
            return _Result(self._analysis_rows)

        if self._raise_on_table and self._raise_on_table in sql:
            raise self._raise_with

        return _Result()


# ---------------------------------------------------------------------------
# compute_tombstone_hash
# ---------------------------------------------------------------------------


def test_tombstone_hash_is_deterministic() -> None:
    sid = UUID("11111111-1111-1111-1111-111111111111")
    tid = UUID("22222222-2222-2222-2222-222222222222")
    ts = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)

    h1 = compute_tombstone_hash(sid, tid, ts)
    h2 = compute_tombstone_hash(sid, tid, ts)
    assert h1 == h2
    assert len(h1) == 32  # SHA-256 → 32 raw bytes


def test_tombstone_hash_differs_on_each_input() -> None:
    sid = UUID("11111111-1111-1111-1111-111111111111")
    tid = UUID("22222222-2222-2222-2222-222222222222")
    ts = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
    base = compute_tombstone_hash(sid, tid, ts)

    # Different study_id → different hash.
    assert compute_tombstone_hash(uuid4(), tid, ts) != base
    # Different tenant_id → different hash.
    assert compute_tombstone_hash(sid, uuid4(), ts) != base
    # Different timestamp → different hash.
    later = datetime(2026, 5, 14, 12, 0, 1, tzinfo=timezone.utc)
    assert compute_tombstone_hash(sid, tid, later) != base


# ---------------------------------------------------------------------------
# _hard_delete_case_graph — runs every cascade table
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hard_delete_runs_every_cascade_table_in_order() -> None:
    """All ``_CASCADE_TABLES`` get a DELETE in the documented order."""
    sid, tid = uuid4(), uuid4()
    aid = uuid4()
    session = _RecordingSession(analysis_rows=[(aid,)])
    await _hard_delete_case_graph(session, study_id=sid, tenant_id=tid)  # type: ignore[arg-type]

    # Drop the leading analysis-id SELECT.
    delete_calls = [c for c in session.calls if c[0].startswith("DELETE FROM")]
    tables_seen = [c[0].split("DELETE FROM", 1)[1].strip().split()[0] for c in delete_calls]
    assert tables_seen == list(_CASCADE_TABLES)


@pytest.mark.asyncio
async def test_hard_delete_carries_tenant_scope_on_study_and_series() -> None:
    """Per orchestrator docstring, every DELETE is scoped to ``tenant_id``."""
    sid, tid = uuid4(), uuid4()
    session = _RecordingSession(analysis_rows=[(uuid4(),)])
    await _hard_delete_case_graph(session, study_id=sid, tenant_id=tid)  # type: ignore[arg-type]

    for sql, params in session.calls:
        if "DELETE FROM study" in sql or "DELETE FROM series" in sql or "DELETE FROM analysis" in sql:
            assert "tenant_id = :tid" in sql
            assert params.get("tid") == str(tid)


# ---------------------------------------------------------------------------
# C-AUDIT-3 — fail-loud on DELETE failure (not "tolerate missing table")
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_failure_reraises_when_not_missing_table() -> None:
    """C-AUDIT-3: a real DB error (FK violation, permission, deadlock) must
    propagate so the caller can roll back. We simulate by raising a generic
    runtime error on a specific table — the orchestrator MUST re-raise."""
    sid, tid = uuid4(), uuid4()
    session = _RecordingSession(
        analysis_rows=[(uuid4(),)],
        raise_on_table="DELETE FROM lesion",
        raise_with=RuntimeError("FK violation"),
    )
    with pytest.raises(RuntimeError, match="FK violation"):
        await _hard_delete_case_graph(session, study_id=sid, tenant_id=tid)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_delete_missing_table_swallowed_for_dev_scaffold() -> None:
    """The narrow ``does not exist`` carve-out keeps dev scaffolds bootstrapping.

    A DELETE error whose message contains "does not exist" is logged + skipped.
    """
    sid, tid = uuid4(), uuid4()
    session = _RecordingSession(
        analysis_rows=[(uuid4(),)],
        raise_on_table="DELETE FROM review",
        raise_with=RuntimeError("relation \"review\" does not exist"),
    )
    # No raise — orchestrator swallows the missing-table error.
    await _hard_delete_case_graph(session, study_id=sid, tenant_id=tid)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_hard_delete_no_analyses_still_runs_study_series_analysis_deletes() -> None:
    """When no analyses exist, the analysis-scoped DELETEs are skipped but
    study/series/analysis tables are still scrubbed."""
    sid, tid = uuid4(), uuid4()
    session = _RecordingSession(analysis_rows=[])
    await _hard_delete_case_graph(session, study_id=sid, tenant_id=tid)  # type: ignore[arg-type]

    delete_tables = [
        c[0].split("DELETE FROM", 1)[1].strip().split()[0]
        for c in session.calls
        if c[0].startswith("DELETE FROM")
    ]
    # Study + series + analysis always; analysis-scoped tables skipped.
    assert "study" in delete_tables
    assert "series" in delete_tables
    assert "analysis" in delete_tables
    # The analysis-scoped tables MUST have been skipped.
    assert "lesion" not in delete_tables
    assert "delivery" not in delete_tables


# ---------------------------------------------------------------------------
# _insert_tombstone — fail-loud semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_insert_tombstone_writes_required_columns() -> None:
    sid, tid, rid = uuid4(), uuid4(), uuid4()
    ts = datetime.now(timezone.utc)
    session = _RecordingSession()
    await _insert_tombstone(
        session,  # type: ignore[arg-type]
        study_id=sid,
        tenant_id=tid,
        erasure_request_id=rid,
        tombstone_hash=b"\xab" * 32,
        executed_at=ts,
    )
    assert len(session.calls) == 1
    sql, params = session.calls[0]
    assert "INSERT INTO erasure_tombstone" in sql
    assert params["sid"] == str(sid)
    assert params["tid"] == str(tid)
    assert params["rid"] == str(rid)
    assert params["h"] == b"\xab" * 32


@pytest.mark.asyncio
async def test_insert_tombstone_real_db_error_propagates() -> None:
    """Same C-AUDIT-3 contract as DELETE: a non-missing-table failure
    must propagate so the caller's txn rolls back."""
    session = _RecordingSession(
        raise_on_table="INSERT INTO erasure_tombstone",
        raise_with=RuntimeError("constraint violation"),
    )
    with pytest.raises(RuntimeError, match="constraint violation"):
        await _insert_tombstone(
            session,  # type: ignore[arg-type]
            study_id=uuid4(),
            tenant_id=uuid4(),
            erasure_request_id=uuid4(),
            tombstone_hash=b"\xab" * 32,
            executed_at=datetime.now(timezone.utc),
        )
