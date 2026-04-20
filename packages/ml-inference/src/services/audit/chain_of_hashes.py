# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Audit chain-of-hashes writer (T065).

Implements the per-tenant linear SHA-256 chain described in
``specs/001-zero-training-mvp/research.md`` §A.3 and
``data-model.md`` §14.

Plain-English analogy:
    Think of the chain like a wax-sealed bundle of letters. Each new
    letter references the seal of the previous one, so if anyone
    slides a forged letter into the middle the seal chain breaks and
    the forgery is obvious.

Key behaviours:

- Every write happens in the **caller's** SQLAlchemy ``AsyncSession`` /
  Postgres transaction. If the caller's business write rolls back, so
  does the audit row. There is no separate audit transaction — this is
  what makes the chain-of-hashes atomic with the event it describes.
- The previous leaf is read with ``SELECT ... FOR UPDATE`` to serialize
  concurrent writers per tenant (research §A.3 requires strict monotonic
  ``sequence_no``).
- Fail-closed per spec FR-029b: any exception propagates; the caller's
  transaction is expected to roll back. We never swallow errors.

Canonicalization follows RFC 8785 JCS — sorted keys, compact separators,
UTF-8. This is the same canonicalization the daily Merkle anchor task
(T067) feeds into the Merkle leaves.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

GENESIS_HASH: bytes = b"\x00" * 32


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def canonical_json(obj: Any) -> str:
    """RFC 8785 JCS canonical JSON serialization.

    We use ``json.dumps`` with ``sort_keys=True`` and compact separators.
    ``ensure_ascii=False`` keeps UTF-8 bytes for Georgian / German text
    so the resulting hash is stable across platforms that don't escape
    non-ASCII identically.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256(data: bytes) -> bytes:
    """Return the raw 32-byte SHA-256 digest of ``data``."""
    return hashlib.sha256(data).digest()


# ---------------------------------------------------------------------------
# Data transfer object
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuditChainRow:
    """Persisted representation of a single chain entry."""

    tenant_id: UUID
    sequence_no: int
    leaf_hash: bytes
    prev_leaf_hash: bytes
    canonical_json: str
    written_at: datetime


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------


class AuditChainWriter:
    """Appends tamper-evident rows to ``audit_event_chain``.

    The writer is stateless aside from the session factory reference
    (kept for consumers that want to run maintenance queries outside
    an active request context — the hot path uses the session passed
    to :meth:`write`).
    """

    def __init__(
        self,
        session_factory: Callable[[], AsyncSession] | None = None,
    ) -> None:
        # ``session_factory`` is optional so the writer can be constructed
        # in tests with no DB. Production callers must pass the caller's
        # own ``session`` to :meth:`write`.
        self._session_factory = session_factory

    async def write(
        self,
        event_dict: dict[str, Any],
        tenant_id: UUID,
        session: AsyncSession,
    ) -> AuditChainRow:
        """Append one row to the chain within the caller's transaction.

        Parameters
        ----------
        event_dict:
            Dict representing the FHIR AuditEvent (already PHI-scrubbed
            by the caller — see T066 / T069).
        tenant_id:
            Tenant UUID. Used both for partitioning and as mix-in for the
            leaf hash so per-tenant chains cannot be cross-grafted.
        session:
            The caller's live ``AsyncSession``. We intentionally do **not**
            open or commit our own transaction — the audit row lives or
            dies with the caller's business write (FR-029b).

        Returns
        -------
        AuditChainRow
            The row we just inserted.
        """
        canonical = canonical_json(event_dict)
        canonical_bytes = canonical.encode("utf-8")

        tid_str = str(tenant_id)

        # 1. Lock the previous row + read the previous leaf hash.
        #    ``FOR UPDATE`` serializes concurrent writers per tenant.
        prev_row = await session.execute(
            text(
                """
                SELECT leaf_hash
                FROM audit_event_chain
                WHERE tenant_id = :tid
                ORDER BY sequence_no DESC
                LIMIT 1
                FOR UPDATE
                """
            ),
            {"tid": tid_str},
        )
        prev_leaf_hash_row = prev_row.first()
        prev_leaf_hash: bytes = (
            bytes(prev_leaf_hash_row[0]) if prev_leaf_hash_row else GENESIS_HASH
        )

        # 2. Compute next sequence_no.
        seq_row = await session.execute(
            text(
                """
                SELECT COALESCE(MAX(sequence_no), 0) + 1
                FROM audit_event_chain
                WHERE tenant_id = :tid
                """
            ),
            {"tid": tid_str},
        )
        sequence_no: int = int(seq_row.scalar_one())

        # 3. Compute leaf_hash =
        #      sha256(prev_leaf_hash ||
        #             sha256(tenant_id || ':' || seq || ':' || canonical_json))
        canonical_sha = sha256(
            tid_str.encode("utf-8")
            + b":"
            + str(sequence_no).encode("utf-8")
            + b":"
            + canonical_bytes
        )
        leaf_hash = sha256(prev_leaf_hash + canonical_sha)

        written_at = datetime.now(timezone.utc)

        # 4. INSERT the row. Uses parameter binding to avoid SQL injection
        #    and to let asyncpg marshal bytea cleanly.
        await session.execute(
            text(
                """
                INSERT INTO audit_event_chain
                    (tenant_id, sequence_no, leaf_hash, prev_leaf_hash,
                     canonical_json, written_at)
                VALUES
                    (:tid, :seq, :leaf, :prev, :canonical, :written_at)
                """
            ),
            {
                "tid": tid_str,
                "seq": sequence_no,
                "leaf": leaf_hash,
                "prev": prev_leaf_hash,
                "canonical": canonical,
                "written_at": written_at,
            },
        )

        # 5. Return the row. We do NOT commit — that is the caller's job.
        return AuditChainRow(
            tenant_id=tenant_id,
            sequence_no=sequence_no,
            leaf_hash=leaf_hash,
            prev_leaf_hash=prev_leaf_hash,
            canonical_json=canonical,
            written_at=written_at,
        )


__all__ = [
    "AuditChainRow",
    "AuditChainWriter",
    "GENESIS_HASH",
    "canonical_json",
    "sha256",
]
