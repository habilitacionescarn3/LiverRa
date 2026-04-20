# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Rate-limit middleware (T408).

Plain-English:
    Some endpoints — finalize-report, PACS push, GDPR erasure — are
    both expensive and security-sensitive. A bug or an attacker could
    hammer them and burn budget / DoS the PACS. This middleware uses
    ``slowapi`` (a fast Redis- or memory-backed limiter) to cap how
    often each ``(tenant_id, user_id, endpoint)`` triple may hit.

Per-endpoint limits (per plan.md §Hardening Matrix):

    finalize                 10 / min
    PACS push                20 / min
    PACS push retry          6 / min
    erasure                  5 / min
    demo seed                2 / min
    auth step-up             10 / 5 min
    upload                   60 / min

On 429 we emit an RFC 7807 ``rate-limit-exceeded`` problem+json body
with a ``Retry-After`` header so the frontend can back off gracefully.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional
from uuid import uuid4

try:  # pragma: no cover
    from fastapi import Request
    from fastapi.responses import JSONResponse

    _FASTAPI_AVAILABLE = True
except ImportError:  # pragma: no cover
    Request = None  # type: ignore[assignment]
    JSONResponse = None  # type: ignore[assignment]
    _FASTAPI_AVAILABLE = False

try:  # pragma: no cover
    from slowapi import Limiter
    from slowapi.errors import RateLimitExceeded
    from slowapi.middleware import SlowAPIMiddleware

    _SLOWAPI_AVAILABLE = True
except ImportError:  # pragma: no cover
    Limiter = None  # type: ignore[assignment]
    RateLimitExceeded = Exception  # type: ignore[assignment]
    SlowAPIMiddleware = None  # type: ignore[assignment]
    _SLOWAPI_AVAILABLE = False

try:
    from ..services.errors.catalog import ErrorSlug, problem_detail
except Exception:  # pragma: no cover
    ErrorSlug = None  # type: ignore[assignment]
    problem_detail = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Limit table (endpoint path prefix → slowapi limit string)
# ---------------------------------------------------------------------------

LIMITS: dict[str, str] = {
    # path-prefix → "N/period" (slowapi syntax)
    "/api/v1/reviews/*/finalize": "10/minute",
    "/api/v1/reports/*/pacs-push/*/retry": "6/minute",
    "/api/v1/reports/*/pacs-push": "20/minute",
    "/api/v1/erasure": "5/minute",
    "/api/v1/demo/seed": "2/minute",
    "/api/v1/auth/step-up": "10/5 minutes",
    "/api/v1/ingest/uploads": "60/minute",
}


def _rate_key(request: "Request") -> str:  # type: ignore[name-defined]
    """Build the ``(tenant_id, user_id, endpoint)`` composite key.

    Falls back to the raw client IP when request.state is not yet
    populated (pre-auth routes like ``/api/v1/system/health``).
    """
    state = getattr(request, "state", None)
    tenant_id = getattr(state, "tenant_id", None) if state is not None else None
    user_id = getattr(state, "user_id", None) if state is not None else None
    endpoint = request.url.path
    if tenant_id and user_id:
        return f"{tenant_id}:{user_id}:{endpoint}"
    client = getattr(request, "client", None)
    host = getattr(client, "host", "anonymous") if client else "anonymous"
    return f"ip:{host}:{endpoint}"


def _match_limit(path: str) -> Optional[str]:
    """Find the slowapi limit string for a given concrete path."""
    import fnmatch

    for pattern, limit in LIMITS.items():
        if fnmatch.fnmatch(path, pattern):
            return limit
    return None


def build_limiter() -> Optional[Any]:
    """Construct the slowapi ``Limiter`` (or None if the dep is absent)."""
    if not _SLOWAPI_AVAILABLE or Limiter is None:
        return None
    return Limiter(key_func=_rate_key, default_limits=[])


async def rate_limit_exceeded_handler(
    request: "Request", exc: "RateLimitExceeded"  # type: ignore[name-defined]
) -> Any:
    """Render 429s as problem+json with Retry-After."""
    retry_after = getattr(exc, "retry_after", None) or "60"
    instance = str(uuid4())
    body = {
        "type": "https://liverra.ai/errors/rate-limit-exceeded",
        "title": "Rate Limit Exceeded",
        "status": 429,
        "detail": "Too many requests. Please retry after a short wait.",
        "instance": instance,
    }
    if ErrorSlug is not None and problem_detail is not None:
        body = problem_detail(
            slug=ErrorSlug.RATE_LIMIT_EXCEEDED,
            status=429,
            detail="Too many requests. Please retry after a short wait.",
            instance=instance,
        )
    if JSONResponse is None:  # pragma: no cover
        raise RuntimeError("FastAPI is required")
    return JSONResponse(
        content=body,
        status_code=429,
        media_type="application/problem+json",
        headers={"Retry-After": str(retry_after)},
    )


def install(app: Any) -> None:
    """Attach slowapi to a FastAPI app.

    Usage from ``main.py``::

        from .middleware import rate_limit
        rate_limit.install(app)

    Per-route decorators (``@limiter.limit(...)``) are applied in the
    individual router modules — this helper just wires up the global
    middleware + error handler.
    """
    limiter = build_limiter()
    if limiter is None or SlowAPIMiddleware is None:
        logger.info("slowapi not installed — rate-limit middleware disabled")
        return

    # Expose on app.state for per-route decorator access.
    app.state.limiter = limiter
    try:
        app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
        app.add_middleware(SlowAPIMiddleware)
    except Exception as exc:  # pragma: no cover
        logger.warning("Failed to attach slowapi middleware: %s", exc)


__all__ = [
    "LIMITS",
    "build_limiter",
    "install",
    "rate_limit_exceeded_handler",
]
