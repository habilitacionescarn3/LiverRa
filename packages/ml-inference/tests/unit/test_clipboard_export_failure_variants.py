# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Parametrized outcome-code matrix — clipboard-export failure variants
(002-acr-structured-readout T083).

Plain-English:
    contracts/audit-event.md §2 maps each ``failure_category`` to a
    FHIR ``outcome`` code:

      network                  → "4"  (minor)
      clipboard_blocked        → "4"  (minor)
      audit_chain_unavailable  → "4"  (minor)
      auth_denied              → "8"  (serious)
      tenant_violation         → "8"  (serious)

    This test pins that table directly so any future contract drift
    surfaces as a parametrized-case failure.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

try:
    from src.services.audit.clipboard_export_event import (  # type: ignore[import-not-found]
        ClipboardExportAuditPayload,
        build_audit_event,
    )
    from src.services.audit.fhir_extensions import (  # type: ignore[import-not-found]
        AUDIT_FAILURE_CATEGORY,
    )
except Exception as exc:  # pragma: no cover
    pytestmark = pytest.mark.skip(
        reason=f"clipboard_export_event not importable: {exc!r}"
    )


OUTCOME_MATRIX = [
    ("network", "4"),
    ("clipboard_blocked", "4"),
    ("audit_chain_unavailable", "4"),
    ("auth_denied", "8"),
    ("tenant_violation", "8"),
]


@pytest.mark.parametrize("failure_category,expected_outcome", OUTCOME_MATRIX)
def test_failure_category_outcome_mapping(
    failure_category: str, expected_outcome: str
) -> None:
    payload = ClipboardExportAuditPayload(
        client_action_id=uuid4(),
        actor_role="attending_radiologist",
        locale="en",
        action_timestamp=datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc),
        outcome="failure",
        failure_category=failure_category,  # type: ignore[arg-type]
    )

    event = build_audit_event(
        payload, actor_id=uuid4(), analysis_id=uuid4(), tenant_id=uuid4()
    )

    assert event["outcome"] == expected_outcome, (
        f"failure_category={failure_category} expected outcome={expected_outcome}, "
        f"got {event['outcome']}"
    )

    # Failure-category extension must also be present with the matching code.
    fc_ext = next(
        (e for e in event["extension"] if e["url"] == AUDIT_FAILURE_CATEGORY),
        None,
    )
    assert fc_ext is not None, "expected failure-category extension on failure event"
    assert fc_ext["valueCode"] == failure_category
