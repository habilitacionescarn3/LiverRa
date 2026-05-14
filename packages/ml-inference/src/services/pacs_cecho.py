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
from typing import Any, Optional

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
    """Fire a DICOM C-ECHO at the destination; fall back to TCP probe.

    When ``use_tls`` is True we wrap the pynetdicom association in a
    standard TLS context and (optionally) pin the server certificate's
    SHA-256 fingerprint. Earlier code accepted these kwargs but ignored
    them — the call always went out cleartext (audit C-PACS-4).
    """
    try:
        # L-PACS-2: probe imports to surface ImportError before we hand
        # off to the thread. The actual usage lives inside
        # ``_pynetdicom_echo``; these two lines exist solely so the
        # ``except ImportError`` branch fires on dev hosts that don't
        # ship pynetdicom (and we degrade to the TCP probe).
        from pynetdicom import AE  # type: ignore  # noqa: F401
        from pynetdicom.sop_class import Verification  # type: ignore  # noqa: F401

        return await asyncio.to_thread(
            _pynetdicom_echo,
            ae_title=ae_title,
            host=host,
            port=port,
            timeout_s=timeout_s,
            use_tls=use_tls,
            cert_fingerprint=cert_fingerprint,
        )
    except ImportError:
        if use_tls:
            # We cannot honour TLS without pynetdicom's TLS-aware
            # AE.associate path. Refuse rather than silently downgrading
            # to a cleartext TCP probe.
            logger.error(
                "pynetdicom not installed — cannot fulfil use_tls=True C-ECHO"
            )
            return CEchoResult(
                reachable=False,
                error="tls_unavailable_pynetdicom_missing",
            )
        logger.info("pynetdicom not installed — falling back to TCP probe")
        return await _tcp_probe(host=host, port=port, timeout_s=timeout_s)
    except Exception as exc:  # noqa: BLE001
        return CEchoResult(reachable=False, error=_scrub(str(exc)))


def _build_tls_context(cert_fingerprint: Optional[str]) -> Any:
    """Return an SSL context that optionally pins the server cert.

    pynetdicom's ``AE.associate(..., tls_args=(ctx, hostname))`` expects a
    pre-built :class:`ssl.SSLContext`. We supply a default secure context
    and, if a fingerprint was provided, validate it in a follow-up
    callback (pynetdicom doesn't expose a fingerprint primitive directly;
    we handle the verification by reading the peer cert after the TLS
    handshake completes).
    """
    import ssl

    ctx = ssl.create_default_context()
    # Require server-cert validation against system trust store; if the
    # operator chose to pin a self-signed CA they'll configure CAfile/
    # CApath out-of-band.
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


def _verify_fingerprint(assoc: Any, expected_fp: str) -> bool:
    """Compare the peer cert SHA-256 fingerprint against the configured pin.

    Returns True when the fingerprints match (case-insensitive, dashes
    and colons normalised). Returns False on any mismatch or extraction
    failure — caller must reject the association.
    """
    import hashlib

    try:
        # pynetdicom 2.x exposes the wrapped socket via the transport;
        # if not available, we can't verify → fail closed.
        sock = getattr(assoc, "socket", None) or getattr(assoc, "transport", None)
        peer_cert = getattr(sock, "getpeercert", lambda binary_form=True: None)(
            binary_form=True
        )
        if not peer_cert:
            return False
        actual = hashlib.sha256(peer_cert).hexdigest().lower()
    except Exception:  # noqa: BLE001
        return False
    norm = expected_fp.replace(":", "").replace("-", "").strip().lower()
    return actual == norm


def _pynetdicom_echo(
    *,
    ae_title: str,
    host: str,
    port: int,
    timeout_s: float,
    use_tls: bool = False,
    cert_fingerprint: Optional[str] = None,
) -> CEchoResult:
    # L-PACS-2: import inline — pynetdicom is an optional runtime dep
    # gated by the ImportError probe in the caller (lines 53-54). Keeping
    # the import local to the function preserves the lazy-load contract
    # for test envs that don't install pynetdicom.
    from pynetdicom import AE  # type: ignore
    from pynetdicom.sop_class import Verification  # type: ignore

    ae = AE(ae_title="LIVERRA")
    ae.add_requested_context(Verification)
    ae.network_timeout = timeout_s
    ae.acse_timeout = timeout_s

    t0 = time.perf_counter()
    associate_kwargs: dict[str, Any] = {"ae_title": ae_title}
    if use_tls:
        try:
            ctx = _build_tls_context(cert_fingerprint)
        except Exception as exc:  # noqa: BLE001
            return CEchoResult(reachable=False, error=_scrub(str(exc)))
        # pynetdicom 2.x: tls_args=(SSLContext, server_hostname)
        associate_kwargs["tls_args"] = (ctx, host)

    assoc = ae.associate(host, int(port), **associate_kwargs)
    try:
        if not assoc.is_established:
            return CEchoResult(reachable=False, error="association_rejected")
        if use_tls and cert_fingerprint:
            if not _verify_fingerprint(assoc, cert_fingerprint):
                return CEchoResult(
                    reachable=False,
                    error="cert_fingerprint_mismatch",
                )
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
