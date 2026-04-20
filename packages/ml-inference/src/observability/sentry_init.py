# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Sentry SDK initialisation (T126).

Plain-English:
    Sentry is our error tracker. Every uncaught exception on the
    FastAPI server gets packaged into an "event" and shipped to the
    EU-hosted Sentry ingest. Before that happens, we run the entire
    event dict through the PHI scrubber. If the scrubber raises —
    meaning it could not guarantee a clean event — we **drop the
    event on the floor** (fail-closed per FR-029b) and tick the
    ``phi_scrubber_failed_total`` Prometheus counter so ops is
    alerted. Losing a bug report is far cheaper than leaking patient
    data.

References:
    - spec.md §NFR-007 (observability PHI scrubbing)
    - plan.md §Observability Event Catalogue → Sentry captures
    - ``src/observability/phi_scrubber.py`` (T069)
"""
from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional

# sentry-sdk is a soft dependency: if a slim container is built without
# observability the module must still be importable. Downstream callers
# check ``sentry_available()`` before assuming Sentry is live.
try:  # pragma: no cover — import side-effect only.
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    _SENTRY_AVAILABLE = True
except ImportError:  # pragma: no cover
    sentry_sdk = None  # type: ignore[assignment]
    FastApiIntegration = None  # type: ignore[assignment]
    StarletteIntegration = None  # type: ignore[assignment]
    _SENTRY_AVAILABLE = False

# phi_scrubber is owned by T069. We import it lazily so this module can
# be exercised in unit tests that stub out the scrubber.
try:
    from .phi_scrubber import (
        PHIScrubber,
        ScrubberFailure,
        phi_scrubber_failed_total,
    )

    _SCRUBBER_AVAILABLE = True
except Exception:  # pragma: no cover
    PHIScrubber = None  # type: ignore[assignment]
    ScrubberFailure = Exception  # type: ignore[assignment]
    phi_scrubber_failed_total = None  # type: ignore[assignment]
    _SCRUBBER_AVAILABLE = False


logger = logging.getLogger(__name__)

# Module-level singleton PHIScrubber (cheap — pre-compiled regexes).
_scrubber: Optional[Any] = None

# Set by init_sentry; exposed via sentry_available().
_initialized: bool = False


def sentry_available() -> bool:
    """True if Sentry SDK is installed AND init_sentry has run."""
    return _SENTRY_AVAILABLE and _initialized


def _get_scrubber() -> Any:
    """Lazy-build the process-wide PHIScrubber singleton."""
    global _scrubber
    if _scrubber is None and _SCRUBBER_AVAILABLE and PHIScrubber is not None:
        _scrubber = PHIScrubber()
    return _scrubber


def _before_send(event: dict, hint: Mapping[str, Any]) -> Optional[dict]:
    """Sentry ``before_send`` hook — scrubs the event fail-closed.

    - Returns the scrubbed event dict on success (forwarded to Sentry).
    - Returns ``None`` on any scrubber failure → Sentry drops the
      event. Also increments ``phi_scrubber_failed_total`` so the
      PagerDuty alert in plan.md §Alerts fires.
    """
    scrubber = _get_scrubber()
    if scrubber is None:
        # Scrubber not available — refuse to send the event (fail-closed).
        logger.warning("phi_scrubber unavailable — dropping Sentry event")
        if phi_scrubber_failed_total is not None:  # pragma: no cover
            phi_scrubber_failed_total.labels(reason="scrubber_unavailable").inc()
        return None

    try:
        scrubbed = scrubber.scrub_dict(event)
        return scrubbed if isinstance(scrubbed, dict) else None
    except ScrubberFailure as exc:
        logger.error("scrubber failed for Sentry event: %s", exc, exc_info=True)
        if phi_scrubber_failed_total is not None:
            phi_scrubber_failed_total.labels(reason="sentry_before_send").inc()
        return None
    except Exception as exc:  # pragma: no cover — defensive
        logger.error("unexpected scrubber error: %s", exc, exc_info=True)
        if phi_scrubber_failed_total is not None:
            phi_scrubber_failed_total.labels(reason="sentry_unexpected").inc()
        return None


def init_sentry(
    dsn: Optional[str] = None,
    environment: Optional[str] = None,
    release: Optional[str] = None,
    traces_sample_rate: float = 0.1,
    profiles_sample_rate: float = 0.1,
) -> bool:
    """Initialise the Sentry SDK.

    - ``dsn`` — defaults to ``SENTRY_DSN`` env var. The DSN itself
      selects the EU region (``https://...@o0.ingest.de.sentry.io/...``).
    - ``environment`` — ``dev``/``staging``/``prod``. Defaults to env
      var ``LIVERRA_ENV``.
    - ``before_send`` is wired to :func:`_before_send`.
    - Returns True if init succeeded, False otherwise. The FastAPI
      app must be able to start even when Sentry is not configured.
    """
    global _initialized

    dsn = dsn or os.environ.get("SENTRY_DSN")
    if not dsn:
        logger.info("SENTRY_DSN not set — Sentry disabled")
        return False

    if not _SENTRY_AVAILABLE or sentry_sdk is None:
        logger.warning("sentry_sdk not installed — Sentry disabled")
        return False

    environment = environment or os.environ.get("LIVERRA_ENV", "dev")
    release = release or os.environ.get("LIVERRA_RELEASE")

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=release,
            traces_sample_rate=traces_sample_rate,
            profiles_sample_rate=profiles_sample_rate,
            before_send=_before_send,
            send_default_pii=False,  # belt + suspenders with scrubber
            attach_stacktrace=True,
            integrations=[
                StarletteIntegration(transaction_style="endpoint"),
                FastApiIntegration(transaction_style="endpoint"),
            ],
        )
        _initialized = True
        logger.info("Sentry initialised (env=%s)", environment)
        return True
    except Exception as exc:  # pragma: no cover — defensive
        logger.error("Sentry init failed: %s", exc, exc_info=True)
        return False


def install(app: Any) -> None:
    """Idempotent FastAPI attachment hook.

    Sentry's ``FastApiIntegration`` installs middleware automatically
    via ``sentry_sdk.init``; this helper simply ensures init has run
    using the app's environment. Safe to call multiple times.
    """
    if not _initialized:
        init_sentry()


__all__ = [
    "init_sentry",
    "install",
    "sentry_available",
]
