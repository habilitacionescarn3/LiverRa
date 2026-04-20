# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Crypto-shred latency + correctness tests (T334, US9).

Plain-English:
    We simulate the AWS KMS client with a mock that records every
    ``disable_key`` + ``schedule_key_deletion`` call. Two assertions:

      1. ``ScheduleKeyDeletion`` is called exactly once per invocation.
      2. Over 100 iterations the p99 latency is <60 seconds (SC-016).

    The mock returns instantly, so the latency budget in dev is
    essentially the Python overhead. This is deliberately generous —
    the real production constraint is network + AWS, tested in the
    gdpr-erasure-sim.sh script against a live KMS endpoint.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest


def _build_fake_kms_client() -> MagicMock:
    """Return a MagicMock that mimics boto3's KMS client contract."""
    client = MagicMock(name="kms")
    # describe_key → KeyMetadata for idempotent create path (unused here).
    client.describe_key.return_value = {"KeyMetadata": {"KeyId": "stub"}}
    client.disable_key.return_value = {}
    client.schedule_key_deletion.return_value = {"DeletionDate": "2025-12-31T00:00:00Z"}
    return client


@pytest.mark.asyncio
async def test_schedule_case_key_deletion_calls_kms_once() -> None:
    """A single invocation must call disable_key + schedule_key_deletion once each."""
    from src.services.erasure.crypto_shred import (  # type: ignore
        schedule_case_key_deletion,
    )

    fake = _build_fake_kms_client()

    # Patch the lazy factory and the audit emitter (we don't exercise
    # AuditEvent wiring in this unit test).
    with patch(
        "src.services.erasure.crypto_shred._kms_client", return_value=fake
    ), patch(
        "src.services.erasure.crypto_shred._emit_audit",
        new_callable=lambda: _async_noop,
    ):
        await schedule_case_key_deletion(
            "alias/test/case/xyz",
            tenant_id=uuid4(),
            study_id=uuid4(),
            pending_window_days=7,
            incident_path=False,
        )

    assert fake.disable_key.call_count == 1, "disable_key must be called once"
    assert fake.schedule_key_deletion.call_count == 1, "schedule_key_deletion must be called once"

    sk_args = fake.schedule_key_deletion.call_args
    assert sk_args.kwargs["PendingWindowInDays"] == 7


@pytest.mark.asyncio
async def test_crypto_shred_p99_under_60s_over_100_iterations() -> None:
    """Run the mocked call 100× and assert p99 latency is <60s (SC-016).

    With a noop mock this is trivially true, but the test guards
    against future regressions where synchronous IO or heavy
    audit-emission work accidentally lands in the hot path.
    """
    from src.services.erasure.crypto_shred import (  # type: ignore
        schedule_case_key_deletion,
    )

    fake = _build_fake_kms_client()
    iterations = 100
    latencies: list[float] = []

    with patch(
        "src.services.erasure.crypto_shred._kms_client", return_value=fake
    ), patch(
        "src.services.erasure.crypto_shred._emit_audit",
        new_callable=lambda: _async_noop,
    ):
        for _ in range(iterations):
            t0 = time.monotonic()
            await schedule_case_key_deletion(
                "alias/test/case/xyz",
                tenant_id=uuid4(),
                study_id=uuid4(),
                pending_window_days=7,
                incident_path=False,
            )
            latencies.append(time.monotonic() - t0)

    latencies.sort()
    p99 = latencies[int(iterations * 0.99) - 1]
    assert p99 < 60.0, f"p99 latency {p99:.3f}s exceeds 60s SC-016 budget"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _async_noop(*_args: object, **_kwargs: object) -> None:
    """Async no-op used to stand in for the audit emitter."""
    return None
