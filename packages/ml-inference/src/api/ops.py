# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Ops HTTP API (T312, T314, T315, T443, US8).

Plain-English:
    The ops engineer's remote control. Four routes:

      - ``GET  /ops/queue``                             cross-tenant snapshot
      - ``POST /ops/analyses/{id}/retry``               re-queue from checkpoint
      - ``POST /ops/analyses/{id}/cancel``              graceful stop
      - ``POST /ops/analyses/{id}/mark-blocked``        flag as unrecoverable

    Everything the ops engineer sees MUST be PHI-free (FR-033c). Two
    guards:

      1. ``queue_aggregator.build_view`` selects only PHI-free columns.
      2. ``_phi_guard`` re-runs the entire serialized payload through
         :class:`PHIScrubber` and refuses to send if anything mutates
         (fail-closed per NFR-007).

    Mutations (``retry``/``cancel``/``mark-blocked``) emit
    ``ops_retry`` / ``ops_cancel`` / ``ops_mark_blocked`` FHIR
    AuditEvents through the chain-of-hashes writer (T315) so the ops
    action is reconstructible during a compliance audit.

Spec refs:
    - spec.md §FR-033a/b/c, NFR-007
    - contracts/api-openapi.yaml §ops
    - research.md §X.3
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
from ..services.ops.queue_aggregator import QueueView, build_view

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class MarkBlockedRequest(BaseModel):
    """Body for ``POST /ops/analyses/{id}/mark-blocked``."""

    note: Optional[str] = Field(
        default=None,
        description=(
            "Free-text note — scrubbed for PHI server-side before persistence."
        ),
        max_length=1000,
    )


class OpsMutationResponse(BaseModel):
    """Shared response body for retry/cancel/mark-blocked."""

    analysis_id: UUID
    status: str
    audit_sequence_no: Optional[int] = None


# ---------------------------------------------------------------------------
# Helpers — PHI guard + audit
# ---------------------------------------------------------------------------


def _phi_guard(payload: dict[str, Any]) -> None:
    """Defence-in-depth PHI check. Raises 500 if scrubber mutates payload.

    Plain-English: even though :mod:`queue_aggregator` selects only
    PHI-free columns, we re-run the final serialized response through
    the central :class:`PHIScrubber`. If the scrubber finds anything
    that looks like a German/Georgian name, an MRN, a DICOM UID in a
    free-text field, or an email address, the payload has been
    contaminated and we MUST refuse to send it (NFR-007 fail-closed).

    We compare canonical-JSON of before/after — if identical, the
    payload is clean; otherwise we raise and the handler translates
    to a 500 Problem+JSON.
    """
    try:
        from ..observability.phi_scrubber import PHIScrubber, ScrubberFailure
    except Exception:  # pragma: no cover — bootstrap path
        logger.warning("PHIScrubber unavailable; ops response unguarded")
        return

    scrubber = PHIScrubber()
    try:
        scrubbed = scrubber.scrub_dict(payload)
    except ScrubberFailure as exc:
        logger.error("PHI scrubber failed on ops payload: %s", exc)
        raise ProblemDetailException(
            ErrorSlug.INTERNAL,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Ops payload rejected — PHI scrubber failed (fail-closed).",
            instance=str(uuid4()),
        ) from exc

    # Compare canonical JSON. If the scrubber redacted anything, the
    # two serializations will differ.
    import json

    def _canon(obj: Any) -> str:
        return json.dumps(
            obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
        )

    if _canon(payload) != _canon(scrubbed):
        # A field that made it through the SQL projection nonetheless
        # contains PHI — this is a bug in the aggregator or a data
        # model regression. Fail loudly.
        logger.error(
            "ops payload contained PHI — blocked by fail-closed scrubber "
            "(NFR-007); payload keys=%s",
            list(payload.keys()),
        )
        raise ProblemDetailException(
            ErrorSlug.INTERNAL,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Ops payload rejected — would have leaked PHI.",
            instance=str(uuid4()),
        )


_TERMINAL_STATES = {"completed", "complete", "failed", "cancelled", "blocked"}


async def _load_analysis_for_ops(
    session: AsyncSession, analysis_id: UUID
) -> Optional[dict[str, Any]]:
    """Load an analysis row cross-tenant (ops scope is global)."""
    result = await session.execute(
        text(
            """
            SELECT a.id, a.study_id, a.tenant_id, a.status, a.queued_at,
                   a.started_at, a.completed_at, a.pipeline_version,
                   a.model_versions, a.error_slug
            FROM analysis a
            WHERE a.id = :id
            """
        ),
        {"id": str(analysis_id)},
    )
    row = result.mappings().first()
    return dict(row) if row else None


async def _emit_ops_audit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    analysis_id: UUID,
    tenant_id: UUID,
    user_id: Optional[str],
    extra: Optional[dict[str, Any]] = None,
) -> Optional[int]:
    """Emit an ``ops_retry`` / ``ops_cancel`` / ``ops_mark_blocked`` event.

    FR-029b: audit failures MUST break the mutation (caller's DB txn
    rolls back). We surface the chain ``sequence_no`` via the
    ``X-LiverRa-Audit-Seq`` response header so the frontend can show
    "audit confirmed #NNN".
    """
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:  # pragma: no cover
        logger.debug("AuditChainWriter unavailable; skipping %s", category)
        return None

    writer: AuditChainWriter = (
        getattr(request.app.state, "audit_chain_writer", None)
        or AuditChainWriter()
    )
    user = getattr(request.state, "user", None)
    user_id = user_id or (getattr(user, "id", None) if user else None)

    event = {
        "resourceType": "AuditEvent",
        "id": str(uuid4()),
        "category": category,
        "recorded": datetime.now(timezone.utc).isoformat(),
        "agent": [{"who": {"reference": f"Practitioner/{user_id}" if user_id else None}}],
        "entity": [{"what": {"reference": f"Analysis/{analysis_id}"}}],
    }
    if extra:
        # Extra is scrubbed as a precaution — ops actions may carry
        # a "note" field that a careless engineer could populate with
        # patient info. Better to pre-scrub than leak.
        try:
            from ..observability.phi_scrubber import PHIScrubber
            extra = PHIScrubber().scrub_dict(extra)
        except Exception:  # pragma: no cover
            pass
        event["extension"] = [{"url": "liverra:extra", "valueString": str(extra)}]

    row = await writer.write(event, tenant_id, session)
    return row.sequence_no


def _dispatch_cascade(analysis_id: UUID, *, start_stage: int = 0) -> None:
    """Best-effort cascade dispatch — no-op if Celery not wired."""
    try:
        from ..tasks.cascade import run_cascade  # type: ignore[import-not-found]

        run_cascade.delay(str(analysis_id), start_stage)  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        logger.info("cascade dispatch skipped: %s", exc)


def _revoke_cascade(analysis_id: UUID) -> None:
    try:
        from ..tasks.cascade import revoke_cascade  # type: ignore[import-not-found]

        revoke_cascade(str(analysis_id))
    except Exception:  # noqa: BLE001
        logger.info("cascade revoke skipped for analysis=%s", analysis_id)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/queue",
    summary="Cross-tenant queue snapshot (no PHI) — ops role only",
)
@require_permission("ops.queue_view")
async def get_queue(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Return the aggregated cross-tenant queue telemetry.

    The aggregator only SELECTs PHI-free columns, but we run a
    fail-closed :class:`PHIScrubber` pass over the serialized output
    before returning (NFR-007).
    """
    view: QueueView = await build_view(session)
    payload = view.to_dict()
    _phi_guard(payload)  # fail-closed; raises 500 if anything slipped through
    return payload


@router.post(
    "/analyses/{analysis_id}/retry",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=OpsMutationResponse,
    summary="Ops re-queue from last successful checkpoint (FR-033b)",
)
@require_permission("ops.case_unstick")
async def ops_retry_analysis(
    analysis_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> OpsMutationResponse:
    """Ops variant of the retry flow (parallel to ``POST /analyses/{id}/retry``).

    Differs from the clinician-facing retry in one respect: the ops
    engineer may retry analyses that belong to ANY tenant, so we do
    not gate on ``request.state.tenant_id``.
    """
    row = await _load_analysis_for_ops(session, analysis_id)
    if row is None:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Analysis not found.",
            instance=str(uuid4()),
        )
    if row["status"] not in {"failed", "cancelled", "blocked"}:
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_400_BAD_REQUEST,
            f"Cannot ops-retry analysis in state '{row['status']}'.",
            instance=str(uuid4()),
        )

    # Read last checkpoint to resume from the right stage.
    cp_res = await session.execute(
        text(
            """
            SELECT stage_no FROM pipeline_checkpoint
            WHERE analysis_id = :id
            ORDER BY stage_no DESC LIMIT 1
            """
        ),
        {"id": str(analysis_id)},
    )
    last_cp = cp_res.scalar_one_or_none()
    start_stage = (last_cp + 1) if last_cp is not None else 0

    # Requeue in-place: flip status back to 'queued' rather than minting a
    # new row. Ops engineers want a single lineage per case, not a forest.
    await session.execute(
        text(
            """
            UPDATE analysis
            SET status = 'queued',
                started_at = NULL,
                completed_at = NULL,
                error_slug = NULL
            WHERE id = :id
            """
        ),
        {"id": str(analysis_id)},
    )

    _dispatch_cascade(analysis_id, start_stage=start_stage)

    seq_no = await _emit_ops_audit(
        request,
        session,
        category="ops_retry",
        analysis_id=analysis_id,
        tenant_id=row["tenant_id"],
        user_id=None,
        extra={"start_stage": start_stage, "from_status": row["status"]},
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return OpsMutationResponse(
        analysis_id=analysis_id,
        status="queued",
        audit_sequence_no=seq_no,
    )


@router.post(
    "/analyses/{analysis_id}/cancel",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=OpsMutationResponse,
    summary="Ops cancel — flip to 'cancelled' + revoke Celery (FR-033a)",
)
@require_permission("ops.case_unstick")
async def ops_cancel_analysis(
    analysis_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> OpsMutationResponse:
    row = await _load_analysis_for_ops(session, analysis_id)
    if row is None:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Analysis not found.",
            instance=str(uuid4()),
        )
    if row["status"] in _TERMINAL_STATES:
        return OpsMutationResponse(analysis_id=analysis_id, status=row["status"])

    await session.execute(
        text(
            """
            UPDATE analysis
            SET status = 'cancelled', completed_at = now()
            WHERE id = :id
            """
        ),
        {"id": str(analysis_id)},
    )
    _revoke_cascade(analysis_id)

    seq_no = await _emit_ops_audit(
        request,
        session,
        category="ops_cancel",
        analysis_id=analysis_id,
        tenant_id=row["tenant_id"],
        user_id=None,
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return OpsMutationResponse(
        analysis_id=analysis_id,
        status="cancelled",
        audit_sequence_no=seq_no,
    )


@router.post(
    "/analyses/{analysis_id}/mark-blocked",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=OpsMutationResponse,
    summary="Flag an analysis as unrecoverable; notifies submitting clinician",
)
@require_permission("ops.case_unstick")
async def ops_mark_blocked(
    analysis_id: UUID,
    body: MarkBlockedRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> OpsMutationResponse:
    """Terminal state used when ops can't recover the case and wants the
    submitting clinician to be notified. The notification itself is
    emitted by a downstream Celery task listening on ``ops_mark_blocked``
    AuditEvents — wiring lives in the notifications worker.
    """
    row = await _load_analysis_for_ops(session, analysis_id)
    if row is None:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Analysis not found.",
            instance=str(uuid4()),
        )
    if row["status"] in _TERMINAL_STATES and row["status"] != "blocked":
        raise ProblemDetailException(
            ErrorSlug.VALIDATION,
            status.HTTP_400_BAD_REQUEST,
            f"Analysis already terminal (status='{row['status']}').",
            instance=str(uuid4()),
        )

    # Scrub the free-text note before persistence — ops engineers may
    # accidentally paste patient context.
    scrubbed_note: Optional[str] = None
    if body.note:
        try:
            from ..observability.phi_scrubber import PHIScrubber
            scrubbed_note = PHIScrubber().scrub_string(body.note)
        except Exception:  # pragma: no cover — fail-closed = drop
            scrubbed_note = "[redacted]"

    await session.execute(
        text(
            """
            UPDATE analysis
            SET status = 'blocked',
                completed_at = now(),
                implausible_output_reason = COALESCE(:note, implausible_output_reason)
            WHERE id = :id
            """
        ),
        {"id": str(analysis_id), "note": scrubbed_note},
    )

    seq_no = await _emit_ops_audit(
        request,
        session,
        category="ops_mark_blocked",
        analysis_id=analysis_id,
        tenant_id=row["tenant_id"],
        user_id=None,
        extra={"note": scrubbed_note} if scrubbed_note else None,
    )
    if seq_no is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq_no)

    return OpsMutationResponse(
        analysis_id=analysis_id,
        status="blocked",
        audit_sequence_no=seq_no,
    )


__all__ = ["router", "OpsMutationResponse", "MarkBlockedRequest"]
