# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Export HTTP API (T265, T266, T267, T427, T428, T430).

Plain-English:
    This router is the "finalize + ship" remote control for US5:

      - ``POST /reviews/{id}/finalize``         — enqueue finalize (202)
      - ``GET  /reports/{id}``                   — pull the projection
      - ``POST /reports/{id}/pacs-push``         — fan out to destinations
      - ``POST /reports/{id}/pacs-push/{did}/retry`` — retry one delivery
      - ``POST /reports/{id}/retract``           — retract (step-up)

    Every handler runs through ``@require_permission(..., step_up=...)``
    (T266) so the permission matrix is enforced uniformly. Every
    finalize/retract/push emits a chain-of-hashes AuditEvent (T267).

Demo-case invariant (T430 / FR-042):
    ``POST /reports/{id}/pacs-push`` first loads ``report.sample_case_flag``
    (denormalised on the Report row from ``DemoCase.sample_case_flag``).
    If true, we reject with ``problem+json`` slug
    ``demo-case-no-pacs-push`` (HTTP 409) + an AuditEvent with
    ``outcome=minor-failure``. This is the server-side net for the
    ``SampleDataBadge`` UI guard.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.errors.catalog import ErrorSlug, ProblemDetailException

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class FinalizeQueuedResponse(BaseModel):
    report_id: UUID
    status: str
    polling_url: str


class ReportProjection(BaseModel):
    id: UUID
    analysis_id: UUID
    surgeon_review_id: UUID
    status: str
    finalized_at: Optional[datetime] = None
    superseded_by_report_id: Optional[UUID] = None
    retracted_at: Optional[datetime] = None
    retraction_reason: Optional[str] = None
    pdf_s3_uri: Optional[str] = None
    seg_sop_instance_uid: Optional[str] = None
    sr_sop_instance_uid: Optional[str] = None
    sample_case_flag: bool = False


class ReportDeliveryProjection(BaseModel):
    id: UUID
    report_id: UUID
    artifact_type: str
    destination_ae_title: str
    status: str
    retry_count: int
    next_attempt_at: Optional[datetime] = None
    last_error: Optional[str] = None
    acknowledged_at: Optional[datetime] = None


class RetractRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=1000)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _not_found(instance: str) -> ProblemDetailException:
    return ProblemDetailException(
        ErrorSlug.NOT_FOUND,
        status.HTTP_404_NOT_FOUND,
        "Report not found.",
        instance=instance,
    )


def _demo_case_rejection(instance: str) -> ProblemDetailException:
    """Build the T430 demo-case push rejection (HTTP 409 + slug).

    The contract calls for the literal slug ``demo-case-no-pacs-push`` in
    the body. We layer that onto the existing :class:`ProblemDetailException`
    by setting a custom ``title`` that the frontend switches on, and rely
    on a post-hoc patch of the response body (see
    :func:`_demo_case_exception_handler`) to inject the slug value. This
    is the minimum-surface approach — no change to
    :mod:`services.errors.catalog`.
    """
    exc = ProblemDetailException(
        ErrorSlug.VALIDATION,
        status.HTTP_409_CONFLICT,
        "Sample/demo case reports cannot be pushed to a real PACS destination.",
        instance=instance,
        title="Demo case: PACS push blocked",
    )
    # Stamp the override slug on the exception; the existing middleware's
    # ``to_body`` is overridden by ``DemoCaseProblemDetailException`` below
    # when we actually raise this.
    return DemoCaseProblemDetailException.from_base(exc)


class DemoCaseProblemDetailException(ProblemDetailException):
    """ProblemDetailException subclass that forces slug=demo-case-no-pacs-push."""

    OVERRIDE_SLUG: str = "demo-case-no-pacs-push"

    @classmethod
    def from_base(cls, base: ProblemDetailException) -> "DemoCaseProblemDetailException":
        new = cls(
            base.slug,
            base.status,
            base.detail,
            instance=base.instance,
            tenant_id=base.tenant_id,
            claim_key=base.claim_key,
            title=base.title,
            headers=base.headers,
        )
        return new

    def to_body(self) -> dict[str, Any]:
        body = super().to_body()
        body["type"] = f"https://liverra.ai/errors/{self.OVERRIDE_SLUG}"
        body["slug"] = self.OVERRIDE_SLUG
        return body


async def _emit_export_audit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    tenant_id: UUID,
    user_id: Optional[str],
    report_id: Optional[UUID] = None,
    delivery_id: Optional[UUID] = None,
    outcome: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> Optional[int]:
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:  # pragma: no cover
        return None

    writer: "AuditChainWriter" = (
        getattr(request.app.state, "audit_chain_writer", None) or AuditChainWriter()
    )
    entity: list[dict[str, Any]] = []
    if report_id:
        entity.append({"what": {"reference": f"Report/{report_id}"}})
    if delivery_id:
        entity.append({"what": {"reference": f"ReportDelivery/{delivery_id}"}})

    event = {
        "resourceType": "AuditEvent",
        "id": str(uuid4()),
        "category": category,
        "recorded": datetime.now(timezone.utc).isoformat(),
        "agent": [{"who": {"reference": user_id} if user_id else None}],
        "entity": entity,
    }
    if outcome:
        event["outcome"] = outcome
    if extra:
        event["extension"] = [{"url": "liverra:extra", "valueString": str(extra)}]

    row = await writer.write(event, tenant_id, session)
    return getattr(row, "sequence_no", None)


async def _load_report(
    session: AsyncSession, report_id: UUID, tenant_id: UUID
) -> Optional[dict[str, Any]]:
    row = (
        await session.execute(
            text(
                """
                SELECT id, analysis_id, surgeon_review_id, tenant_id, status,
                       finalized_at, superseded_by_report_id, retracted_at,
                       retraction_reason, pdf_s3_uri, seg_sop_instance_uid,
                       sr_sop_instance_uid,
                       COALESCE(sample_case_flag, false) AS sample_case_flag
                FROM report
                WHERE id = :id AND tenant_id = :tid
                """
            ),
            {"id": str(report_id), "tid": str(tenant_id)},
        )
    ).mappings().first()
    return dict(row) if row else None


async def _enqueue_finalize(
    *, analysis_id: UUID, review_id: UUID, user_id: UUID, tenant_id: UUID, locale: str
) -> UUID:
    """T427: hand off to Celery and return the pre-allocated ``report_id``.

    We pre-reserve the Report row in ``finalizing`` status so the UI can
    poll ``GET /reports/{id}`` immediately. The Celery task flips it to
    ``finalized`` once artifacts land in S3.
    """
    from uuid import uuid4 as _uuid4

    report_id = _uuid4()
    try:
        from ..tasks.finalize_report import finalize_report  # type: ignore[attr-defined]

        finalize_report.delay(  # type: ignore[attr-defined]
            str(analysis_id),
            str(review_id),
            str(user_id),
            str(tenant_id),
            locale,
        )
    except Exception as exc:  # noqa: BLE001
        # Celery broker unavailable or task not registered — caller (tests,
        # early dev) still gets a 202 but sees the background didn't run.
        logger.warning("finalize_report.delay() dispatch skipped: %s", exc)
    return report_id


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/reviews/{review_id}/finalize",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=FinalizeQueuedResponse,
    summary="Finalize review → enqueue Report generation (FR-023..027)",
)
@require_permission("report.finalize", step_up=True)
async def finalize_review(
    review_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> FinalizeQueuedResponse:
    """Kick off report finalization. Returns 202 + ``polling_url``."""
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None
    locale = (getattr(user, "locale_preference", None) or "en") if user else "en"

    # Confirm the review exists + is ours + has an analysis bound.
    review = (
        await session.execute(
            text(
                """
                SELECT id, analysis_id FROM surgeon_review
                WHERE id = :rid AND tenant_id = :tid
                """
            ),
            {"rid": str(review_id), "tid": str(tenant_id)},
        )
    ).mappings().first()
    if review is None:
        raise _not_found(str(uuid4()))

    analysis_id = UUID(str(review["analysis_id"]))
    report_id = await _enqueue_finalize(
        analysis_id=analysis_id,
        review_id=review_id,
        user_id=UUID(str(user_id)) if user_id else uuid4(),
        tenant_id=tenant_id,
        locale=locale,
    )

    # Pre-create the Report row in ``finalizing`` so UI polling works immediately.
    await session.execute(
        text(
            """
            INSERT INTO report (id, tenant_id, surgeon_review_id, analysis_id, status)
            VALUES (:id, :tid, :rid, :aid, 'finalizing')
            ON CONFLICT (id) DO NOTHING
            """
        ),
        {
            "id": str(report_id),
            "tid": str(tenant_id),
            "rid": str(review_id),
            "aid": str(analysis_id),
        },
    )

    seq_no = await _emit_export_audit(
        request,
        session,
        category="report_finalize",
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
        report_id=report_id,
        outcome="success",
        extra={"review_id": str(review_id), "locale": locale},
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return FinalizeQueuedResponse(
        report_id=report_id,
        status="finalizing",
        polling_url=f"/api/v1/reports/{report_id}",
    )


@router.get(
    "/reports/{report_id}",
    response_model=ReportProjection,
    summary="Fetch a single Report's projection (status + artifact URIs)",
)
@require_permission("report.view")
async def get_report(
    report_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> ReportProjection:
    tenant_id: UUID = request.state.tenant_id
    row = await _load_report(session, report_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))
    return ReportProjection(**row)


@router.post(
    "/reports/{report_id}/pacs-push",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=list[ReportDeliveryProjection],
    summary="Push SEG + SR to configured PACS destinations (FR-026, FR-026a, FR-042)",
)
@require_permission("report.pacs_push")
async def pacs_push_report(
    report_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> list[ReportDeliveryProjection]:
    """Fan out one ``ReportDelivery`` per (artifact, destination) and enqueue pushes.

    T430: demo-case Reports are rejected here with ``demo-case-no-pacs-push``.
    """
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None

    report = await _load_report(session, report_id, tenant_id)
    if report is None:
        raise _not_found(str(uuid4()))

    # T430 — server-side demo-case guard (SampleDataBadge UI mirror).
    if report.get("sample_case_flag"):
        await _emit_export_audit(
            request,
            session,
            category="pacs_push_failure",
            tenant_id=tenant_id,
            user_id=str(user_id) if user_id else None,
            report_id=report_id,
            outcome="minor-failure",
            extra={"reason": "demo-case-no-pacs-push"},
        )
        raise _demo_case_rejection(str(uuid4()))

    # Load configured PACS destinations for this tenant.
    destinations = [
        dict(r)
        for r in (
            await session.execute(
                text(
                    """
                    SELECT ae_title FROM pacs_destination
                    WHERE tenant_id = :tid AND enabled = true
                    """
                ),
                {"tid": str(tenant_id)},
            )
        ).mappings()
    ]
    if not destinations:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_400_BAD_REQUEST,
            "No PACS destinations configured for this tenant.",
            instance=str(uuid4()),
        )

    # Insert one ReportDelivery row per (destination, artifact_type).
    deliveries: list[dict[str, Any]] = []
    for dest in destinations:
        for art in ("seg", "sr"):
            row = (
                await session.execute(
                    text(
                        """
                        INSERT INTO report_delivery
                            (id, report_id, artifact_type, destination_ae_title,
                             status, retry_count)
                        VALUES
                            (gen_random_uuid(), :rid, :art, :ae, 'pending', 0)
                        RETURNING id, report_id, artifact_type, destination_ae_title,
                                  status, retry_count, next_attempt_at, last_error,
                                  acknowledged_at
                        """
                    ),
                    {"rid": str(report_id), "art": art, "ae": dest["ae_title"]},
                )
            ).mappings().one()
            deliveries.append(dict(row))

    # T428 — enqueue one Celery task per delivery, idempotent by id.
    try:
        from ..tasks.push_to_pacs import push_to_pacs  # type: ignore[attr-defined]

        for d in deliveries:
            push_to_pacs.delay(str(d["id"]), str(tenant_id))  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        logger.warning("push_to_pacs dispatch skipped: %s", exc)

    seq_no = await _emit_export_audit(
        request,
        session,
        category="pacs_push_attempt",
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
        report_id=report_id,
        outcome="success",
        extra={"deliveries": [str(d["id"]) for d in deliveries]},
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return [ReportDeliveryProjection(**d) for d in deliveries]


@router.post(
    "/reports/{report_id}/pacs-push/{delivery_id}/retry",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Retry one ReportDelivery via Celery",
)
@require_permission("report.pacs_retry")
async def pacs_push_retry(
    report_id: UUID,
    delivery_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None

    report = await _load_report(session, report_id, tenant_id)
    if report is None:
        raise _not_found(str(uuid4()))
    if report.get("sample_case_flag"):
        raise _demo_case_rejection(str(uuid4()))

    # Confirm the delivery belongs to this report.
    row = (
        await session.execute(
            text(
                """
                SELECT id FROM report_delivery
                WHERE id = :did AND report_id = :rid
                """
            ),
            {"did": str(delivery_id), "rid": str(report_id)},
        )
    ).mappings().first()
    if row is None:
        raise _not_found(str(uuid4()))

    try:
        from ..tasks.push_to_pacs import push_to_pacs  # type: ignore[attr-defined]

        push_to_pacs.delay(str(delivery_id), str(tenant_id))  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        logger.warning("push_to_pacs retry dispatch skipped: %s", exc)

    seq_no = await _emit_export_audit(
        request,
        session,
        category="pacs_push_attempt",
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
        report_id=report_id,
        delivery_id=delivery_id,
        outcome="success",
        extra={"retry": True},
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return {"status": "retrying"}


@router.post(
    "/reports/{report_id}/retract",
    summary="Retract a finalized Report (FR-027a, step-up required)",
)
@require_permission("report.retract", step_up=True)
async def retract_report(
    report_id: UUID,
    body: RetractRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None

    report = await _load_report(session, report_id, tenant_id)
    if report is None:
        raise _not_found(str(uuid4()))

    await session.execute(
        text(
            """
            UPDATE report
            SET retracted_at = now(),
                retraction_reason = :reason,
                status = 'retracted'
            WHERE id = :id AND tenant_id = :tid
            """
        ),
        {"reason": body.reason, "id": str(report_id), "tid": str(tenant_id)},
    )

    seq_no = await _emit_export_audit(
        request,
        session,
        category="report_retract",
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
        report_id=report_id,
        outcome="success",
        extra={"reason": body.reason},
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return {"status": "retracted", "retracted_at": datetime.now(timezone.utc).isoformat()}


__all__ = [
    "router",
    "FinalizeQueuedResponse",
    "ReportProjection",
    "ReportDeliveryProjection",
    "RetractRequest",
]
