# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Admin HTTP API (T279, T284, T285, T432, T433, T434).

Plain-English:
    The admin router is the tenant-admin's console. Think of it as the
    building-manager's keyring: it lets a tenant admin view their tenant
    details, invite new clinicians, suspend a user, configure the hospital
    PACS destination (with a C-ECHO pre-flight check), approve user-
    submitted case-deletion requests, and browse the audit log — all
    scoped to their tenant.

Endpoints (per contracts/api-openapi.yaml §admin):
    GET  /admin/tenants/me                      — tenant details
    GET  /admin/users                           — list tenant users
    POST /admin/users/invite                    — 72h JWT invite → SES
    POST /admin/users/{id}/suspend              — soft-suspend
    PUT  /admin/pacs-destination                — save PACS dest (+C-ECHO)
    POST /admin/pacs-destination/echo           — ping PACS (C-ECHO)
    POST /admin/studies/{id}/delete-request     — approve deletion
    GET  /admin/audit                           — filterable audit log
    POST /admin/analyses/{id}/override-coverage — FR-006a override

Every state-changing route:
    1. Is gated by `@require_permission(...)` (T284).
    2. Emits a FHIR AuditEvent via `AuditChainWriter` (T285).
    3. Returns `X-LiverRa-Audit-Seq` header when audit is wired.

Cross-refs:
    - spec.md §FR-039 (admin ops), §FR-046 (deletion), §FR-006a (coverage
      override), §FR-032a (tenant isolation).
    - research.md §A.5 (SES notifications).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..middleware.require_permission import require_permission
from ..services.admin.case_deletion import CaseDeletionService
from ..services.admin.invite_service import InviteService
from ..services.errors.catalog import ErrorSlug, ProblemDetailException
from ..services.notifications.ses_adapter import SESAdapter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class TenantResponse(BaseModel):
    id: UUID
    name: str
    locale_default: str = "en"
    pacs_destination: Optional[dict[str, Any]] = None
    allow_partial_coverage_override: bool = False


class UserRow(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str
    role: str
    locale_preference: str = "en"
    suspended: bool = False
    ruo_accepted_at: Optional[datetime] = None
    mfa_enrolled_at: Optional[datetime] = None
    last_active_at: Optional[datetime] = None


class InviteUserRequest(BaseModel):
    email: EmailStr
    role: str = Field(
        ..., description="One of hpb_surgeon, radiologist, fellow, ops, compliance, dpo"
    )
    display_name: str
    locale_preference: str = "en"


class InviteUserResponse(BaseModel):
    invite_id: UUID
    expires_at: datetime


class PacsDestinationRequest(BaseModel):
    ae_title: str
    host: str
    port: int = Field(..., ge=1, le=65535)
    use_tls: bool = False
    cert_fingerprint: Optional[str] = None


class PacsDestinationResponse(BaseModel):
    destination: PacsDestinationRequest
    cecho_round_trip_ms: int


class CEchoResponse(BaseModel):
    reachable: bool
    round_trip_ms: Optional[int] = None
    scanner_ae_responded: Optional[str] = None
    error: Optional[str] = Field(None, description="PHI-scrubbed error message.")


class AuditEventSummary(BaseModel):
    id: UUID
    sequence_no: int
    category: str
    recorded: datetime
    actor: Optional[str] = None
    outcome: str = "success"
    summary: Optional[str] = None


class OverrideCoverageRequest(BaseModel):
    reason: str = Field(..., min_length=10, max_length=500)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _emit_audit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    tenant_id: UUID,
    actor: Optional[str],
    entity_ref: Optional[str] = None,
    extra: Optional[dict[str, Any]] = None,
) -> Optional[int]:
    """Best-effort AuditChainWriter append — T285."""
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:
        logger.debug("AuditChainWriter unavailable; skip %s audit", category)
        return None

    writer: AuditChainWriter = (
        getattr(request.app.state, "audit_chain_writer", None) or AuditChainWriter()
    )
    event: dict[str, Any] = {
        "resourceType": "AuditEvent",
        "id": str(uuid4()),
        "category": category,
        "recorded": datetime.now(timezone.utc).isoformat(),
        "agent": [{"who": {"reference": actor} if actor else None}],
    }
    if entity_ref:
        event["entity"] = [{"what": {"reference": entity_ref}}]
    if extra:
        event["extension"] = [{"url": "liverra:extra", "valueString": str(extra)}]
    try:
        row = await writer.write(event, tenant_id, session)
        return row.sequence_no
    except Exception as exc:  # noqa: BLE001
        logger.exception("audit write failed for %s: %s", category, exc)
        raise


def _set_audit_header(response: Response, seq: Optional[int]) -> None:
    if seq is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq)


def _actor(request: Request) -> Optional[str]:
    user = getattr(request.state, "user", None)
    if user is None:
        return None
    uid = getattr(user, "id", None) or (user.get("id") if isinstance(user, dict) else None)
    return str(uid) if uid else None


def _tenant_uuid(request: Request) -> UUID:
    tid = getattr(request.state, "tenant_id", None)
    if tid is None:
        raise ProblemDetailException(
            ErrorSlug.UNAUTHENTICATED,
            status.HTTP_401_UNAUTHORIZED,
            "Missing tenant context.",
        )
    return UUID(str(tid))


# ---------------------------------------------------------------------------
# Tenants / users
# ---------------------------------------------------------------------------


@router.get("/tenants/me", response_model=TenantResponse)
@require_permission("admin.view_audit")
async def get_current_tenant(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> TenantResponse:
    tid = _tenant_uuid(request)
    result = await session.execute(
        text(
            """
            SELECT id, name, locale_default, pacs_destination,
                   allow_partial_coverage_override
            FROM tenant
            WHERE id = :tid
            """
        ),
        {"tid": str(tid)},
    )
    row = result.mappings().first()
    if not row:
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Tenant not found.",
        )
    return TenantResponse(
        id=row["id"],
        name=row["name"],
        locale_default=row.get("locale_default") or "en",
        pacs_destination=row.get("pacs_destination"),
        allow_partial_coverage_override=bool(
            row.get("allow_partial_coverage_override") or False
        ),
    )


@router.get("/users", response_model=list[UserRow])
@require_permission("admin.view_audit")
async def list_users(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> list[UserRow]:
    tid = _tenant_uuid(request)
    result = await session.execute(
        text(
            """
            SELECT id, email, display_name, role, locale_preference,
                   suspended_at IS NOT NULL AS suspended,
                   ruo_accepted_at, mfa_enrolled_at, last_active_at
            FROM "user"
            WHERE tenant_id = :tid
            ORDER BY display_name ASC
            """
        ),
        {"tid": str(tid)},
    )
    return [UserRow(**dict(r)) for r in result.mappings()]


@router.post(
    "/users/invite",
    response_model=InviteUserResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@require_permission("admin.invite_user")
async def invite_user(
    body: InviteUserRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> InviteUserResponse:
    """T433: create 72h JWT invite + send localized email via SES."""
    tid = _tenant_uuid(request)
    actor = _actor(request)

    invite_service = InviteService.from_app_state(request.app.state)
    invite = await invite_service.create_invite(
        session=session,
        tenant_id=tid,
        email=body.email,
        role=body.role,
        display_name=body.display_name,
        locale=body.locale_preference,
        invited_by=actor,
    )

    ses = SESAdapter.from_app_state(request.app.state)
    await ses.send(
        session=session,
        to=body.email,
        template="invite",
        locale=body.locale_preference,
        ctx={
            "display_name": body.display_name,
            "accept_url": invite.accept_url,
            "expires_at": invite.expires_at.isoformat(),
            "tenant_id": str(tid),
        },
    )

    seq = await _emit_audit(
        request,
        session,
        category="admin_invite",
        tenant_id=tid,
        actor=actor,
        entity_ref=f"Invite/{invite.invite_id}",
        extra={"email_hash": invite.email_hash, "role": body.role},
    )
    _set_audit_header(response, seq)
    return InviteUserResponse(invite_id=invite.invite_id, expires_at=invite.expires_at)


@router.post(
    "/users/{user_id}/suspend", status_code=status.HTTP_204_NO_CONTENT
)
@require_permission("admin.suspend_user")
async def suspend_user(
    user_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> Response:
    tid = _tenant_uuid(request)
    actor = _actor(request)
    result = await session.execute(
        text(
            """
            UPDATE "user"
            SET suspended_at = now()
            WHERE id = :uid AND tenant_id = :tid AND suspended_at IS NULL
            RETURNING id
            """
        ),
        {"uid": str(user_id), "tid": str(tid)},
    )
    if not result.first():
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "User not found or already suspended.",
        )
    await session.commit()
    seq = await _emit_audit(
        request,
        session,
        category="admin_suspend_user",
        tenant_id=tid,
        actor=actor,
        entity_ref=f"User/{user_id}",
    )
    _set_audit_header(response, seq)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# PACS destination
# ---------------------------------------------------------------------------


@router.put("/pacs-destination", response_model=PacsDestinationResponse)
@require_permission("admin.configure_pacs")
async def put_pacs_destination(
    body: PacsDestinationRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> PacsDestinationResponse:
    """Save tenant PACS destination — requires a successful C-ECHO first."""
    tid = _tenant_uuid(request)
    actor = _actor(request)

    # Pre-flight C-ECHO (T432 wiring).
    from ..services.pacs_cecho import ping as cecho_ping

    echo = await cecho_ping(
        ae_title=body.ae_title,
        host=body.host,
        port=body.port,
        use_tls=body.use_tls,
        cert_fingerprint=body.cert_fingerprint,
    )
    if not echo.reachable:
        raise ProblemDetailException(
            ErrorSlug.PACS_UNREACHABLE,
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"PACS pre-flight C-ECHO failed: {echo.error or 'unreachable'}",
        )

    await session.execute(
        text(
            """
            UPDATE tenant
            SET pacs_destination = :dest
            WHERE id = :tid
            """
        ),
        {
            "dest": body.model_dump_json(),
            "tid": str(tid),
        },
    )
    await session.commit()

    seq = await _emit_audit(
        request,
        session,
        category="admin_configure_pacs",
        tenant_id=tid,
        actor=actor,
        extra={"ae_title": body.ae_title, "host": body.host, "port": body.port},
    )
    _set_audit_header(response, seq)
    return PacsDestinationResponse(
        destination=body,
        cecho_round_trip_ms=echo.round_trip_ms or 0,
    )


@router.post("/pacs-destination/echo", response_model=CEchoResponse)
@require_permission("admin.cecho_pacs")
async def echo_pacs_destination(
    request: Request,
    session: AsyncSession = Depends(get_db),
    body: Optional[PacsDestinationRequest] = None,
) -> CEchoResponse:
    """T432: test-ping the tenant PACS (or an ad-hoc target supplied in body)."""
    tid = _tenant_uuid(request)

    # If body missing, load stored destination.
    if body is None:
        r = await session.execute(
            text("SELECT pacs_destination FROM tenant WHERE id = :tid"),
            {"tid": str(tid)},
        )
        row = r.mappings().first()
        dest = (row or {}).get("pacs_destination") or {}
        if not dest:
            raise ProblemDetailException(
                ErrorSlug.NOT_FOUND,
                status.HTTP_404_NOT_FOUND,
                "No PACS destination configured for this tenant.",
            )
        body = PacsDestinationRequest(**dest)

    from ..services.pacs_cecho import ping as cecho_ping

    echo = await cecho_ping(
        ae_title=body.ae_title,
        host=body.host,
        port=body.port,
        use_tls=body.use_tls,
        cert_fingerprint=body.cert_fingerprint,
    )
    return CEchoResponse(
        reachable=echo.reachable,
        round_trip_ms=echo.round_trip_ms,
        scanner_ae_responded=echo.scanner_ae_responded,
        error=echo.error,
    )


# ---------------------------------------------------------------------------
# Case deletion approval (FR-046)
# ---------------------------------------------------------------------------


@router.post("/studies/{study_id}/delete-request")
@require_permission("admin.approve_deletion")
async def approve_delete_request(
    study_id: UUID,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """T434: approve a user-submitted study-deletion request (soft-delete)."""
    tid = _tenant_uuid(request)
    actor = _actor(request)
    if actor is None:
        raise ProblemDetailException(
            ErrorSlug.UNAUTHENTICATED,
            status.HTTP_401_UNAUTHORIZED,
            "Missing approver identity.",
        )

    svc = CaseDeletionService(session=session)
    outcome = await svc.approve(
        request_id=study_id, approver_id=UUID(actor), tenant_id=tid
    )

    seq = await _emit_audit(
        request,
        session,
        category="admin_approve_deletion",
        tenant_id=tid,
        actor=actor,
        entity_ref=f"Study/{study_id}",
        extra={"affected_analyses": outcome.affected_analyses},
    )
    _set_audit_header(response, seq)
    return {
        "study_id": str(study_id),
        "soft_deleted_at": outcome.soft_deleted_at.isoformat(),
        "affected_analyses": outcome.affected_analyses,
    }


# ---------------------------------------------------------------------------
# Audit browser
# ---------------------------------------------------------------------------


@router.get("/audit", response_model=list[AuditEventSummary])
@require_permission("admin.view_audit")
async def list_audit(
    request: Request,
    session: AsyncSession = Depends(get_db),
    from_: Optional[datetime] = Query(None, alias="from"),
    to: Optional[datetime] = Query(None),
    category: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
) -> list[AuditEventSummary]:
    tid = _tenant_uuid(request)
    filters = ["tenant_id = :tid"]
    params: dict[str, Any] = {"tid": str(tid), "lim": limit}
    if from_:
        filters.append("recorded >= :from_")
        params["from_"] = from_
    if to:
        filters.append("recorded <= :to_")
        params["to_"] = to
    if category:
        filters.append("category = :cat")
        params["cat"] = category

    result = await session.execute(
        text(
            f"""
            SELECT id, sequence_no, category, recorded, actor_ref AS actor,
                   outcome, summary
            FROM audit_event
            WHERE {' AND '.join(filters)}
            ORDER BY sequence_no DESC
            LIMIT :lim
            """
        ),
        params,
    )
    return [AuditEventSummary(**dict(r)) for r in result.mappings()]


# ---------------------------------------------------------------------------
# FR-006a — admin-only coverage override (T437 companion)
# ---------------------------------------------------------------------------


@router.post("/analyses/{analysis_id}/override-coverage")
@require_permission("admin.coverage_override", step_up=True)
async def override_coverage(
    analysis_id: UUID,
    body: OverrideCoverageRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Tenant admin can override a `coverage_insufficient` rejection.

    Invariants (FR-006a):
      - Target analysis must exist within this tenant.
      - Override reason is persisted to the analysis + stamped on every
        downstream audit event.
      - Emits an `admin_override_coverage` AuditEvent.
    """
    tid = _tenant_uuid(request)
    actor = _actor(request)
    result = await session.execute(
        text(
            """
            UPDATE analysis
            SET coverage_override_reason = :reason,
                coverage_override_by = :by,
                coverage_override_at = now()
            WHERE id = :aid AND tenant_id = :tid
            RETURNING id
            """
        ),
        {
            "reason": body.reason,
            "by": actor,
            "aid": str(analysis_id),
            "tid": str(tid),
        },
    )
    if not result.first():
        raise ProblemDetailException(
            ErrorSlug.NOT_FOUND,
            status.HTTP_404_NOT_FOUND,
            "Analysis not found.",
        )
    await session.commit()
    seq = await _emit_audit(
        request,
        session,
        category="admin_override_coverage",
        tenant_id=tid,
        actor=actor,
        entity_ref=f"Analysis/{analysis_id}",
        extra={"reason_len": len(body.reason)},
    )
    _set_audit_header(response, seq)
    return {"analysis_id": str(analysis_id), "overridden_at": datetime.now(timezone.utc).isoformat()}
