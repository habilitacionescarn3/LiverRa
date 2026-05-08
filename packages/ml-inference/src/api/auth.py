# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Minimal password-gate auth (production stop-gap until real Cognito).

Plain-English: this exists so we can publish the LiverRa UI on Netlify
without leaving it wide open. A small allowlist of clinician emails +
shared password gives us "private demo for trusted users" — not
enterprise-grade, but appropriate for the staged-rollout posture.

Replace with full Cognito OIDC before clinical pilot per Constitution VI.

Allowlist + password live in env:
    LIVERRA_DEMO_USERS    — comma-separated `email:role` pairs
                             (e.g. "lasha@liverra.local:admin,demo@liverra.local:hpb_surgeon")
    LIVERRA_DEMO_PASSWORD — shared password (HS256-signed JWT returned on success)
    LIVERRA_JWT_SECRET    — HMAC secret for issued JWTs (32+ chars)

Endpoints:
    POST /api/v1/auth/login    — { email, password } → { access_token, expires_at }
    GET  /api/v1/auth/me       — current user from Bearer token (or dev-bypass)

The auth middleware accepts these tokens via the same path it accepts
Cognito tokens (both are HS256/RS256-signed JWTs with `sub` and
`custom:tenant_id` claims).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid5, NAMESPACE_DNS

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger(__name__)

router = APIRouter()

DEV_TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=1, max_length=200)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_at: datetime
    user_id: str
    email: str
    role: str


class MeResponse(BaseModel):
    user: dict
    tenant: dict
    permissions: list[str]


# ---------------------------------------------------------------------------
# Allowlist + JWT helpers
# ---------------------------------------------------------------------------


def _load_allowlist() -> dict[str, str]:
    """Parse LIVERRA_DEMO_USERS into {email: role}.

    Default fallback (dev only): one demo user.
    """
    raw = os.environ.get(
        "LIVERRA_DEMO_USERS",
        "demo@liverra.local:admin,lasha@liverra.local:hpb_surgeon",
    )
    out: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        email, role = entry.split(":", 1)
        out[email.lower().strip()] = role.strip()
    return out


def _password() -> str:
    return os.environ.get("LIVERRA_DEMO_PASSWORD", "livercheck-demo")


def _jwt_secret() -> bytes:
    secret = os.environ.get(
        "LIVERRA_JWT_SECRET",
        "dev-only-not-for-production-replace-with-32-byte-secret",
    )
    return secret.encode("utf-8")


def _b64url(data: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    import base64

    pad = (4 - len(s) % 4) % 4
    return base64.urlsafe_b64decode(s + "=" * pad)


def _issue_jwt(email: str, role: str) -> tuple[str, datetime]:
    """Issue an HS256-signed JWT with claims compatible with AuthMiddleware."""
    user_id = uuid5(NAMESPACE_DNS, f"liverra:{email}").hex
    now = int(time.time())
    exp = now + 12 * 3600  # 12 hours
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "email": email,
        "custom:tenant_id": str(DEV_TENANT_ID),
        "role": role,
        "iat": now,
        "exp": exp,
        "auth_time": now,
        "iss": "liverra-password-gate",
    }
    h = _b64url(json.dumps(header, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    msg = f"{h}.{p}".encode()
    sig = hmac.new(_jwt_secret(), msg, hashlib.sha256).digest()
    s = _b64url(sig)
    token = f"{h}.{p}.{s}"
    return token, datetime.fromtimestamp(exp, tz=timezone.utc)


def _verify_jwt(token: str) -> Optional[dict]:
    """Verify an HS256 JWT issued by `_issue_jwt`. Returns payload or None."""
    try:
        h_b64, p_b64, s_b64 = token.split(".")
    except ValueError:
        return None
    msg = f"{h_b64}.{p_b64}".encode()
    expected = hmac.new(_jwt_secret(), msg, hashlib.sha256).digest()
    actual = _b64url_decode(s_b64)
    if not hmac.compare_digest(expected, actual):
        return None
    try:
        payload = json.loads(_b64url_decode(p_b64))
    except (json.JSONDecodeError, ValueError):
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/login", response_model=LoginResponse, status_code=status.HTTP_200_OK)
async def login(body: LoginRequest) -> LoginResponse:
    """Issue a JWT for an allowlisted user + correct shared password."""
    email = body.email.lower().strip()
    allowlist = _load_allowlist()
    if email not in allowlist:
        logger.info("login: denied for unknown email %s", email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    if not hmac.compare_digest(body.password, _password()):
        # The format-string below contains the word "credential" which
        # trips Semgrep's keyword heuristic; the actual log argument is
        # just the email — no secret material is recorded.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.info("login: invalid credential for %s", email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    role = allowlist[email]
    token, expires_at = _issue_jwt(email, role)
    return LoginResponse(
        access_token=token,
        expires_at=expires_at,
        user_id=uuid5(NAMESPACE_DNS, f"liverra:{email}").hex,
        email=email,
        role=role,
    )


@router.get("/me", response_model=MeResponse)
async def me(request: Request) -> MeResponse:
    """Return the current user — populated by AuthMiddleware (dev bypass or
    a verified JWT). If the token isn't recognized, returns dev fallback.
    """
    user = getattr(request.state, "user", None)
    tenant_id = getattr(request.state, "tenant_id", DEV_TENANT_ID)
    if user is None:
        # Fall back to dev defaults so the UI doesn't crash.
        user = {
            "id": "00000000-0000-0000-0000-0000000000aa",
            "email": "dev@liverra.local",
            "permissions": [],
            "groups": [],
        }
    return MeResponse(
        user={
            "id": user.get("id"),
            "email": user.get("email"),
            "name": user.get("email", "Dev User").split("@")[0].title(),
        },
        tenant={"id": str(tenant_id)},
        permissions=list(user.get("permissions", [])),
    )
