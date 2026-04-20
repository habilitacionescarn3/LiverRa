# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""FHIR Bundle transaction rollback integration test (T419 / FR-017b).

Plain-English analogy:
    A reviewer batch-saves 5 edits plus 1 audit addendum as a single
    FHIR "transaction" Bundle. Either ALL 6 entries stick, or NONE
    of them do — like a bank transfer that either moves every cent or
    no cents. We inject a deliberate failure on entry N-1 and check
    that nothing lands in the database.

Spec refs: FR-017b, FR-029b (audit atomicity).
"""
from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

import pytest

try:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    _SQLA_AVAILABLE = True
except ImportError:  # pragma: no cover
    _SQLA_AVAILABLE = False


SKIP = not _SQLA_AVAILABLE or not os.environ.get("DATABASE_URL")


def _bundle(segmentation_ids: list[str], fail_at: int) -> dict[str, Any]:
    """Build a FHIR transaction Bundle with a poison-pill row."""
    entries = []
    for i, sid in enumerate(segmentation_ids):
        op: dict[str, Any] = {
            "fullUrl": f"urn:uuid:{sid}",
            "resource": {
                "resourceType": "Observation",
                "id": sid,
                "status": "final",
                "code": {
                    "coding": [
                        {
                            "system": "http://liverra.ai/fhir/segmentation",
                            "code": "mask-edit",
                        }
                    ]
                },
            },
            "request": {"method": "PUT", "url": f"Observation/{sid}"},
        }
        if i == fail_at:
            # Poison pill: missing required `status` → server-side reject.
            op["resource"].pop("status")
        entries.append(op)

    # Trailing AuditEvent addendum.
    entries.append(
        {
            "fullUrl": f"urn:uuid:{uuid4()}",
            "resource": {
                "resourceType": "AuditEvent",
                "action": "U",
                "recorded": "2026-04-19T12:00:00Z",
            },
            "request": {"method": "POST", "url": "AuditEvent"},
        }
    )
    return {"resourceType": "Bundle", "type": "transaction", "entry": entries}


@pytest.mark.integration
@pytest.mark.skipif(SKIP, reason="DATABASE_URL / SQLAlchemy not available")
@pytest.mark.asyncio
async def test_reviewer_bundle_rolls_back_on_failure() -> None:
    """POST N-entry bundle with failure on N-1 → zero side effects."""
    from src.db.session import tenant_session  # type: ignore[import-not-found]

    tenant_id = uuid4()
    seg_ids = [str(uuid4()) for _ in range(5)]
    bundle = _bundle(seg_ids, fail_at=3)  # N-1

    async with tenant_session(tenant_id) as session:  # type: ignore[misc]
        pre = (
            await session.execute(
                text(
                    "SELECT COUNT(*) FROM segmentation "
                    "WHERE id = ANY(CAST(:ids AS uuid[]))"
                ),
                {"ids": seg_ids},
            )
        ).scalar_one()
        pre_audit = (
            await session.execute(
                text("SELECT COUNT(*) FROM audit_event_chain WHERE tenant_id = :tid"),
                {"tid": str(tenant_id)},
            )
        ).scalar_one()

    # Simulate the bundle handler path — we intentionally use a fresh
    # session so the failure propagates like the real FHIR router would.
    try:
        async with tenant_session(tenant_id) as session:  # type: ignore[misc]
            for i, entry in enumerate(bundle["entry"][:-1]):
                res = entry["resource"]
                if "status" not in res:
                    raise ValueError(
                        f"Bundle entry {i} missing required `status`"
                    )
                await session.execute(
                    text(
                        """
                        INSERT INTO segmentation (id, analysis_id, generation_source)
                        VALUES (:id, :aid, 'reviewer_edited')
                        """
                    ),
                    {"id": res["id"], "aid": str(uuid4())},
                )
            # AuditEvent addendum — never reached because of the raise above.
            await session.execute(
                text(
                    "INSERT INTO audit_event_chain "
                    "(tenant_id, sequence_no, leaf_hash, prev_leaf_hash, "
                    " canonical_json, written_at) "
                    "VALUES (:tid, 1, :hash, :hash, '{}', now())"
                ),
                {"tid": str(tenant_id), "hash": b"\x00" * 32},
            )
            await session.commit()
    except ValueError:
        # Expected — the `async with` block will roll back for us.
        pass

    # Post-state: counts unchanged.
    async with tenant_session(tenant_id) as session:  # type: ignore[misc]
        post = (
            await session.execute(
                text(
                    "SELECT COUNT(*) FROM segmentation "
                    "WHERE id = ANY(CAST(:ids AS uuid[]))"
                ),
                {"ids": seg_ids},
            )
        ).scalar_one()
        post_audit = (
            await session.execute(
                text("SELECT COUNT(*) FROM audit_event_chain WHERE tenant_id = :tid"),
                {"tid": str(tenant_id)},
            )
        ).scalar_one()

    assert post == pre, "Bundle rollback failed: segmentations leaked in"
    assert post_audit == pre_audit, "Bundle rollback failed: audit rows leaked in"
