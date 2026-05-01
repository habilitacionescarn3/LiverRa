"""FastAPI auth middleware — Cognito JWT → request.state (T049).

Every request (except public/system endpoints) MUST carry
``Authorization: Bearer <jwt>``. The middleware:

1. Extracts the bearer token.
2. Validates it via :class:`JwksValidator` (T047).
3. Populates ``request.state``:
   - ``tenant_id`` — UUID from ``custom:tenant_id`` claim.
   - ``user``     — dict ``{id, email, cognito_sub, permissions}``.
   - ``auth_time``— `datetime` for step-up freshness checks.
4. Loads domain permissions from the ``permission_grant`` table, scoped to
   the user's tenant through the RLS session GUC.

Any validation failure yields an ``application/problem+json`` 401 with one
of the slugs:

- ``step-up-required`` — token expired (caller should silently renew).
- ``forbidden``        — signature / issuer / audience / algorithm wrong.

Public routes that bypass the guard: ``/api/v1/system/health``,
``/api/v1/system/version``, ``/docs``, ``/openapi.json``.

Spec reference: T049, plan.md §Authentication.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Awaitable, Callable, Iterable, Optional
from uuid import UUID

from fastapi import Request, Response
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from ..services.auth.jwks_validator import InvalidToken, JwksValidator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROBLEM_JSON = "application/problem+json"

# Endpoints that MUST remain reachable without a valid JWT — system health
# probes, OpenAPI docs. Keep this list short and audited.
DEFAULT_EXCLUDED_PREFIXES: tuple[str, ...] = (
    "/api/v1/system/health",
    "/api/v1/system/version",
    "/api/v1/auth/login",  # password gate — public by design
    "/docs",
    "/redoc",
    "/openapi.json",
    "/favicon.ico",
)


# ---------------------------------------------------------------------------
# Problem+JSON helpers
# ---------------------------------------------------------------------------

def _problem_response(
    *, status_code: int, slug: str, title: str, detail: str,
) -> JSONResponse:
    body = {
        "type": f"https://liverra.ai/errors/{slug}",
        "title": title,
        "status": status_code,
        "slug": slug,
        "detail": detail,
    }
    return JSONResponse(status_code=status_code, content=body, media_type=PROBLEM_JSON)


def _step_up_required_response(reason: str) -> JSONResponse:
    return _problem_response(
        status_code=401,
        slug="step-up-required",
        title="Step-up authentication required",
        detail=reason or "Access token has expired; re-authenticate to continue.",
    )


def _forbidden_response(reason: str) -> JSONResponse:
    return _problem_response(
        status_code=401,
        slug="forbidden",
        title="Invalid credentials",
        detail=reason or "Bearer token is invalid.",
    )


def _missing_token_response() -> JSONResponse:
    return _problem_response(
        status_code=401,
        slug="forbidden",
        title="Authentication required",
        detail="Missing Authorization: Bearer header.",
    )


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

class AuthMiddleware(BaseHTTPMiddleware):
    """Validate Cognito JWT and populate ``request.state``."""

    def __init__(
        self,
        app,  # ASGI app — untyped per Starlette convention
        *,
        validator: Optional[JwksValidator] = None,
        excluded_prefixes: Iterable[str] = DEFAULT_EXCLUDED_PREFIXES,
    ) -> None:
        super().__init__(app)
        # Dev bypass skips validator construction (Cognito env not required).
        bypass_active = os.environ.get("LIVERRA_AUTH_BYPASS", "").lower() in {"1", "true", "yes"}
        if validator is not None:
            self._validator = validator
        elif bypass_active:
            self._validator = None  # never used — dispatch short-circuits
        else:
            self._validator = _build_validator_from_env()
        self._excluded_prefixes = tuple(excluded_prefixes)

    # ------------------------------------------------------------------
    # Entry point
    # ------------------------------------------------------------------

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path

        # Fast-path: CORS preflight + public endpoints bypass auth.
        if request.method == "OPTIONS":
            return await call_next(request)
        if any(path.startswith(p) for p in self._excluded_prefixes):
            return await call_next(request)

        # Local-dev bypass — when LIVERRA_AUTH_BYPASS=true, populate
        # request.state with a synthetic dev tenant + superuser and skip
        # JWT validation entirely. Never enable in production.
        if os.environ.get("LIVERRA_AUTH_BYPASS", "").lower() in {"1", "true", "yes"}:
            _populate_dev_bypass_state(request)
            return await call_next(request)

        # --- 1. Extract bearer token -----------------------------------
        auth_header = request.headers.get("authorization") or request.headers.get(
            "Authorization"
        )
        if not auth_header or not auth_header.lower().startswith("bearer "):
            return _missing_token_response()
        token = auth_header.split(None, 1)[1].strip()

        # --- 2. Validate signature + claims ----------------------------
        try:
            claims = self._validator.validate(token)
        except InvalidToken as exc:
            if exc.reason == "expired":
                return _step_up_required_response(exc.detail or "Token expired")
            return _forbidden_response(exc.detail or exc.reason)
        except Exception as exc:  # noqa: BLE001 — defence in depth
            logger.exception("auth middleware: unexpected validation error: %s", exc)
            return _forbidden_response("Token validation failed")

        # --- 3. Populate request.state ---------------------------------
        tenant_id_raw = claims.get("custom:tenant_id")
        if not tenant_id_raw:
            return _forbidden_response("Token missing custom:tenant_id claim")
        try:
            tenant_id = UUID(str(tenant_id_raw))
        except (ValueError, TypeError):
            return _forbidden_response("custom:tenant_id is not a UUID")

        cognito_sub = claims.get("sub")
        email = claims.get("email")  # often only on ID tokens; may be None
        auth_time_raw = claims.get("auth_time")

        auth_time: Optional[datetime] = None
        if auth_time_raw is not None:
            try:
                auth_time = datetime.fromtimestamp(
                    float(auth_time_raw), tz=timezone.utc
                )
            except (ValueError, TypeError):
                auth_time = None

        # --- 4. Load domain permissions (tenant-scoped) ----------------
        permissions: list[str] = []
        try:
            permissions = await _load_permissions(
                tenant_id=tenant_id, cognito_sub=str(cognito_sub or "")
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "auth middleware: permission load failed for sub=%s tenant=%s: %s",
                cognito_sub, tenant_id, exc,
            )
            permissions = []

        request.state.tenant_id = tenant_id
        request.state.auth_time = auth_time
        request.state.user = {
            "id": cognito_sub,
            "email": email,
            "cognito_sub": cognito_sub,
            "permissions": permissions,
            "groups": list(claims.get("cognito:groups") or []),
        }
        request.state.jwt_claims = claims

        return await call_next(request)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# All permissions defined under @require_permission() across src/api/*.
# Used by the dev-bypass path to grant a superuser.
_DEV_BYPASS_PERMISSIONS: tuple[str, ...] = (
    "admin.approve_deletion", "admin.cecho_pacs", "admin.configure_pacs",
    "admin.coverage_override", "admin.invite_user", "admin.suspend_user",
    "admin.view_audit", "analysis.cancel", "analysis.retry", "analysis.view",
    "compliance.generate_audit_summary", "compliance.spot_check_ruo",
    "compliance.toggle_claim_registry", "compliance.view_mbom",
    "erasure.execute", "ops.case_unstick", "ops.queue_view",
    "report.finalize", "report.pacs_push", "report.pacs_retry",
    "report.retract", "report.view", "review.acquire_seat",
    "review.override_classification", "review.refine_mask",
    "review.reprompt_lesion", "study.upload", "study.view",
)

# Fixed dev-tenant + dev-user UUIDs so the seed script and the middleware
# agree without IPC. Both rows are upserted by tools/seed-dev-tenant.py.
DEV_TENANT_ID = UUID("00000000-0000-0000-0000-000000000001")
DEV_COGNITO_SUB = "00000000-0000-0000-0000-0000000000aa"


def _populate_dev_bypass_state(request: Request) -> None:
    request.state.tenant_id = DEV_TENANT_ID
    request.state.auth_time = datetime.now(timezone.utc)  # always fresh — step-up passes
    request.state.user = {
        "id": DEV_COGNITO_SUB,
        "email": "dev@liverra.local",
        "cognito_sub": DEV_COGNITO_SUB,
        "permissions": list(_DEV_BYPASS_PERMISSIONS),
        "groups": ["liverra-dev"],
    }
    request.state.jwt_claims = {
        "sub": DEV_COGNITO_SUB,
        "email": "dev@liverra.local",
        "custom:tenant_id": str(DEV_TENANT_ID),
        "cognito:groups": ["liverra-dev"],
        "auth_time": int(datetime.now(timezone.utc).timestamp()),
    }


def _build_validator_from_env() -> JwksValidator:
    """Build a JwksValidator from env vars.

    Required env:
      COGNITO_ISSUER_URL   — e.g. https://cognito-idp.eu-central-1.amazonaws.com/<pool>
      COGNITO_AUDIENCE     — app-client ID

    Raising here (import-time) would crash FastAPI at import; instead we
    raise lazily only when the middleware tries to validate a request, so
    tests can instantiate the middleware with a hand-built validator.
    """
    issuer = os.environ.get("COGNITO_ISSUER_URL", "")
    audience = os.environ.get("COGNITO_AUDIENCE", "")
    if not issuer or not audience:
        raise RuntimeError(
            "AuthMiddleware requires COGNITO_ISSUER_URL and COGNITO_AUDIENCE "
            "environment variables (or pass a JwksValidator explicitly)."
        )
    return JwksValidator(issuer_url=issuer, audience=audience)


async def _load_permissions(
    *, tenant_id: UUID, cognito_sub: str,
) -> list[str]:
    """Load the flat permission list for this user, tenant-scoped.

    Reads from the ``permission_grant`` table via a short-lived
    `tenant_session` so RLS policies apply. Returns an empty list if the
    user has no grants (the route-level @require_permission guard will
    then reject every sensitive action).
    """
    if not cognito_sub:
        return []

    # Import here to avoid circular imports (db.session depends on FastAPI).
    from ..db.session import tenant_session

    async with tenant_session(tenant_id) as session:
        result = await session.execute(
            text(
                """
                SELECT DISTINCT permission
                FROM permission_grant
                WHERE cognito_sub = :sub
                """
            ),
            {"sub": cognito_sub},
        )
        rows = result.fetchall()
    return [row[0] for row in rows if row[0]]


__all__ = ["AuthMiddleware", "DEFAULT_EXCLUDED_PREFIXES"]
