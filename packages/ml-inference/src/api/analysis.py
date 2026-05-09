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

import asyncio

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import Response as FastAPIResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.errors.catalog import ErrorSlug, ProblemDetailException

logger = logging.getLogger(__name__)


router = APIRouter()


# ---------------------------------------------------------------------------
# Demo-mode synthetic NIfTI mask
# ---------------------------------------------------------------------------
# Plain-English: the demo cascade writes fake `s3://liverra-demo/...` mask
# URIs because no real GPU stage runs in dev. Rather than 502'ing the layer
# overlay request, we synthesize a small ellipsoid binary mask in-memory so
# the frontend has something to paint. Real S3-backed cascades fall through.
def _synthesize_demo_nifti(anatomy_category: str) -> bytes:
    """Return a gzipped 256³ ellipsoid NIfTI mask for demo cascades."""
    import io
    import gzip
    import numpy as np
    import nibabel as nib

    dim = 256
    grid = np.indices((dim, dim, dim), dtype=np.float32) - dim / 2
    rx, ry, rz = 90.0, 70.0, 60.0
    inside = (grid[0] / rx) ** 2 + (grid[1] / ry) ** 2 + (grid[2] / rz) ** 2 <= 1
    voxels = inside.astype(np.uint8)
    img = nib.Nifti1Image(voxels, affine=np.eye(4))
    raw = img.to_bytes()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as gz:
        gz.write(raw)
    return buf.getvalue()


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
    # DICOM StudyInstanceUID + patient ref are surfaced from the joined
    # `study` row so the analysis detail page can render the imaging viewer
    # without an extra fetch.
    study_instance_uid: Optional[str] = None
    patient_ref: Optional[str] = None
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
    # LEFT JOIN `study` so the detail response can carry the DICOM
    # StudyInstanceUID + patient ref. The viewer needs the UID to fetch
    # series via QIDO/WADO; without it the dark center pane has nothing
    # to render.
    result = await session.execute(
        text(
            """
            SELECT a.id, a.study_id, a.tenant_id, a.status, a.queued_at,
                   a.started_at, a.completed_at, a.error_slug,
                   a.pipeline_version, a.model_versions,
                   a.implausible_output_reason,
                   s.study_instance_uid, s.patient_ref
            FROM analysis a
            LEFT JOIN study s ON s.id = a.study_id
            WHERE a.id = :id AND a.tenant_id = :tid
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
        study_instance_uid=row.get("study_instance_uid"),
        patient_ref=row.get("patient_ref"),
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

    Three modes, chosen by env vars (precedence: DEMO → REAL → default):

    - LIVERRA_CASCADE_DEMO_MODE=true  → ``demo_cascade``: 7 stages of
      synthetic output (~30s). For UX testing without real CT input.
    - LIVERRA_CASCADE_REAL_MODE=true  → ``real_cascade_task``: TS-based
      cascade (TotalSegmentator + heuristics + LI-RADS rules) producing
      clinically-plausible output. Requires the 4 phase NIfTIs to be in
      MinIO already (ingest stage 0 must have run).
    - neither set                     → ``run_cascade``: the original
      Celery Canvas chain that calls Triton. Currently broken because
      Triton is loaded with placeholder STU-Net stubs — fix-forward path
      is to deploy real STU-Net weights.

    The default is REAL_MODE so clicking "Run AI" produces good output
    today. To exercise the Triton path explicitly, set both env vars to
    false / unset and re-dispatch.
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

    real_mode = os.environ.get("LIVERRA_CASCADE_REAL_MODE", "true").lower() in {"1", "true", "yes"}
    if real_mode:
        try:
            from celery import chain  # type: ignore[import-not-found]
            from ..tasks.ingest import ingest_study  # type: ignore[import-not-found]
            from ..tasks.real_cascade_task import real_cascade_task  # type: ignore[import-not-found]
            # Look up study_id sync; ingest_study needs both. Same pattern as
            # run_cascade in tasks/cascade.py.
            import psycopg  # type: ignore[import-not-found]
            sync_url = os.environ.get(
                "DATABASE_URL_SYNC",
                "postgresql://liverra:liverra@localhost:5432/liverra",
            )
            with psycopg.connect(sync_url, autocommit=True) as conn:
                row = conn.execute(
                    "SELECT study_id FROM analysis WHERE id = %s",
                    (str(analysis_id),),
                ).fetchone()
                if row is None:
                    logger.warning("real_cascade dispatch: analysis %s not found", analysis_id)
                    return None
                study_id = str(row[0])
            # Chain: stage 0 (DICOM→NIfTI to MinIO) → TS-based 7-stage cascade.
            # ingest is idempotent — re-uploading existing phases is a no-op
            # path-wise, and the converter will skip series it can't classify.
            async_result = chain(
                ingest_study.si(str(analysis_id), study_id),
                real_cascade_task.si(str(analysis_id), start_stage),
            ).apply_async()
            return str(async_result.id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("real_cascade chain dispatch failed: %s", exc)
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

    # 3. DICOM→NIfTI staging used to run synchronously here; it now runs
    #    as the cascade's stage 0 (`liverra.tasks.ingest_study`) so the
    #    HTTP request returns 202 immediately, large studies don't blow
    #    past timeouts, and failures retry. Demo mode skips ingest
    #    entirely because demo_cascade fabricates synthetic outputs.

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

    # Commit BEFORE dispatching: the cascade tasks (real_cascade_task,
    # ingest_study) open fresh sync connections and must see this row.
    # Without an explicit commit the INSERT lives in an uncommitted async
    # transaction and the sync lookups in _dispatch_cascade return None.
    await session.commit()

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
    # AI-default FLR percent (functional remnant), populated via LEFT JOIN
    # on flr_calculation. None if no AI default has been computed yet.
    flr_pct: Optional[float] = None


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
                   a.pipeline_version, s.study_instance_uid, s.patient_ref,
                   f.remnant_pct_functional AS flr_pct
            FROM analysis a
            LEFT JOIN study s ON s.id = a.study_id
            LEFT JOIN flr_calculation f
                   ON f.analysis_id = a.id AND f.author = 'ai_default'
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

    items: list[AnalysisListItem] = []
    for r in page_rows:
        d = dict(r)
        # asyncpg / driver may return Decimal for numeric columns; coerce
        # to float so Pydantic + JSON serialisation are stable.
        flr = d.get("flr_pct")
        if flr is not None:
            try:
                d["flr_pct"] = float(flr)
            except (TypeError, ValueError):
                d["flr_pct"] = None
        items.append(AnalysisListItem(**d))
    return AnalysisListResponse(items=items, next_page_token=next_token)


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
                    SELECT id, bbox3d, couinaud_location, longest_diameter_mm, volume_ml,
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
                SELECT id, plane_normal, plane_offset_mm, plane_pose, resected_volume_ml,
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


# ---------------------------------------------------------------------------
# Report PDF (T-report-renderer)
# ---------------------------------------------------------------------------


class ReportMetaResponse(BaseModel):
    """Lightweight projection used by ``GET /analyses/{id}/report``."""

    analysis_id: UUID
    pdf_uri: Optional[str] = None
    finalized_at: Optional[datetime] = None
    version: Optional[int] = None
    on_demand: bool = Field(
        False,
        description=(
            "True when no formal `report` row exists yet but the on-demand "
            "renderer can produce a PDF via /report/pdf."
        ),
    )


def _build_s3_client_for_reports() -> Any:
    """Build an S3 client that honors MinIO env overrides."""
    import boto3  # local import — avoids hard dep at module load

    return boto3.client(
        "s3",
        region_name=os.environ.get("AWS_REGION", "eu-central-1"),
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL"),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


# Cache key includes the renderer's PDF_LAYOUT_VERSION so any layout
# change naturally invalidates stale cached PDFs (no manual purge).
from ..services.report_renderer import PDF_LAYOUT_VERSION as _PDF_LAYOUT_VERSION

_REPORT_PDF_KEY_TEMPLATE = (
    "analyses/{analysis_id}/report." + _PDF_LAYOUT_VERSION + ".pdf"
)
_REPORT_BUCKET_DEFAULT = "liverra-analyses-eu-central-1"


@router.get(
    "/{analysis_id}/report",
    response_model=ReportMetaResponse,
    summary="Report metadata projection (on-demand or finalized)",
)
@require_permission("analysis.view")
async def get_report_meta(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> ReportMetaResponse:
    """Return either the finalized ``report`` row or an on-demand sentinel.

    A real Report row only exists once a surgeon completes the finalize
    wizard; for demos / completed analyses we still expose an
    ``on_demand=true`` projection so the UI can show a "Download" button.
    """
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))

    rrow = (
        await session.execute(
            text(
                """
                SELECT pdf_uri, finalized_at, version
                FROM report
                WHERE analysis_id = :aid
                ORDER BY version DESC
                LIMIT 1
                """
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().first()

    if rrow:
        return ReportMetaResponse(
            analysis_id=analysis_id,
            pdf_uri=rrow["pdf_uri"],
            finalized_at=rrow["finalized_at"],
            version=rrow["version"],
            on_demand=False,
        )

    # No formal report — but the analysis is completed → on-demand path works.
    if arow["status"] in _DONE_STATES:
        return ReportMetaResponse(analysis_id=analysis_id, on_demand=True)

    raise _not_found(str(uuid4()))


@router.get(
    "/{analysis_id}/report/pdf",
    summary="Streaming PDF report (cached in S3, lazy-rendered if missing)",
)
@require_permission("analysis.view")
async def get_report_pdf(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    """Return ``application/pdf`` bytes.

    Lookup order:
      1. If a ``report`` row exists with a ``pdf_uri`` → fetch from S3.
      2. Else look for a cached on-demand PDF at the standard S3 key.
      3. Else render via :func:`render_analysis_pdf`, cache to S3
         (best-effort), and stream the bytes.
    """
    tenant_id: UUID = request.state.tenant_id
    # RLS gate — every other endpoint flows through tenant_session() which
    # sets this GUC; this handler took Depends(get_db) so we must set it
    # explicitly. Without this, RLS policies on `analysis` strip every row
    # and the lookup 404s even for valid analyses.
    await session.execute(
        text("SELECT set_config('app.tenant_id', :tid, true)"),
        {"tid": str(tenant_id)},
    )
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    if arow["status"] not in _DONE_STATES:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_404_NOT_FOUND,
            f"Report unavailable while analysis is '{arow['status']}'.",
            instance=str(uuid4()),
        )

    rrow = (
        await session.execute(
            text(
                """
                SELECT pdf_uri FROM report
                WHERE analysis_id = :aid
                ORDER BY version DESC LIMIT 1
                """
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().first()

    s3 = _build_s3_client_for_reports()
    bucket = os.environ.get("LIVERRA_ANALYSES_BUCKET", _REPORT_BUCKET_DEFAULT)
    cache_key = _REPORT_PDF_KEY_TEMPLATE.format(analysis_id=analysis_id)

    def _try_fetch_finalized() -> Optional[bytes]:
        if not rrow or not rrow["pdf_uri"]:
            return None
        uri = rrow["pdf_uri"]
        if not uri.startswith("s3://"):
            return None
        # parse s3://bucket/key
        rest = uri[len("s3://") :]
        if "/" not in rest:
            return None
        b, k = rest.split("/", 1)
        try:
            obj = s3.get_object(Bucket=b, Key=k)
            return obj["Body"].read()
        except Exception as exc:  # noqa: BLE001
            logger.warning("finalized PDF fetch failed (%s) — falling back", exc)
            return None

    def _try_fetch_cached() -> Optional[bytes]:
        try:
            obj = s3.get_object(Bucket=bucket, Key=cache_key)
            return obj["Body"].read()
        except Exception:  # noqa: BLE001
            return None

    def _render_and_cache() -> bytes:
        from ..services.report_renderer import render_analysis_pdf

        pdf_bytes = render_analysis_pdf(analysis_id, s3_client=s3)
        try:
            s3.put_object(
                Bucket=bucket,
                Key=cache_key,
                Body=pdf_bytes,
                ContentType="application/pdf",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("report cache upload failed (%s) — serving anyway", exc)
        return pdf_bytes

    loop = asyncio.get_running_loop()
    pdf_bytes = await loop.run_in_executor(None, _try_fetch_finalized)
    if pdf_bytes is None:
        pdf_bytes = await loop.run_in_executor(None, _try_fetch_cached)
    if pdf_bytes is None:
        pdf_bytes = await loop.run_in_executor(None, _render_and_cache)

    filename = f"liverra-report-{analysis_id}.pdf"
    return FastAPIResponse(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=300",
        },
    )


# ---------------------------------------------------------------------------
# Native HTML report endpoints (Phase A)
# ---------------------------------------------------------------------------
#
# These return JSON summary data + per-stage PNG bytes for the
# ReportInlineView frontend component. The URLs intentionally do NOT
# contain "/pdf" so browser content blockers (Opera ad/tracker/privacy
# guard) won't match common PDF-blocking filter patterns.


@router.get(
    "/{analysis_id}/report/summary",
    summary="Structured report data (cover stats, model versions, QC flags)",
)
@require_permission("analysis.view")
async def get_report_summary(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Return JSON the ReportInlineView component renders as cards."""
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))

    stage_rows = (
        await session.execute(
            text(
                """
                SELECT stage_no, stage, model_version, model_license_hash,
                       written_at, output_uri
                FROM pipeline_checkpoint
                WHERE analysis_id = :aid
                ORDER BY stage_no
                """
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().all()

    flr_row = (
        await session.execute(
            text(
                "SELECT total_ml, flr_ml, flr_pct, plane_pose "
                "FROM flr_calculation WHERE analysis_id = :aid"
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().first()

    lesion_rows = (
        await session.execute(
            text(
                """
                SELECT id, bbox3d, longest_diameter_mm, mask_uri
                FROM lesion WHERE analysis_id = :aid
                ORDER BY longest_diameter_mm DESC NULLS LAST
                """
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().all()

    seg_rows = (
        await session.execute(
            text(
                """
                SELECT anatomy_category, anatomy_detail, volume_ml
                FROM segmentation WHERE analysis_id = :aid
                ORDER BY anatomy_category, anatomy_detail NULLS FIRST
                """
            ),
            {"aid": str(analysis_id)},
        )
    ).mappings().all()

    # QC flags (Phase B2) — best-effort
    qc_flags: list[dict] = []
    try:
        from ..services.qc_flags import compute_qc_flags
        qc_flags = await asyncio.get_running_loop().run_in_executor(
            None, compute_qc_flags, _build_s3_client_for_reports(),
            analysis_id, arow["study_id"],
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("QC flags skipped: %s", exc)

    # Phase 1 heuristic findings — keyed by finding_type.
    findings: dict[str, Any] = {}
    try:
        finding_rows = (
            await session.execute(
                text(
                    "SELECT finding_type, payload "
                    "FROM analysis_finding WHERE analysis_id = :aid"
                ),
                {"aid": str(analysis_id)},
            )
        ).mappings().all()
        findings = {r["finding_type"]: r["payload"] for r in finding_rows}
    except Exception as exc:  # noqa: BLE001
        logger.info("findings skipped: %s", exc)

    return {
        "analysis_id": str(analysis_id),
        "study_id": str(arow["study_id"]),
        "patient_ref": arow.get("patient_ref"),
        "status": arow["status"],
        "started_at": arow.get("started_at"),
        "completed_at": arow.get("completed_at"),
        "pipeline_version": arow.get("pipeline_version"),
        "stages": [
            {
                "stage_no": r["stage_no"],
                "stage": r["stage"],
                "model_version": r["model_version"],
                "license_hash": r["model_license_hash"],
                "written_at": r["written_at"],
            }
            for r in stage_rows
        ],
        "flr": (
            {
                "total_ml": float(flr_row["total_ml"]) if flr_row["total_ml"] else None,
                "flr_ml": float(flr_row["flr_ml"]) if flr_row["flr_ml"] else None,
                "flr_pct": float(flr_row["flr_pct"]) if flr_row["flr_pct"] else None,
                "plane_pose": flr_row["plane_pose"],
            }
            if flr_row else None
        ),
        "segmentations": [
            {
                "anatomy_category": r["anatomy_category"],
                "anatomy_detail": r["anatomy_detail"],
                "volume_ml": float(r["volume_ml"]) if r["volume_ml"] else None,
            }
            for r in seg_rows
        ],
        "lesions": [
            {
                "id": str(r["id"]),
                "bbox3d": r["bbox3d"],
                "longest_diameter_mm": (
                    float(r["longest_diameter_mm"])
                    if r["longest_diameter_mm"] else None
                ),
            }
            for r in lesion_rows
        ],
        "qc_flags": qc_flags,
        "findings": findings,
    }


def _render_response(png_bytes: bytes | None) -> FastAPIResponse:
    if png_bytes is None:
        return FastAPIResponse(status_code=404, content=b"")
    return FastAPIResponse(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.get(
    "/{analysis_id}/report/render/parenchyma",
    summary="Multi-slice parenchyma render (PNG)",
)
@require_permission("analysis.view")
async def render_parenchyma_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_parenchyma, s3, analysis_id, arow["study_id"],
    )
    return _render_response(png)


@router.get(
    "/{analysis_id}/report/render/vessels",
    summary="Vessel-tree render (PNG)",
)
@require_permission("analysis.view")
async def render_vessels_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_vessels, s3, analysis_id, arow["study_id"],
    )
    return _render_response(png)


@router.get(
    "/{analysis_id}/report/render/flr",
    summary="FLR plane visualisation (PNG)",
)
@require_permission("analysis.view")
async def render_flr_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    flr_row = (
        await session.execute(
            text("SELECT plane_pose FROM flr_calculation WHERE analysis_id = :aid"),
            {"aid": str(analysis_id)},
        )
    ).mappings().first()
    plane_z: int | None = None
    if flr_row and flr_row["plane_pose"]:
        plane_z = (flr_row["plane_pose"] or {}).get("z_index")
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_flr, s3, analysis_id, arow["study_id"], plane_z,
    )
    return _render_response(png)


@router.get(
    "/{analysis_id}/report/render/lesion/{lesion_id}",
    summary="Per-lesion 3-axis thumbnail (PNG)",
)
@require_permission("analysis.view")
async def render_lesion_endpoint(
    analysis_id: UUID,
    lesion_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    # Pull the lesion's bbox from the DB so the renderer can fall back
    # to cropping a merged tumor mask if no per-lesion file exists
    # (TS-based cascade writes one merged file, not per-lesion masks).
    from sqlalchemy import text as _text
    bbox_row = await session.execute(
        _text("SELECT bbox3d FROM lesion WHERE id = :lid AND analysis_id = :aid"),
        {"lid": str(lesion_id), "aid": str(analysis_id)},
    )
    bbox_value = bbox_row.scalar_one_or_none()
    bbox_3d: list[int] | None = None
    if bbox_value is not None:
        try:
            import json as _json
            bbox_data = bbox_value if isinstance(bbox_value, dict) else _json.loads(bbox_value)
            coords = bbox_data.get("coords") if isinstance(bbox_data, dict) else None
            if isinstance(coords, list) and len(coords) == 6:
                bbox_3d = [int(c) for c in coords]
        except Exception:  # noqa: BLE001
            bbox_3d = None
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_lesion_thumbnail,
        s3, analysis_id, arow["study_id"], lesion_id, bbox_3d,
    )
    return _render_response(png)


@router.get(
    "/{analysis_id}/report/render/four-phase",
    summary="Side-by-side 4-phase axial comparison (PNG)",
)
@require_permission("analysis.view")
async def render_four_phase_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_four_phase, s3, analysis_id, arow["study_id"],
    )
    return _render_response(png)


@router.get(
    "/{analysis_id}/report/per-slice-pdf",
    summary="Multi-page slice-by-slice PDF for radiologist review",
)
@require_permission("analysis.view")
async def render_per_slice_pdf_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    pdf = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_per_slice_pdf, s3, analysis_id, arow["study_id"],
    )
    if pdf is None:
        return FastAPIResponse(status_code=404, content=b"")
    filename = f"liverra-per-slice-{analysis_id}.pdf"
    return FastAPIResponse(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get(
    "/{analysis_id}/report/render/mesh3d",
    summary="3D parenchyma mesh render (PNG, marching-cubes)",
)
@require_permission("analysis.view")
async def render_mesh3d_endpoint(
    analysis_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))
    from ..services import stage_render
    s3 = _build_s3_client_for_reports()
    png = await asyncio.get_running_loop().run_in_executor(
        None, stage_render.render_mesh3d, s3, analysis_id, arow["study_id"],
    )
    return _render_response(png)


# ---------------------------------------------------------------------------
# Mask streaming (Pass B — overlay support)
# ---------------------------------------------------------------------------
#
# Browsers cannot speak `s3://` directly, and exposing presigned URLs would
# leak bucket names + cross-cut auth (the analysis is tenant-scoped; an S3
# presign is not). Easiest path: the FastAPI app authenticates the request
# (via `require_permission` + tenant filter) then streams the mask bytes
# back as `application/octet-stream`. Frontend feeds the bytes to
# `nifti-reader-js` and converts to a Cornerstone3D labelmap.


@router.get(
    "/{analysis_id}/mask/{anatomy_category}",
    summary="Stream a segmentation mask (NIfTI .nii.gz) for overlay rendering",
)
@require_permission("analysis.view")
async def get_mask_nifti(
    analysis_id: UUID,
    anatomy_category: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> FastAPIResponse:
    """Return raw mask bytes for one segmentation row.

    The frontend Cornerstone3D viewer fetches this to overlay the
    parenchyma / vessel / Couinaud mask on top of the CT slices.
    """
    tenant_id: UUID = request.state.tenant_id
    arow = await _load_analysis_row(session, analysis_id, tenant_id)
    if arow is None:
        raise _not_found(str(uuid4()))

    # Pass D4 — accept compound anatomy keys for Couinaud sub-segments
    # and vessel trunks. The frontend layer-toggle panel encodes 11
    # separate masks (1 liver + 8 Couinaud + 2 vessels); we surface
    # them all behind a single endpoint so the viewer fetcher only
    # has to vary the path component.
    #
    # Plain-English: think of `liver`, `couinaud-iv`, `portal-vein` as
    # short codes the frontend uses; this block translates them into
    # the (anatomy_category, anatomy_detail) pair stored in the
    # `segmentation` table.
    raw_key = anatomy_category
    detail_filter: Optional[str] = None
    if raw_key.startswith("couinaud-"):
        roman = raw_key[len("couinaud-"):].upper()
        # Roman numerals I..VIII are the canonical anatomy_detail per
        # data-model §7. Anything else is a 404.
        if roman not in ("I", "II", "III", "IV", "V", "VI", "VII", "VIII"):
            raise ProblemDetailException(
                ErrorSlug.VALIDATION,
                status.HTTP_404_NOT_FOUND,
                f"Unknown Couinaud key '{raw_key}'.",
                instance=str(uuid4()),
            )
        category = "couinaud"
        detail_filter = roman
    elif raw_key == "portal-vein":
        category = "portal_vein"
    elif raw_key == "hepatic-vein":
        category = "hepatic_vein"
    else:
        # Default: pass through (handles `liver`, legacy single-key
        # callers, and any anatomy_category written verbatim).
        category = raw_key

    # Look up the segmentation row matching (analysis_id, category[, detail]).
    # Prefer the most recent row if multiple writes exist (Celery retries).
    if detail_filter is not None:
        seg_row = (
            await session.execute(
                text(
                    """
                    SELECT mask_url, mask_uri, mask_s3_uri
                    FROM segmentation
                    WHERE analysis_id = :aid
                      AND anatomy_category = :anat
                      AND anatomy_detail = :detail
                    ORDER BY created_at DESC, id DESC LIMIT 1
                    """
                ),
                {"aid": str(analysis_id), "anat": category, "detail": detail_filter},
            )
        ).mappings().first()
    else:
        seg_row = (
            await session.execute(
                text(
                    """
                    SELECT mask_url, mask_uri, mask_s3_uri
                    FROM segmentation
                    WHERE analysis_id = :aid AND anatomy_category = :anat
                    ORDER BY created_at DESC, id DESC LIMIT 1
                    """
                ),
                {"aid": str(analysis_id), "anat": category},
            )
        ).mappings().first()

    # Pick whichever URI column was populated. Couinaud + vessel rows
    # write all three (mask_url, mask_uri, mask_s3_uri) to the same
    # value; legacy parenchyma rows may set only mask_url.
    uri: Optional[str] = None
    if seg_row:
        uri = (
            seg_row.get("mask_url")
            or seg_row.get("mask_s3_uri")
            or seg_row.get("mask_uri")
        )
    if not uri:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_404_NOT_FOUND,
            f"No mask found for anatomy '{anatomy_category}'.",
            instance=str(uuid4()),
        )

    # Demo-mode shortcut: cascades that ran without a real GPU stage write
    # fake `s3://liverra-demo/...` URIs. Synthesize an ellipsoid NIfTI so
    # the frontend overlay has data without needing a real S3 bucket.
    if uri.startswith("s3://liverra-demo/"):
        body = _synthesize_demo_nifti(anatomy_category)
        return FastAPIResponse(
            content=body,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'inline; filename="{anatomy_category}.nii.gz"',
                "Cache-Control": "private, max-age=600",
            },
        )

    if not uri.startswith("s3://"):
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Mask URI is not S3-backed: {uri[:32]}…",
            instance=str(uuid4()),
        )
    rest = uri[len("s3://") :]
    if "/" not in rest:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Malformed mask S3 URI (missing key).",
            instance=str(uuid4()),
        )
    bucket, key = rest.split("/", 1)

    s3 = _build_s3_client_for_reports()

    def _fetch_bytes() -> bytes:
        obj = s3.get_object(Bucket=bucket, Key=key)
        return obj["Body"].read()

    loop = asyncio.get_running_loop()
    try:
        body = await loop.run_in_executor(None, _fetch_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.warning("mask fetch failed for %s: %s", uri, exc)
        raise ProblemDetailException(
            ErrorSlug.PACS_UNREACHABLE,
            status.HTTP_502_BAD_GATEWAY,
            "Could not fetch mask object from object storage.",
            instance=str(uuid4()),
        ) from exc

    # NIfTI files commonly arrive as `.nii.gz`; pass them through verbatim
    # — the frontend pako-decompresses them. Filename hint helps callers
    # that dump to disk for debugging.
    is_gz = key.endswith(".gz")
    filename = f"{anatomy_category}.nii{'.gz' if is_gz else ''}"
    return FastAPIResponse(
        content=body,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, max-age=600",
        },
    )


__all__ = [
    "router",
    "AnalysisDetailResponse",
    "AnalysisResultsResponse",
    "AnalysisQueuedResponse",
    "CreateAnalysisRequest",
    "ReportMetaResponse",
]
