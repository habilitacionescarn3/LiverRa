# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Ops router registration side-file (T320, US8).

Plain-English:
    Most routers in this app are mounted inline in ``main.py``. The ops
    router lives behind an extra permission (``ops.queue_view``) and
    emits cross-tenant data, so we register it through a dedicated
    side-file that:

      1. Mounts ``/api/v1/ops/*``,
      2. Records the route → required-permission mapping into
         ``app.state.route_permissions`` (used by OpenAPI generation
         and the RBAC matrix diff tool to detect drift), and
      3. Fails loudly if the module can't be imported rather than
         silently dropping a compliance-sensitive surface.

Call site:
    ``src/main.py`` imports :func:`register_ops_routes` in the router
    phase and invokes it with the FastAPI app.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI

logger = logging.getLogger(__name__)

OPS_PREFIX = "/api/v1/ops"

# Map route path → required permission. Kept in sync with
# ``contracts/api-openapi.yaml §ops`` and the RBAC matrix.
OPS_ROUTE_PERMISSIONS: dict[str, str] = {
    f"{OPS_PREFIX}/queue": "ops.queue_view",
    f"{OPS_PREFIX}/analyses/{{analysis_id}}/retry": "ops.case_unstick",
    f"{OPS_PREFIX}/analyses/{{analysis_id}}/cancel": "ops.case_unstick",
    f"{OPS_PREFIX}/analyses/{{analysis_id}}/mark-blocked": "ops.case_unstick",
}


def register_ops_routes(app: FastAPI) -> None:
    """Mount the ops router under ``/api/v1/ops``.

    Raises ``RuntimeError`` if the ops module is not importable — ops
    is a compliance-sensitive surface and we would rather fail startup
    than quietly ship a build without it.
    """
    try:
        from .ops import router as ops_router
    except Exception as exc:  # noqa: BLE001
        logger.error("ops router import failed: %s", exc)
        raise RuntimeError(
            "Ops router must be registrable — failing startup per FR-033c."
        ) from exc

    app.include_router(ops_router, prefix=OPS_PREFIX, tags=["ops"])

    existing: dict[str, Any] = getattr(app.state, "route_permissions", {}) or {}
    existing.update(OPS_ROUTE_PERMISSIONS)
    app.state.route_permissions = existing
    logger.info("ops routes registered: %s", sorted(OPS_ROUTE_PERMISSIONS.keys()))


__all__ = ["register_ops_routes", "OPS_ROUTE_PERMISSIONS", "OPS_PREFIX"]
