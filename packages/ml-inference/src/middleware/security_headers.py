# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Security-headers middleware (T409).

Plain-English:
    A browser trusts every header the server sets, so we lock down
    the cross-site attack surface here — Content-Security-Policy,
    HSTS, nosniff, referrer + permissions policy. Every response
    (HTML, JSON, images, PDFs) carries the same hardened header set.

FR-028a demands ``frame-ancestors 'none'`` so LiverRa cannot be
embedded inside a third-party iframe (prevents clickjack + disclaimer
bypass).

References:
    - spec.md §FR-028a (bypass hardening)
    - plan.md §Security Headers

Nginx fallback: ``deploy/nginx/security.conf`` applies the same
headers at the edge proxy so even static assets served directly
by nginx get them.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict

try:  # pragma: no cover
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import Response

    _STARLETTE_AVAILABLE = True
except ImportError:  # pragma: no cover
    BaseHTTPMiddleware = object  # type: ignore[assignment,misc]
    Request = None  # type: ignore[assignment]
    Response = None  # type: ignore[assignment]
    _STARLETTE_AVAILABLE = False


logger = logging.getLogger(__name__)


def build_csp(
    medplum_url: str = "",
    sentry_url: str = "",
    otel_url: str = "",
) -> str:
    """Compose the CSP string from trusted origins.

    ``connect-src`` must include Medplum + Sentry + optionally the
    OTel collector so the browser can POST to them.
    """
    connect_sources = ["'self'"]
    for origin in (medplum_url, sentry_url, otel_url):
        if origin:
            connect_sources.append(origin)
    connect_src = " ".join(connect_sources)
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",  # Mantine emits runtime <style>
            f"connect-src {connect_src}",
            "img-src 'self' data: blob:",
            "worker-src 'self' blob:",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def default_headers() -> Dict[str, str]:
    """Return the canonical header map. Reads trusted origins from env."""
    medplum_url = os.environ.get("MEDPLUM_URL", "")
    sentry_url = os.environ.get("SENTRY_URL", "")
    otel_url = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    return {
        "Content-Security-Policy": build_csp(medplum_url, sentry_url, otel_url),
        "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "X-Frame-Options": "DENY",  # legacy belt-and-braces
    }


class SecurityHeadersMiddleware(BaseHTTPMiddleware):  # type: ignore[misc]
    """Stamp the security headers onto every response."""

    def __init__(self, app: Any, headers: Dict[str, str] | None = None):
        super().__init__(app)
        self._headers = headers or default_headers()

    async def dispatch(self, request: "Request", call_next):  # type: ignore[override,name-defined]
        response: "Response" = await call_next(request)  # type: ignore[name-defined]
        for key, value in self._headers.items():
            # Don't clobber headers that downstream code intentionally set
            # (e.g. a specific CSP for a single route).
            response.headers.setdefault(key, value)
        return response


def install(app: Any) -> None:
    """Attach :class:`SecurityHeadersMiddleware` to a FastAPI/Starlette app."""
    if not _STARLETTE_AVAILABLE:  # pragma: no cover
        logger.warning("starlette missing — security headers disabled")
        return
    app.add_middleware(SecurityHeadersMiddleware)


__all__ = [
    "SecurityHeadersMiddleware",
    "build_csp",
    "default_headers",
    "install",
]
