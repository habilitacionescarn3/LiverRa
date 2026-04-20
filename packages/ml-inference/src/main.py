# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""FastAPI application factory (T132) + system-router wiring (T134).

Plain-English:
    This is the "front door" to the Python backend. It builds the
    FastAPI app, wires every middleware in the right order (CORS ->
    auth -> RLS session -> rate-limit -> security headers), attaches
    observability (Sentry + OpenTelemetry), registers global exception
    handlers, and then mounts every router.

Middleware order (outermost first; Starlette executes the LAST added
first on the way in and first on the way out):

    1. CORS (outermost — handles preflight before anything else)
    2. Auth (JWT → request.state.user_id / tenant_id)
    3. RLS session (tenant context for get_db)
    4. Rate-limit (slowapi, per endpoint)
    5. Security headers (innermost — applies to every response)

Every import that touches a sibling module still under construction is
wrapped in try/except so this file can be unit-tested before the full
stack lands.

References:
    - plan.md §App bootstrap
    - plan.md §Error Handling §Server-side
    - plan.md §Health aggregator
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logger = logging.getLogger(__name__)


_STRICT_BOOT_ENVS = ("staging", "production")


def _strict_boot(component: str, exc: BaseException) -> None:
    """Log a wiring failure; refuse to boot when running in staging/production.

    Why: silent ImportError fallbacks mask middleware that should be loaded
    (auth, RLS, security headers) and turn a typo into a quietly-disabled
    safety control. In dev we keep the soft-fail so unit tests can run
    without the full stack; in regulated environments we fail loud.
    """
    env = os.environ.get("LIVERRA_ENV", "development").lower()
    if env in _STRICT_BOOT_ENVS:
        raise RuntimeError(
            f"{component} failed to wire in {env}: {exc!r}"
        ) from exc
    logger.warning("%s not wired (dev): %s", component, exc)


# Process-wide singleton container. Kept intentionally small: FastAPI's
# ``Depends(...)`` providers read from here.
_singletons: dict[str, Any] = {}


def _cors_origins() -> list[str]:
    raw = os.environ.get(
        "CORS_ORIGINS", "http://localhost:3000,http://localhost:5173"
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


def _get_session_factory() -> Any:
    """Return the async SQLAlchemy session factory, or ``None`` in bare
    dev environments where ``src.db.session`` hasn't been created yet.
    """
    try:
        from src.db.session import get_sessionmaker  # type: ignore[import-not-found]

        return get_sessionmaker()
    except Exception:  # noqa: BLE001
        try:
            from src.db.session import async_session_factory  # type: ignore[import-not-found]

            return async_session_factory
        except Exception:
            return None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Construct singletons on startup, dispose on shutdown.

    Imports happen inside the function so importing ``main`` in tests
    (e.g. for ``TestClient``) doesn't trigger a DB import chain.
    """
    try:
        from src.observability.phi_scrubber import PHIScrubber
        from src.services.audit.chain_of_hashes import AuditChainWriter

        session_factory = _get_session_factory()
        _singletons["audit_writer"] = AuditChainWriter(session_factory)
        _singletons["phi_scrubber"] = PHIScrubber()
        app.state.audit_chain_writer = _singletons["audit_writer"]
        app.state.phi_scrubber = _singletons["phi_scrubber"]
    except Exception as exc:  # pragma: no cover — degrade for local dev
        _strict_boot("Audit/PHI singletons", exc)

    # T414 — MBoM reader singleton (mtime-invalidated).
    try:
        from src.services.mbom.reader import get_default_reader

        _singletons["mbom_reader"] = get_default_reader()
        app.state.mbom_reader = _singletons["mbom_reader"]
    except Exception as exc:  # pragma: no cover
        _strict_boot("MBoM reader", exc)

    try:
        yield
    finally:
        _singletons.clear()


def create_app() -> FastAPI:
    """Build the FastAPI application.

    Safe to call multiple times (tests may build + tear down).
    """
    app = FastAPI(
        title="LiverRa ML Inference API",
        version=os.environ.get("LIVERRA_APP_VERSION", "0.1.0"),
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    # --- Observability (Sentry first so it sees later middleware crashes) --
    try:
        from src.observability import sentry_init

        sentry_init.install(app)
    except Exception as exc:
        _strict_boot("Sentry", exc)

    try:
        from src.observability import otel_init

        otel_init.instrument_app(app)
    except Exception as exc:
        _strict_boot("OpenTelemetry", exc)

    # --- CORS --------------------------------------------------------------
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        # Explicit whitelist — LiverRa handles PHI, so wildcard CORS is
        # disallowed (defense-in-depth, constitution §Security).
        allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Accept",
            "Accept-Language",
            "X-Request-Id",
            "X-Tenant-Id",
            "Last-Event-ID",
        ],
        expose_headers=["X-Request-ID", "X-LiverRa-Tenant", "Retry-After"],
    )

    # --- Auth + RLS session (owned by sibling agents — T046–T059) ---------
    try:
        # Prefer the canonical module; fall back to `auth_middleware` if the
        # neighbouring agent (T046) named it that way during incremental dev.
        try:
            from src.middleware.auth import AuthMiddleware  # type: ignore[import-not-found]
        except Exception:
            from src.middleware.auth_middleware import AuthMiddleware  # type: ignore[import-not-found]

        app.add_middleware(AuthMiddleware)
    except Exception as exc:
        _strict_boot("AuthMiddleware", exc)

    try:
        from src.middleware.rls_session import RLSSessionMiddleware  # type: ignore[import-not-found]

        app.add_middleware(RLSSessionMiddleware)
    except Exception as exc:
        _strict_boot("RLSSessionMiddleware", exc)

    # --- Rate limit + security headers -------------------------------------
    try:
        from src.middleware import rate_limit

        rate_limit.install(app)
    except Exception as exc:
        _strict_boot("Rate-limit middleware", exc)

    try:
        from src.middleware import security_headers

        security_headers.install(app)
    except Exception as exc:
        _strict_boot("Security-headers middleware", exc)

    # --- Exception handlers ------------------------------------------------
    try:
        from src.services.errors.catalog import register_exception_handler

        register_exception_handler(app)
    except Exception as exc:
        _strict_boot("problem+json exception handler", exc)

    # --- Routers -----------------------------------------------------------
    try:
        from src.api.system import router as system_router

        if system_router is not None:
            app.include_router(
                system_router, prefix="/api/v1/system", tags=["system"]
            )
    except Exception as exc:
        _strict_boot("system router", exc)

    # --- Analysis routers (T167 detail + T168 SSE stream) -----------------
    try:
        from src.api.analysis import router as analysis_router
        from src.api.analysis_stream import router as analysis_stream_router

        app.include_router(
            analysis_router, prefix="/api/v1/analyses", tags=["analysis"]
        )
        # Stream router shares the same prefix — ordering is fine because
        # FastAPI matches the more specific /stream suffix first.
        app.include_router(
            analysis_stream_router,
            prefix="/api/v1/analyses",
            tags=["analysis"],
        )
    except Exception as exc:
        _strict_boot("analysis routers", exc)

    # --- Compliance router (T338 / T448) ----------------------------------
    try:
        from src.api.compliance import router as compliance_router

        app.include_router(
            compliance_router, prefix="/api/v1/compliance", tags=["compliance"]
        )
    except Exception as exc:
        _strict_boot("compliance router", exc)

    # --- Export router (T265 finalize + PACS push + retract) ------------
    try:
        from src.api.export import router as export_router

        # Router paths are fully-qualified (``/reviews/...``, ``/reports/...``)
        # per contracts/api-openapi.yaml §export — mount at ``/api/v1``.
        app.include_router(export_router, prefix="/api/v1", tags=["export"])
    except Exception as exc:
        _strict_boot("export router", exc)

    # TODO(T140+): mount ingest, review routers.
    return app


# ---------------------------------------------------------------------------
# Dependency providers (used with ``Depends(...)`` in route handlers)
# ---------------------------------------------------------------------------


def get_audit_writer() -> Any:
    """Return the process-wide AuditChainWriter singleton."""
    return _singletons.get("audit_writer")


def get_phi_scrubber() -> Any:
    """Return the process-wide PHIScrubber singleton."""
    return _singletons.get("phi_scrubber")


# App instance for ``uvicorn src.main:app`` style invocation.
app = create_app()
