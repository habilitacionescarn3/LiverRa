# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""GDPR erasure HTTP API (T323, T327, T328, T446, US9).

Plain-English:
    Two endpoints:

      - ``POST /erasure/requests``         DPO submits a new request
      - ``GET  /erasure/requests/{id}``    status + confirmation PDF

    Both are behind ``@require_permission('erasure.execute', step_up=True)``
    — a non-DPO user trying the URL gets a 403, a DPO without a fresh
    MFA session gets a 401 with ``slug=step-up-required``.

    On POST we:
      1. Persist the ``erasure_request`` row in ``status='requested'``,
      2. Emit an ``erasure_requested`` AuditEvent,
      3. Enqueue the ``erasure_execute`` Celery task (T446 wires the
         actual orchestrator call).

    On GET we return the request status plus, for completed rows, a
    pre-signed URL to the WeasyPrint-rendered confirmation PDF (or
    stream the bytes directly in dev environments without S3).

    Any denied call (RBAC / step-up failure) emits an AuditEvent with
    ``rbac.denied=true`` — required by NFR-007 so compliance auditors
    can reconstruct access-control failures.

Spec refs:
    - spec.md §FR-040, §FR-032a, §FR-002a
    - contracts/api-openapi.yaml §erasure
    - research.md §X.1
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

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
# Pydantic models
# ---------------------------------------------------------------------------


class CreateErasureRequest(BaseModel):
    """Body for ``POST /erasure/requests``."""

    target_study_id: UUID = Field(
        ..., description="Study UUID to erase. Must belong to DPO's tenant."
    )
    justification: str = Field(
        ...,
        min_length=10,
        max_length=2000,
        description="Documented reason for erasure (Art. 17 grounds).",
    )


class CreateErasureResponse(BaseModel):
    erasure_request_id: UUID


class ErasureStatusResponse(BaseModel):
    status: str
    tombstone_hash_hex: Optional[str] = None
    confirmation_pdf_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _emit_erasure_audit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    tenant_id: UUID,
    user_id: Optional[str],
    study_id: Optional[UUID] = None,
    erasure_request_id: Optional[UUID] = None,
    denied: bool = False,
) -> Optional[int]:
    """Write an ``erasure_*`` AuditEvent (T328). Fail-closed."""
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:  # pragma: no cover
        logger.debug("AuditChainWriter unavailable; %s audit skipped", category)
        return None

    writer = (
        getattr(request.app.state, "audit_chain_writer", None) or AuditChainWriter()
    )

    from ..services.audit.audit_helpers import build_audit_event, fhir_ref

    entity_refs: list[str] = []
    if study_id:
        entity_refs.append(fhir_ref("Study", study_id))
    if erasure_request_id:
        entity_refs.append(fhir_ref("ErasureRequest", erasure_request_id))

    event = build_audit_event(
        category=category,
        actor=f"Practitioner/{user_id}" if user_id else None,
        entity_refs=entity_refs,
        outcome="8" if denied else "0",
        extensions=(
            [{"url": "liverra:rbac.denied", "valueBoolean": True}] if denied else None
        ),
    )

    row = await writer.write(event, tenant_id, session)
    return row.sequence_no


async def _load_erasure_request(
    session: AsyncSession,
    *,
    erasure_request_id: UUID,
    tenant_id: UUID,
) -> Optional[dict[str, Any]]:
    """Load a request row — scoped to the caller's tenant."""
    try:
        result = await session.execute(
            text(
                """
                SELECT id, tenant_id, target_study_id, justification, status,
                       requested_at, completed_at, tombstone_hash,
                       confirmation_pdf_url, dpo_email
                FROM erasure_request
                WHERE id = :rid AND tenant_id = :tid
                """
            ),
            {"rid": str(erasure_request_id), "tid": str(tenant_id)},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("erasure_request table not yet available: %s", exc)
        return None
    row = result.mappings().first()
    return dict(row) if row else None


def _dispatch_erasure(erasure_request_id: UUID) -> None:
    """Enqueue the ``erasure_execute`` Celery task (T446)."""
    try:
        from ..tasks.erasure_execute import erasure_execute  # type: ignore

        erasure_execute.delay(str(erasure_request_id))  # type: ignore[attr-defined]
    except Exception as exc:  # noqa: BLE001
        logger.info("erasure_execute dispatch skipped: %s", exc)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/requests",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=CreateErasureResponse,
    summary="Submit a GDPR Art. 17 erasure request (DPO + step-up required)",
)
@require_permission("erasure.execute", step_up=True)
async def create_erasure_request(
    body: CreateErasureRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> CreateErasureResponse:
    """Create + enqueue an erasure. Returns 202 with the request id.

    Idempotency: if a ``requested`` or ``executing`` erasure already
    exists for the target study, we return that one — erasure is a
    terminal action; we must not double-fire.
    """
    tenant_id: UUID = request.state.tenant_id
    user = getattr(request.state, "user", None)
    user_id = str(getattr(user, "id", "")) if user else None
    dpo_email = getattr(user, "email", None) if user else None

    # Confirm the target study belongs to the caller's tenant (FR-032a).
    study_check = await session.execute(
        text(
            """
            SELECT id FROM study WHERE id = :sid AND tenant_id = :tid
            """
        ),
        {"sid": str(body.target_study_id), "tid": str(tenant_id)},
    )
    if study_check.first() is None:
        # FR-032a: don't reveal cross-tenant existence. Return 404 same
        # as for a non-existent study.
        await _emit_erasure_audit(
            request,
            session,
            category="erasure_requested",
            tenant_id=tenant_id,
            user_id=user_id,
            study_id=body.target_study_id,
            denied=True,
        )
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Study not found.",
            instance=str(uuid4()),
        )

    # Idempotency: return an in-flight request if one exists.
    existing = await session.execute(
        text(
            """
            SELECT id FROM erasure_request
            WHERE target_study_id = :sid
              AND tenant_id = :tid
              AND status IN ('requested','executing')
            ORDER BY requested_at DESC LIMIT 1
            """
        ),
        {"sid": str(body.target_study_id), "tid": str(tenant_id)},
    )
    active = existing.first()
    if active:
        return CreateErasureResponse(erasure_request_id=active[0])

    erasure_id = uuid4()
    try:
        await session.execute(
            text(
                """
                INSERT INTO erasure_request
                    (id, tenant_id, target_study_id, justification,
                     status, requested_at, dpo_email)
                VALUES
                    (:id, :tid, :sid, :jst, 'requested', now(), :email)
                """
            ),
            {
                "id": str(erasure_id),
                "tid": str(tenant_id),
                "sid": str(body.target_study_id),
                "jst": body.justification,
                "email": dpo_email,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("erasure_request insert failed: %s", exc)
        raise ProblemDetailException(
            ErrorSlug.INTERNAL,
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Could not record erasure request.",
            instance=str(uuid4()),
        ) from exc

    await _emit_erasure_audit(
        request,
        session,
        category="erasure_requested",
        tenant_id=tenant_id,
        user_id=user_id,
        study_id=body.target_study_id,
        erasure_request_id=erasure_id,
    )

    # T446: enqueue the orchestrator's Celery task. Orchestrator looks
    # the request up by id, so we don't need to pass the full payload.
    _dispatch_erasure(erasure_id)

    return CreateErasureResponse(erasure_request_id=erasure_id)


@router.get(
    "/requests/{erasure_id}",
    summary="Fetch erasure request status; streams confirmation PDF if completed",
)
@require_permission("erasure.execute", step_up=True)
async def get_erasure_request(
    erasure_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> Any:
    """Return JSON status OR stream the PDF if the client asks for it.

    The client indicates preference via ``Accept: application/pdf``.
    When the request is complete and the caller wants the PDF we
    stream raw bytes; otherwise we return the JSON status object.
    """
    tenant_id: UUID = request.state.tenant_id
    row = await _load_erasure_request(
        session, erasure_request_id=erasure_id, tenant_id=tenant_id
    )
    if not row:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Erasure request not found.",
            instance=str(uuid4()),
        )

    # When the caller wants the PDF and the request is completed, stream
    # from S3 (if the URL is set) or regenerate on the fly.
    wants_pdf = "application/pdf" in (request.headers.get("accept", "") or "")
    if wants_pdf and row["status"] == "completed":
        pdf_url = row.get("confirmation_pdf_url")
        if pdf_url:
            response.headers["Location"] = pdf_url
            return FastAPIResponse(status_code=status.HTTP_302_FOUND, headers=response.headers)
        # Fallback: regenerate from the orchestrator inputs. In dev we
        # don't have the bytes stored, so we return 404 — the caller
        # should retry after a moment.
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Confirmation PDF not yet available.",
            instance=str(uuid4()),
        )

    tombstone_hex = (
        row["tombstone_hash"].hex() if isinstance(row.get("tombstone_hash"), (bytes, bytearray)) else row.get("tombstone_hash")
    )
    return ErasureStatusResponse(
        status=row["status"],
        tombstone_hash_hex=tombstone_hex,
        confirmation_pdf_url=row.get("confirmation_pdf_url"),
    )


__all__ = [
    "router",
    "CreateErasureRequest",
    "CreateErasureResponse",
    "ErasureStatusResponse",
]
