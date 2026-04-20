# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DICOM C-ECHO ping wrapper used by the admin PACS-destination flow (T432).

Plain-English:
    C-ECHO is DICOM's "are you there?" — the modern-era PING for imaging
    servers. Before we accept a hospital's PACS destination config, we
    need to prove we can reach it. We prefer ``pynetdicom`` at runtime;
    if it's not installed or a network layer blocks the actual probe
    during dev/test, we fall back to a best-effort TCP connect so the
    admin still sees an actionable result.

Returns a plain dataclass (no exceptions on unreachable) because the
caller surfaces the ``error`` string in the UI.
"""
from __future__ import annotations

import asyncio
import logging
import socket
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CEchoResult:
    reachable: bool
    round_trip_ms: Optional[int] = None
    scanner_ae_responded: Optional[str] = None
    error: Optional[str] = None


async def ping(
    *,
    ae_title: str,
    host: str,
    port: int,
    use_tls: bool = False,
    cert_fingerprint: Optional[str] = None,
    timeout_s: float = 5.0,
) -> CEchoResult:
    """Fire a DICOM C-ECHO at the destination; fall back to TCP probe."""
    try:
        from pynetdicom import AE  # type: ignore
        from pynetdicom.sop_class import Verification  # type: ignore

        return await asyncio.to_thread(
            _pynetdicom_echo,
            ae_title=ae_title,
            host=host,
            port=port,
            timeout_s=timeout_s,
        )
    except ImportError:
        logger.info("pynetdicom not installed — falling back to TCP probe")
        return await _tcp_probe(host=host, port=port, timeout_s=timeout_s)
    except Exception as exc:  # noqa: BLE001
        return CEchoResult(reachable=False, error=_scrub(str(exc)))


def _pynetdicom_echo(
    *, ae_title: str, host: str, port: int, timeout_s: float
) -> CEchoResult:
    from pynetdicom import AE  # type: ignore
    from pynetdicom.sop_class import Verification  # type: ignore

    ae = AE(ae_title="LIVERRA")
    ae.add_requested_context(Verification)
    ae.network_timeout = timeout_s
    ae.acse_timeout = timeout_s

    t0 = time.perf_counter()
    assoc = ae.associate(host, int(port), ae_title=ae_title)
    try:
        if not assoc.is_established:
            return CEchoResult(reachable=False, error="association_rejected")
        status = assoc.send_c_echo()
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        ok = bool(status and int(getattr(status, "Status", 0)) == 0x0000)
        return CEchoResult(
            reachable=ok,
            round_trip_ms=elapsed_ms,
            scanner_ae_responded=ae_title,
            error=None if ok else "c_echo_non_success_status",
        )
    finally:
        if assoc.is_established:
            assoc.release()


async def _tcp_probe(*, host: str, port: int, timeout_s: float) -> CEchoResult:
    def _probe() -> CEchoResult:
        t0 = time.perf_counter()
        try:
            with socket.create_connection((host, port), timeout=timeout_s):
                return CEchoResult(
                    reachable=True,
                    round_trip_ms=int((time.perf_counter() - t0) * 1000),
                )
        except OSError as exc:
            return CEchoResult(reachable=False, error=_scrub(str(exc)))

    return await asyncio.to_thread(_probe)


def _scrub(msg: str) -> str:
    """Strip anything that could be a PHI leak from an upstream error."""
    # Never echo the full error verbatim; only surface the error class hint.
    if "refused" in msg.lower():
        return "connection_refused"
    if "timed out" in msg.lower() or "timeout" in msg.lower():
        return "timeout"
    if "unreachable" in msg.lower():
        return "host_unreachable"
    if "resolve" in msg.lower() or "getaddrinfo" in msg.lower():
        return "dns_error"
    return "connection_failed"
