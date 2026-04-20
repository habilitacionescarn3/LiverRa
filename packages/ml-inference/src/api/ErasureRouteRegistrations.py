# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Erasure router registration side-file (T332, US9).

Plain-English:
    Mounts ``/api/v1/erasure/*`` and records the route → permission
    mapping on ``app.state.route_permissions`` for OpenAPI generation
    and matrix-drift detection. Mirrors the pattern in
    :mod:`OpsRouteRegistrations`.

    Erasure is the most sensitive surface in the system — we fail
    startup if the module can't be imported rather than silently
    shipping a build without it.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI

logger = logging.getLogger(__name__)

ERASURE_PREFIX = "/api/v1/erasure"

ERASURE_ROUTE_PERMISSIONS: dict[str, str] = {
    f"{ERASURE_PREFIX}/requests": "erasure.execute",
    f"{ERASURE_PREFIX}/requests/{{erasure_id}}": "erasure.execute",
}


def register_erasure_routes(app: FastAPI) -> None:
    """Mount the erasure router under ``/api/v1/erasure``.

    Raises ``RuntimeError`` if the erasure module is not importable —
    this is a compliance-critical surface and we treat a missing
    router as a deployment failure.
    """
    try:
        from .erasure import router as erasure_router
    except Exception as exc:  # noqa: BLE001
        logger.error("erasure router import failed: %s", exc)
        raise RuntimeError(
            "Erasure router must be registrable — failing startup per FR-040."
        ) from exc

    app.include_router(erasure_router, prefix=ERASURE_PREFIX, tags=["erasure"])

    existing: dict[str, Any] = getattr(app.state, "route_permissions", {}) or {}
    existing.update(ERASURE_ROUTE_PERMISSIONS)
    app.state.route_permissions = existing
    logger.info(
        "erasure routes registered: %s", sorted(ERASURE_ROUTE_PERMISSIONS.keys())
    )


__all__ = [
    "register_erasure_routes",
    "ERASURE_ROUTE_PERMISSIONS",
    "ERASURE_PREFIX",
]
