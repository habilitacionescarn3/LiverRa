# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Celery task for pushing a Report to a PACS destination (T264, T428).

Plain-English:
    The finalize flow writes one :class:`ReportDelivery` row per
    ``(report, destination, artifact)`` triple in the ``pending`` state.
    This Celery task is the wheel that actually turns each row: it loads
    the SEG/SR bytes from S3, runs the retry-state-machine-driven push,
    and writes the state back to Postgres.

    Idempotency key: ``(report_id, destination_id, attempt_n)``. Two
    concurrent Celery workers for the same key will serialise via
    ``SELECT ... FOR UPDATE SKIP LOCKED`` on ``report_delivery``.

    PHI handling: any exception string we log to ``last_error`` is run
    through :class:`PHIScrubber` by the FSM before it reaches Postgres.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID, uuid4

try:  # pragma: no cover — boto3 is a production dep
    import boto3  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore[assignment]

try:  # pragma: no cover
    import pydicom  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    pydicom = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text

from src.db.session import get_sessionmaker
from src.observability.phi_scrubber import PHIScrubber
from src.services.pacs_push import retry_state_machine as fsm
from src.services.pacs_push.retry_state_machine import DeliveryRecord, DemoCasePushRejected
from src.services.pacs_push.storescu import PACSDestination, push_artifacts

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers (sync/async bridge for Celery workers)
# ---------------------------------------------------------------------------


async def _load_delivery(session: Any, delivery_id: UUID) -> DeliveryRecord | None:
    row = (
        await session.execute(
            text(
                """
                SELECT rd.id, rd.report_id, rd.destination_ae_title, rd.artifact_type,
                       rd.status, rd.retry_count, rd.last_error, rd.next_attempt_at,
                       rd.first_sent_at, rd.last_attempted_at, rd.acknowledged_at,
                       COALESCE(r.sample_case_flag, false) AS sample_case_flag
                FROM report_delivery rd
                JOIN report r ON r.id = rd.report_id
                WHERE rd.id = :id
                FOR UPDATE
                """
            ),
            {"id": str(delivery_id)},
        )
    ).mappings().first()
    if row is None:
        return None
    return DeliveryRecord(
        id=str(row["id"]),
        report_id=str(row["report_id"]),
        destination_ae_title=row["destination_ae_title"],
        artifact_type=row["artifact_type"],
        status=row["status"],
        retry_count=int(row["retry_count"] or 0),
        last_error=row.get("last_error"),
        next_attempt_at=row.get("next_attempt_at"),
        first_sent_at=row.get("first_sent_at"),
        last_attempted_at=row.get("last_attempted_at"),
        acknowledged_at=row.get("acknowledged_at"),
        sample_case_flag=bool(row.get("sample_case_flag")),
    )


async def _persist_delivery(session: Any, record: DeliveryRecord) -> None:
    await session.execute(
        text(
            """
            UPDATE report_delivery
            SET status = :status,
                retry_count = :retry_count,
                last_error = :last_error,
                next_attempt_at = :next_attempt_at,
                first_sent_at = :first_sent_at,
                last_attempted_at = :last_attempted_at,
                acknowledged_at = :acknowledged_at
            WHERE id = :id
            """
        ),
        {
            "status": record.status,
            "retry_count": record.retry_count,
            "last_error": record.last_error,
            "next_attempt_at": record.next_attempt_at,
            "first_sent_at": record.first_sent_at,
            "last_attempted_at": record.last_attempted_at,
            "acknowledged_at": record.acknowledged_at,
            "id": record.id,
        },
    )


async def _load_destination(session: Any, tenant_id: UUID, ae_title: str) -> PACSDestination:
    row = (
        await session.execute(
            text(
                """
                SELECT ae_title, host, port, caller_ae_title
                FROM pacs_destination
                WHERE tenant_id = :tid AND ae_title = :ae
                """
            ),
            {"tid": str(tenant_id), "ae": ae_title},
        )
    ).mappings().first()
    if row is None:
        raise LookupError(f"pacs_destination tenant={tenant_id} ae={ae_title!r} not found")
    return PACSDestination(
        ae_title=row["ae_title"],
        host=row["host"],
        port=int(row["port"]),
        caller_ae_title=row.get("caller_ae_title") or "LIVERRA",
    )


async def _load_artifact_s3(report_id: UUID, artifact_type: str) -> Any:
    """Load SEG/SR bytes from S3 + parse with pydicom."""
    if pydicom is None or boto3 is None:  # pragma: no cover
        raise RuntimeError("push_to_pacs requires pydicom + boto3 in production")

    from src.db.session import get_sessionmaker

    maker = get_sessionmaker()
    async with maker() as s:
        row = (
            await s.execute(
                text(
                    """
                    SELECT seg_s3_uri, sr_s3_uri
                    FROM report WHERE id = :rid
                    """
                ),
                {"rid": str(report_id)},
            )
        ).mappings().first()

    if row is None:
        raise LookupError(f"report {report_id} not found during artifact load")

    uri: str = row["seg_s3_uri"] if artifact_type == "seg" else row["sr_s3_uri"]
    if not uri.startswith("s3://"):
        raise ValueError(f"unsupported artifact URI: {uri!r}")
    _, _, tail = uri.partition("s3://")
    bucket, _, key = tail.partition("/")

    client = boto3.client("s3")
    body = client.get_object(Bucket=bucket, Key=key)["Body"].read()

    import io

    return pydicom.dcmread(io.BytesIO(body), force=True)


async def _audit(writer: Any, session: Any, category: str, record: DeliveryRecord, tenant_id: UUID) -> None:
    """Emit a ``pacs_push_*`` AuditEvent; fail-closed via AuditChainWriter."""
    if writer is None:
        return
    from datetime import datetime, timezone

    from src.services.audit.audit_helpers import build_audit_event, fhir_ref

    await writer.write(
        build_audit_event(
            category=category,
            entity_refs=[
                fhir_ref("Report", record.report_id),
                fhir_ref("ReportDelivery", record.id),
            ],
            extensions=[
                {"url": "liverra:ae_title", "valueString": record.destination_ae_title},
                {"url": "liverra:artifact_type", "valueString": record.artifact_type},
                {"url": "liverra:retry_count", "valueInteger": record.retry_count},
            ],
        ),
        tenant_id,
        session,
    )


async def _run_once(delivery_id: UUID, tenant_id: UUID) -> None:
    from src.services.audit.chain_of_hashes import AuditChainWriter

    maker = get_sessionmaker()
    async with maker() as session:
        record = await _load_delivery(session, delivery_id)
        if record is None:
            logger.warning("push_to_pacs: delivery %s not found", delivery_id)
            return

        if record.status == fsm.STATE_ACKNOWLEDGED:
            return

        dataset = await _load_artifact_s3(UUID(record.report_id), record.artifact_type)
        destination = await _load_destination(session, tenant_id, record.destination_ae_title)

        scrubber = PHIScrubber()

        async def _sender() -> Any:
            return await push_artifacts(destination, [(record.artifact_type, dataset)])

        try:
            outcome = await fsm.advance(record, _sender, scrubber=scrubber)
        except DemoCasePushRejected as exc:
            logger.warning("DemoCase push rejected delivery=%s: %s", record.id, exc)
            record.status = fsm.STATE_FAILED
            record.last_error = fsm.DEMO_CASE_REJECTION_SLUG
            await _persist_delivery(session, record)
            await session.commit()
            return

        await _persist_delivery(session, outcome.record)
        await _audit(AuditChainWriter(), session, outcome.audit_category or "pacs_push_attempt", outcome.record, tenant_id)
        await session.commit()


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------


try:
    from src.workers.app import app
except ImportError:  # pragma: no cover — test-only bootstrap
    app = None  # type: ignore[assignment]


def push_to_pacs_impl(delivery_id: str, tenant_id: str) -> None:
    """Sync shim — the Celery task body we register below delegates here.

    Kept module-level so tests can import it without a live Celery broker.
    """
    asyncio.run(_run_once(UUID(delivery_id), UUID(tenant_id)))


if app is not None:  # pragma: no cover — Celery registration
    @app.task(
        bind=True,
        name="liverra.tasks.push_to_pacs",
        autoretry_for=(),
        acks_late=True,
    )
    def push_to_pacs(self: Task, delivery_id: str, tenant_id: str) -> None:  # type: ignore[override]
        """Celery entrypoint — idempotent per ``(delivery_id, retry_count)``."""
        push_to_pacs_impl(delivery_id, tenant_id)


__all__ = ["push_to_pacs_impl"]
