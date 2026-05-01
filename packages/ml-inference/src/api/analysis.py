# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Analysis HTTP API (T167, T169, T170).

Plain-English:
    This router is the remote control for a single CT analysis. The
    frontend uses it to:

      - ``POST /analyses``             kick off the cascade for a study,
      - ``GET  /analyses/{id}``        poll the current state,
      - ``GET  /analyses/{id}/results`` grab the aggregated outputs,
      - ``POST /analyses/{id}/cancel`` gracefully stop a queued/running job,
      - ``POST /analyses/{id}/retry``  re-queue from the last successful
                                         ``pipeline_checkpoint`` stage.

    Realtime stage-by-stage progress is handled by a sibling router
    (``analysis_stream.py``) over Server-Sent Events.

Shape (per contracts/api-openapi.yaml §analyses):
    - success bodies are ``application/json``
    - error bodies are ``application/problem+json`` via the T405 catalog
    - cancel/retry emit FHIR AuditEvents through ``AuditChainWriter``
      and return the assigned chain sequence number in the response
      header ``X-LiverRa-Audit-Seq`` (T170).

Cross-refs:
    - spec.md §FR-007a, §FR-014a/b, §FR-033a (cancel), §FR-033b (retry).
    - plan.md §Data Fetching Strategy.
    - research.md §X.2 (PipelineCheckpoint), §A.3 (audit chain).
"""
from __future__ import annotations

import json
import logging
import os
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
# Pydantic request/response models
# ---------------------------------------------------------------------------


class CreateAnalysisRequest(BaseModel):
    """Body for ``POST /analyses`` — the study to enqueue."""

    study_id: UUID = Field(..., description="UUID of the accepted Study row.")


class CreateAnalysisFromOrthancRequest(BaseModel):
    """Body for ``POST /analyses/from-orthanc`` — convenience for "Run AI" UX.

    Takes a DICOM StudyInstanceUID (already on local PACS) and either
    finds the matching Study row or creates one in 'accepted' state, then
    enqueues an analysis. Bridges the gap between PACS browser UX and the
    canonical study_id-based POST /analyses.
    """

    study_instance_uid: str = Field(
        ...,
        description="DICOM StudyInstanceUID present on local Orthanc.",
        min_length=1,
        max_length=128,
    )
    patient_ref: Optional[str] = Field(
        None,
        description="Optional patient identifier; defaults to study UID hash.",
    )


class AnalysisDetailResponse(BaseModel):
    """Single-row Analysis projection used by all detail endpoints."""

    id: UUID
    study_id: UUID
    status: str
    queued_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error_slug: Optional[str] = None
    pipeline_version: str
    model_versions: dict[str, Any] = Field(default_factory=dict)
    implausible_output_reason: Optional[str] = None
    stage_progress: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Ordered list of completed pipeline_checkpoint stages.",
    )


class AnalysisResultsResponse(BaseModel):
    """Aggregated result bundle — returned by ``GET /analyses/{id}/results``."""

    analysis: AnalysisDetailResponse
    segmentations: list[dict[str, Any]] = Field(default_factory=list)
    lesions: list[dict[str, Any]] = Field(default_factory=list)
    flr_default: Optional[dict[str, Any]] = None
    confidence_flags: list[str] = Field(default_factory=list)


class AnalysisQueuedResponse(BaseModel):
    """Response body for ``POST /analyses`` (enqueue)."""

    analysis_id: UUID
    status: str
    queued_at: datetime


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


# Terminal + successful states used below.
_TERMINAL_STATES = {"completed", "complete", "failed", "cancelled"}
_DONE_STATES = {"completed", "complete", "partial_result"}


async def _load_analysis_row(
    session: AsyncSession, analysis_id: UUID, tenant_id: UUID
) -> Optional[dict[str, Any]]:
    """Load one analysis row or ``None`` if missing/cross-tenant.

    RLS policy already filters by ``current_setting('app.tenant_id')``; the
    explicit ``tenant_id = :tid`` clause is belt-and-suspenders for FR-032a.
    """
    result = await session.execute(
        text(
            """
            SELECT id, study_id, tenant_id, status, queued_at, started_at,
                   completed_at, error_slug, pipeline_version, model_versions,
                   implausible_output_reason
            FROM analysis
            WHERE id = :id AND tenant_id = :tid
            """
        ),
        {"id": str(analysis_id), "tid": str(tenant_id)},
    )
    row = result.mappings().first()
    return dict(row) if row else None


async def _load_checkpoints(
    session: AsyncSession, analysis_id: UUID
) -> list[dict[str, Any]]:
    """Return all completed ``pipeline_checkpoint`` rows, ordered."""
    result = await session.execute(
        text(
            """
            SELECT stage_no, stage, output_uri, written_at,
                   model_version, model_license_hash
            FROM pipeline_checkpoint
            WHERE analysis_id = :id
            ORDER BY stage_no ASC
            """
        ),
        {"id": str(analysis_id)},
    )
    return [dict(r) for r in result.mappings()]


def _not_found(instance: str) -> ProblemDetailException:
    return ProblemDetailException(
        ErrorSlug.NOT_FOUND,
        status.HTTP_404_NOT_FOUND,
        "Analysis not found.",
        instance=instance,
    )


def _to_detail(row: dict[str, Any], checkpoints: list[dict[str, Any]]) -> AnalysisDetailResponse:
    return AnalysisDetailResponse(
        id=row["id"],
        study_id=row["study_id"],
        status=row["status"],
        queued_at=row["queued_at"],
        started_at=row.get("started_at"),
        completed_at=row.get("completed_at"),
        error_slug=row.get("error_slug"),
        pipeline_version=row["pipeline_version"],
        model_versions=row.get("model_versions") or {},
        implausible_output_reason=row.get("implausible_output_reason"),
        stage_progress=[
            {
                "stage_no": cp["stage_no"],
                "stage": cp["stage"],
                "output_uri": cp["output_uri"],
                "written_at": cp["written_at"],
                "model_version": cp["model_version"],
                "model_license_hash": cp["model_license_hash"],
            }
            for cp in checkpoints
        ],
    )


# ---------------------------------------------------------------------------
# Audit helper (T170)
# ---------------------------------------------------------------------------


async def _emit_analysis_audit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    analysis_id: UUID,
    tenant_id: UUID,
    user_id: Optional[str],
    extra: Optional[dict[str, Any]] = None,
) -> Optional[int]:
    """Append an ``analysis_cancel`` / ``analysis_retry`` AuditEvent row.

    Returns the assigned ``sequence_no`` (to be surfaced on the response
    via ``X-LiverRa-Audit-Seq``) or ``None`` if the audit writer is not
    wired yet. Failures are intentionally NOT swallowed when the writer
    IS wired — per FR-029b, audit failures must break the request.
    """
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:  # pragma: no cover — bootstrap path
        logger.debug("AuditChainWriter unavailable; skipping %s audit", category)
        return None

    writer: AuditChainWriter = (
        getattr(request.app.state, "audit_chain_writer", None)
        or AuditChainWriter()
    )
    event = {
        "resourceType": "AuditEvent",
        "id": str(uuid4()),
        "category": category,
        "recorded": datetime.now(timezone.utc).isoformat(),
        "agent": [{"who": {"reference": user_id} if user_id else None}],
        "entity": [{"what": {"reference": f"Analysis/{analysis_id}"}}],
    }
    if extra:
        event["extension"] = [{"url": "liverra:extra", "valueString": str(extra)}]

    row = await writer.write(event, tenant_id, session)
    return row.sequence_no


# ---------------------------------------------------------------------------
# Celery dispatch (thin wrapper — real cascade task owned by sibling agent)
# ---------------------------------------------------------------------------


def _dispatch_cascade(analysis_id: UUID, *, start_stage: int = 0) -> Optional[str]:
    """Enqueue the cascade Celery task. Returns the task_id if dispatched.

    When LIVERRA_CASCADE_DEMO_MODE=true, dispatches the demo_cascade task
    instead of the real one — simulates 7 stages with synthetic output
    over ~30s. Lets clinicians evaluate the full UX without depending on
    real 4-phase liver CT input or a fully-wired DICOM→NIfTI pipeline.
    Unset the env var to use the real cascade.
    """
    demo_mode = os.environ.get("LIVERRA_CASCADE_DEMO_MODE", "").lower() in {"1", "true", "yes"}
    if demo_mode:
        try:
            from ..tasks.demo_cascade import demo_cascade  # type: ignore[import-not-found]
            async_result = demo_cascade.delay(str(analysis_id), start_stage)
            return str(async_result.id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("demo_cascade dispatch failed: %s", exc)
            return None

    try:
        from ..tasks.cascade import run_cascade  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        logger.info(
            "cascade dispatch skipped — tasks.cascade not wired "
            "(analysis=%s, start_stage=%s)",
            analysis_id,
            start_stage,
        )
        return None

    try:
        async_result = run_cascade.delay(str(analysis_id), start_stage)  # type: ignore[attr-defined]
        return str(async_result.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("cascade dispatch failed: %s", exc)
        return None


def _revoke_cascade(analysis_id: UUID) -> None:
    """Send a Celery revoke for the analysis' cascade, best-effort."""
    try:
        from ..tasks.cascade import revoke_cascade  # type: ignore[import-not-found]

        revoke_cascade(str(analysis_id))
    except Exception:
        logger.info("cascade revoke skipped for analysis=%s", analysis_id)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=AnalysisQueuedResponse,
    summary="Enqueue an analysis for an accepted study (idempotent per study_id)",
)
@require_permission("study.upload")
async def create_analysis(
    body: CreateAnalysisRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AnalysisQueuedResponse:
    """Kick off the cascade for an accepted study.

    Idempotency: if an active (``queued``/``running``) analysis already
    exists for ``study_id`` we return that one — per the OpenAPI contract
    note "idempotent per study_id".
    """
    tenant_id: UUID = request.state.tenant_id

    # 1. Confirm the study exists + belongs to our tenant.
    study_row = await session.execute(
        text(
            """
            SELECT id, ingestion_outcome
            FROM study
            WHERE id = :sid AND tenant_id = :tid
            """
        ),
        {"sid": str(body.study_id), "tid": str(tenant_id)},
    )
    study = study_row.mappings().first()
    if not study:
        raise _not_found(str(uuid4()))
    if study["ingestion_outcome"] != "accepted":
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_400_BAD_REQUEST,
            "Study is not in 'accepted' state; ingestion must complete first.",
            instance=str(uuid4()),
        )

    # 2. Idempotency — reuse an active analysis if one already exists.
    existing = await session.execute(
        text(
            """
            SELECT id, status, queued_at
            FROM analysis
            WHERE study_id = :sid AND tenant_id = :tid
              AND status IN ('queued','running')
            ORDER BY queued_at DESC
            LIMIT 1
            """
        ),
        {"sid": str(body.study_id), "tid": str(tenant_id)},
    )
    active = existing.mappings().first()
    if active:
        return AnalysisQueuedResponse(
            analysis_id=active["id"],
            status=active["status"],
            queued_at=active["queued_at"],
        )

    # 3. Insert new Analysis row (pipeline_version from env — stamped by MBoM).
    pipeline_version = request.app.state.__dict__.get(
        "liverra_pipeline_version", "0.0.0-dev"
    )
    insert_row = await session.execute(
        text(
            """
            INSERT INTO analysis (tenant_id, study_id, status, pipeline_version)
            VALUES (:tid, :sid, 'queued', :pv)
            RETURNING id, queued_at
            """
        ),
        {
            "tid": str(tenant_id),
            "sid": str(body.study_id),
            "pv": pipeline_version,
        },
    )
    created = insert_row.mappings().one()

    # 4. Hand off to the cascade Celery task (best-effort dispatch).
    _dispatch_cascade(created["id"])

    return AnalysisQueuedResponse(
        analysis_id=created["id"],
        status="queued",
        queued_at=created["queued_at"],
    )


@router.post(
    "/from-orthanc",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=AnalysisQueuedResponse,
    summary="Run AI on a study that's already on local PACS (idempotent)",
)
@require_permission("study.upload")
async def create_analysis_from_orthanc(
    body: CreateAnalysisFromOrthancRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AnalysisQueuedResponse:
    """Find-or-create a Study row for an Orthanc StudyInstanceUID, then
    enqueue an analysis. Idempotent: re-running on the same UID returns
    the existing active analysis if one is queued/running.
    """
    tenant_id: UUID = request.state.tenant_id

    # 1. Find or create the study row (in 'accepted' state for demo).
    existing_study = await session.execute(
        text(
            """
            SELECT id, ingestion_outcome
            FROM study
            WHERE study_instance_uid = :uid AND tenant_id = :tid
            """
        ),
        {"uid": body.study_instance_uid, "tid": str(tenant_id)},
    )
    study_row = existing_study.mappings().first()
    if study_row:
        study_uuid = study_row["id"]
    else:
        patient_ref = body.patient_ref or f"orthanc-{body.study_instance_uid[-12:]}"
        new_study = await session.execute(
            text(
                """
                INSERT INTO study (tenant_id, study_instance_uid, patient_ref,
                                   ingestion_outcome)
                VALUES (:tid, :uid, :pref, 'accepted')
                RETURNING id
                """
            ),
            {
                "tid": str(tenant_id),
                "uid": body.study_instance_uid,
                "pref": patient_ref,
            },
        )
        study_uuid = new_study.mappings().one()["id"]

    # 2. Idempotency — return active analysis if one already exists.
    existing_analysis = await session.execute(
        text(
            """
            SELECT id, status, queued_at
            FROM analysis
            WHERE study_id = :sid AND tenant_id = :tid
              AND status IN ('queued','running')
            ORDER BY queued_at DESC
            LIMIT 1
            """
        ),
        {"sid": str(study_uuid), "tid": str(tenant_id)},
    )
    active = existing_analysis.mappings().first()
    if active:
        return AnalysisQueuedResponse(
            analysis_id=active["id"],
            status=active["status"],
            queued_at=active["queued_at"],
        )

    # 3. Stage Orthanc study → NIfTI in MinIO (no-op in demo mode where
    #    the cascade ignores S3 inputs anyway). Failure here is non-fatal:
    #    the cascade will fail at parenchyma with a clear error_slug if
    #    inputs are missing in real-cascade mode. Skip if env opts out.
    demo_mode = os.environ.get("LIVERRA_CASCADE_DEMO_MODE", "").lower() in {"1", "true", "yes"}
    skip_stage = os.environ.get("LIVERRA_SKIP_DICOM_STAGE", "").lower() in {"1", "true", "yes"}
    staged_phases: dict[str, str] = {}
    if not demo_mode and not skip_stage:
        try:
            from ..services.dicom_to_nifti import stage_orthanc_study_to_minio

            staged_phases = stage_orthanc_study_to_minio(
                body.study_instance_uid, study_uuid,
            )
            if staged_phases:
                # Persist phase coverage so the cascade orchestrator knows
                # which phases were successfully staged.
                await session.execute(
                    text(
                        """
                        UPDATE study
                           SET phase_coverage = :pc::jsonb
                         WHERE id = :sid
                        """
                    ),
                    {
                        "sid": str(study_uuid),
                        "pc": json.dumps({p: True for p in staged_phases}),
                    },
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "DICOM→NIfTI stage failed for study %s: %s — cascade may "
                "fail at parenchyma. Set LIVERRA_CASCADE_DEMO_MODE=true "
                "for demo mode that ignores S3 inputs.",
                body.study_instance_uid, exc,
            )

    # 4. Insert new Analysis + dispatch cascade.
    pipeline_version = request.app.state.__dict__.get(
        "liverra_pipeline_version", "0.0.0-dev"
    )
    insert_row = await session.execute(
        text(
            """
            INSERT INTO analysis (tenant_id, study_id, status, pipeline_version)
            VALUES (:tid, :sid, 'queued', :pv)
            RETURNING id, queued_at
            """
        ),
        {"tid": str(tenant_id), "sid": str(study_uuid), "pv": pipeline_version},
    )
    created = insert_row.mappings().one()

    _dispatch_cascade(created["id"])

    return AnalysisQueuedResponse(
        analysis_id=created["id"],
        status="queued",
        queued_at=created["queued_at"],
    )


class AnalysisListItem(BaseModel):
    """Compact analysis row for list views (CasesListView)."""

    id: UUID
    study_id: UUID
    study_instance_uid: Optional[str] = None
    patient_ref: Optional[str] = None
    status: str
    queued_at: datetime
    completed_at: Optional[datetime] = None
    pipeline_version: str


class AnalysisListResponse(BaseModel):
    """Paginated list response — cursor-based per plan §query keys."""

    items: list[AnalysisListItem]
    next_page_token: Optional[str] = None


@router.get(
    "",
    response_model=AnalysisListResponse,
    summary="List analyses for the current tenant (paginated)",
)
@require_permission("analysis.view")
async def list_analyses(
    request: Request,
    session: AsyncSession = Depends(get_db),
    limit: int = 25,
    page_token: Optional[str] = None,
    status_filter: Optional[str] = None,
) -> AnalysisListResponse:
    """Tenant-scoped list of analyses, newest first.

    Cursor pagination: ``next_page_token`` is the queued_at ISO timestamp
    of the last row returned. Pass it as ``page_token`` for the next page.
    """
    tenant_id: UUID = request.state.tenant_id
    limit = max(1, min(limit, 100))

    where_clauses = ["a.tenant_id = :tid"]
    params: dict[str, Any] = {"tid": str(tenant_id), "limit": limit + 1}
    if page_token:
        where_clauses.append("a.queued_at < :cursor")
        params["cursor"] = page_token
    if status_filter:
        where_clauses.append("a.status = :status")
        params["status"] = status_filter

    where_sql = " AND ".join(where_clauses)
    result = await session.execute(
        text(
            f"""
            SELECT a.id, a.study_id, a.status, a.queued_at, a.completed_at,
                   a.pipeline_version, s.study_instance_uid, s.patient_ref
            FROM analysis a
            LEFT JOIN study s ON s.id = a.study_id
            WHERE {where_sql}
            ORDER BY a.queued_at DESC
            LIMIT :limit
            """
        ),
        params,
    )
    rows = list(result.mappings())
    has_more = len(rows) > limit
    page_rows = rows[:limit]
    next_token = (
        page_rows[-1]["queued_at"].isoformat() if has_more and page_rows else None
    )
    return AnalysisListResponse(
        items=[AnalysisListItem(**dict(r)) for r in page_rows],
        next_page_token=next_token,
    )


@router.get(
    "/{analysis_id}",
    response_model=AnalysisDetailResponse,
    summary="Single analysis detail (status + stage progress + model versions)",
)
@require_permission("analysis.view")
async def get_analysis(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AnalysisDetailResponse:
    """Return the detail projection for one analysis."""
    tenant_id: UUID = request.state.tenant_id
    row = await _load_analysis_row(session, analysis_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))
    checkpoints = await _load_checkpoints(session, analysis_id)
    return _to_detail(row, checkpoints)


@router.get(
    "/{analysis_id}/results",
    response_model=AnalysisResultsResponse,
    summary="Aggregated results — segmentations, lesions, FLR default",
)
@require_permission("analysis.view")
async def get_analysis_results(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> AnalysisResultsResponse:
    """Return the aggregated outputs once at least a partial result exists."""
    tenant_id: UUID = request.state.tenant_id
    row = await _load_analysis_row(session, analysis_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))

    if row["status"] not in _DONE_STATES:
        # Per spec: results not available until complete/partial.
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_404_NOT_FOUND,
            f"Results unavailable while analysis is '{row['status']}'.",
            instance=str(uuid4()),
        )

    checkpoints = await _load_checkpoints(session, analysis_id)

    segmentations = [
        dict(r)
        for r in (
            await session.execute(
                text(
                    """
                    SELECT id, anatomy_category, anatomy_detail, volume_ml,
                           mask_url, snomed_code
                    FROM segmentation
                    WHERE analysis_id = :id
                    """
                ),
                {"id": str(analysis_id)},
            )
        ).mappings()
    ]
    lesions = [
        dict(r)
        for r in (
            await session.execute(
                text(
                    """
                    SELECT id, couinaud_location, longest_diameter_mm, volume_ml,
                           discovery_source, classification
                    FROM lesion
                    WHERE analysis_id = :id
                    """
                ),
                {"id": str(analysis_id)},
            )
        ).mappings()
    ]
    flr_default_row = (
        await session.execute(
            text(
                """
                SELECT id, plane_normal, plane_offset_mm, resected_volume_ml,
                       remnant_volume_ml, remnant_pct_functional, author
                FROM flr_calculation
                WHERE analysis_id = :id AND author = 'ai_default'
                ORDER BY id DESC LIMIT 1
                """
            ),
            {"id": str(analysis_id)},
        )
    ).mappings().first()

    return AnalysisResultsResponse(
        analysis=_to_detail(row, checkpoints),
        segmentations=segmentations,
        lesions=lesions,
        flr_default=dict(flr_default_row) if flr_default_row else None,
        confidence_flags=[],
    )


@router.post(
    "/{analysis_id}/cancel",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Gracefully cancel a queued/running analysis (FR-033a)",
)
@require_permission("analysis.cancel")
async def cancel_analysis(
    analysis_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Mark ``status='cancelled'``, revoke Celery, emit AuditEvent.

    Idempotent: cancelling an already-terminal analysis is a no-op.
    """
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None

    row = await _load_analysis_row(session, analysis_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))

    if row["status"] in _TERMINAL_STATES:
        return {"status": row["status"], "already_terminal": True}

    await session.execute(
        text(
            """
            UPDATE analysis
            SET status = 'cancelled',
                completed_at = now()
            WHERE id = :id AND tenant_id = :tid
            """
        ),
        {"id": str(analysis_id), "tid": str(tenant_id)},
    )

    # Best-effort Celery revoke — do NOT fail the request on revoke errors.
    _revoke_cascade(analysis_id)

    seq_no = await _emit_analysis_audit(
        request,
        session,
        category="analysis_cancel",
        analysis_id=analysis_id,
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return {"status": "cancelled"}


@router.post(
    "/{analysis_id}/retry",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=AnalysisQueuedResponse,
    summary="Retry from last successful checkpoint (FR-033b)",
)
@require_permission("analysis.retry")
async def retry_analysis(
    analysis_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> AnalysisQueuedResponse:
    """Re-enqueue the cascade starting at ``last_checkpoint.stage_no + 1``.

    Creates a NEW ``analysis`` row with ``retry_of_analysis_id`` pointing
    at the old one (kept in ``model_versions`` JSON for backward-compat
    until the schema gains a dedicated column).
    """
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = getattr(user, "id", None) if user else None

    row = await _load_analysis_row(session, analysis_id, tenant_id)
    if row is None:
        raise _not_found(str(uuid4()))
    if row["status"] not in {"failed", "cancelled"}:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_400_BAD_REQUEST,
            f"Cannot retry analysis in state '{row['status']}'.",
            instance=str(uuid4()),
        )

    checkpoints = await _load_checkpoints(session, analysis_id)
    last_stage_no = checkpoints[-1]["stage_no"] if checkpoints else -1
    start_stage = last_stage_no + 1

    new_row = await session.execute(
        text(
            """
            INSERT INTO analysis
                (tenant_id, study_id, status, pipeline_version, model_versions)
            VALUES
                (:tid, :sid, 'queued', :pv, :mv)
            RETURNING id, queued_at
            """
        ),
        {
            "tid": str(tenant_id),
            "sid": str(row["study_id"]),
            "pv": row["pipeline_version"],
            "mv": '{"retry_of_analysis_id":"' + str(analysis_id) + '"}',
        },
    )
    created = new_row.mappings().one()

    _dispatch_cascade(created["id"], start_stage=start_stage)

    seq_no = await _emit_analysis_audit(
        request,
        session,
        category="analysis_retry",
        analysis_id=created["id"],
        tenant_id=tenant_id,
        user_id=str(user_id) if user_id else None,
        extra={
            "retry_of_analysis_id": str(analysis_id),
            "start_stage": start_stage,
        },
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return AnalysisQueuedResponse(
        analysis_id=created["id"],
        status="queued",
        queued_at=created["queued_at"],
    )


__all__ = [
    "router",
    "AnalysisDetailResponse",
    "AnalysisResultsResponse",
    "AnalysisQueuedResponse",
    "CreateAnalysisRequest",
]
