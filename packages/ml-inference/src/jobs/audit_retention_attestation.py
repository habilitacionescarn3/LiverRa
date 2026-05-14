# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Annual audit-retention attestation (002-acr-structured-readout T091).

Plain-English:
    Once a year (cron, January 2nd 03:00 UTC) we summarise every
    ``readout-clipboard-export`` audit row written in the previous
    calendar year, sign the summary with HMAC-SHA256, and stash the
    signed JSON in S3 at
    ``s3://{bucket}/retention-attestations/{year}.json``.

    This proves to a CE-MDR / FDA auditor that the per-tenant chain
    was alive and counted at year-end — combined with the daily
    Merkle anchor (T067) it gives auditors two independent witnesses
    that the chain hasn't been silently truncated.

Idempotency:
    Re-running the job for the same year is a no-op: if the S3 key
    already exists, we return the previously-stored summary. The
    chain-of-hashes table has a tamper-detection trigger that raises
    ``check_violation`` on UPDATE/DELETE, so the counts can never
    decrease between invocations.

Dependency injection:
    The function takes ``session_factory`` and ``s3_client`` as
    arguments so tests can hand in fakes. Production callers
    (APScheduler in ``main.py``) construct real ones via the existing
    DB engine and ``boto3.client('s3')``.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


# The HMAC key used to sign the attestation summary. In production this
# should come from KMS — for now we read an env var, and fall back to a
# placeholder so dev tests can run. The docstring documents this clearly.
def _attestation_signing_key() -> bytes:
    """Return the HMAC-SHA256 signing key for the yearly attestation.

    Production should rotate this via KMS; this placeholder lets unit
    tests run without touching AWS.
    """
    raw = os.environ.get("LIVERRA_AUDIT_ATTESTATION_KEY")
    if raw:
        return raw.encode("utf-8")
    logger.warning(
        "LIVERRA_AUDIT_ATTESTATION_KEY not set — using placeholder signing key "
        "(safe for dev only; MUST be set before production deploy)."
    )
    return b"liverra-dev-placeholder-attestation-key"


def _attestation_key(year: int) -> str:
    """S3 object key for the attestation of a given year."""
    return f"retention-attestations/{year}.json"


def _sign(body: bytes) -> str:
    """Return a hex-encoded HMAC-SHA256 of ``body``."""
    return hmac.new(_attestation_signing_key(), body, hashlib.sha256).hexdigest()


async def _count_clipboard_export_rows_by_tenant(
    session: AsyncSession, *, year: int
) -> dict[str, int]:
    """Query the chain for clipboard-export rows in ``year``, grouped by tenant.

    The match key is the canonical-JSON LIKE pattern that the writer
    emits — same idiom used by :mod:`clipboard_export_event` for the
    idempotency lookup. We rely on the chain row's ``canonical_json``
    column containing the FHIR ``"code": "readout-clipboard-export"``
    substring, which is invariant across event versions.
    """
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    # LIKE pattern MUST match the no-space convention emitted by
    # ``services.audit.chain_of_hashes.canonical_json`` (B-AUDIT-2). A
    # ``": "`` here silently misses every row.
    result = await session.execute(
        text(
            """
            SELECT tenant_id::text, COUNT(*)
              FROM audit_event_chain
             WHERE canonical_json LIKE '%"code":"readout-clipboard-export"%'
               AND written_at >= :start
               AND written_at <  :end
             GROUP BY tenant_id
            """
        ),
        {"start": start, "end": end},
    )
    return {row[0]: int(row[1]) for row in result.all()}


async def _verify_chain_for_tenants(
    session: AsyncSession,
    *,
    tenant_ids: list[str],
    year: int,
) -> dict[str, dict[str, Any]]:
    """Run :func:`verify_chain_db` for each tenant over the attestation year.

    Implements H-AUDIT-4: the attestation must not just count rows — it must
    also assert the leaf-hash chain is intact for the year. Returns
    ``{tenant_id: {"chain_valid": bool, "rows_checked": int, "first_invalid_seq": int|None, "gaps": list[[int, int]]}}``.
    Failures are reported per-tenant rather than aborting the whole job; the
    operator can act on the specific tenant whose chain broke.
    """
    from src.services.audit.chain_of_hashes import verify_chain_db

    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)

    out: dict[str, dict[str, Any]] = {}
    for tid_str in tenant_ids:
        try:
            tid = UUID(tid_str)
        except (TypeError, ValueError):
            logger.warning("verify_chain skipped: invalid tenant id %r", tid_str)
            continue
        # Resolve sequence-no boundaries for the year.
        bounds = await session.execute(
            text(
                """
                SELECT MIN(sequence_no), MAX(sequence_no)
                  FROM audit_event_chain
                 WHERE tenant_id = :tid
                   AND written_at >= :start
                   AND written_at <  :end
                """
            ),
            {"tid": tid_str, "start": start, "end": end},
        )
        first_row = bounds.first()
        if first_row is None or first_row[0] is None:
            out[tid_str] = {
                "chain_valid": True,
                "rows_checked": 0,
                "first_invalid_seq": None,
                "gaps": [],
            }
            continue
        start_seq = int(first_row[0])
        end_seq = int(first_row[1])
        result = await verify_chain_db(
            session, tid, start_seq=start_seq, end_seq=end_seq
        )
        out[tid_str] = {
            "chain_valid": result.ok,
            "rows_checked": result.rows_checked,
            "first_invalid_seq": result.first_invalid_sequence_no,
            "gaps": [list(g) for g in result.gaps],
        }
        if not result.ok:
            logger.error(
                "audit_retention_attestation: chain INVALID for tenant=%s year=%d "
                "first_invalid_seq=%s gaps=%s",
                tid_str,
                year,
                result.first_invalid_sequence_no,
                result.gaps,
            )
    return out


def _existing_summary(s3_client: Any, bucket: str, key: str) -> dict[str, int] | None:
    """Return the previously-stored counts if the attestation already exists.

    Treated as authoritative — once an attestation is sealed we never
    overwrite it, even if a late-arriving row would shift the count.
    Such drift should be impossible (chain rows are append-only and
    locked by ``FOR UPDATE``), but the policy is defensive.
    """
    try:
        get = s3_client.get_object(Bucket=bucket, Key=key)
    except Exception:
        return None
    try:
        body = get["Body"].read() if hasattr(get.get("Body", None), "read") else get.get("Body")
        if isinstance(body, bytes):
            body = body.decode("utf-8")
        payload = json.loads(body)
        counts = payload.get("counts_by_tenant")
        if isinstance(counts, dict):
            return {str(k): int(v) for k, v in counts.items()}
    except Exception as exc:  # pragma: no cover — defensive
        logger.warning("Could not parse existing attestation %s: %s", key, exc)
    return None


async def run_attestation(
    *,
    year: int,
    session_factory: Callable[[], AsyncSession]
    | Callable[[], Awaitable[AsyncSession]],
    s3_client: Any,
    bucket: str,
) -> dict[str, int]:
    """Compute + persist the annual clipboard-export attestation.

    Parameters
    ----------
    year:
        The calendar year to summarise (inclusive, UTC). Typically the
        previous calendar year — the scheduled cron in ``main.py``
        passes ``datetime.utcnow().year - 1``.
    session_factory:
        Zero-arg callable yielding an async SQLAlchemy session. Either
        a sync callable returning the session directly or an
        async-context manager — the function handles both.
    s3_client:
        boto3-style S3 client (must implement ``get_object`` and
        ``put_object``). Tests pass a ``unittest.mock.Mock``.
    bucket:
        S3 bucket name. Tests use a string literal.

    Returns
    -------
    dict[str, int]
        ``{tenant_id: row_count}`` for the year. If the attestation
        already exists in S3, returns the stored counts unchanged.
    """
    key = _attestation_key(year)

    existing = _existing_summary(s3_client, bucket, key)
    if existing is not None:
        logger.info(
            "Attestation for %d already present at s3://%s/%s — skipping re-write.",
            year,
            bucket,
            key,
        )
        return existing

    # Resolve the session — supports both sync callables that return a
    # session-context and async-context managers.
    raw = session_factory()
    if hasattr(raw, "__aenter__"):
        async with raw as session:  # type: ignore[union-attr]
            counts = await _count_clipboard_export_rows_by_tenant(session, year=year)
            # H-AUDIT-4: also verify chain integrity per tenant. Two
            # independent witnesses (row count + leaf-hash walk) is what
            # makes the attestation actually attest to anything.
            chain_status = await _verify_chain_for_tenants(
                session, tenant_ids=list(counts.keys()), year=year
            )
    else:
        # Caller already handed us an active session.
        counts = await _count_clipboard_export_rows_by_tenant(raw, year=year)  # type: ignore[arg-type]
        chain_status = await _verify_chain_for_tenants(
            raw, tenant_ids=list(counts.keys()), year=year  # type: ignore[arg-type]
        )

    summary: dict[str, Any] = {
        "kind": "readout_clipboard_export_attestation",
        "year": year,
        "counts_by_tenant": counts,
        "chain_integrity_by_tenant": chain_status,
        "all_chains_valid": all(
            c.get("chain_valid", False) for c in chain_status.values()
        ),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "row_total": sum(counts.values()),
    }
    body_bytes = json.dumps(summary, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    signature = _sign(body_bytes)
    signed_envelope = {
        "summary": summary,
        "signature_hmac_sha256_hex": signature,
        "signature_algorithm": "HMAC-SHA256",
    }
    envelope_bytes = json.dumps(
        signed_envelope, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")

    s3_client.put_object(
        Bucket=bucket,
        Key=key,
        Body=envelope_bytes,
        ContentType="application/json",
    )

    logger.info(
        "Wrote retention attestation for %d to s3://%s/%s (%d tenants, %d rows).",
        year,
        bucket,
        key,
        len(counts),
        summary["row_total"],
    )
    return counts


__all__ = [
    "run_attestation",
]
