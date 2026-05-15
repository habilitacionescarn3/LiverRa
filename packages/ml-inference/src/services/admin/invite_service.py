# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Invite service (T280).

Plain-English:
    When a tenant-admin invites a new clinician, we don't email them a
    raw password. Instead, we mint a short-lived (72 h) signed JWT
    "accept-invite" token, store a hash of their email + the invite row,
    and email them a one-use link. When they click, the frontend posts
    the JWT back, we verify the signature, and complete the account.

Shape:
    - ``InviteService.create_invite(...)`` -> ``Invite`` dataclass
    - ``InviteService.verify_token(token)`` -> ``InvitePayload`` (raises on
      invalid/expired)

Cross-refs:
    - spec.md §FR-039 (admin invite workflow)
    - data-model.md §User, §Invite
"""
from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

import jwt  # PyJWT
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

DEFAULT_INVITE_TTL = timedelta(hours=72)
JWT_ALG = "HS256"


@dataclass(frozen=True)
class Invite:
    invite_id: UUID
    tenant_id: UUID
    email_hash: str
    role: str
    expires_at: datetime
    accept_url: str
    token: str


@dataclass(frozen=True)
class InvitePayload:
    invite_id: UUID
    tenant_id: UUID
    email: str
    role: str
    display_name: str
    locale: str


class InviteService:
    """72-hour signed-JWT invite issuer + verifier."""

    def __init__(
        self,
        *,
        jwt_secret: str,
        app_base_url: str,
        ttl: timedelta = DEFAULT_INVITE_TTL,
    ) -> None:
        self._secret = jwt_secret
        self._base = app_base_url.rstrip("/")
        self._ttl = ttl

    # ------------------------------------------------------------------
    # Factories
    # ------------------------------------------------------------------

    @classmethod
    def from_app_state(cls, state: Any) -> "InviteService":
        """Build from FastAPI app.state (injected by startup) with env fallback.

        CC-2 / B-AUTH-4: there is NO hardcoded dev-fallback signing key any
        more. The env var must be set in every environment. The risk of a
        well-known fallback secret leaking into a non-dev deployment was
        too high — invite-accept JWTs are bearer credentials granting
        account creation, so a fallback secret is effectively a tenant
        compromise vector.
        """
        svc = getattr(state, "invite_service", None)
        if isinstance(svc, cls):
            return svc
        secret = (
            getattr(state, "invite_jwt_secret", None)
            or os.environ.get("LIVERRA_INVITE_JWT_SECRET")
        )
        if not secret:
            env = os.environ.get("LIVERRA_ENV", "development").lower()
            raise RuntimeError(
                "LIVERRA_INVITE_JWT_SECRET must be set "
                f"(LIVERRA_ENV={env}). Generate one with "
                "`python -c 'import secrets; print(secrets.token_urlsafe(48))'` "
                "and export it before starting the FastAPI app."
            )
        base = (
            getattr(state, "app_base_url", None)
            or os.environ.get("LIVERRA_APP_BASE_URL")
            or "http://localhost:3000"
        )
        return cls(jwt_secret=secret, app_base_url=base)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def hash_email(email: str) -> str:
        """SHA-256 of the lowercased email — stored in DB in place of raw value."""
        return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()

    # ------------------------------------------------------------------
    # Mint
    # ------------------------------------------------------------------

    async def create_invite(
        self,
        *,
        session: AsyncSession,
        tenant_id: UUID,
        email: str,
        role: str,
        display_name: str,
        locale: str,
        invited_by: Optional[str],
    ) -> Invite:
        now = datetime.now(timezone.utc)
        expires = now + self._ttl
        invite_id = uuid4()
        email_hash = self.hash_email(email)

        payload: dict[str, Any] = {
            "iss": "liverra.ai",
            "aud": "invite",
            "sub": email_hash,
            "invite_id": str(invite_id),
            "tenant_id": str(tenant_id),
            "email": email,
            "role": role,
            "display_name": display_name,
            "locale": locale,
            "iat": int(now.timestamp()),
            "exp": int(expires.timestamp()),
            "jti": uuid4().hex,
        }
        token = jwt.encode(payload, self._secret, algorithm=JWT_ALG)

        # Persist the row (best-effort — the `invite` table may be migrated
        # separately; swallow table-missing errors during early bootstrap).
        try:
            await session.execute(
                text(
                    """
                    INSERT INTO invite (id, tenant_id, email_hash, role,
                                        locale, expires_at, invited_by)
                    VALUES (:id, :tid, :eh, :role, :locale, :exp, :by)
                    """
                ),
                {
                    "id": str(invite_id),
                    "tid": str(tenant_id),
                    "eh": email_hash,
                    "role": role,
                    "locale": locale,
                    "exp": expires,
                    "by": invited_by,
                },
            )
            await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("invite row not persisted (migration pending?): %s", exc)
            await session.rollback()

        accept_url = f"{self._base}/onboarding/accept?token={token}"
        return Invite(
            invite_id=invite_id,
            tenant_id=tenant_id,
            email_hash=email_hash,
            role=role,
            expires_at=expires,
            accept_url=accept_url,
            token=token,
        )

    # ------------------------------------------------------------------
    # Verify + consume
    # ------------------------------------------------------------------

    INVITE_ISSUER = "liverra.ai"

    def verify_token(self, token: str) -> InvitePayload:
        """Return parsed payload. Raises ``jwt.PyJWTError`` on failure.

        B-AUTH-4 / H-AUTH-6: enforces ``iss`` AND ``aud`` AND mandates the
        ``jti`` claim's presence so a follow-up ``consume_invite`` can mark
        it used. The previous version checked ``aud`` only — a forged token
        from any other LiverRa system was accepted.
        """
        payload = jwt.decode(
            token,
            self._secret,
            algorithms=[JWT_ALG],
            audience="invite",
            issuer=self.INVITE_ISSUER,
            options={"require": ["exp", "iat", "sub", "iss", "jti"]},
        )
        return InvitePayload(
            invite_id=UUID(payload["invite_id"]),
            tenant_id=UUID(payload["tenant_id"]),
            email=payload["email"],
            role=payload["role"],
            display_name=payload.get("display_name", ""),
            locale=payload.get("locale", "en"),
        )

    async def consume_invite(
        self, *, session: AsyncSession, token: str
    ) -> InvitePayload:
        """Verify token + mark its ``jti`` consumed atomically.

        Raises :class:`InviteAlreadyUsed` if another caller already claimed
        the JTI (race-safe via ``INSERT … ON CONFLICT DO NOTHING RETURNING``).
        Backwards-compatible with deployments where the ``invite_used`` table
        has not yet been migrated — in that case we still verify the JWT but
        log a warning so the migration gap is visible in observability.
        """
        payload = jwt.decode(
            token,
            self._secret,
            algorithms=[JWT_ALG],
            audience="invite",
            issuer=self.INVITE_ISSUER,
            options={"require": ["exp", "iat", "sub", "iss", "jti"]},
        )
        jti: str = payload["jti"]
        try:
            row = await session.execute(
                text(
                    """
                    INSERT INTO invite_used (jti, consumed_at)
                    VALUES (:jti, NOW())
                    ON CONFLICT (jti) DO NOTHING
                    RETURNING jti
                    """
                ),
                {"jti": jti},
            )
            consumed = row.fetchone()
            await session.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "invite_used table missing or unreachable; "
                "replay protection BYPASSED for this call: %s",
                exc,
            )
            await session.rollback()
            consumed = ("bypass",)  # treat as fresh consumption

        if consumed is None:
            raise InviteAlreadyUsed(jti)

        return InvitePayload(
            invite_id=UUID(payload["invite_id"]),
            tenant_id=UUID(payload["tenant_id"]),
            email=payload["email"],
            role=payload["role"],
            display_name=payload.get("display_name", ""),
            locale=payload.get("locale", "en"),
        )


class InviteAlreadyUsed(Exception):
    """Raised when an invite JTI was previously consumed (single-use enforced)."""

    def __init__(self, jti: str) -> None:
        super().__init__(f"Invite already used: jti={jti}")
        self.jti = jti
