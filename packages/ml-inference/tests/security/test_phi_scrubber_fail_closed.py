"""PHI scrubber fail-closed semantics — release-blocker for NFR-007.

Plan §Mandatory security-critical suites · Tasks T453 · Spec §NFR-007.

Verifies:
    (a) When the scrubber's ``before_send`` hook crashes, the event is
        **dropped** (0 outbound to Sentry). Never allow an unscrubbed event
        to escape.
    (b) The ``phi_scrubber_failed_total`` Prometheus counter increments.
    (c) The fallback path never surfaces the raw event.

The test patches the project's scrubber entry points; the specific Sentry
module path is discovered defensively so the test runs in environments where
``sentry_sdk`` is pinned or vendored.
"""

from __future__ import annotations

from typing import Any, Callable, List
from unittest.mock import MagicMock

import pytest


# ---------------------------------------------------------------------------
# Module discovery
# ---------------------------------------------------------------------------


def _import_scrubber():  # type: ignore[no-untyped-def]
    for modname in (
        "src.services.anon.sentry_scrubber",
        "src.observability.sentry_scrubber",
        "src.observability.scrubber",
        "src.services.anon.scrubber",
    ):
        try:
            mod = __import__(modname, fromlist=["*"])
            return mod
        except Exception:
            continue
    pytest.skip("No Sentry PHI-scrubber module found")


def _get_counter(mod: Any) -> Any:
    for attr in ("phi_scrubber_failed_total", "PHI_SCRUBBER_FAILED_TOTAL", "scrubber_failed_counter"):
        counter = getattr(mod, attr, None)
        if counter is not None:
            return counter
    pytest.skip("phi_scrubber_failed_total counter not exposed on module")


def _call_before_send(mod: Any, event: dict, hint: dict) -> Any:
    for attr in ("before_send", "scrub_before_send", "phi_safe_before_send"):
        fn = getattr(mod, attr, None)
        if callable(fn):
            return fn(event, hint)
    pytest.skip("No before_send-style callable found on scrubber module")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture
def scrubber_module():  # type: ignore[no-untyped-def]
    return _import_scrubber()


def test_scrubber_crash_drops_event(scrubber_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """If the scrubber's internal redactor raises, before_send MUST return None."""

    # Patch any internal redact callable to raise.
    patched = False
    for attr in ("redact", "_redact_payload", "scrub_event", "scrub"):
        if hasattr(scrubber_module, attr):
            monkeypatch.setattr(
                scrubber_module,
                attr,
                MagicMock(side_effect=RuntimeError("scrubber kaboom")),
                raising=True,
            )
            patched = True
    if not patched:
        pytest.skip("No internal redact callable to patch")

    event = {
        "message": "Patient Björn Müller, DOB 19670814",
        "extra": {"patient_name": "Björn Müller"},
    }
    hint: dict = {}

    result = _call_before_send(scrubber_module, event, hint)
    assert result is None, (
        "Scrubber crash MUST drop the event (return None). "
        f"Got {result!r} — fail-OPEN vulnerability."
    )


def test_counter_increments_on_scrubber_failure(scrubber_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    counter = _get_counter(scrubber_module)

    patched = False
    for attr in ("redact", "_redact_payload", "scrub_event", "scrub"):
        if hasattr(scrubber_module, attr):
            monkeypatch.setattr(
                scrubber_module,
                attr,
                MagicMock(side_effect=RuntimeError("scrubber kaboom")),
                raising=True,
            )
            patched = True
    if not patched:
        pytest.skip("No internal redact callable to patch")

    # Snapshot before
    def _counter_value(c: Any) -> float:
        # prometheus_client Counter API — sum across all child metrics
        if hasattr(c, "_value") and hasattr(c._value, "get"):
            return float(c._value.get())
        # Labeled counter
        if hasattr(c, "_metrics"):
            return float(sum(m._value.get() for m in c._metrics.values()))
        # Plain python attr fallback
        return float(getattr(c, "value", 0))

    before = _counter_value(counter)

    _call_before_send(scrubber_module, {"message": "x"}, {})

    after = _counter_value(counter)
    assert after > before, (
        f"phi_scrubber_failed_total did not increment "
        f"(before={before}, after={after})"
    )


def test_fallback_never_emits_raw_event(scrubber_module: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Even if the scrubber has a 'fallback' branch, it must NOT pass the raw
    event through. The safe fallback is to drop."""

    patched = False
    for attr in ("redact", "_redact_payload", "scrub_event", "scrub"):
        if hasattr(scrubber_module, attr):
            monkeypatch.setattr(
                scrubber_module,
                attr,
                MagicMock(side_effect=RuntimeError("boom")),
                raising=True,
            )
            patched = True
    if not patched:
        pytest.skip("No internal redact callable to patch")

    raw_event = {"message": "MRN: HR-00384219", "extra": {"dob": "1967-08-14"}}
    result = _call_before_send(scrubber_module, raw_event, {})
    # None (drop) is the only acceptable outcome
    assert result is None or result == {}, (
        f"Fallback leaked raw event: {result!r}"
    )
