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
        """Build from FastAPI app.state (injected by startup) with env fallback."""
        svc = getattr(state, "invite_service", None)
        if isinstance(svc, cls):
            return svc
        secret = (
            getattr(state, "invite_jwt_secret", None)
            or os.environ.get("LIVERRA_INVITE_JWT_SECRET")
        )
        if not secret:
            # Fail loud in regulated environments so a missing env var never
            # silently falls back to a well-known signing key.
            if os.environ.get("LIVERRA_ENV", "development").lower() in (
                "staging",
                "production",
            ):
                raise RuntimeError(
                    "LIVERRA_INVITE_JWT_SECRET must be set in staging/production"
                )
            secret = "dev-invite-secret-CHANGE-ME"  # dev fallback only
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
    # Verify
    # ------------------------------------------------------------------

    def verify_token(self, token: str) -> InvitePayload:
        """Return parsed payload. Raises `jwt.PyJWTError` on failure."""
        payload = jwt.decode(
            token,
            self._secret,
            algorithms=[JWT_ALG],
            audience="invite",
            options={"require": ["exp", "iat", "sub"]},
        )
        return InvitePayload(
            invite_id=UUID(payload["invite_id"]),
            tenant_id=UUID(payload["tenant_id"]),
            email=payload["email"],
            role=payload["role"],
            display_name=payload.get("display_name", ""),
            locale=payload.get("locale", "en"),
        )
