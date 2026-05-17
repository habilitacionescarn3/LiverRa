# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Review HTTP API router (T232 + T235 + T236 + T422).

Plain-English:
    This router is the surgeon's "edit mode" console. Once a case has
    been analysed by the AI cascade, one reviewer at a time may
    "sit in the seat" and refine masks, re-prompt missed lesions,
    override AI tumor classifications, and adjust FLR. Every write
    is permission-checked, audit-chained, and works even when the
    tab is offline (the frontend queues edits and replays them here).

Endpoints (contracts/api-openapi.yaml §review):
    POST /reviews                           → acquire seat (one per analysis)
    POST /reviews/{id}/heartbeat            → extend seat TTL by 60 s
    POST /reviews/{id}/release              → finalize + release seat
    POST /reviews/{id}/mask-refine          → VISTA3D click-to-refine
    POST /reviews/{id}/lesion-prompt        → MedSAM-2 lesion prompt
    POST /reviews/{id}/classification-override (step-up) → tumor class override
    POST /reviews/{id}/flr                  → FLR recalc
    POST /reviews/{id}/takeover-request     → ask current holder to release
    GET  /reviews/{id}/takeover-events      → SSE stream of takeover events

All mutating handlers:
  - go through ``@require_permission`` (T235);
  - append a FHIR AuditEvent via ``AuditChainWriter`` (T236);
  - run seat acquire/heartbeat/release and mask composite through
    the services in ``src.services.review`` (T422 wire).

Spec/plan refs:
    - FR-015, FR-016, FR-017, FR-017a, FR-017b, FR-018a, FR-018b, FR-018c
    - plan.md §Review seat concurrency, §Offline reviewer-edit durability
    - research.md §C.6
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.errors.catalog import ErrorSlug, ProblemDetailException
from ..services.review.seat_manager import (
    ReviewNotFound,
    SeatManager,
    SeatUnavailable,
    TAKEOVER_CHANNEL_PREFIX,
)
from ..services.review.refinement_local_recompute import (
    LocalRecompute,
    RecomputeResult,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Service singletons (overridable in tests via FastAPI dependency_overrides)
# ---------------------------------------------------------------------------


def get_seat_manager(request: Request) -> SeatManager:
    """Return the app-wide SeatManager (built in main.lifespan)."""
    mgr = getattr(request.app.state, "seat_manager", None)
    if mgr is None:
        # Construct a redis-less manager — pub/sub will degrade to
        # persisted timeline_events replay through the SSE endpoint.
        mgr = SeatManager(redis_publisher=None)
        request.app.state.seat_manager = mgr
    return mgr


def get_local_recompute(request: Request) -> LocalRecompute:
    comp = getattr(request.app.state, "local_recompute", None)
    if comp is None:
        comp = LocalRecompute()
        request.app.state.local_recompute = comp
    return comp


def _audit_writer(request: Request) -> Any:
    """Return AuditChainWriter singleton (skipped in tests without DB)."""
    return getattr(request.app.state, "audit_chain_writer", None)


async def _emit_audit(
    request: Request,
    session: AsyncSession,
    action: str,
    tenant_id: UUID,
    user_id: UUID,
    analysis_id: UUID,
    extra: Optional[dict[str, Any]] = None,
) -> None:
    """Append a FHIR AuditEvent row to the chain (T236).

    Silently skipped when the writer isn't wired (unit tests) so handler
    tests don't need the full chain infra to exercise the happy path.
    """
    writer = _audit_writer(request)
    if writer is None:
        return
    try:
        event = {
            "resourceType": "AuditEvent",
            "action": action,
            "recorded": datetime.now(timezone.utc).isoformat(),
            "agent": [{"who": {"identifier": {"value": str(user_id)}}}],
            "entity": [
                {
                    "what": {"identifier": {"value": str(analysis_id)}},
                    "type": {"code": "analysis"},
                }
            ],
        }
        if extra:
            event["extra"] = extra
        await writer.write(event, tenant_id=tenant_id, session=session)
    except Exception as exc:  # noqa: BLE001
        # Audit write-failure is a hard block in prod (FR-029b). Propagate.
        logger.error("review audit write failed: %s", exc)
        raise


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class AcquireSeatRequest(BaseModel):
    analysis_id: UUID


class SeatResponse(BaseModel):
    review_id: UUID
    analysis_id: UUID
    user_id: UUID
    seat_held_until: datetime
    finalized_at: Optional[datetime] = None


class MaskRefineRequest(BaseModel):
    analysis_id: UUID
    segmentation_id: UUID
    click_type: str = Field(..., description="add|subtract|point")
    voxel: list[int] = Field(..., min_length=3, max_length=3)
    client_version: int = Field(1, description="Optimistic-concurrency tag.")


class LesionPromptRequest(BaseModel):
    analysis_id: UUID
    voxel: list[int] = Field(..., min_length=3, max_length=3)
    label: Optional[str] = None
    client_version: int = 1


class ClassificationOverrideRequest(BaseModel):
    lesion_id: UUID
    new_class: str
    reason: str = Field(..., min_length=3, max_length=2000)
    client_version: int = 1


class FLRRequest(BaseModel):
    analysis_id: UUID
    resection_plane_json: dict[str, Any]
    client_version: int = 1


class ReviewerMarkerRequest(BaseModel):
    """Marker drop — voxel-anchored sticky note placed by the reviewer.

    Phase G of the Refine production-readiness work. See plan at
    `/Users/toko/.claude/plans/on-this-page-i-soft-nebula.md`.
    """

    analysis_id: UUID
    voxel: list[int] = Field(..., min_length=3, max_length=3)
    couinaud_segment: Optional[str] = Field(default=None, max_length=8)
    segmentation_id: Optional[str] = Field(default=None, max_length=64)
    label: Optional[str] = Field(default=None, max_length=80)
    note: Optional[str] = Field(default=None, max_length=2000)
    client_version: int = 1


class ReviewerMarkerResponse(BaseModel):
    id: UUID
    analysis_id: UUID
    review_id: UUID
    voxel: list[int]
    couinaud_segment: Optional[str]
    segmentation_id: Optional[str]
    label: Optional[str]
    note: Optional[str]
    created_at: datetime
    created_by: UUID


class TakeoverRequestBody(BaseModel):
    analysis_id: UUID


# ---------------------------------------------------------------------------
# Helpers — user/tenant extraction
# ---------------------------------------------------------------------------


def _user_id(request: Request) -> UUID:
    # AuthMiddleware populates request.state.user (a dict in both the
    # JWT and dev-bypass paths). The lone outlier was reading
    # request.state.user_id, which no middleware ever sets — that 401
    # was being silently rewritten to 404 by the global FORBIDDEN→
    # NOT_FOUND handler (FR-032a), which presented as the "endpoint
    # missing" gate on the frontend.
    user = getattr(request.state, "user", None)
    uid: Any = None
    if isinstance(user, dict):
        uid = user.get("id") or user.get("cognito_sub")
    elif user is not None:
        uid = getattr(user, "id", None) or getattr(user, "cognito_sub", None)
    if uid is None:
        raise ProblemDetailException(
            slug=ErrorSlug.FORBIDDEN,
            status=401,
            detail="Authentication required.",
            instance="/reviews",
        )
    return UUID(str(uid))


def _user_role(request: Request) -> str:
    """Return the requester's primary role for audit attribution.

    The classification-override audit table (migration 0015) requires a
    ``reviewer_role`` column so a CE-MDR auditor can prove that an
    override was applied by someone with the appropriate clinical scope
    (radiologist vs surgeon vs admin). We derive it from the JWT's
    ``cognito:groups`` claim (populated as ``user["groups"]``); the
    first group is treated as the canonical role. Fallback to
    ``"unknown"`` so the INSERT never NULLs out a NOT-NULL column —
    the audit row still lands, and the value flags the upstream issue
    for the security review queue.
    """
    user = getattr(request.state, "user", None)
    groups: Any = None
    if isinstance(user, dict):
        groups = user.get("groups")
    elif user is not None:
        groups = getattr(user, "groups", None)
    if isinstance(groups, (list, tuple)) and groups:
        return str(groups[0])
    return "unknown"


def _stale_problem(detail: str = "Stale revision — refresh and retry") -> ProblemDetailException:
    """409 problem+json for optimistic-locking version mismatches (H-LOCK-*)."""
    return ProblemDetailException(
        slug=ErrorSlug.VALIDATION,
        status=409,
        detail=detail,
        instance="/reviews",
    )


def _tenant_id(request: Request) -> UUID:
    tid = getattr(request.state, "tenant_id", None)
    if tid is None:
        raise ProblemDetailException(
            slug=ErrorSlug.FORBIDDEN,
            status=403,
            detail="Tenant context missing.",
            instance="/reviews",
        )
    return UUID(str(tid))


def _seat_unavailable_problem(exc: SeatUnavailable) -> ProblemDetailException:
    return ProblemDetailException(
        slug=ErrorSlug.SEAT_TAKEN,
        status=409,
        detail=(
            f"Seat held by {exc.holder_display_name or exc.holder_user_id}."
        ),
        instance="/reviews",
    )


# ---------------------------------------------------------------------------
# Seat lifecycle
# ---------------------------------------------------------------------------


@router.post("", response_model=SeatResponse, status_code=201)
@require_permission("review.acquire_seat")
async def acquire_seat(
    body: AcquireSeatRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> SeatResponse:
    """Open a new SurgeonReview row (== take the reviewer seat).

    C-REFINE-2 — Four-eyes (two-person control): when an analysis was
    produced by a radiologist whose Cognito sub is stamped on
    ``analysis.radiologist_user_id``, that same user cannot acquire the
    reviewer seat. The original radiologist must sign off; a second
    reviewer must edit. The column is filled by the upload / dictation
    flow; for legacy analyses where it's NULL we fall back to single-
    person control so existing workflows are not broken.
    """
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)

    # Four-eyes pre-check.
    radio = (
        await session.execute(
            text(
                "SELECT radiologist_user_id FROM analysis "
                "WHERE id = :aid AND tenant_id = :tid"
            ),
            {"aid": str(body.analysis_id), "tid": str(tenant_id)},
        )
    ).first()
    if radio and radio[0] is not None and str(radio[0]) == str(user_id):
        raise ProblemDetailException(
            slug=ErrorSlug.FORBIDDEN,
            status=403,
            detail=(
                "Two-person control: the originating radiologist cannot "
                "also be the reviewer. Hand the case to a second clinician."
            ),
            instance="/reviews",
        )

    try:
        seat = await manager.acquire(
            analysis_id=body.analysis_id,
            user_id=user_id,
            session=session,
        )
    except SeatUnavailable as exc:
        raise _seat_unavailable_problem(exc) from exc

    await _emit_audit(
        request, session, "review.seat_taken",
        tenant_id=tenant_id, user_id=user_id, analysis_id=body.analysis_id,
        extra={"review_id": str(seat.review_id)},
    )
    return SeatResponse(
        review_id=seat.review_id,
        analysis_id=seat.analysis_id,
        user_id=seat.user_id,
        seat_held_until=seat.seat_held_until,
        finalized_at=seat.finalized_at,
    )


@router.post("/{review_id}/heartbeat")
@require_permission("review.acquire_seat")
async def heartbeat(
    review_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> dict[str, Any]:
    try:
        seat_until = await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND,
            status=404,
            detail=str(exc),
            instance="/reviews",
        ) from exc
    return {"seat_held_until": seat_until.isoformat()}


@router.post("/{review_id}/release")
@require_permission("review.acquire_seat")
async def release(
    review_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> dict[str, Any]:
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)

    # Look up the analysis id so audit has something to correlate on.
    row = (
        await session.execute(
            text("SELECT analysis_id FROM surgeon_review WHERE id = :rid"),
            {"rid": str(review_id)},
        )
    ).first()
    analysis_id = UUID(str(row[0])) if row else review_id

    await manager.release(review_id, session=session)
    await _emit_audit(
        request, session, "review.seat_released",
        tenant_id=tenant_id, user_id=user_id, analysis_id=analysis_id,
        extra={"review_id": str(review_id)},
    )
    return {"status": "released"}


# ---------------------------------------------------------------------------
# Mask refine (T422: calls LocalRecompute.composite for new Segmentation)
# ---------------------------------------------------------------------------


@router.post("/{review_id}/mask-refine")
@require_permission("review.refine_mask")
async def mask_refine(
    review_id: UUID,
    body: MaskRefineRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
    recompute: LocalRecompute = Depends(get_local_recompute),
) -> dict[str, Any]:
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)

    # Every mutation also refreshes the seat so an active reviewer
    # never loses their seat while typing.
    try:
        await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc

    # H-LOCK-1: optimistic-concurrency check + bump on the parent
    # segmentation's "owning" lesion row. The mask refine path mutates
    # one segmentation chain rooted at one lesion; the client supplies
    # the version it last saw, and we CAS-bump it atomically. Two
    # reviewers clicking the same voxel between heartbeats will both
    # send the same ``client_version``; only one bump succeeds, the
    # other receives 409 ``Stale revision`` and is told to refresh.
    cas_row = (
        await session.execute(
            text(
                """
                UPDATE lesion
                   SET client_version = client_version + 1
                 WHERE analysis_id = :aid
                   AND client_version = :cv
                 RETURNING client_version
                """
            ),
            {"aid": str(body.analysis_id), "cv": int(body.client_version)},
        )
    ).first()
    if cas_row is None:
        # No row matched ⇒ either the analysis has no lesion (degenerate)
        # OR the version on the wire is stale. Disambiguate so the
        # reviewer sees the right toast.
        exists = (
            await session.execute(
                text("SELECT 1 FROM lesion WHERE analysis_id = :aid LIMIT 1"),
                {"aid": str(body.analysis_id)},
            )
        ).first()
        if exists is not None:
            raise _stale_problem("Stale mask version — refresh and retry")

    try:
        result: RecomputeResult = await recompute.composite(
            analysis_id=body.analysis_id,
            parent_segmentation_id=body.segmentation_id,
            click_type=body.click_type,
            voxel=tuple(body.voxel),
            user_id=user_id,
            session=session,
        )
    except ValueError as exc:  # empty-region click, out-of-volume click, etc.
        raise ProblemDetailException(
            slug=ErrorSlug.VALIDATION, status=422,
            detail=str(exc), instance="/reviews",
        ) from exc

    # C-REFINE-1: a mask refine invalidates the existing FLR computation.
    # We dispatch the segment-aware-FLR recompute as a Celery task so the
    # response stays snappy (the math takes 5-10 s on a real volume) and
    # the PDF finalizer can block on a mask-version drift check if/when
    # downstream wires that in. Failures here are non-fatal — the audit
    # row already captures the mask change; the initial FLR is a
    # fallback the surgeon can override manually.
    try:
        study_row = (
            await session.execute(
                text("SELECT study_id FROM analysis WHERE id = :aid"),
                {"aid": str(body.analysis_id)},
            )
        ).first()
        if study_row is not None:
            from ..tasks.flr_default import (  # local import keeps router import-light
                compute_initial_flr,
            )

            compute_initial_flr.delay(  # type: ignore[attr-defined]
                str(body.analysis_id), str(study_row[0])
            )
    except Exception as exc:  # noqa: BLE001 — Celery may be absent in unit tests
        logger.warning(
            "mask_refine: FLR recompute dispatch skipped (%s)", exc
        )

    await _emit_audit(
        request, session, "mask_edit",
        tenant_id=tenant_id, user_id=user_id, analysis_id=body.analysis_id,
        extra={
            "review_id": str(review_id),
            "parent_segmentation_id": str(body.segmentation_id),
            "new_segmentation_id": str(result.new_segmentation_id),
            "click_type": body.click_type,
            "voxel": body.voxel,
            "delta_voxels": result.delta_voxels,
            "recompute_seconds": result.recompute_seconds,
            "client_version": int(body.client_version),
        },
    )
    return {
        "new_segmentation_id": str(result.new_segmentation_id),
        "delta_voxels": result.delta_voxels,
        "recompute_seconds": result.recompute_seconds,
        "server_version": result.server_version,
    }


# ---------------------------------------------------------------------------
# Lesion prompt (MedSAM-2)
# ---------------------------------------------------------------------------


@router.post("/{review_id}/lesion-prompt")
@require_permission("review.reprompt_lesion")
async def lesion_prompt(
    review_id: UUID,
    body: LesionPromptRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
    recompute: LocalRecompute = Depends(get_local_recompute),
) -> dict[str, Any]:
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)

    try:
        await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc

    # H-LOCK-2: optimistic-concurrency check on the analysis's most-recent
    # lesion version. lesion_prompt APPENDS a new lesion — we use the
    # max-version sentinel so concurrent prompts don't double-insert at
    # the same voxel (idempotency lives in ``recompute.lesion_prompt``,
    # but the CAS bump is the cheap pre-check).
    max_v_row = (
        await session.execute(
            text(
                """
                SELECT COALESCE(MAX(client_version), 0)
                  FROM lesion
                 WHERE analysis_id = :aid
                """
            ),
            {"aid": str(body.analysis_id)},
        )
    ).first()
    max_v = int(max_v_row[0]) if max_v_row and max_v_row[0] is not None else 0
    if max_v > int(body.client_version):
        raise _stale_problem("Stale analysis lesion version — refresh and retry")

    try:
        result = await recompute.lesion_prompt(
            analysis_id=body.analysis_id,
            voxel=tuple(body.voxel),
            label=body.label,
            user_id=user_id,
            session=session,
        )
    except ValueError as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.VALIDATION, status=422,
            detail=str(exc), instance="/reviews",
        ) from exc

    await _emit_audit(
        request, session, "lesion_reprompt",
        tenant_id=tenant_id, user_id=user_id, analysis_id=body.analysis_id,
        extra={
            "review_id": str(review_id),
            "new_lesion_id": str(result["lesion_id"]),
            "voxel": body.voxel,
            "client_version": int(body.client_version),
        },
    )
    return result


# ---------------------------------------------------------------------------
# Classification override (step-up)
# ---------------------------------------------------------------------------


@router.post("/{review_id}/classification-override")
@require_permission("review.override_classification", step_up=True)
async def classification_override(
    review_id: UUID,
    body: ClassificationOverrideRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> dict[str, Any]:
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)
    user_role = _user_role(request)

    try:
        await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc

    # B-REFINE-2: every override-audit row must reference a real
    # analysis. The lesion → analysis lookup also surfaces the AI's
    # original ``before_class`` + ``before_confidence`` so the new
    # row in ``lesion_classification_override`` is a complete forensic
    # record (per migration 0015 column set).
    lesion_row = (
        await session.execute(
            text(
                """
                SELECT l.analysis_id,
                       l.client_version,
                       c.suggested_class,
                       (c.probs_vec ->> c.suggested_class)::numeric
                           AS confidence
                  FROM lesion l
                  LEFT JOIN classification c ON c.lesion_id = l.id
                 WHERE l.id = :lid
                """
            ),
            {"lid": str(body.lesion_id)},
        )
    ).first()
    if lesion_row is None:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail="Lesion not found.", instance="/reviews",
        )
    analysis_id = UUID(str(lesion_row[0]))
    lesion_version = int(lesion_row[1]) if lesion_row[1] is not None else 1
    before_class = lesion_row[2]
    before_confidence = lesion_row[3]

    # H-LOCK-3: optimistic-concurrency on the lesion version. Two
    # reviewers overriding the same lesion simultaneously will both send
    # the same client_version; only one wins the bump, the other gets
    # 409 ``Stale revision`` and is told to refresh.
    if int(body.client_version) != lesion_version:
        raise _stale_problem(
            "Stale lesion classification version — refresh and retry"
        )

    await session.execute(
        text(
            """
            UPDATE lesion
               SET client_version = client_version + 1
             WHERE id = :lid AND client_version = :cv
            """
        ),
        {"lid": str(body.lesion_id), "cv": int(body.client_version)},
    )

    # B-REFINE-3 (backend half): mark any previously-active override on
    # this (analysis, lesion) pair as inactive — the partial UNIQUE
    # index from migration 0015 enforces "one active row per lesion".
    await session.execute(
        text(
            """
            UPDATE lesion_classification_override
               SET is_active = FALSE
             WHERE analysis_id = :aid
               AND lesion_id = :lid
               AND is_active = TRUE
            """
        ),
        {"aid": str(analysis_id), "lid": str(body.lesion_id)},
    )

    # INSERT with the migration-0015 column set:
    #   (analysis_id, lesion_id, override_class, reviewer_user_id,
    #    reviewer_role, ack_id, before_class, before_confidence,
    #    is_active, tenant_id)
    inserted = (
        await session.execute(
            text(
                """
                INSERT INTO lesion_classification_override
                    (analysis_id, lesion_id, override_class,
                     reviewer_user_id, reviewer_role,
                     before_class, before_confidence,
                     is_active, tenant_id)
                VALUES
                    (:aid, :lid, :cls, :uid, :role,
                     :before_cls, :before_conf, TRUE, :tid)
                RETURNING id, created_at
                """
            ),
            {
                "aid": str(analysis_id),
                "lid": str(body.lesion_id),
                "cls": body.new_class,
                "uid": str(user_id),
                "role": user_role,
                "before_cls": before_class,
                "before_conf": before_confidence,
                "tid": str(tenant_id),
            },
        )
    ).first()

    override_id = str(inserted[0]) if inserted else None

    await _emit_audit(
        request, session, "classification_override",
        tenant_id=tenant_id, user_id=user_id,
        analysis_id=analysis_id,  # B-REFINE-2: real analysis id, not UUID(0)
        extra={
            "review_id": str(review_id),
            "lesion_id": str(body.lesion_id),
            "new_class": body.new_class,
            "before_class": before_class,
            "reason": body.reason,
            "override_id": override_id,
            "reviewer_role": user_role,
            "client_version": int(body.client_version),
        },
    )
    return {
        "override_id": override_id,
        "new_class": body.new_class,
        "reviewer_role": user_role,
    }


# ---------------------------------------------------------------------------
# FLR
# ---------------------------------------------------------------------------


@router.post("/{review_id}/flr")
@require_permission("review.refine_mask", step_up=True)
async def flr_update(
    review_id: UUID,
    body: FLRRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> dict[str, Any]:
    """C-REFINE-2: step-up MFA enforced — FLR drives the surgical plan.

    H-LOCK-4 / H-REFINE-1: CAS on ``analysis.flr_version``. Two reviewers
    saving the resection plane between heartbeats both send the same
    ``client_version``; only one bump succeeds, the other gets 409 with
    ``Stale revision`` so the UI can refetch.
    """
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)
    try:
        await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc

    # H-LOCK-4 / H-REFINE-1: optimistic-concurrency CAS on analysis.flr_version.
    cas = (
        await session.execute(
            text(
                """
                UPDATE analysis
                   SET flr_plane_json = CAST(:plane AS jsonb),
                       flr_updated_at = now(),
                       flr_version = flr_version + 1
                 WHERE id = :aid
                   AND tenant_id = :tid
                   AND flr_version = :cv
                 RETURNING flr_version
                """
            ),
            {
                "plane": json.dumps(body.resection_plane_json),
                "aid": str(body.analysis_id),
                "tid": str(tenant_id),
                "cv": int(body.client_version),
            },
        )
    ).first()
    if cas is None:
        # Disambiguate "not found / wrong tenant" from "stale revision".
        exists = (
            await session.execute(
                text(
                    "SELECT 1 FROM analysis WHERE id = :aid AND tenant_id = :tid"
                ),
                {"aid": str(body.analysis_id), "tid": str(tenant_id)},
            )
        ).first()
        if exists is None:
            raise ProblemDetailException(
                slug=ErrorSlug.NOT_FOUND, status=404,
                detail="Analysis not found.", instance="/reviews",
            )
        raise _stale_problem("Stale FLR plane version — refresh and retry")

    await _emit_audit(
        request, session, "flr_update",
        tenant_id=tenant_id, user_id=user_id, analysis_id=body.analysis_id,
        extra={
            "review_id": str(review_id),
            "client_version": int(body.client_version),
            "new_version": int(cas[0]),
        },
    )
    return {"status": "ok", "flr_version": int(cas[0])}


# ---------------------------------------------------------------------------
# Marker (Phase G — voxel-anchored sticky note)
# ---------------------------------------------------------------------------


@router.post("/{review_id}/marker", response_model=ReviewerMarkerResponse, status_code=201)
@require_permission("review.refine_mask")
async def create_marker(
    review_id: UUID,
    body: ReviewerMarkerRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> ReviewerMarkerResponse:
    """Drop a reviewer marker at a voxel coordinate.

    Markers are additive — no row mutation, no optimistic-lock check on
    the insert path. The seat must still be live (we heartbeat it),
    which is the gate the four refine tools share.
    """
    user_id = _user_id(request)
    tenant_id = _tenant_id(request)

    try:
        await manager.heartbeat(review_id, session=session)
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc

    row = (
        await session.execute(
            text(
                """
                INSERT INTO reviewer_marker (
                    tenant_id, analysis_id, review_id,
                    voxel_x, voxel_y, voxel_z,
                    couinaud_segment, segmentation_id, label, note,
                    created_by, client_version
                ) VALUES (
                    :tid, :aid, :rid,
                    :vx, :vy, :vz,
                    :couinaud, :seg_id, :label, :note,
                    :uid, :cv
                )
                RETURNING id, created_at
                """
            ),
            {
                "tid": str(tenant_id),
                "aid": str(body.analysis_id),
                "rid": str(review_id),
                "vx": int(body.voxel[0]),
                "vy": int(body.voxel[1]),
                "vz": int(body.voxel[2]),
                "couinaud": body.couinaud_segment,
                "seg_id": body.segmentation_id,
                "label": body.label,
                "note": body.note,
                "uid": str(user_id),
                "cv": int(body.client_version),
            },
        )
    ).first()
    if row is None:
        # Should never happen — INSERT … RETURNING always returns a row.
        raise ProblemDetailException(
            slug=ErrorSlug.VALIDATION, status=500,
            detail="Marker insert returned no row.", instance="/reviews",
        )
    marker_id = UUID(str(row[0]))
    created_at = row[1]

    await _emit_audit(
        request, session, "reviewer_marker_placed",
        tenant_id=tenant_id, user_id=user_id, analysis_id=body.analysis_id,
        extra={
            "review_id": str(review_id),
            "marker_id": str(marker_id),
            "voxel": list(body.voxel),
            "couinaud_segment": body.couinaud_segment,
            "segmentation_id": body.segmentation_id,
            "has_label": bool(body.label),
            "has_note": bool(body.note),
        },
    )

    return ReviewerMarkerResponse(
        id=marker_id,
        analysis_id=body.analysis_id,
        review_id=review_id,
        voxel=list(body.voxel),
        couinaud_segment=body.couinaud_segment,
        segmentation_id=body.segmentation_id,
        label=body.label,
        note=body.note,
        created_at=created_at,
        created_by=user_id,
    )


# ---------------------------------------------------------------------------
# Takeover
# ---------------------------------------------------------------------------


@router.post("/takeover-request")
@require_permission("review.acquire_seat")
async def takeover_request(
    body: TakeoverRequestBody,
    request: Request,
    session: AsyncSession = Depends(get_db),
    manager: SeatManager = Depends(get_seat_manager),
) -> dict[str, Any]:
    user_id = _user_id(request)
    try:
        payload = await manager.request_takeover(
            analysis_id=body.analysis_id,
            requester_id=user_id,
            session=session,
        )
    except ReviewNotFound as exc:
        raise ProblemDetailException(
            slug=ErrorSlug.NOT_FOUND, status=404,
            detail=str(exc), instance="/reviews",
        ) from exc
    return payload


@router.get("/{analysis_id}/takeover-events")
async def takeover_events(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """SSE stream of takeover events for a given analysis.

    Strategy:
      1. Replay persisted ``timeline_events`` first so a reconnecting
         client never misses a takeover request.
      2. Subscribe to the Redis channel (if wired) for live events.
      3. Heartbeat with a ``: ping`` comment every 25 s so proxies
         don't drop the connection.
    """
    channel = TAKEOVER_CHANNEL_PREFIX + str(analysis_id)

    async def event_gen() -> AsyncIterator[bytes]:
        # 1. Replay.
        row = (
            await session.execute(
                text(
                    """
                    SELECT timeline_events FROM surgeon_review
                    WHERE analysis_id = :aid
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"aid": str(analysis_id)},
            )
        ).first()
        if row and row[0]:
            events = row[0] if isinstance(row[0], list) else json.loads(row[0])
            for ev in events:
                yield f"event: {ev.get('type', 'message')}\ndata: {json.dumps(ev)}\n\n".encode()

        # 2. Redis subscribe (optional — degrade to replay-only).
        redis = getattr(request.app.state, "redis", None)
        if redis is None:
            # Keep connection alive via heartbeats.
            while True:
                await asyncio.sleep(25)
                yield b": ping\n\n"

        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(channel)
            last_hb = asyncio.get_event_loop().time()
            while True:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=5.0
                )
                if msg and msg.get("type") == "message":
                    data = msg["data"]
                    if isinstance(data, bytes):
                        data = data.decode()
                    yield f"event: takeover-requested\ndata: {data}\n\n".encode()
                now = asyncio.get_event_loop().time()
                if now - last_hb > 25:
                    yield b": ping\n\n"
                    last_hb = now
        finally:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.close()
            except Exception:  # noqa: BLE001
                pass

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


__all__ = ["router"]
