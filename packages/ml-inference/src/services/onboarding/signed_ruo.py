# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Signed-RUO service (T296).

Plain-English:
    When a clinician ticks "I accept the Research Use Only terms", we
    don't just store a boolean — we HMAC-sign ``(user_id | timestamp |
    tenant_genesis | version)`` with a server-side secret so an auditor
    can later verify the exact record. The signature is stored on the
    User row and stamped on the audit event.

Key rotation: we accept a primary + fallback secret so keys can be
rotated without invalidating past acceptances. ``verify()`` tries each
secret until one matches.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SignedRUOService:
    """HMAC-SHA256 signer for the RUO acceptance record."""

    primary_secret: str
    fallback_secrets: tuple[str, ...] = ()

    @classmethod
    def from_app_state(cls, state: Any) -> "SignedRUOService":
        existing = getattr(state, "signed_ruo_service", None)
        if isinstance(existing, cls):
            return existing
        primary = (
            getattr(state, "ruo_signing_secret", None)
            or os.environ.get("LIVERRA_RUO_SIGNING_SECRET")
        )
        if not primary:
            # Fail loud in regulated environments so a missing env var never
            # silently falls back to a well-known signing key.
            if os.environ.get("LIVERRA_ENV", "development").lower() in (
                "staging",
                "production",
            ):
                raise RuntimeError(
                    "LIVERRA_RUO_SIGNING_SECRET must be set in staging/production"
                )
            primary = "dev-ruo-secret-CHANGE-ME"  # dev fallback only
        fallback_env = os.environ.get("LIVERRA_RUO_SIGNING_SECRET_FALLBACK", "")
        fallback = tuple(s for s in fallback_env.split(",") if s)
        return cls(primary_secret=primary, fallback_secrets=fallback)

    @staticmethod
    def _build_payload(
        *, user_id: str, timestamp: str, tenant_genesis: str, version: str
    ) -> bytes:
        # Field separator `|` avoids collisions — RUO version MUST NOT contain
        # `|`; we enforce that at the caller.
        return f"{user_id}|{timestamp}|{tenant_genesis}|{version}".encode("utf-8")

    def sign(
        self,
        *,
        user_id: str,
        timestamp: str,
        tenant_genesis: str,
        version: str,
    ) -> str:
        payload = self._build_payload(
            user_id=user_id,
            timestamp=timestamp,
            tenant_genesis=tenant_genesis,
            version=version,
        )
        mac = hmac.new(
            self.primary_secret.encode("utf-8"), payload, hashlib.sha256
        ).hexdigest()
        return mac

    def verify(
        self,
        signature: str,
        *,
        user_id: str,
        timestamp: str,
        tenant_genesis: str,
        version: str,
    ) -> bool:
        payload = self._build_payload(
            user_id=user_id,
            timestamp=timestamp,
            tenant_genesis=tenant_genesis,
            version=version,
        )
        for secret in (self.primary_secret, *self.fallback_secrets):
            mac = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
            if hmac.compare_digest(mac, signature):
                return True
        return False
