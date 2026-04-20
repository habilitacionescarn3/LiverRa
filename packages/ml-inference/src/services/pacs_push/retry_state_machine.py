# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""PACS push retry state machine (T262, extended by T430).

Plain-English analogy:
    Think of this as a patient nurse at a reception desk. When a
    ReportDelivery row is created, it starts at ``pending``. When the
    Celery task picks it up, we flip to ``sending``. If C-STORE returns
    0x0000 we go to ``acknowledged``; anything else bumps ``retry_count``
    and schedules the next try in 1, 2, 4, 8, 16, 32, 60 minutes (capped
    at 6 attempts — research §B.6). After the 6th failure we stop and
    move to ``failed`` → the operator is offered a ``manual_fallback``
    path (download the SEG/SR and C-STORE them themselves).

    Every ``last_error`` we write is PHI-scrubbed first so a patient
    name that leaked into a pynetdicom traceback never lands in Postgres.

Demo-case invariant (T430):
    ``advance()`` ALSO refuses to push DemoCase-backed reports. That's a
    server-side safety net on top of the frontend SampleDataBadge — if
    the UI is bypassed, the FSM still says "no" and the caller surfaces
    the ``demo-case-no-pacs-push`` slug.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Iterable, Optional

try:  # pragma: no cover — fail-closed scrubber is installed in all envs
    from src.observability.phi_scrubber import PHIScrubber, ScrubberFailure
except ImportError:  # pragma: no cover — test stubs
    PHIScrubber = None  # type: ignore[assignment,misc]

    class ScrubberFailure(Exception):  # type: ignore[no-redef]
        pass

logger = logging.getLogger(__name__)


# Research §B.6: 1→2→4→8→16→32→60 min; we keep only 6 steps so the 6th
# attempt fires at minute 32 from the first failure and the 7th would
# have been at minute 60 (not taken — delivery is marked ``failed`` instead).
BACKOFF_SCHEDULE_MIN: tuple[int, ...] = (1, 2, 4, 8, 16, 32)

# Maximum retry attempts before giving up. Attempts 0..5 inclusive, so the
# 6th retry (``retry_count=6``) is the trigger to mark failed.
MAX_RETRY_COUNT: int = 6


# Valid FSM states, mirroring ``ReportDelivery.status`` enum in data-model.md.
STATE_PENDING = "pending"
STATE_SENDING = "sending"
STATE_ACKNOWLEDGED = "acknowledged"
STATE_FAILED = "failed"
STATE_MANUAL_FALLBACK = "manual_fallback"

# Demo-case rejection slug (T430 / FR-042).
DEMO_CASE_REJECTION_SLUG: str = "demo-case-no-pacs-push"


@dataclass
class DeliveryRecord:
    """In-memory projection of one ``ReportDelivery`` row.

    The FSM is DB-agnostic: the caller hands it this projection and gets
    back a mutated one. Persistence lives in ``tasks/push_to_pacs.py``
    (T264) — that's what keeps this module trivially unit-testable.
    """

    id: str
    report_id: str
    destination_ae_title: str
    artifact_type: str  # "seg" or "sr"
    status: str = STATE_PENDING
    retry_count: int = 0
    last_error: str | None = None
    next_attempt_at: datetime | None = None
    first_sent_at: datetime | None = None
    last_attempted_at: datetime | None = None
    acknowledged_at: datetime | None = None
    sample_case_flag: bool = False  # T430: set from Report.sample_case_flag


@dataclass
class AdvanceOutcome:
    """What :func:`advance` tells its caller to do next."""

    record: DeliveryRecord
    should_retry: bool
    reject_reason_slug: str | None = None  # set on demo-case rejection
    audit_category: str | None = None  # "pacs_push_attempt" / "success" / "failure"


class DemoCasePushRejected(Exception):
    """Raised by :func:`start` when a DemoCase is asked to push (T430)."""

    slug: str = DEMO_CASE_REJECTION_SLUG


def _scrub(message: str | None, *, scrubber: Optional["PHIScrubber"] = None) -> str | None:
    """PHI-scrub ``last_error`` before writing. Fail-closed on scrubber errors."""
    if not message:
        return message
    if PHIScrubber is None:
        # Test / dev build without the scrubber — be conservative and truncate
        # anything that smells like a free-text traceback.
        return message.splitlines()[0][:200]
    try:
        inst = scrubber or PHIScrubber()
        return inst.scrub_string(message)[:500]
    except ScrubberFailure:
        logger.error("PHI scrubber failure on PACS retry error message")
        return "redacted-scrubber-failure"


def _backoff_delta(retry_count: int) -> timedelta:
    """Wait interval BEFORE the ``retry_count``-th attempt.

    ``retry_count`` of 0 → fire immediately; of 1 → 1 min; of 6 → treated
    as exhausted upstream.
    """
    if retry_count <= 0:
        return timedelta(0)
    idx = min(retry_count - 1, len(BACKOFF_SCHEDULE_MIN) - 1)
    return timedelta(minutes=BACKOFF_SCHEDULE_MIN[idx])


def start(record: DeliveryRecord, *, now: datetime | None = None) -> DeliveryRecord:
    """Transition ``pending`` → ``sending``. Enforces demo-case invariant (T430).

    Raises :class:`DemoCasePushRejected` when ``record.sample_case_flag``
    is True — per FR-042 a DemoCase-backed Report must NEVER reach a
    real PACS.
    """
    if record.sample_case_flag:
        raise DemoCasePushRejected(
            "Cannot push a sample-data report to a real PACS destination."
        )
    if record.status not in (STATE_PENDING, STATE_FAILED):
        logger.warning(
            "FSM.start called with status=%s (expected %s|%s); returning unchanged",
            record.status, STATE_PENDING, STATE_FAILED,
        )
        return record

    ts = now or datetime.now(timezone.utc)
    record.status = STATE_SENDING
    record.last_attempted_at = ts
    if record.first_sent_at is None:
        record.first_sent_at = ts
    return record


def on_success(record: DeliveryRecord, *, now: datetime | None = None) -> DeliveryRecord:
    """Transition ``sending`` → ``acknowledged``. Terminal success."""
    ts = now or datetime.now(timezone.utc)
    record.status = STATE_ACKNOWLEDGED
    record.acknowledged_at = ts
    record.last_error = None
    record.next_attempt_at = None
    return record


def on_failure(
    record: DeliveryRecord,
    error_message: str | None,
    *,
    now: datetime | None = None,
    scrubber: Optional["PHIScrubber"] = None,
) -> DeliveryRecord:
    """Bump ``retry_count`` + schedule the next attempt OR give up.

    After :data:`MAX_RETRY_COUNT` we move to :data:`STATE_FAILED` and
    leave ``next_attempt_at=None`` so no Celery beat picks us up again.
    The operator then has to click "Download for manual push" in the UI
    which flips the row to :data:`STATE_MANUAL_FALLBACK`.
    """
    ts = now or datetime.now(timezone.utc)
    record.retry_count += 1
    record.last_error = _scrub(error_message, scrubber=scrubber)
    record.last_attempted_at = ts

    if record.retry_count >= MAX_RETRY_COUNT:
        record.status = STATE_FAILED
        record.next_attempt_at = None
    else:
        record.status = STATE_PENDING
        record.next_attempt_at = ts + _backoff_delta(record.retry_count)
    return record


def to_manual_fallback(
    record: DeliveryRecord, *, now: datetime | None = None
) -> DeliveryRecord:
    """Operator-initiated terminal transition from ``failed``."""
    if record.status != STATE_FAILED:
        logger.warning(
            "manual_fallback requested from non-failed state=%s", record.status
        )
    record.status = STATE_MANUAL_FALLBACK
    record.last_attempted_at = now or datetime.now(timezone.utc)
    return record


async def advance(
    record: DeliveryRecord,
    sender: Callable[[], Awaitable["PushLike"]],
    *,
    now: datetime | None = None,
    scrubber: Optional["PHIScrubber"] = None,
) -> AdvanceOutcome:
    """Run one attempt: ``pending → sending → (acknowledged|pending|failed)``.

    ``sender`` is an awaitable that returns an object exposing a
    boolean ``all_acknowledged`` + optional ``error_message`` /
    ``artifacts``. We decouple from :mod:`storescu` so unit tests can
    inject a fake without importing pynetdicom.
    """
    if record.status == STATE_ACKNOWLEDGED:
        return AdvanceOutcome(record=record, should_retry=False, audit_category="pacs_push_success")

    try:
        start(record, now=now)
    except DemoCasePushRejected:
        return AdvanceOutcome(
            record=record,
            should_retry=False,
            reject_reason_slug=DEMO_CASE_REJECTION_SLUG,
            audit_category="pacs_push_failure",
        )

    try:
        push = await sender()
    except Exception as exc:  # noqa: BLE001 — convert into FSM failure edge
        message = f"sender-exception:{type(exc).__name__}:{exc}"
        on_failure(record, message, now=now, scrubber=scrubber)
        return AdvanceOutcome(
            record=record,
            should_retry=record.status != STATE_FAILED,
            audit_category="pacs_push_failure",
        )

    if getattr(push, "all_acknowledged", False):
        on_success(record, now=now)
        return AdvanceOutcome(
            record=record, should_retry=False, audit_category="pacs_push_success"
        )

    reason_parts: list[str] = []
    if getattr(push, "error_message", None):
        reason_parts.append(str(push.error_message))
    for art in getattr(push, "artifacts", []) or []:
        if not getattr(art, "acknowledged", False):
            reason_parts.append(
                f"{getattr(art, 'artifact_type', '?')}:{getattr(art, 'error_message', '?')}"
            )
    message = "; ".join(reason_parts) or "unknown-push-failure"
    on_failure(record, message, now=now, scrubber=scrubber)
    return AdvanceOutcome(
        record=record,
        should_retry=record.status != STATE_FAILED,
        audit_category="pacs_push_failure",
    )


class PushLike:  # pragma: no cover — typing-only protocol stand-in
    """Structural type hint for the object :func:`advance` expects back."""

    all_acknowledged: bool
    error_message: str | None
    artifacts: Iterable[object]


__all__ = [
    "DeliveryRecord",
    "AdvanceOutcome",
    "DemoCasePushRejected",
    "BACKOFF_SCHEDULE_MIN",
    "MAX_RETRY_COUNT",
    "STATE_PENDING",
    "STATE_SENDING",
    "STATE_ACKNOWLEDGED",
    "STATE_FAILED",
    "STATE_MANUAL_FALLBACK",
    "DEMO_CASE_REJECTION_SLUG",
    "start",
    "on_success",
    "on_failure",
    "to_manual_fallback",
    "advance",
]
