# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Step-up auth smoke test (T194 — placeholder for Phase 7).

Plain-English:
    The *real* step-up tests (T265 + T266) will exercise the finalize
    endpoint's MFA-within-5-minutes guard end-to-end. Those land in
    Phase 7 ("Finalize + Export"). This placeholder keeps CI honest
    right now by asserting the middleware is wired and that
    ``step_up=True`` attaches the metadata flag the finalize route
    will depend on.

Flagged ``@pytest.mark.placeholder`` so the CI pipeline can filter in
or out during staged rollout.
"""
from __future__ import annotations

import pytest


@pytest.mark.placeholder
def test_require_permission_imports_cleanly():
    """Smoke: the decorator module loads without pulling heavy deps."""
    from src.middleware.require_permission import require_permission

    assert callable(require_permission)


@pytest.mark.placeholder
def test_step_up_flag_attached_to_wrapper():
    """``step_up=True`` exposes the flag on the wrapped function."""
    from fastapi import Request

    from src.middleware.require_permission import require_permission

    @require_permission("report.finalize", step_up=True)
    async def _finalize(request: Request):  # pragma: no cover — never invoked
        return {"ok": True}

    assert getattr(_finalize, "__liverra_permission__", None) == "report.finalize"
    assert getattr(_finalize, "__liverra_step_up__", None) is True


@pytest.mark.placeholder
def test_step_up_default_false():
    """Without ``step_up=True`` the flag is False."""
    from fastapi import Request

    from src.middleware.require_permission import require_permission

    @require_permission("analysis.view")
    async def _view(request: Request):  # pragma: no cover
        return {"ok": True}

    assert getattr(_view, "__liverra_step_up__", None) is False
