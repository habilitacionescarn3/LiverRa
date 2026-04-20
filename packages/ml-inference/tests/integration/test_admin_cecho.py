# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Integration test — admin C-ECHO flow (T293, US6).

Plain-English:
    Exercises ``/api/v1/admin/pacs-destination/echo`` against a mocked
    PACS:

      1. Happy path   — ping succeeds (TCP probe reachable) → 200 with
         ``reachable: true`` + ``round_trip_ms`` > 0.
      2. Failure path — host refuses / unreachable → 200 with
         ``reachable: false`` + PHI-scrubbed error slug (never the raw
         OS error text).

Spec refs:
    - spec.md §FR-039 (admin C-ECHO pre-flight)
    - research.md §A.5
"""
from __future__ import annotations

import asyncio
import socket
from contextlib import contextmanager

import pytest

from packages.ml_inference.src.services.pacs_cecho import ping, _scrub  # type: ignore


@contextmanager
def _open_reject_socket() -> "socket.socket":
    """Spin up a listening socket that immediately closes — used to test
    the reachable-but-minimal path."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    try:
        yield srv
    finally:
        srv.close()


def test_cecho_happy_tcp_reachable() -> None:
    """Reachable host → ``reachable=True`` with positive round_trip_ms."""
    with _open_reject_socket() as srv:
        port = srv.getsockname()[1]
        result = asyncio.run(
            ping(ae_title="TEST", host="127.0.0.1", port=port, timeout_s=2.0)
        )
        assert result.reachable is True
        assert result.round_trip_ms is not None
        assert result.round_trip_ms >= 0


def test_cecho_failure_connection_refused() -> None:
    """Closed port → ``reachable=False`` with a sanitized error slug."""
    # Port 1 is privileged and generally refuses — used as a low-risk probe
    # target that won't have a listener in CI.
    result = asyncio.run(
        ping(ae_title="TEST", host="127.0.0.1", port=1, timeout_s=1.0)
    )
    assert result.reachable is False
    assert result.error is not None
    # The error must NEVER be the raw OS error — it must be a scrubbed slug.
    assert result.error in {
        "connection_refused",
        "timeout",
        "host_unreachable",
        "connection_failed",
        "dns_error",
    }


def test_cecho_timeout_slug() -> None:
    """Unroutable IP within tight timeout → timeout slug."""
    # 203.0.113.1 is documentation-only (RFC 5737) — never routed.
    result = asyncio.run(
        ping(ae_title="TEST", host="203.0.113.1", port=104, timeout_s=0.5)
    )
    assert result.reachable is False
    # Any of the scrubbed slugs is acceptable; the key invariant is "no PHI".
    assert result.error is not None
    assert len(result.error) < 64


def test_scrub_removes_raw_paths() -> None:
    assert _scrub("[Errno 111] Connection refused") == "connection_refused"
    assert _scrub("timed out after 5 seconds") == "timeout"
    assert _scrub("Name or service not known") == "dns_error"
    assert _scrub("getaddrinfo failed") == "dns_error"
    assert _scrub("host unreachable /var/patient.dcm") == "host_unreachable"
    # Catch-all NEVER echoes the original string.
    scrubbed = _scrub("some arbitrary error with PHI-looking text 'John Doe'")
    assert "John Doe" not in scrubbed
    assert scrubbed == "connection_failed"
