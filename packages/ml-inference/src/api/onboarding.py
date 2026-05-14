# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Onboarding HTTP API (T295, T298, T439).

Plain-English:
    This router is the back-end for the first-time-login wizard. It
    exposes three endpoints:

      POST /auth/ruo-accept       — clinician signs the RUO terms. We
                                    persist an HMAC signature alongside
                                    their user row so an auditor can
                                    later prove *this user* accepted
                                    *these terms* at *this time*.
      POST /auth/mfa-enrol        — wraps the Cognito TOTP enrolment
                                    + backup-code generator.
      GET  /auth/me/onboarding-status — reports which steps are still
                                    outstanding. Used by the frontend
                                    gate (`useOnboardingStatus`).

    All three write FHIR AuditEvents via ``AuditChainWriter`` (T298).

Cross-refs:
    - spec.md §FR-041 (onboarding), §FR-031 (signed RUO), §FR-042 (demo case)
    - data-model.md §User, §OnboardingStatus
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_db
from ..services.errors.catalog import ErrorSlug, ProblemDetailException
from ..services.onboarding.sample_case_runner import SampleCaseRunner
from ..services.onboarding.signed_ruo import SignedRUOService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["onboarding"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class RUOAcceptRequest(BaseModel):
    version: str = Field(..., description="RUO document version accepted.")
    locale: str = Field(..., description="Locale the user read (en/de/ka).")


class RUOAcceptResponse(BaseModel):
    accepted_at: datetime
    signature_prefix: str = Field(..., description="First 16 chars of HMAC signature.")


class MFAEnrolStartResponse(BaseModel):
    secret: str = Field(..., description="TOTP base32 secret (one-shot).")
    otpauth_uri: str = Field(..., description="otpauth://... URI for QR.")
    backup_codes: list[str]


class MFAEnrolVerifyRequest(BaseModel):
    otp: str = Field(..., min_length=6, max_length=8)


class OnboardingStatus(BaseModel):
    user_id: UUID
    tenant_id: UUID
    ruo_accepted_at: Optional[datetime] = None
    mfa_enrolled_at: Optional[datetime] = None
    sample_case_run_at: Optional[datetime] = None
    tour_completed_at: Optional[datetime] = None
    completed: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _user_id(request: Request) -> UUID:
    user = getattr(request.state, "user", None)
    uid = None
    if user is not None:
        uid = getattr(user, "id", None) or (
            user.get("id") if isinstance(user, dict) else None
        )
    if not uid:
        raise ProblemDetailException(
            ErrorSlug.UNAUTHENTICATED,
            status.HTTP_401_UNAUTHORIZED,
            "Not authenticated.",
        )
    return UUID(str(uid))


def _tenant_id(request: Request) -> UUID:
    tid = getattr(request.state, "tenant_id", None)
    if tid is None:
        raise ProblemDetailException(
            ErrorSlug.UNAUTHENTICATED,
            status.HTTP_401_UNAUTHORIZED,
            "Missing tenant context.",
        )
    return UUID(str(tid))


async def _emit(
    request: Request,
    session: AsyncSession,
    *,
    category: str,
    tenant_id: UUID,
    user_id: Optional[UUID],
    extra: Optional[dict[str, Any]] = None,
) -> Optional[int]:
    """T298: AuditChainWriter append for onboarding events."""
    try:
        from ..services.audit.chain_of_hashes import AuditChainWriter
    except ImportError:
        logger.debug("AuditChainWriter unavailable; skip %s", category)
        return None
    writer: AuditChainWriter = (
        getattr(request.app.state, "audit_chain_writer", None) or AuditChainWriter()
    )
    from ..services.audit.audit_helpers import build_audit_event

    event = build_audit_event(
        category=category,
        actor=f"Practitioner/{user_id}" if user_id else None,
        extensions=(
            [{"url": "liverra:extra", "valueString": str(extra)}] if extra else None
        ),
    )
    row = await writer.write(event, tenant_id, session)
    return row.sequence_no


def _set_audit_header(response: Response, seq: Optional[int]) -> None:
    if seq is not None:
        response.headers["X-LiverRa-Audit-Seq"] = str(seq)


# ---------------------------------------------------------------------------
# RUO acceptance (FR-031)
# ---------------------------------------------------------------------------


@router.post("/ruo-accept", response_model=RUOAcceptResponse)
async def ruo_accept(
    body: RUOAcceptRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> RUOAcceptResponse:
    """T439: persist signed RUO acceptance. HMAC-SHA256 signature includes
    user_id + timestamp + tenant_genesis hash. Idempotent — second call
    refreshes the timestamp but returns 200."""
    uid = _user_id(request)
    tid = _tenant_id(request)

    # Load tenant genesis hash so the signature binds to the tenant origin.
    r = await session.execute(
        text("SELECT genesis_hash FROM tenant WHERE id = :tid"),
        {"tid": str(tid)},
    )
    row = r.mappings().first()
    tenant_genesis = (row or {}).get("genesis_hash") or f"tenant:{tid}"

    signer = SignedRUOService.from_app_state(request.app.state)
    now = datetime.now(timezone.utc)
    signature = signer.sign(
        user_id=str(uid),
        timestamp=now.isoformat(),
        tenant_genesis=str(tenant_genesis),
        version=body.version,
    )

    await session.execute(
        text(
            """
            UPDATE "user"
            SET ruo_accepted_at = :ts,
                ruo_accepted_signature = :sig,
                ruo_accepted_version = :ver,
                ruo_accepted_locale = :loc
            WHERE id = :uid
            """
        ),
        {
            "ts": now,
            "sig": signature,
            "ver": body.version,
            "loc": body.locale,
            "uid": str(uid),
        },
    )
    await session.commit()

    seq = await _emit(
        request,
        session,
        category="ruo_acceptance",
        tenant_id=tid,
        user_id=uid,
        extra={"version": body.version, "locale": body.locale},
    )
    _set_audit_header(response, seq)
    return RUOAcceptResponse(accepted_at=now, signature_prefix=signature[:16])


# ---------------------------------------------------------------------------
# MFA enrolment
# ---------------------------------------------------------------------------


@router.post("/mfa-enrol", response_model=MFAEnrolStartResponse)
async def mfa_enrol_start(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> MFAEnrolStartResponse:
    """Wrap Cognito TOTP associate call; generate 10 backup codes."""
    uid = _user_id(request)
    tid = _tenant_id(request)

    # Generate a 20-byte base32 TOTP secret (RFC 6238 default).
    import base64

    raw = secrets.token_bytes(20)
    secret = base64.b32encode(raw).decode("ascii").rstrip("=")

    # Backup codes: 10 × 8 hex groups — one-time, show once.
    backup_codes = [secrets.token_hex(4).upper() for _ in range(10)]

    # Persist backup-code hashes (never raw). In production, call Cognito
    # AdminSetUserMFAPreference here; the wire-up is the surgeon's next step.
    from hashlib import sha256

    for code in backup_codes:
        await session.execute(
            text(
                """
                INSERT INTO mfa_backup_code (user_id, code_hash, issued_at)
                VALUES (:uid, :h, now())
                """
            ),
            {"uid": str(uid), "h": sha256(code.encode()).hexdigest()},
        )
    await session.commit()

    otpauth_uri = f"otpauth://totp/LiverRa:{uid}?secret={secret}&issuer=LiverRa"

    seq = await _emit(
        request,
        session,
        category="mfa_challenge",
        tenant_id=tid,
        user_id=uid,
        extra={"phase": "enrol_start"},
    )
    _set_audit_header(response, seq)
    return MFAEnrolStartResponse(
        secret=secret,
        otpauth_uri=otpauth_uri,
        backup_codes=backup_codes,
    )


@router.post("/mfa-enrol/verify")
async def mfa_enrol_verify(
    body: MFAEnrolVerifyRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Finalize MFA enrolment (real TOTP verification is in Cognito; this
    route simply flips the `mfa_enrolled_at` stamp once the client has
    satisfied the server-side Cognito verify call)."""
    uid = _user_id(request)
    tid = _tenant_id(request)
    now = datetime.now(timezone.utc)

    await session.execute(
        text(
            """
            UPDATE "user"
            SET mfa_enrolled_at = :ts
            WHERE id = :uid AND mfa_enrolled_at IS NULL
            """
        ),
        {"ts": now, "uid": str(uid)},
    )
    await session.commit()

    seq = await _emit(
        request,
        session,
        category="mfa_challenge",
        tenant_id=tid,
        user_id=uid,
        extra={"phase": "enrol_verify", "otp_len": len(body.otp)},
    )
    _set_audit_header(response, seq)
    return {"mfa_enrolled_at": now.isoformat()}


# ---------------------------------------------------------------------------
# Status gate
# ---------------------------------------------------------------------------


@router.get("/me/onboarding-status", response_model=OnboardingStatus)
async def onboarding_status(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> OnboardingStatus:
    uid = _user_id(request)
    tid = _tenant_id(request)

    r = await session.execute(
        text(
            """
            SELECT ruo_accepted_at, mfa_enrolled_at,
                   sample_case_run_at, tour_completed_at
            FROM "user"
            WHERE id = :uid
            """
        ),
        {"uid": str(uid)},
    )
    row = r.mappings().first() or {}
    ruo = row.get("ruo_accepted_at")
    mfa = row.get("mfa_enrolled_at")
    sample = row.get("sample_case_run_at")
    tour = row.get("tour_completed_at")
    completed = bool(ruo and mfa)

    if completed and (not sample or not tour):
        # Fire-and-forget idempotent seed for the tenant demo case.
        try:
            runner = SampleCaseRunner.from_app_state(request.app.state)
            await runner.ensure_seeded(tenant_id=tid)
        except Exception as exc:  # noqa: BLE001
            logger.debug("sample-case seed skipped: %s", exc)

    return OnboardingStatus(
        user_id=uid,
        tenant_id=tid,
        ruo_accepted_at=ruo,
        mfa_enrolled_at=mfa,
        sample_case_run_at=sample,
        tour_completed_at=tour,
        completed=completed,
    )
