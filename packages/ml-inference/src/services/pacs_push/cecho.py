# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Async DICOM C-ECHO pre-flight (T263).

Plain-English:
    Before a hospital admin saves a new PACS destination in LiverRa we
    need to know the destination is actually reachable — otherwise the
    surgeon finalises a Report, we push, and everything silently
    queues retries into nothing.

    C-ECHO is the DICOM equivalent of ``ping``: a verify-class DIMSE
    handshake that returns 0x0000 when the remote AE is happily
    listening. :func:`ping` does exactly one attempt and returns a
    typed result; higher-level code decides whether to retry.

Consumers:
    - US6 PACS config save flow (``POST /admin/pacs-destinations/echo``).
    - Operator "Re-test connection" button.
    - Finalize pre-flight (optional — the retry FSM covers the steady-
      state path, so we don't block finalize on a transient ping fail).

Dependencies: ``pynetdicom>=2.1``.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover
    from pynetdicom import AE  # type: ignore[import-not-found]
    from pynetdicom.sop_class import Verification  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    AE = None  # type: ignore[assignment,misc]
    Verification = "1.2.840.10008.1.1"  # type: ignore[assignment]

from .storescu import PACSDestination, STATUS_SUCCESS

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EchoResult:
    """Outcome of one C-ECHO attempt.

    ``status_code`` is the raw DIMSE Status (or ``None`` if association
    never formed). ``success`` is the friendly bool other code checks.
    ``error_slug`` is a short machine-safe reason — never PHI-heavy.
    """

    success: bool
    status_code: int | None
    error_slug: str | None = None
    latency_ms: float | None = None


def _ping_sync(destination: PACSDestination) -> EchoResult:
    if AE is None:  # pragma: no cover
        raise RuntimeError(
            "C-ECHO requires pynetdicom; install via `pip install 'pynetdicom>=2.1'`"
        )

    ae = AE(ae_title=destination.caller_ae_title)
    ae.connection_timeout = destination.connect_timeout_s
    ae.dimse_timeout = destination.dimse_timeout_s
    ae.add_requested_context(Verification)

    import time

    t0 = time.perf_counter()
    assoc = None
    try:
        assoc = ae.associate(
            destination.host,
            destination.port,
            ae_title=destination.ae_title,
        )
    except Exception as exc:  # noqa: BLE001
        return EchoResult(
            success=False,
            status_code=None,
            error_slug=f"associate-exception:{type(exc).__name__}",
        )

    if assoc is None or not getattr(assoc, "is_established", False):
        return EchoResult(
            success=False,
            status_code=None,
            error_slug="associate-not-established",
        )

    try:
        status = assoc.send_c_echo()
        status_code = int(getattr(status, "Status", 0xFFFF))
    except Exception as exc:  # noqa: BLE001
        status_code = None
        logger.warning("C-ECHO DIMSE failed: %s", type(exc).__name__)
        return EchoResult(
            success=False,
            status_code=None,
            error_slug=f"c-echo-exception:{type(exc).__name__}",
        )
    finally:
        try:
            assoc.release()
        except Exception:  # noqa: BLE001
            pass

    success = status_code == STATUS_SUCCESS
    latency_ms = (time.perf_counter() - t0) * 1000.0
    return EchoResult(
        success=success,
        status_code=status_code,
        error_slug=None if success else f"c-echo-status:{status_code:#06x}",
        latency_ms=latency_ms,
    )


async def ping(destination: PACSDestination) -> EchoResult:
    """Issue a single C-ECHO against ``destination``. Async-friendly.

    Does not raise on network errors — returns an :class:`EchoResult`
    with ``success=False`` + a short ``error_slug``. That shape keeps
    the FastAPI handler simple: it just mirrors the result into
    ``application/json``.
    """
    return await asyncio.to_thread(_ping_sync, destination)


__all__ = ["EchoResult", "ping"]
