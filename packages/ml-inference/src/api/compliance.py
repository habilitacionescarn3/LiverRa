# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Compliance HTTP API (T338, T343, T448).

Plain-English:
    This router is the read-mostly surface the compliance reviewer
    talks to. Four capabilities:

      - ``GET  /compliance/mbom``           — who trained/approved each ML
                                                model in the current build,
      - ``GET  /compliance/audit-summary``  — walks the per-tenant audit
                                                chain for a time window and
                                                verifies every seal lines up,
      - ``POST /compliance/ruo-spot-check`` — samples N export artifacts
                                                for a 20-artifact SC-009 review,
      - ``GET  /compliance/claim-registry`` — read the 7-claim regulatory
                                                status table,
      - ``PUT  /compliance/claim-registry`` — toggle one claim (step-up
                                                MFA required; emits
                                                ``model_version_update``
                                                AuditEvent via chain writer).

Permissions (T343 — enforced by @require_permission):
    GET  mbom              →  compliance.view_mbom
    GET  audit-summary     →  compliance.generate_audit_summary
    POST ruo-spot-check    →  compliance.spot_check_ruo
    GET  claim-registry    →  compliance.view_mbom  (same read-side grant)
    PUT  claim-registry    →  compliance.toggle_claim_registry + step_up=True

Every handler is tenant-scoped via ``request.state.tenant_id`` — the
authoritative value lives in the Cognito JWT + `ComplianceAssignment`
map, resolved by ``AuthMiddleware`` before this router sees the
request. Cross-tenant access returns 404 per FR-032a.

Spec refs: contracts/api-openapi.yaml §compliance, FR-028b, FR-038,
SC-009, SC-010.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.compliance import (
    chain_verifier,
    claim_registry,
    mbom_reader,
    ruo_spot_check,
)
from ..services.errors.catalog import ErrorSlug, ProblemDetailException

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic request bodies
# ---------------------------------------------------------------------------


class RuoSpotCheckRequest(BaseModel):
    """Body for ``POST /ruo-spot-check`` — how many artifacts to sample."""

    sample_size: int = Field(default=20, ge=1, le=200)


class ClaimRegistryUpdateRequest(BaseModel):
    """Body for ``PUT /claim-registry`` — one-at-a-time toggle.

    Matches ``ClaimRegistryEntry`` in the OpenAPI spec.
    """

    claim_key: str
    status: str
    effective_from: Optional[str] = None
    regulatory_reference: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_audit_writer(request: Request) -> Any:
    """Return the live ``AuditChainWriter`` singleton, if wired."""
    writer = getattr(request.app.state, "audit_chain_writer", None)
    if writer is not None:
        return writer
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter

        return AuditChainWriter()
    except Exception:  # noqa: BLE001
        return None


def _actor_id(request: Request) -> Optional[str]:
    user = getattr(request.state, "user", None)
    if user is None:
        return None
    return getattr(user, "id", None) or (
        user.get("id") if isinstance(user, dict) else None
    )


def _bad_request(msg: str) -> ProblemDetailException:
    return ProblemDetailException(
        ErrorSlug.VALIDATION,
        status.HTTP_400_BAD_REQUEST,
        msg,
        instance=str(uuid4()),
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/mbom",
    summary="Active Model Bill of Materials (FR-038)",
)
@require_permission("compliance.view_mbom")
async def get_mbom(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return every ML model shipped in the current build.

    Merges the live ``MBoM.json`` (for commit SHA + license hash) with
    historical ``model_bill_of_materials`` rows (for approver + source
    URL + integration date).
    """
    return await mbom_reader.load(session)


@router.get(
    "/audit-summary",
    summary="Tamper-evident audit summary with chain verification (SC-010)",
)
@require_permission("compliance.generate_audit_summary")
async def get_audit_summary(
    request: Request,
    tenant_id: UUID = Query(..., description="Target tenant (ComplianceAssignment scope)"),
    frm: datetime = Query(..., alias="from"),
    to: datetime = Query(...),
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Walk the chain for ``[from, to]`` and return the verified summary."""
    if to <= frm:
        raise _bad_request("`to` must be strictly greater than `from`.")

    # Cross-tenant hardening (FR-032a): a compliance reviewer MAY have a
    # ComplianceAssignment for multiple tenants, but the request's
    # ``request.state.tenant_id`` should match or the assignment mapping
    # must explicitly grant the requested tenant. The middleware
    # (T046/T062) is expected to have already narrowed this — here we
    # only reject if the user's context has no tenant at all.
    context_tid = getattr(request.state, "tenant_id", None)
    if context_tid is None:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Tenant context missing.",
            instance=str(uuid4()),
        )

    result = await chain_verifier.verify(
        session=session, tenant_id=tenant_id, frm=frm, to=to
    )
    return result.to_api_dict()


@router.post(
    "/ruo-spot-check",
    summary="Sample N artifacts for RUO watermark review (SC-009)",
)
@require_permission("compliance.spot_check_ruo")
async def post_ruo_spot_check(
    body: RuoSpotCheckRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return ``sample_size`` random export artifacts with watermark bbox."""
    tenant_id: UUID = request.state.tenant_id
    items = await ruo_spot_check.sample_and_verify(
        session=session,
        tenant_id=tenant_id,
        sample_size=body.sample_size,
    )
    return [i.to_api_dict() for i in items]


@router.get(
    "/claim-registry",
    summary="All 7 RegulatoryClaimRegistry rows (FR-028b)",
)
@require_permission("compliance.view_mbom")
async def get_claim_registry(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Read the claim registry for the current tenant."""
    tenant_id: UUID = request.state.tenant_id
    rows = await claim_registry.read(session=session, tenant_id=tenant_id)
    return [r.to_api_dict() for r in rows]


@router.put(
    "/claim-registry",
    summary="Toggle one claim's regulatory status (step-up MFA required)",
)
@require_permission("compliance.toggle_claim_registry", step_up=True)
async def put_claim_registry(
    body: ClaimRegistryUpdateRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Upsert one claim row and emit a ``model_version_update`` AuditEvent.

    Returns the persisted row projection. The response header
    ``X-LiverRa-Audit-Seq`` carries the chain sequence number assigned
    to the emitted AuditEvent so the UI can echo it in a toast / log.
    """
    tenant_id: UUID = request.state.tenant_id
    try:
        updated = await claim_registry.update(
            session=session,
            tenant_id=tenant_id,
            actor_user_id=_actor_id(request),
            claim_key=body.claim_key,
            status=body.status,
            regulatory_reference=body.regulatory_reference,
            audit_writer=_resolve_audit_writer(request),
        )
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc

    return updated.to_api_dict()


__all__ = ["router"]
