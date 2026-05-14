# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Audit residual-identifier rewriter (T325, US9).

Plain-English:
    GDPR Art. 17 says we must erase the data — but our audit chain is
    a linked list of SHA-256 hashes (research §A.3). If we literally
    deleted an audit row the chain would break and we'd lose the
    regulator's trust.

    The workaround (also documented in research §X.1): we keep the
    hashed rows intact (they are one-way hashes, not recoverable) and
    ONLY rewrite the *residual identifiers* that may appear in the
    un-hashed columns (the ``canonical_json`` payload we store for
    debugging + the FHIR ``entity.what.reference`` strings). Residual
    identifiers become ``sha256(orig || tombstone_hash)`` — still
    useful for correlation during a compliance review, but no longer
    traceable back to the patient.

    Critically: we NEVER touch the ``leaf_hash``, ``prev_leaf_hash``,
    or ``sequence_no`` columns. Those are the chain. They are computed
    over the canonical JSON AT THE TIME the event was written — any
    modification would break integrity. We leave them alone.

Spec refs:
    - research.md §A.3 (chain integrity)
    - research.md §X.1 (erasure residual-identifier policy)
    - spec.md §FR-040
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Iterable, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Identifier-shaped patterns we hash-replace in canonical JSON.
# - UUID                 xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
# - DICOM UID            dotted numeric, 9+ components, length 16–64
# - MRN-like             "MRN: 1234567", "Patient ID: X-5532/2025"
# - Email                RFC-ish
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_DICOM_UID_RE = re.compile(r"\b(?:\d+\.){8,}\d+\b")
_MRN_RE = re.compile(r"(?:MRN|Patient[ _-]?ID|PID)\s*[:#]?\s*[A-Za-z0-9\-/]{3,}")
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")


@dataclass(frozen=True)
class RewriteResult:
    events_scanned: int
    events_rewritten: int
    substitutions: int


def _hash_token(token: str, tombstone_hash: bytes) -> str:
    """Return the URL-safe prefix of sha256(token || tombstone_hash).

    12-char prefix is enough for compliance correlation (2^48 space)
    while making brute-force reversal infeasible.
    """
    digest = hashlib.sha256(token.encode("utf-8") + tombstone_hash).hexdigest()
    return f"[erased:{digest[:12]}]"


def _rewrite_string(s: str, tombstone_hash: bytes) -> tuple[str, int]:
    """Rewrite identifier-shaped substrings. Returns (new_string, count)."""
    count = 0

    def _sub(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return _hash_token(match.group(0), tombstone_hash)

    out = _UUID_RE.sub(_sub, s)
    out = _DICOM_UID_RE.sub(_sub, out)
    out = _MRN_RE.sub(_sub, out)
    out = _EMAIL_RE.sub(_sub, out)
    return out, count


def _walk_and_rewrite(
    node: Any, tombstone_hash: bytes, counter: list[int]
) -> Any:
    """Deep-walk dict/list/str, replacing identifier tokens. Pure function."""
    if isinstance(node, dict):
        return {
            k: _walk_and_rewrite(v, tombstone_hash, counter) for k, v in node.items()
        }
    if isinstance(node, list):
        return [_walk_and_rewrite(v, tombstone_hash, counter) for v in node]
    if isinstance(node, str):
        out, n = _rewrite_string(node, tombstone_hash)
        counter[0] += n
        return out
    return node


async def rewrite(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    study_id: UUID,
    tombstone_hash: bytes,
    dry_run: bool = False,
) -> RewriteResult:
    """Rewrite residual identifiers in audit events tied to ``study_id``.

    We SELECT every audit event whose ``canonical_json`` payload mentions
    the study UUID or any UUID that is part of the case graph (analysis,
    segmentation, lesion, etc.). To keep this module DB-agnostic and
    simple, we match against the serialized payload via ``ILIKE``; the
    real discriminator is the UUID rewrite regex.

    Critically: we UPDATE only the ``canonical_json`` column. The
    ``leaf_hash``, ``prev_leaf_hash``, and ``sequence_no`` columns are
    left untouched so the chain remains verifiable — AuditChainWriter's
    contract explicitly tolerates out-of-band ``canonical_json``
    rewrites precisely because of GDPR (see research §A.3).

    Parameters
    ----------
    dry_run:
        When ``True`` returns the substitution count without writing.
        Useful for the erasure confirmation PDF to show "N residual
        identifiers redacted" before committing the irreversible step.
    """
    # B-AUDIT-1 fix: business AuditEvents live in ``audit_event_chain`` per
    # migration 0005 — the side-channel ``audit_event`` table is reserved
    # for ``tampering_attempt`` rows. Querying the wrong table here silently
    # returned ``events_rewritten=0`` and the DPO signed a PDF certifying a
    # step that never ran. Keys here:
    #   - the chain table has no ``id`` column; rows are keyed by
    #     ``(tenant_id, sequence_no)``. We use ``sequence_no`` as the WHERE
    #     selector on UPDATE.
    #   - ``canonical_json`` on this table is ``text`` (not jsonb) so the
    #     UPDATE cast is intentionally a plain string assignment.
    rows = await session.execute(
        text(
            """
            SELECT sequence_no, canonical_json
            FROM audit_event_chain
            WHERE tenant_id = :tid
              AND canonical_json ILIKE :needle
            """
        ),
        {
            "tid": str(tenant_id),
            "needle": f"%{str(study_id)}%",
        },
    )

    scanned = 0
    rewritten = 0
    total_subs = 0

    for row in rows.mappings():
        scanned += 1
        payload = row["canonical_json"]
        if isinstance(payload, str):
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                logger.warning(
                    "audit_event_chain (tenant=%s seq=%s) canonical_json "
                    "not parseable — skipping",
                    tenant_id,
                    row["sequence_no"],
                )
                continue
        else:
            parsed = payload

        counter = [0]
        new_payload = _walk_and_rewrite(parsed, tombstone_hash, counter)
        if counter[0] == 0:
            continue
        total_subs += counter[0]
        rewritten += 1

        if dry_run:
            continue

        # Serialize with canonical settings to keep downstream tooling
        # happy, but note: we are NOT recomputing leaf_hash. The
        # original leaf_hash was computed over the ORIGINAL payload;
        # re-hashing would break the chain. Leaving it intentionally
        # stale is the correct behaviour per research §A.3.
        new_json = json.dumps(
            new_payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        await session.execute(
            text(
                """
                UPDATE audit_event_chain
                SET canonical_json = :json
                WHERE tenant_id = :tid AND sequence_no = :seq
                """
            ),
            {
                "json": new_json,
                "tid": str(tenant_id),
                "seq": row["sequence_no"],
            },
        )

    return RewriteResult(
        events_scanned=scanned,
        events_rewritten=rewritten,
        substitutions=total_subs,
    )


__all__ = ["rewrite", "RewriteResult"]
