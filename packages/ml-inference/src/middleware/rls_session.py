# SPDX-FileCopyrightText: Copyright LiverRa
# SPDX-License-Identifier: Apache-2.0

"""
RLSSessionMiddleware (minimal staging stub).

Plain-English:
    Postgres Row-Level Security only fires when the session-local setting
    ``app.tenant_id`` is set on the connection. The production middleware
    will, on every request, read the authenticated user's ``tenant_id`` from
    ``request.state`` and execute ``SET LOCAL app.tenant_id = '...'`` at the
    start of the request transaction.

    This file is a **staging stub** — it lets the app boot in production
    mode (``LIVERRA_ENV=staging|production``) so the deployment can come up
    while the full RLS-session wiring lands in a follow-up. It is a no-op
    middleware that records its presence in a request-state flag so other
    code can detect "RLS-session not yet wired" and refuse to serve PHI.

DO NOT ship to production with real PHI until this is replaced. The RLS
policies on audit_event, audit_event_chain, analysis_finding, and
lesion_classification_override only work when the session var is set —
without that, every request reads/writes across all tenants.
"""
from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class RLSSessionMiddleware(BaseHTTPMiddleware):
    """No-op stub. Records its presence so downstream code can detect that
    RLS-session wiring is not yet active and short-circuit PHI surfaces.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        request.state.rls_session_wired = False
        response: Response = await call_next(request)
        response.headers.setdefault("X-LiverRa-RLS-Session", "stub")
        return response
