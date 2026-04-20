# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Audit-chain verifier (T339).

Plain-English:
    The audit trail is a linked list of SHA-256 seals (research §A.3):
    each event carries the hash of the previous one, so a single
    tampered byte anywhere in the history breaks the chain forever
    after. This module is the verifier — the inspector who walks
    through a specific time window and asks "do the seals still line
    up?". If any don't, it returns the exact row where the breach
    starts so the compliance view can point at it.

    It also returns the Merkle root for the window and the S3 URIs of
    the daily Merkle anchors the window overlaps — those anchors live
    in an Object-Lock (compliance mode) bucket with 6-year retention
    (research §A.3), so cross-referencing the in-DB computation with
    the anchor proves the database itself wasn't mass-rewritten.

Return shape matches the OpenAPI ``/compliance/audit-summary`` 200
response plus the verifier-internal ``first_invalid_sequence_no`` +
``events`` fields the UI needs (T347 + T449).

Spec refs: research.md §A.3, data-model.md §14, SC-010.
"""
from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


GENESIS_HASH: bytes = b"\x00" * 32


@dataclass(frozen=True)
class AuditSummaryEvent:
    """Projection of one row for the compliance summary table."""

    id: str
    category: str
    actor: str
    subject: str
    timestamp: datetime
    outcome: str
    chain_sequence_no: int


@dataclass
class ChainVerificationResult:
    """Verifier return DTO — serialized 1:1 to the audit-summary response."""

    events: list[AuditSummaryEvent] = field(default_factory=list)
    chain_valid: bool = True
    first_invalid_sequence_no: Optional[int] = None
    merkle_root_for_window: str = ""
    s3_anchor_uris: list[str] = field(default_factory=list)

    def to_api_dict(self) -> dict[str, Any]:
        """Return the response body shaped to ``contracts/api-openapi.yaml``."""
        return {
            "events": [
                {
                    "id": e.id,
                    "category": e.category,
                    "actor": e.actor,
                    "subject": e.subject,
                    "timestamp": e.timestamp.isoformat(),
                    "outcome": e.outcome,
                    "chain_sequence_no": e.chain_sequence_no,
                }
                for e in self.events
            ],
            "chain_valid": self.chain_valid,
            "chain_first_invalid_sequence_no": self.first_invalid_sequence_no,
            "merkle_root_for_window": self.merkle_root_for_window,
            "s3_anchor_uris": self.s3_anchor_uris,
        }


# ---------------------------------------------------------------------------
# Hashing helpers — MUST match ``services/audit/chain_of_hashes.py``.
# ---------------------------------------------------------------------------


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _recompute_leaf_hash(
    *,
    tenant_id: UUID,
    sequence_no: int,
    canonical_json: str,
    prev_leaf_hash: bytes,
) -> bytes:
    """Recompute the leaf hash exactly the way the writer does.

    Must mirror ``services/audit/chain_of_hashes.AuditChainWriter.write``
    byte-for-byte, otherwise verification would erroneously flag every
    row as tampered. Kept as a pure function so unit tests can feed it
    the identical inputs and assert equality.
    """
    canonical_sha = _sha256(
        str(tenant_id).encode("utf-8")
        + b":"
        + str(sequence_no).encode("utf-8")
        + b":"
        + canonical_json.encode("utf-8")
    )
    return _sha256(prev_leaf_hash + canonical_sha)


def _merkle_root(leaves: list[bytes]) -> str:
    """Naive binary-tree Merkle root over ``leaves`` (hex-encoded).

    Empty input → empty string. Odd tiers are duplicated per the common
    Bitcoin convention. The daily anchor task (T067) uses the same
    convention — this function is the read-side equivalent.
    """
    if not leaves:
        return ""
    level: list[bytes] = list(leaves)
    while len(level) > 1:
        if len(level) % 2 == 1:
            level.append(level[-1])
        level = [_sha256(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0].hex()


# ---------------------------------------------------------------------------
# Verifier
# ---------------------------------------------------------------------------


def _s3_anchor_uri(tenant_id: UUID, day: date) -> str:
    """Build the S3 URI of the daily Merkle anchor for ``day``.

    Pattern mirrors the T067 anchor writer:
      ``s3://<bucket>/merkle/<tenant_id>/<YYYY>/<MM>/<DD>.json``.
    """
    bucket = os.environ.get(
        "LIVERRA_AUDIT_ANCHOR_BUCKET", "liverra-audit-anchors-eu-central-1"
    )
    return (
        f"s3://{bucket}/merkle/{tenant_id}/"
        f"{day.year:04d}/{day.month:02d}/{day.day:02d}.json"
    )


def _daily_anchors(
    tenant_id: UUID, frm: datetime, to: datetime
) -> list[str]:
    """Enumerate the daily anchor URIs the window overlaps."""
    out: list[str] = []
    cursor = datetime(frm.year, frm.month, frm.day, tzinfo=timezone.utc).date()
    last = datetime(to.year, to.month, to.day, tzinfo=timezone.utc).date()
    # Hard cap at 400 days to avoid pathological inputs in the API.
    for _ in range(400):
        out.append(_s3_anchor_uri(tenant_id, cursor))
        if cursor >= last:
            break
        cursor = date.fromordinal(cursor.toordinal() + 1)
    return out


async def verify(
    *,
    session: AsyncSession,
    tenant_id: UUID,
    frm: datetime,
    to: datetime,
    max_events: int = 500,
) -> ChainVerificationResult:
    """Verify the audit chain for ``tenant_id`` in ``[frm, to]``.

    Algorithm:
      1. Load all rows in the window ordered by ``sequence_no``.
      2. If the window does not start at ``sequence_no=1``, fetch the
         preceding row's ``leaf_hash`` as the seed ``prev_leaf_hash``.
         (A missing predecessor at a boundary would be caught by the
         sibling daily-anchor check, not by the per-window verifier.)
      3. For each row, recompute ``leaf_hash`` using the same formula
         as ``AuditChainWriter``; if it differs, mark the chain invalid
         at that ``sequence_no`` and stop walking.
      4. Compute a Merkle root of the (recomputed) leaf hashes in the
         window — the UI compares this against the S3 anchor(s).
    """
    rows = (
        await session.execute(
            text(
                """
                SELECT sequence_no, canonical_json, leaf_hash, prev_leaf_hash,
                       written_at
                FROM audit_event_chain
                WHERE tenant_id = :tid
                  AND written_at >= :frm
                  AND written_at <= :to
                ORDER BY sequence_no ASC
                LIMIT :limit
                """
            ),
            {
                "tid": str(tenant_id),
                "frm": frm,
                "to": to,
                "limit": max_events,
            },
        )
    ).mappings().all()

    result = ChainVerificationResult()

    # Seed the walk: if the first row in the window is NOT sequence_no=1,
    # fetch the prior row's stored leaf to chain against.
    prev_leaf: bytes = GENESIS_HASH
    if rows:
        first_seq = int(rows[0]["sequence_no"])
        if first_seq > 1:
            prior = (
                await session.execute(
                    text(
                        """
                        SELECT leaf_hash FROM audit_event_chain
                        WHERE tenant_id = :tid AND sequence_no = :seq
                        """
                    ),
                    {"tid": str(tenant_id), "seq": first_seq - 1},
                )
            ).first()
            if prior is not None:
                prev_leaf = bytes(prior[0])
            else:
                # Missing predecessor → chain is logically broken before
                # the window started. Flag invalidity explicitly.
                result.chain_valid = False
                result.first_invalid_sequence_no = first_seq
                result.s3_anchor_uris = _daily_anchors(tenant_id, frm, to)
                return result

    leaf_hashes: list[bytes] = []
    summary_events: list[AuditSummaryEvent] = []

    for row in rows:
        seq = int(row["sequence_no"])
        canonical: str = row["canonical_json"]
        stored_leaf: bytes = bytes(row["leaf_hash"])
        stored_prev: bytes = bytes(row["prev_leaf_hash"])
        written_at: datetime = row["written_at"]

        # Chain link: stored prev_leaf_hash must equal our running
        # prev_leaf (except at genesis where prev_leaf is GENESIS_HASH).
        if stored_prev != prev_leaf:
            result.chain_valid = False
            result.first_invalid_sequence_no = seq
            break

        recomputed = _recompute_leaf_hash(
            tenant_id=tenant_id,
            sequence_no=seq,
            canonical_json=canonical,
            prev_leaf_hash=prev_leaf,
        )
        if recomputed != stored_leaf:
            result.chain_valid = False
            result.first_invalid_sequence_no = seq
            break

        leaf_hashes.append(stored_leaf)
        summary_events.append(
            _parse_event_summary(row_canonical=canonical, seq=seq, written_at=written_at)
        )
        prev_leaf = stored_leaf

    result.events = summary_events
    result.merkle_root_for_window = _merkle_root(leaf_hashes)
    result.s3_anchor_uris = _daily_anchors(tenant_id, frm, to)
    return result


def _parse_event_summary(
    *, row_canonical: str, seq: int, written_at: datetime
) -> AuditSummaryEvent:
    """Best-effort projection of the FHIR AuditEvent JSON onto the API shape.

    Compliance summary rows are deliberately PHI-free (spec §FR-029); we
    pull only category, actor reference, and the first entity reference
    (the "subject").  Anything missing falls back to empty string so the
    UI can still render the row.
    """
    import json

    try:
        ev: dict[str, Any] = json.loads(row_canonical)
    except Exception:  # noqa: BLE001
        ev = {}

    ev_id = str(ev.get("id") or seq)
    category = str(ev.get("category") or "")

    actor = ""
    agents = ev.get("agent") or []
    if isinstance(agents, list) and agents:
        who = (agents[0] or {}).get("who") or {}
        actor = str(who.get("reference") or "")

    subject = ""
    entities = ev.get("entity") or []
    if isinstance(entities, list) and entities:
        what = (entities[0] or {}).get("what") or {}
        subject = str(what.get("reference") or "")

    outcome = str(ev.get("outcome") or "success")

    return AuditSummaryEvent(
        id=ev_id,
        category=category,
        actor=actor,
        subject=subject,
        timestamp=written_at,
        outcome=outcome,
        chain_sequence_no=seq,
    )


__all__ = [
    "AuditSummaryEvent",
    "ChainVerificationResult",
    "GENESIS_HASH",
    "verify",
]
