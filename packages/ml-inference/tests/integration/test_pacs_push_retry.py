# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""T276 — PACS push retry state-machine integration tests.

Plain-English:
    Drive the :mod:`retry_state_machine` through a failure burst and
    assert:

      1. ``retry_count`` monotonically climbs.
      2. ``next_attempt_at`` steps through the 1→2→4→8→16→32 min
         exponential backoff.
      3. A raw pynetdicom traceback containing a patient name gets
         PHI-scrubbed before it lands in ``last_error``.
      4. After :data:`MAX_RETRY_COUNT` consecutive failures the FSM
         moves to :data:`STATE_FAILED` and stops scheduling attempts.

    The C-STORE transport is faked with a simple async sender so the
    test is hermetic (no pynetdicom / network).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Iterable

import pytest

from src.services.pacs_push.retry_state_machine import (
    BACKOFF_SCHEDULE_MIN,
    DeliveryRecord,
    DemoCasePushRejected,
    MAX_RETRY_COUNT,
    STATE_ACKNOWLEDGED,
    STATE_FAILED,
    STATE_PENDING,
    advance,
    on_failure,
    on_success,
    start,
)


class _FakePushFailure:
    all_acknowledged = False
    error_message = "pynetdicom.association.Exception: unable to store for Iosif Stalin MRN=12345"
    artifacts: Iterable[object] = ()


class _FakePushSuccess:
    all_acknowledged = True
    error_message = None
    artifacts: Iterable[object] = ()


@pytest.mark.asyncio
async def test_exponential_backoff_schedule() -> None:
    record = DeliveryRecord(
        id="d1",
        report_id="r1",
        destination_ae_title="HOSP_AE",
        artifact_type="seg",
    )

    # Six consecutive failures — walk the backoff schedule.
    now = datetime(2026, 4, 19, tzinfo=timezone.utc)

    async def _fail() -> _FakePushFailure:
        return _FakePushFailure()

    prior_next = None
    for i in range(1, MAX_RETRY_COUNT + 1):
        now = now + timedelta(seconds=5)
        outcome = await advance(record, _fail, now=now)
        assert outcome.audit_category == "pacs_push_failure"
        assert record.retry_count == i
        if i < MAX_RETRY_COUNT:
            assert record.status == STATE_PENDING
            expected_min = BACKOFF_SCHEDULE_MIN[i - 1]
            expected = now + timedelta(minutes=expected_min)
            assert record.next_attempt_at == expected, (
                f"attempt {i}: expected next_attempt_at={expected}, "
                f"got {record.next_attempt_at}"
            )
        else:
            # 6th failure → terminal failed state, no retry scheduled.
            assert record.status == STATE_FAILED
            assert record.next_attempt_at is None


@pytest.mark.asyncio
async def test_phi_scrubbed_in_last_error() -> None:
    record = DeliveryRecord(
        id="d2",
        report_id="r2",
        destination_ae_title="HOSP_AE",
        artifact_type="sr",
    )

    async def _fail() -> _FakePushFailure:
        return _FakePushFailure()

    await advance(record, _fail)
    err = record.last_error or ""
    # The literal patient-name + MRN MUST NOT survive into the DB row.
    assert "Iosif Stalin" not in err, f"last_error leaked a patient name: {err!r}"
    assert "MRN=12345" not in err, f"last_error leaked an MRN: {err!r}"
    # But we still have *something* to debug with.
    assert err.strip(), "last_error was empty; callers need a hint"


@pytest.mark.asyncio
async def test_success_terminal_transition() -> None:
    record = DeliveryRecord(
        id="d3",
        report_id="r3",
        destination_ae_title="HOSP_AE",
        artifact_type="seg",
    )

    async def _ok() -> _FakePushSuccess:
        return _FakePushSuccess()

    outcome = await advance(record, _ok)
    assert record.status == STATE_ACKNOWLEDGED
    assert record.acknowledged_at is not None
    assert outcome.audit_category == "pacs_push_success"


def test_demo_case_start_rejection() -> None:
    record = DeliveryRecord(
        id="d4",
        report_id="r4",
        destination_ae_title="HOSP_AE",
        artifact_type="seg",
        sample_case_flag=True,
    )

    with pytest.raises(DemoCasePushRejected):
        start(record)


@pytest.mark.asyncio
async def test_demo_case_advance_returns_slug() -> None:
    record = DeliveryRecord(
        id="d5",
        report_id="r5",
        destination_ae_title="HOSP_AE",
        artifact_type="seg",
        sample_case_flag=True,
    )

    async def _never() -> _FakePushSuccess:  # pragma: no cover — should not be called
        raise AssertionError("sender must not be invoked for demo-case records")

    outcome = await advance(record, _never)
    assert outcome.reject_reason_slug == "demo-case-no-pacs-push"
    assert outcome.audit_category == "pacs_push_failure"


def test_on_failure_idempotent_in_scheduling() -> None:
    """Calling on_failure twice shouldn't double-book the schedule."""
    record = DeliveryRecord(
        id="d6",
        report_id="r6",
        destination_ae_title="HOSP_AE",
        artifact_type="sr",
    )
    base = datetime(2026, 4, 19, tzinfo=timezone.utc)
    on_failure(record, "err", now=base)
    first_next = record.next_attempt_at
    on_failure(record, "err", now=base + timedelta(seconds=1))
    # Every new failure recomputes — monotonicity matters but exact
    # equality after a re-call isn't required; we just assert the
    # schedule didn't regress below the first attempt.
    assert record.next_attempt_at >= first_next  # type: ignore[operator]
