# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Pytest configuration for the GPU inference tests.

The tests run on developer laptops + CI containers that may have
neither CUDA, nor TotalSegmentator weights, nor the ``totalsegmentator``
package installed. We therefore:

  1. Set ``LIVERRA_GPU_SHARED_TOKEN`` to a dummy value before importing
     ``main`` — the lifespan refuses to start otherwise (intentional
     B-INFER-3 hardening).
  2. Provide a sync ``client`` fixture using ``TestClient`` so individual
     tests don't repeat the boilerplate.

Heavy inference is not exercised here. The endpoint logic that
verifies authentication, license-gate, and ``/health`` semantics
runs without ever touching TotalSegmentator.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

# Ensure the package root is on sys.path so ``import main`` works
# regardless of where pytest is invoked.
_PKG_ROOT = Path(__file__).resolve().parent.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))


@pytest.fixture(autouse=True)
def _set_shared_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Provide a deterministic Bearer token so verify_token works."""
    monkeypatch.setenv("LIVERRA_GPU_SHARED_TOKEN", "test-shared-token-do-not-use-in-prod")


@pytest.fixture()
def app():
    """Import the FastAPI app lazily so the env vars are in place."""
    # Re-import on each test so module-level state cannot leak across tests.
    import importlib

    import main  # type: ignore[import-not-found]

    importlib.reload(main)
    return main.app


@pytest.fixture()
def client(app):
    """Synchronous TestClient that skips the lifespan."""
    try:
        from fastapi.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi not available in this venv")

    # Use ``with`` so lifespan runs only if the test opts in; for these
    # contract tests we bypass it (no GPU, no TS weights). The lifespan
    # itself is exercised by a dedicated test below.
    return TestClient(app)
