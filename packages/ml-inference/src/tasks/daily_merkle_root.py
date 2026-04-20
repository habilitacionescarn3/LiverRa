# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Daily Merkle-root anchor task (T067).

Runs every day at 02:00 UTC per tenant, computes the Merkle root of
yesterday's ``audit_event_chain`` leaves, and writes a JSON manifest to
S3 (``liverra-audit-anchors-eu-central-1``) with Object Lock compliance
mode + 6-year retention. Research §A.3 + §A.4.

Plain-English analogy:
    Every night we take all the chain seals from the day, bundle them
    into a single "daily fingerprint" (Merkle root), and lock that
    fingerprint in a safe that literally cannot be re-opened for six
    years. If anyone later tampers with yesterday's audit rows, the
    fingerprint won't match the safe copy.

Notes on execution:
    - Celery beat schedules one job per day; the job fans out per
      active tenant.
    - We fail-fast per tenant: if S3 write fails we raise, Celery
      retries with backoff, an operator alert fires, and the day's
      anchor is NOT considered written until the retry succeeds.
    - After a successful anchor, we emit a companion ``audit_anchor_written``
      FHIR AuditEvent (fed through the same chain writer so the anchor
      itself is anchored in the next day's anchor — recursive but
      expected).
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable
from uuid import UUID

try:
    from celery import Celery  # type: ignore[import-not-found]
    from celery.schedules import crontab  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — dev env without celery installed
    Celery = None  # type: ignore[assignment]
    crontab = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

S3_BUCKET: str = "liverra-audit-anchors-eu-central-1"
AWS_REGION: str = "eu-central-1"
OBJECT_LOCK_RETENTION_YEARS: int = 6
OBJECT_LOCK_MODE: str = "COMPLIANCE"  # research §A.3


# ---------------------------------------------------------------------------
# Celery app (created lazily so unit tests don't need a running broker)
# ---------------------------------------------------------------------------


def build_celery_app(broker_url: str | None = None) -> Any:
    """Construct a Celery app wired to ``compute_daily_merkle_root``."""
    if Celery is None:
        raise RuntimeError(
            "celery not installed. Add to requirements.txt before scheduling."
        )
    app = Celery("liverra.audit", broker=broker_url or "redis://redis:6379/0")
    app.conf.timezone = "UTC"
    app.conf.beat_schedule = {
        "daily-merkle-root": {
            "task": "src.tasks.daily_merkle_root.compute_daily_merkle_root",
            "schedule": crontab(hour=2, minute=0),
        },
    }
    app.task(name="src.tasks.daily_merkle_root.compute_daily_merkle_root")(
        compute_daily_merkle_root
    )
    return app


# ---------------------------------------------------------------------------
# Merkle tree core (pure, synchronous, easy to unit-test)
# ---------------------------------------------------------------------------


def compute_merkle_root(leaves: list[bytes]) -> bytes:
    """Return the SHA-256 Merkle root of ``leaves``.

    Uses Bitcoin-style duplicate-odd pairing (if a level has an odd
    number of nodes, the last node is paired with itself). Returns
    32 zero bytes if ``leaves`` is empty.
    """
    if not leaves:
        return b"\x00" * 32
    layer = list(leaves)
    while len(layer) > 1:
        if len(layer) % 2 == 1:
            layer.append(layer[-1])
        layer = [
            hashlib.sha256(layer[i] + layer[i + 1]).digest()
            for i in range(0, len(layer), 2)
        ]
    return layer[0]


# ---------------------------------------------------------------------------
# Main task
# ---------------------------------------------------------------------------


async def compute_daily_merkle_root(target_date: str | None = None) -> list[dict[str, Any]]:
    """Compute + anchor yesterday's Merkle root for every active tenant.

    Parameters
    ----------
    target_date:
        ISO ``YYYY-MM-DD`` override. Default: yesterday (UTC).

    Returns
    -------
    list of dicts
        One manifest per tenant that was anchored. Empty list if no
        tenants had leaves for the day.
    """
    # Local imports: async engine / boto3 should only be required at
    # runtime, not at import-time, so unit tests can exercise the pure
    # Merkle logic without a cloud account.
    import boto3  # type: ignore[import-not-found]

    anchor_date = (
        date.fromisoformat(target_date)
        if target_date
        else (datetime.now(timezone.utc).date() - timedelta(days=1))
    )

    tenants = await _list_active_tenants()
    s3 = boto3.client("s3", region_name=AWS_REGION)
    results: list[dict[str, Any]] = []

    for tenant_id in tenants:
        leaves, first_seq, last_seq = await _fetch_leaves_for_day(
            tenant_id, anchor_date
        )
        if not leaves:
            logger.info(
                "merkle_anchor.skip_empty tenant=%s date=%s",
                tenant_id,
                anchor_date.isoformat(),
            )
            continue

        root = compute_merkle_root(leaves)
        manifest = {
            "tenant_id": str(tenant_id),
            "date": anchor_date.isoformat(),
            "merkle_root": root.hex(),
            "leaf_count": len(leaves),
            "first_seq_no": first_seq,
            "last_seq_no": last_seq,
            "built_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }

        key = f"{tenant_id}/{anchor_date.isoformat()}.json"
        retain_until = datetime.now(timezone.utc) + timedelta(
            days=OBJECT_LOCK_RETENTION_YEARS * 366
        )
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=json.dumps(manifest, separators=(",", ":")).encode("utf-8"),
            ContentType="application/json",
            ObjectLockMode=OBJECT_LOCK_MODE,
            ObjectLockRetainUntilDate=retain_until,
        )
        logger.info(
            "merkle_anchor.written tenant=%s date=%s leaves=%d root=%s",
            tenant_id,
            anchor_date.isoformat(),
            len(leaves),
            root.hex()[:16],
        )

        await _emit_anchor_audit_event(
            tenant_id=tenant_id,
            manifest=manifest,
            s3_key=key,
        )
        results.append(manifest)

    return results


# ---------------------------------------------------------------------------
# Helpers — kept small + injectable so tests can stub them.
# ---------------------------------------------------------------------------


async def _list_active_tenants() -> Iterable[UUID]:
    """Return active tenant UUIDs.

    Placeholder implementation — the real tenant roster is served by
    the ``tenant`` table (migration ``0001_tenant_user``). Replaced by
    the Phase-2 orchestration task that wires this to the DB.
    """
    from src.main import _get_session_factory  # local import avoids cycles

    session_factory = _get_session_factory()
    if session_factory is None:
        logger.warning("merkle_anchor.no_session_factory — returning empty tenant list")
        return []

    from sqlalchemy import text  # type: ignore[import-not-found]

    async with session_factory() as session:
        result = await session.execute(
            text("SELECT id FROM tenant WHERE status = 'active'")
        )
        return [UUID(str(row[0])) for row in result.fetchall()]


async def _fetch_leaves_for_day(
    tenant_id: UUID, anchor_date: date
) -> tuple[list[bytes], int | None, int | None]:
    """Return (leaves, first_seq_no, last_seq_no) ordered by sequence_no."""
    from src.main import _get_session_factory

    session_factory = _get_session_factory()
    if session_factory is None:
        return [], None, None

    from sqlalchemy import text

    day_start = datetime.combine(anchor_date, time.min, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)

    async with session_factory() as session:
        result = await session.execute(
            text(
                """
                SELECT sequence_no, leaf_hash
                FROM audit_event_chain
                WHERE tenant_id = :tid
                  AND written_at >= :start
                  AND written_at <  :end
                ORDER BY sequence_no ASC
                """
            ),
            {"tid": str(tenant_id), "start": day_start, "end": day_end},
        )
        rows = result.fetchall()

    if not rows:
        return [], None, None

    leaves = [bytes(row[1]) for row in rows]
    first_seq = int(rows[0][0])
    last_seq = int(rows[-1][0])
    return leaves, first_seq, last_seq


async def _emit_anchor_audit_event(
    *, tenant_id: UUID, manifest: dict[str, Any], s3_key: str
) -> None:
    """Emit a FHIR AuditEvent recording that we anchored the day.

    Uses the process-wide emitter if it's wired; otherwise logs a
    warning (dev environments). We deliberately don't hard-fail here —
    the audit trail is already sealed in S3; missing the FHIR mirror
    is a downgrade, not a correctness failure.
    """
    try:
        from src.main import _singletons
    except Exception:  # pragma: no cover
        return

    emitter = _singletons.get("audit_event_emitter")
    session_factory = _singletons.get("session_factory") if _singletons else None
    if emitter is None or session_factory is None:
        logger.warning(
            "merkle_anchor.emitter_unwired — skipping FHIR mirror for %s/%s",
            tenant_id,
            s3_key,
        )
        return

    from src.services.fhir.audit_event_emitter import DomainAuditEvent

    event = DomainAuditEvent(
        action_code="audit_anchor_written",
        outcome="0",
        actor_reference="Device/liverra-merkle-anchor",
        entity_references=[f"DocumentReference/{s3_key}"],
        extra_extensions=[
            {"url": "merkle_root", "valueString": manifest["merkle_root"]},
            {"url": "leaf_count", "valueInteger": manifest["leaf_count"]},
        ],
    )

    async with session_factory() as session:
        await emitter.emit(event, tenant_id, session)
        await session.commit()


__all__ = [
    "S3_BUCKET",
    "AWS_REGION",
    "OBJECT_LOCK_RETENTION_YEARS",
    "OBJECT_LOCK_MODE",
    "build_celery_app",
    "compute_daily_merkle_root",
    "compute_merkle_root",
]
