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
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

GENESIS_HASH: bytes = b"\x00" * 32

# Canonical-JSON separators — MUST stay in sync with every LIKE pattern that
# probes ``audit_event_chain.canonical_json`` (clipboard_export_event,
# audit_retention_attestation, …). Drift here was historically the cause of
# silent idempotency-replay misses (B-AUDIT-2).
CANONICAL_JSON_SEPARATORS: tuple[str, str] = (",", ":")


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def canonical_json(obj: Any) -> str:
    """RFC 8785 JCS canonical JSON serialization.

    We use ``json.dumps`` with ``sort_keys=True`` and compact separators
    (``separators=(",", ":")`` — NO whitespace anywhere). ``ensure_ascii=False``
    keeps UTF-8 bytes for Georgian / German text so the resulting hash is
    stable across platforms that don't escape non-ASCII identically.

    Every LIKE-pattern that probes ``canonical_json`` MUST be written with the
    same no-space convention. Use :data:`CANONICAL_JSON_SEPARATORS` if you
    construct the separator dynamically.
    """
    return json.dumps(
        obj,
        sort_keys=True,
        separators=CANONICAL_JSON_SEPARATORS,
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

        # 0. Per-tenant advisory lock — closes the first-row race where
        #    two writers see an empty chain, both compute ``sequence_no=1``,
        #    and one wins the unique PK while the other 500s. ``FOR UPDATE``
        #    on step 1 only locks an *existing* row; it cannot lock the
        #    "no row" condition, so we need a lock keyed on the tenant
        #    itself. ``pg_advisory_xact_lock`` auto-releases at COMMIT /
        #    ROLLBACK, so we stay atomic with the caller's transaction.
        #
        #    hashtext() folds the UUID string into the 32-bit lock-key
        #    space Postgres expects. Per-tenant collisions are theoretically
        #    possible but harmless — at worst two unrelated tenants serialise
        #    their writes briefly.
        #
        #    Fixes audit findings B-AUDIT-5 and B-SCHEMA-2.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:tid))"),
            {"tid": tid_str},
        )

        # 1. Lock the previous row + read the previous leaf hash.
        #    ``FOR UPDATE`` serializes concurrent writers per tenant
        #    *once at least one row exists*; the advisory lock above
        #    handles the empty-chain case.
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


    # -----------------------------------------------------------------
    # Request-bound helpers (T062 wiring)
    # -----------------------------------------------------------------

    @classmethod
    def from_request(cls, request: Any) -> "RequestBoundAuditChainWriter":
        """Return a writer bound to FastAPI ``request`` state.

        Pulls ``tenant_id``, the actor's principal id (``request.state.user``),
        the request correlation id, and remote-addr / user-agent off the
        request so :meth:`write_permission_check` can record them without
        duplicating the extraction in every middleware call site.

        Used by ``middleware/require_permission.py`` — fixes B-AUDIT-3
        (helper method was referenced but never existed).
        """
        return RequestBoundAuditChainWriter(request, base_writer=cls())


@dataclass
class RequestBoundAuditChainWriter:
    """Convenience wrapper that pre-fills tenant/actor from ``Request.state``.

    Why a separate class: the core :class:`AuditChainWriter.write` takes an
    explicit ``session`` + ``tenant_id`` so it stays usable in batch jobs
    (Celery beat, cron). Middleware doesn't have a session in hand at the
    decorator boundary — it just wants to emit "did/didn't grant this
    permission" with the correlation it already carries. This wrapper bridges
    those two worlds without compromising the core writer's purity.
    """

    request: Any
    base_writer: "AuditChainWriter"

    # The writer's own session factory — used so the permission-check writes
    # in their OWN short-lived transaction (we don't want to entangle the
    # caller's request transaction with audit IO; this matches the existing
    # ``compliance/chain_verifier`` pattern of "audit row commits independently
    # of the business write" for middleware-emitted events).
    async def write_permission_check(
        self,
        *,
        actor: Optional[str],
        tenant: Optional[str],
        permission: str,
        outcome: str,
        reason: Optional[str] = None,
        path: Optional[str] = None,
        method: Optional[str] = None,
    ) -> Optional[AuditChainRow]:
        """Emit one ``permission_check`` AuditEvent.

        ``outcome`` is one of ``allowed`` / ``denied`` / ``unauthenticated`` /
        ``cross-tenant`` / ``step-up-required`` (mirrors the strings the
        middleware passes). Translated to FHIR ``AuditEvent.outcome`` per
        spec data-model §14: ``allowed`` → ``"0"``; everything else is
        treated as ``"8"`` (serious) so a security operator gets the
        denial highlighted.

        Best-effort: returns ``None`` instead of raising when the session
        factory or tenant is missing. The middleware decorator MUST NOT
        observably fail just because audit is offline (constitution §Defense
        in depth — never break the request path on audit IO).
        """
        if not tenant:
            logger.debug("permission_check audit skipped (no tenant on request)")
            return None

        session_factory = self.base_writer._session_factory
        if session_factory is None:
            logger.debug(
                "permission_check audit skipped (no session factory wired)"
            )
            return None

        try:
            tenant_uuid = UUID(str(tenant))
        except (TypeError, ValueError):
            logger.warning("permission_check audit: invalid tenant id %r", tenant)
            return None

        outcome_code = "0" if outcome == "allowed" else "8"
        request_id = getattr(self.request.state, "request_id", None) if hasattr(self.request, "state") else None
        user_agent = (
            self.request.headers.get("user-agent")
            if hasattr(self.request, "headers")
            else None
        )

        event: dict[str, Any] = {
            "resourceType": "AuditEvent",
            "type": {
                "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
                "code": "rest",
                "display": "RESTful Operation",
            },
            "subtype": [
                {
                    "system": "http://liverra.ai/fhir/CodeSystem/audit-subtypes",
                    "code": "permission_check",
                }
            ],
            "action": "E",
            "recorded": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "outcome": outcome_code,
            "agent": [
                {
                    "who": {
                        "reference": (
                            f"Practitioner/{actor}" if actor else "Device/liverra-anonymous"
                        )
                    },
                    "requestor": True,
                }
            ],
            "source": {"observer": {"reference": "Device/liverra-ml-inference"}},
            "entity": [
                {
                    "what": {"reference": f"Permission/{permission}"},
                    "detail": [
                        d
                        for d in (
                            {"type": "outcome_label", "valueString": outcome},
                            {"type": "reason", "valueString": reason} if reason else None,
                            {"type": "path", "valueString": path} if path else None,
                            {"type": "method", "valueString": method} if method else None,
                            {"type": "request_id", "valueString": str(request_id)} if request_id else None,
                            {"type": "user_agent", "valueString": str(user_agent)} if user_agent else None,
                        )
                        if d is not None
                    ],
                }
            ],
        }

        # Permission-check events run in their own dedicated session so the
        # request transaction is never blocked on audit IO. Errors are
        # logged + propagated to Sentry but never re-raised — middleware is
        # constitutionally fail-open on the audit log itself (the upstream
        # ``permission_check`` decision is enforced regardless of audit).
        try:
            session_ctx = session_factory()
            if hasattr(session_ctx, "__aenter__"):
                async with session_ctx as session:  # type: ignore[union-attr]
                    row = await self.base_writer.write(
                        event_dict=event,
                        tenant_id=tenant_uuid,
                        session=session,
                    )
                    await session.commit()
            else:
                row = await self.base_writer.write(
                    event_dict=event,
                    tenant_id=tenant_uuid,
                    session=session_ctx,  # type: ignore[arg-type]
                )
            return row
        except Exception:
            logger.exception(
                "permission_check audit write failed (perm=%s outcome=%s)",
                permission,
                outcome,
            )
            return None


# ---------------------------------------------------------------------------
# Chain verification — DB-backed AND pure-functional (B-AUDIT-6)
# ---------------------------------------------------------------------------


@dataclass
class ChainVerifyResult:
    """Outcome of :func:`verify_chain` / :func:`verify_chain_db`.

    ``ok``                          — every leaf hash matches AND no gaps.
    ``first_invalid_sequence_no``   — first row whose recomputed leaf hash
                                      did not match storage, or ``None`` on a
                                      pristine chain.
    ``gaps``                        — list of ``(missing_start, missing_end)``
                                      sequence-no ranges (inclusive) detected
                                      during the walk.
    ``rows_checked``                — total rows examined.
    """

    ok: bool
    rows_checked: int = 0
    first_invalid_sequence_no: Optional[int] = None
    gaps: list[tuple[int, int]] = field(default_factory=list)


def _recompute_leaf_hash(
    *,
    tenant_id: str,
    sequence_no: int,
    canonical: str,
    prev_leaf_hash: bytes,
) -> bytes:
    """Reproduce the writer's hashing formula byte-for-byte.

    MUST mirror :meth:`AuditChainWriter.write` — drifting here would mean
    the verifier flags every row as tampered.
    """
    canonical_sha = sha256(
        tenant_id.encode("utf-8")
        + b":"
        + str(sequence_no).encode("utf-8")
        + b":"
        + canonical.encode("utf-8")
    )
    return sha256(prev_leaf_hash + canonical_sha)


def verify_chain(chain: list[dict[str, Any]]) -> ChainVerifyResult | bool:
    """Verify an in-memory list of chain rows.

    Test-facing entry point (used by ``test_chain_of_hashes.py``). Accepts
    rows shaped like the dicts returned by :func:`write_event` below, walks
    them in order, and asserts that every ``leaf_hash`` is consistent with
    the canonical-JSON of the row's event payload.

    Returns ``True``/``False`` for backward-compat with the existing test
    helper that wraps the call in ``bool(...)``. The richer
    :class:`ChainVerifyResult` is available via :attr:`ChainVerifyResult.ok`
    when a caller wants the breakdown — for now the contract is the simple
    bool.
    """
    if not chain:
        return True

    expected_prev: bytes = GENESIS_HASH
    last_seq: Optional[int] = None

    for row in chain:
        try:
            seq = int(row["sequence"])
            stored_prev_hex = row.get("prev_hash") or row.get("prev_leaf_hash")
            stored_leaf_hex = row["leaf_hash"]
            tenant_id_raw = str(row.get("tenant_id") or row.get("tenant") or "")
            payload = row.get("payload") or row.get("event") or row
        except (KeyError, ValueError, TypeError):
            return False

        # Linearity — sequence numbers must be monotonic with no gaps.
        if last_seq is not None and seq != last_seq + 1:
            return False
        last_seq = seq

        try:
            stored_prev = bytes.fromhex(stored_prev_hex) if stored_prev_hex else GENESIS_HASH
            stored_leaf = bytes.fromhex(stored_leaf_hex)
        except (TypeError, ValueError):
            return False

        if stored_prev != expected_prev:
            return False

        # Recompute over a normalized payload — we use the same canonical
        # serializer the writer uses so the test's "modify a non-hash field"
        # threat model surfaces.
        payload_canonical = canonical_json(_strip_hashes(payload))
        recomputed = _recompute_leaf_hash(
            tenant_id=tenant_id_raw,
            sequence_no=seq,
            canonical=payload_canonical,
            prev_leaf_hash=stored_prev,
        )
        if recomputed != stored_leaf:
            return False

        expected_prev = stored_leaf

    return True


def _strip_hashes(event: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``event`` with chain-bookkeeping keys removed.

    The writer hashes the AuditEvent payload BEFORE it stamps ``leaf_hash``,
    ``prev_hash``, and ``sequence`` onto the returned row. The verifier must
    strip those same keys before recomputing — otherwise the hash would
    include its own hash (impossible to satisfy).
    """
    if not isinstance(event, dict):
        return event
    return {
        k: v
        for k, v in event.items()
        if k not in {"leaf_hash", "prev_hash", "prev_leaf_hash", "sequence"}
    }


def write_event(event: dict[str, Any], *, state: dict[str, Any]) -> dict[str, Any]:
    """Append ``event`` to an in-memory chain held inside ``state``.

    Pure-Python counterpart to :meth:`AuditChainWriter.write` used by the
    unit tests in ``src/services/audit/tests/test_chain_of_hashes.py``.
    The on-disk writer is the source of truth for production; this helper
    exists so the tamper-detection invariants can be exercised without a
    Postgres dependency.

    ``state`` is a caller-owned dict that accumulates ``prev_leaf_hash``
    and the running ``sequence_no`` between calls. The first call seeds
    them from genesis.
    """
    prev_leaf: bytes = state.get("_prev_leaf", GENESIS_HASH)
    seq: int = int(state.get("_next_seq", 1))
    tenant_id = str(event.get("tenant_id") or "tenant-test")

    canonical = canonical_json(_strip_hashes(event))
    leaf_hash = _recompute_leaf_hash(
        tenant_id=tenant_id,
        sequence_no=seq,
        canonical=canonical,
        prev_leaf_hash=prev_leaf,
    )

    row = dict(event)
    row["sequence"] = seq
    row["tenant_id"] = tenant_id
    row["prev_hash"] = prev_leaf.hex()
    row["leaf_hash"] = leaf_hash.hex()

    state["_prev_leaf"] = leaf_hash
    state["_next_seq"] = seq + 1
    return row


async def verify_chain_db(
    session: AsyncSession,
    tenant_id: UUID,
    *,
    start_seq: Optional[int] = None,
    end_seq: Optional[int] = None,
) -> ChainVerifyResult:
    """Walk ``audit_event_chain`` for ``tenant_id`` and verify integrity.

    Recomputes each row's ``leaf_hash``, detects sequence-no gaps, and
    returns a :class:`ChainVerifyResult`. Used by the retention-attestation
    job (H-AUDIT-4) to give regulators TWO independent witnesses that the
    chain wasn't truncated (the daily Merkle anchor is the other).
    """
    clauses = ["tenant_id = :tid"]
    params: dict[str, Any] = {"tid": str(tenant_id)}
    if start_seq is not None:
        clauses.append("sequence_no >= :start")
        params["start"] = start_seq
    if end_seq is not None:
        clauses.append("sequence_no <= :end")
        params["end"] = end_seq

    sql = (
        "SELECT sequence_no, canonical_json, leaf_hash, prev_leaf_hash "
        "FROM audit_event_chain WHERE "
        + " AND ".join(clauses)
        + " ORDER BY sequence_no ASC"
    )

    result = await session.execute(text(sql), params)
    rows = result.mappings().all()

    if not rows:
        return ChainVerifyResult(ok=True, rows_checked=0)

    res = ChainVerifyResult(ok=True, rows_checked=len(rows))
    expected_prev: bytes = GENESIS_HASH

    # Seed expected_prev with the row before our window, if any.
    first_seq = int(rows[0]["sequence_no"])
    if first_seq > 1 and (start_seq is None or start_seq > 1):
        prior = (
            await session.execute(
                text(
                    "SELECT leaf_hash FROM audit_event_chain "
                    "WHERE tenant_id = :tid AND sequence_no = :seq"
                ),
                {"tid": str(tenant_id), "seq": first_seq - 1},
            )
        ).first()
        if prior is not None:
            expected_prev = bytes(prior[0])

    last_seq_seen: Optional[int] = None
    for row in rows:
        seq = int(row["sequence_no"])
        canonical = row["canonical_json"]
        stored_leaf = bytes(row["leaf_hash"])
        stored_prev = bytes(row["prev_leaf_hash"])

        # Gap detection — record missing sequence numbers.
        if last_seq_seen is not None and seq != last_seq_seen + 1:
            res.gaps.append((last_seq_seen + 1, seq - 1))
            res.ok = False
        last_seq_seen = seq

        if stored_prev != expected_prev:
            res.ok = False
            if res.first_invalid_sequence_no is None:
                res.first_invalid_sequence_no = seq
            break

        recomputed = _recompute_leaf_hash(
            tenant_id=str(tenant_id),
            sequence_no=seq,
            canonical=canonical,
            prev_leaf_hash=expected_prev,
        )
        if recomputed != stored_leaf:
            res.ok = False
            if res.first_invalid_sequence_no is None:
                res.first_invalid_sequence_no = seq
            break

        expected_prev = stored_leaf

    return res


__all__ = [
    "AuditChainRow",
    "AuditChainWriter",
    "CANONICAL_JSON_SEPARATORS",
    "ChainVerifyResult",
    "GENESIS_HASH",
    "RequestBoundAuditChainWriter",
    "canonical_json",
    "sha256",
    "verify_chain",
    "verify_chain_db",
    "write_event",
]
