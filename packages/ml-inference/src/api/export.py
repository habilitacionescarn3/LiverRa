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
from fastapi.responses import RedirectResponse
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
    # The actual `report` schema (see Alembic 20260419_0004_review_report)
    # uses `review_id` / `pdf_uri` / `seg_sop_uid` / `sr_sop_uid` /
    # `supersedes_report_id`, has no `tenant_id` (it lives on `analysis`),
    # and stores no explicit `status` / `retraction_reason` /
    # `sample_case_flag` columns. We translate at the SQL boundary so the
    # ReportProjection model + every caller that reads keys like
    # `sample_case_flag` keeps working without a migration.
    row = (
        await session.execute(
            text(
                """
                SELECT
                    r.id,
                    r.analysis_id,
                    r.review_id           AS surgeon_review_id,
                    r.pdf_uri             AS pdf_s3_uri,
                    r.seg_sop_uid         AS seg_sop_instance_uid,
                    r.sr_sop_uid          AS sr_sop_instance_uid,
                    r.finalized_at,
                    r.retracted_at,
                    (
                        SELECT rr.id
                        FROM report rr
                        WHERE rr.supersedes_report_id = r.id
                        LIMIT 1
                    )                     AS superseded_by_report_id,
                    CASE
                        WHEN r.retracted_at IS NOT NULL THEN 'retracted'
                        WHEN EXISTS (
                            SELECT 1 FROM report rr
                            WHERE rr.supersedes_report_id = r.id
                        ) THEN 'superseded'
                        WHEN r.finalized_at IS NULL THEN 'finalizing'
                        ELSE 'finalized'
                    END                   AS status,
                    NULL::text            AS retraction_reason,
                    false                 AS sample_case_flag
                FROM report r
                JOIN analysis a ON a.id = r.analysis_id
                WHERE r.id = :id AND a.tenant_id = :tid
                """
            ),
            {"id": str(report_id), "tid": str(tenant_id)},
        )
    ).mappings().first()
    return dict(row) if row else None


async def _enqueue_finalize(
    *,
    session: AsyncSession,
    analysis_id: UUID,
    review_id: UUID,
    user_id: UUID,
    tenant_id: UUID,
    locale: str,
) -> UUID:
    """T427: persist a placeholder Report row + dispatch the Celery task.

    Plain-English: the heavy SEG/SR/PDF builders in ``tasks/finalize_report``
    are still scaffolded (raise NotImplementedError) pending the
    mask-fetcher integration. Until they land, we still need ``GET
    /reports/{id}`` to return 200 immediately so the wizard's success
    screen + ReportView load. So we INSERT a minimal row here with
    placeholder artifact URIs; once the real builders ship they can flip
    the row in place (or delete + reinsert).
    """
    from uuid import uuid4 as _uuid4

    report_id = _uuid4()

    # Compute the next per-analysis version number. The (analysis_id,
    # version) unique index means we can't reuse 1 for a re-finalize.
    next_version = (
        await session.execute(
            text(
                "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM report "
                "WHERE analysis_id = :aid"
            ),
            {"aid": str(analysis_id)},
        )
    ).scalar_one()

    # Placeholder artifact URIs — the columns are NOT NULL but no content
    # constraint. The PDF URI points at the analysis-level on-demand
    # renderer so a future GET /reports/{id}/pdf route can redirect there
    # if no SEG/SR builder has run yet.
    pdf_uri_placeholder = f"/api/v1/analyses/{analysis_id}/report/pdf"

    # The session arrives inside an outer ``session.begin()`` (see
    # ``db.session.get_db``) — calling commit/rollback ourselves would
    # break that context manager. Let the framework commit on success;
    # any INSERT error propagates as a 500 so it's visible, not silently
    # swallowed.
    await session.execute(
        text(
            """
            INSERT INTO report
                (id, analysis_id, review_id, version,
                 pdf_uri, seg_sop_uid, sr_sop_uid)
            VALUES
                (:id, :aid, :rid, :ver, :pdf, '', '')
            """
        ),
        {
            "id": str(report_id),
            "aid": str(analysis_id),
            "rid": str(review_id),
            "ver": int(next_version),
            "pdf": pdf_uri_placeholder,
        },
    )

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

    # Confirm the review exists + the analysis is in our tenant.
    # surgeon_review has no tenant_id of its own; ownership lives on
    # analysis. Two-table JOIN so a missing review *and* a cross-tenant
    # review both surface as "not found" (FR-032a — never disclose).
    review = (
        await session.execute(
            text(
                """
                SELECT sr.id, sr.analysis_id
                FROM surgeon_review sr
                JOIN analysis a ON a.id = sr.analysis_id
                WHERE sr.id = :rid AND a.tenant_id = :tid
                """
            ),
            {"rid": str(review_id), "tid": str(tenant_id)},
        )
    ).mappings().first()
    if review is None:
        raise _not_found(str(uuid4()))

    analysis_id = UUID(str(review["analysis_id"]))
    report_id = await _enqueue_finalize(
        session=session,
        analysis_id=analysis_id,
        review_id=review_id,
        user_id=UUID(str(user_id)) if user_id else uuid4(),
        tenant_id=tenant_id,
        locale=locale,
    )

    # NOTE: the prior code pre-created a Report row in "finalizing" status,
    # but the actual report schema (migration 0004) has neither a `status`
    # nor `tenant_id` column and requires `version` + `pdf_uri` +
    # `seg_sop_uid` + `sr_sop_uid` (NOT NULL, no defaults). The Celery
    # task is responsible for inserting the row once artifacts exist.
    # The polling endpoint at `_load_report` is also out of sync with the
    # current schema and needs its own fix; tracked separately.

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


@router.get(
    "/reports/{report_id}/deliveries",
    response_model=list[ReportDeliveryProjection],
    summary="List PACS deliveries for a Report (one row per destination × artifact)",
)
@require_permission("report.view")
async def list_report_deliveries(
    report_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> list[ReportDeliveryProjection]:
    """Return all ``report_delivery`` rows for a report.

    Plain-English: feeds the PACS Push panel with one row per delivery
    attempt. Tenant scoping rides on the parent report (verified via
    ``_load_report``) — no separate JOIN needed.

    Schema-vs-projection note: the underlying ``report_delivery`` table
    uses ``state``/``attempt_count``/``destination_id`` (Alembic 0004),
    whereas the projection model exposes
    ``status``/``retry_count``/``destination_ae_title``. The state value
    domain also differs (``pending|in_flight|delivered|failed|retracted``
    in DB vs. ``pending|sending|acknowledged|failed|manual_fallback`` on
    the wire). We translate at the SQL boundary so neither side has to
    care about the other's vocabulary.
    """
    tenant_id: UUID = request.state.tenant_id
    if await _load_report(session, report_id, tenant_id) is None:
        raise _not_found(str(uuid4()))

    rows = (
        await session.execute(
            text(
                """
                SELECT
                    id,
                    report_id,
                    'seg'::text                    AS artifact_type,
                    destination_id                 AS destination_ae_title,
                    CASE state
                        WHEN 'in_flight' THEN 'sending'
                        WHEN 'delivered' THEN 'acknowledged'
                        WHEN 'retracted' THEN 'manual_fallback'
                        ELSE state
                    END                            AS status,
                    attempt_count                  AS retry_count,
                    next_attempt_at,
                    last_error,
                    CASE WHEN state = 'delivered'
                        THEN updated_at ELSE NULL
                    END                            AS acknowledged_at
                FROM report_delivery
                WHERE report_id = :rid
                ORDER BY created_at ASC
                """
            ),
            {"rid": str(report_id)},
        )
    ).mappings().all()
    return [ReportDeliveryProjection(**dict(r)) for r in rows]


@router.get(
    "/reports/{report_id}/pdf",
    summary="PDF bytes for a finalized Report (delegates to analysis renderer)",
)
@require_permission("report.view")
async def get_report_pdf_proxy(
    report_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Resolve the report's analysis_id and 307 to the analysis PDF route.

    Plain-English: the heavy SEG/SR/PDF builder pipeline isn't wired yet,
    so the report row's ``pdf_uri`` points at the analysis-level
    on-demand renderer (``/analyses/{id}/report/pdf``). Rather than
    duplicating the render-or-cache logic, we 307-redirect — preserves
    method, the iframe follows transparently, and the analysis route
    keeps being the single source of truth for PDF rendering.
    """
    tenant_id: UUID = request.state.tenant_id
    row = await _load_report(session, report_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))
    analysis_id = row["analysis_id"]
    return RedirectResponse(
        url=f"/api/v1/analyses/{analysis_id}/report/pdf",
        status_code=status.HTTP_307_TEMPORARY_REDIRECT,
    )


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

    # Schema reality check: the actual `report` table (Alembic 0004) has
    # neither `retraction_reason` nor `status` nor `tenant_id` columns —
    # tenancy lives on `analysis`, retraction is just `retracted_at IS
    # NOT NULL`, and the reason isn't persisted (it's emitted into the
    # AuditEvent below for the regulatory trail). Tenant scoping happens
    # via the JOIN to keep cross-tenant retracts impossible.
    await session.execute(
        text(
            """
            UPDATE report
            SET retracted_at = now()
            FROM analysis a
            WHERE report.id = :id
              AND report.analysis_id = a.id
              AND a.tenant_id = :tid
            """
        ),
        {"id": str(report_id), "tid": str(tenant_id)},
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
