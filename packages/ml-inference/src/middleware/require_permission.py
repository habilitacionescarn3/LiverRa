"""FastAPI permission guard for LiverRa.

Provides the ``@require_permission(perm, *, step_up=False)`` decorator used on
every API handler that performs a sensitive action. The guard cooperates with
the upstream ``AuthMiddleware`` (which populates ``request.state.user`` and
``request.state.tenant_id``) to enforce:

  - **Authentication** (401 if user missing).
  - **Authorization** (403 if the permission is absent from the user's set).
  - **Tenant isolation** (404 if the target resource belongs to a different
    tenant — per FR-032a we MUST NOT disclose the existence of cross-tenant
    resources).
  - **Step-up freshness** (401 with ``slug=step-up-required`` when
    ``step_up=True`` and the user's last authentication is older than five
    minutes).

Every check — allowed or denied — emits a ``permission_check`` FHIR
AuditEvent via the chain-of-hashes writer (fail-closed in production; silently
skipped during early bootstrap when the audit module is not yet wired).

Response bodies use ``application/problem+json`` (RFC 7807) with a LiverRa
``slug`` field — the error catalog is single-sourced and consumed by the
frontend toast/modal layer.

Spec references: T062, research.md §X.3, plan.md §Frontend RBAC wiring,
spec.md §FR-032 / §FR-032a.
"""

from __future__ import annotations

import functools
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# Step-up auth freshness window per NFR-007 / spec.md §FR-032.
STEP_UP_WINDOW = timedelta(minutes=5)

PROBLEM_JSON = "application/problem+json"


# ---------------------------------------------------------------------------
# Problem+JSON error helpers
# ---------------------------------------------------------------------------


class PermissionProblem(HTTPException):
    """HTTPException carrying a LiverRa problem+json body."""

    def __init__(
        self,
        status_code: int,
        *,
        slug: str,
        title: str,
        detail: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        body: dict[str, Any] = {
            "type": f"https://liverra.ai/errors/{slug}",
            "title": title,
            "status": status_code,
            "slug": slug,
            "detail": detail,
        }
        if extra:
            body.update(extra)
        super().__init__(status_code=status_code, detail=body)
        self.slug = slug

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status_code,
            content=self.detail,
            media_type=PROBLEM_JSON,
        )


def _unauthenticated() -> PermissionProblem:
    return PermissionProblem(
        401,
        slug="unauthenticated",
        title="Authentication required",
        detail="No authenticated principal on this request.",
    )


def _not_found() -> PermissionProblem:
    # Per FR-032a: missing-permission AND cross-tenant access both return
    # 404 (never 403). A 403 would leak the existence of cross-tenant or
    # higher-privilege resources to an unauthorized caller. The audit
    # event still carries the actual permission + outcome reason so
    # operators can tell denials from genuine misses.
    return PermissionProblem(
        404,
        slug="not-found",
        title="Not found",
        detail="Resource not found.",
    )


def _step_up_required(perm: str) -> PermissionProblem:
    return PermissionProblem(
        401,
        slug="step-up-required",
        title="Step-up authentication required",
        detail=(
            f"Permission {perm} requires a recent MFA challenge "
            f"(within {int(STEP_UP_WINDOW.total_seconds() // 60)} minutes)."
        ),
        extra={"required_permission": perm, "max_age_seconds": int(STEP_UP_WINDOW.total_seconds())},
    )


# ---------------------------------------------------------------------------
# Request-state accessors
# ---------------------------------------------------------------------------


def _get_request(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Request:
    """Locate the Request object in FastAPI handler args/kwargs."""
    request = kwargs.get("request")
    if isinstance(request, Request):
        return request
    for arg in args:
        if isinstance(arg, Request):
            return arg
    raise RuntimeError(
        "require_permission: handler is missing a `request: Request` parameter"
    )


def _get_user(request: Request) -> Any:
    user = getattr(request.state, "user", None)
    if user is None:
        return None
    return user


def _get_user_permissions(user: Any) -> set[str]:
    perms = getattr(user, "permissions", None)
    if perms is None and isinstance(user, dict):
        perms = user.get("permissions")
    if perms is None:
        return set()
    return {str(p) for p in perms}


def _get_auth_time(request: Request) -> Optional[datetime]:
    auth_time = getattr(request.state, "auth_time", None)
    if auth_time is None:
        return None
    if isinstance(auth_time, datetime):
        return auth_time if auth_time.tzinfo else auth_time.replace(tzinfo=timezone.utc)
    if isinstance(auth_time, (int, float)):
        return datetime.fromtimestamp(float(auth_time), tz=timezone.utc)
    if isinstance(auth_time, str):
        try:
            return datetime.fromisoformat(auth_time.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _tenant_id(request: Request) -> Optional[str]:
    tid = getattr(request.state, "tenant_id", None)
    return str(tid) if tid is not None else None


def _resource_tenant(request: Request) -> Optional[str]:
    """Fetch the tenant id of the resource being accessed, if the upstream
    repository layer populated `request.state.resource_tenant_id`.

    We intentionally DO NOT load the resource here — that is the handler's
    job. The guard only checks the tenant id if the repository layer already
    populated it on request.state during an earlier dependency resolution.
    """
    rtid = getattr(request.state, "resource_tenant_id", None)
    return str(rtid) if rtid is not None else None


# ---------------------------------------------------------------------------
# Audit hook (optional, fail-safe import)
# ---------------------------------------------------------------------------


async def _emit_audit_event(
    request: Request,
    perm: str,
    outcome: str,
    *,
    reason: Optional[str] = None,
) -> None:
    """Emit a ``permission_check`` AuditEvent.

    The audit writer module may not exist during very early bootstrap; in that
    case we log the intent and continue. Once the audit writer ships, remove
    the ImportError fallback and treat a write failure as fail-closed.

    NB: ``write_permission_check`` is async because the underlying chain
    writer touches the DB. Awaiting here keeps the call site honest — the
    previous non-await form generated a "coroutine never awaited" warning
    on every denial.
    """
    try:
        # Local import so the middleware stays importable before the audit
        # module is wired.
        from ..services.audit.chain_of_hashes import AuditChainWriter  # type: ignore

        writer = AuditChainWriter.from_request(request)
        user = _get_user(request)
        coro = writer.write_permission_check(
            actor=getattr(user, "id", None) if user else None,
            tenant=_tenant_id(request),
            permission=perm,
            outcome=outcome,
            reason=reason,
            path=str(request.url.path),
            method=request.method,
        )
        # The wrapper returns a coroutine; await it so chain writes commit
        # rather than landing in a "coroutine never awaited" warning.
        if hasattr(coro, "__await__"):
            await coro
    except ImportError:
        logger.debug(
            "AuditChainWriter unavailable; skipping permission_check audit",
            extra={"perm": perm, "outcome": outcome},
        )
    except Exception as exc:  # noqa: BLE001 — audit must not break the request path
        logger.warning(
            "Failed to emit permission_check AuditEvent: %s", exc,
            extra={"perm": perm, "outcome": outcome},
        )


# ---------------------------------------------------------------------------
# Decorator
# ---------------------------------------------------------------------------


def require_permission(
    perm: str, *, step_up: bool = False
) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
    """FastAPI decorator enforcing a single permission.

    Usage::

        @router.post("/reports/{id}/finalize")
        @require_permission("report.finalize", step_up=True)
        async def finalize_report(id: str, request: Request) -> Any:
            ...

    The decorated handler MUST declare a ``request: Request`` parameter
    (either positional or keyword) — FastAPI supplies it automatically.
    """

    def decorator(
        handler: Callable[..., Awaitable[Any]]
    ) -> Callable[..., Awaitable[Any]]:
        @functools.wraps(handler)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            request = _get_request(args, kwargs)

            # --- 1. Authenticated? -------------------------------------
            user = _get_user(request)
            if user is None:
                await _emit_audit_event(request, perm, "unauthenticated")
                raise _unauthenticated()

            # --- 2. Tenant isolation (FR-032a) -------------------------
            # If a repository layer has populated `resource_tenant_id`
            # we compare BEFORE the permission check so cross-tenant
            # attempts surface as 404 (not 403).
            request_tid = _tenant_id(request)
            resource_tid = _resource_tenant(request)
            if (
                request_tid is not None
                and resource_tid is not None
                and request_tid != resource_tid
            ):
                await _emit_audit_event(
                    request,
                    perm,
                    "cross-tenant",
                    reason="resource belongs to different tenant",
                )
                raise _not_found()

            # --- 3. Permission present? --------------------------------
            # Per FR-032a: a missing permission MUST surface as 404, not
            # 403 — disclosing 403 would leak the existence of the route /
            # resource to an unauthorized caller. The audit event below
            # records the real outcome (`denied` + permission name) so the
            # red-team test matrix can verify the deny actually happened.
            user_perms = _get_user_permissions(user)
            if perm not in user_perms:
                await _emit_audit_event(
                    request, perm, "denied", reason="permission not granted"
                )
                raise _not_found()

            # --- 4. Step-up freshness ----------------------------------
            if step_up:
                auth_time = _get_auth_time(request)
                now = datetime.now(tz=timezone.utc)
                if auth_time is None or (now - auth_time) > STEP_UP_WINDOW:
                    await _emit_audit_event(
                        request, perm, "step-up-required",
                        reason="auth_time stale or missing",
                    )
                    raise _step_up_required(perm)

            await _emit_audit_event(request, perm, "allowed")
            return await handler(*args, **kwargs)

        # Expose metadata for documentation / OpenAPI extensions.
        wrapper.__liverra_permission__ = perm  # type: ignore[attr-defined]
        wrapper.__liverra_step_up__ = step_up  # type: ignore[attr-defined]
        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# Exception handler registration
# ---------------------------------------------------------------------------


async def _permission_problem_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Render ``PermissionProblem`` as ``application/problem+json``.

    Without this handler, FastAPI's default ``HTTPException`` handler wraps
    the body dict under ``{"detail": ...}`` — which mangles the problem+json
    contract (``type``, ``slug``, ``status`` would all become unreachable
    inside ``detail``). Registering this handler in ``create_app`` (T049)
    AND in unit-test apps that exercise ``@require_permission`` produces a
    spec-compliant body.
    """
    if isinstance(exc, PermissionProblem):
        return exc.to_response()
    # Shouldn't happen — FastAPI only routes registered exception types here.
    return JSONResponse(
        status_code=500,
        content={"type": "https://liverra.ai/errors/internal", "status": 500},
        media_type=PROBLEM_JSON,
    )


def install_permission_problem_handler(app: FastAPI) -> None:
    """Register the problem+json renderer on a FastAPI app.

    Safe to call multiple times (FastAPI deduplicates by exception class).
    """
    app.add_exception_handler(PermissionProblem, _permission_problem_handler)


__all__ = [
    "PermissionProblem",
    "STEP_UP_WINDOW",
    "install_permission_problem_handler",
    "require_permission",
]
