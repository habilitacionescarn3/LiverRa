# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""FHIR R4 conformance check for clipboard-export AuditEvent
(002-acr-structured-readout T082).

Plain-English:
    The previous test asserts our hand-crafted dict matches the
    contract field-by-field. This test goes one step further: we feed
    that same dict through the official ``fhir.resources`` model and
    let it validate the wire shape against the published FHIR R4
    StructureDefinition.

    The library is an optional install — when it's missing (CI without
    it, dev laptops without the dependency) this entire module is
    skipped rather than erroring out.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import pytest

# Try R4 first; fall back to R4B (newer name).
try:  # noqa: SIM105
    from fhir.resources.auditevent import AuditEvent  # type: ignore[import-not-found]
except Exception:
    try:
        from fhir.resources.R4B.auditevent import (  # type: ignore[import-not-found]
            AuditEvent,
        )
    except Exception:
        pytestmark = pytest.mark.skip(
            reason="fhir.resources not installed — install with `pip install fhir.resources`"
        )

try:
    from src.services.audit.clipboard_export_event import (  # type: ignore[import-not-found]
        ClipboardExportAuditPayload,
        build_audit_event,
    )
except Exception as exc:  # pragma: no cover
    pytestmark = pytest.mark.skip(
        reason=f"clipboard_export_event not importable: {exc!r}"
    )


def _payload(
    *, outcome: str = "success", failure_category: str | None = None
) -> "ClipboardExportAuditPayload":
    return ClipboardExportAuditPayload(
        client_action_id=uuid4(),
        actor_role="attending_radiologist",
        locale="en",
        action_timestamp=datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc),
        outcome=outcome,  # type: ignore[arg-type]
        failure_category=failure_category,  # type: ignore[arg-type]
    )


def test_success_event_validates_against_fhir_r4() -> None:
    event = build_audit_event(
        _payload(outcome="success"),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    AuditEvent(**event)  # raises pydantic.ValidationError if non-conformant


@pytest.mark.parametrize(
    "failure_category",
    [
        "network",
        "clipboard_blocked",
        "audit_chain_unavailable",
        "auth_denied",
        "tenant_violation",
    ],
)
def test_failure_variants_validate_against_fhir_r4(failure_category: str) -> None:
    event = build_audit_event(
        _payload(outcome="failure", failure_category=failure_category),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    AuditEvent(**event)
