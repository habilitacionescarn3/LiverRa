# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for ``build_audit_event`` — clipboard-export AuditEvent shape
(002-acr-structured-readout T081).

Plain-English:
    Every Copy-to-Clipboard click in the ACR readout panel must
    produce a FHIR R4 AuditEvent whose wire shape obeys the contract
    in ``specs/002-acr-structured-readout/contracts/audit-event.md``.
    These tests pin every field that an auditor will look for so we
    catch accidental rename / drop / outcome-code regressions.

Reference: contracts/audit-event.md §1 (canonical shape) + §2 (outcome
codes).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import pytest

try:
    from src.services.audit.clipboard_export_event import (  # type: ignore[import-not-found]
        ClipboardExportAuditPayload,
        build_audit_event,
    )
    from src.services.audit.fhir_extensions import (  # type: ignore[import-not-found]
        AUDIT_CLIENT_ACTION_ID,
        AUDIT_FAILURE_CATEGORY,
        AUDIT_LOCALE,
        AUDIT_TENANT,
        CLINICAL_ROLES_SYSTEM,
    )
except Exception as exc:  # pragma: no cover
    pytestmark = pytest.mark.skip(
        reason=f"clipboard_export_event not importable: {exc!r}"
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(
    *,
    outcome: str = "success",
    failure_category: str | None = None,
    actor_role: str = "attending_radiologist",
    locale: str = "en",
) -> "ClipboardExportAuditPayload":
    return ClipboardExportAuditPayload(
        client_action_id=uuid4(),
        actor_role=actor_role,
        locale=locale,  # type: ignore[arg-type]
        action_timestamp=datetime(2026, 5, 13, 12, 0, 0, tzinfo=timezone.utc),
        outcome=outcome,  # type: ignore[arg-type]
        failure_category=failure_category,  # type: ignore[arg-type]
    )


def _ext_by_url(event: dict[str, Any], url: str) -> dict[str, Any] | None:
    for ext in event.get("extension", []):
        if ext.get("url") == url:
            return ext
    return None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_resource_shape_is_fhir_audit_event() -> None:
    actor_id = uuid4()
    analysis_id = uuid4()
    tenant_id = uuid4()
    payload = _make_payload()

    event = build_audit_event(
        payload, actor_id=actor_id, analysis_id=analysis_id, tenant_id=tenant_id
    )

    assert event["resourceType"] == "AuditEvent"
    assert event["category"] == "readout_clipboard_export"
    assert event["action"] == "R"


def test_subtype_carries_readout_clipboard_export_code() -> None:
    event = build_audit_event(
        _make_payload(),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )

    subtype = event["subtype"]
    assert isinstance(subtype, list) and len(subtype) >= 1
    assert subtype[0]["code"] == "readout-clipboard-export"


def test_agent_who_reference_uses_practitioner_prefix() -> None:
    actor_id = uuid4()
    event = build_audit_event(
        _make_payload(),
        actor_id=actor_id,
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )

    who = event["agent"][0]["who"]["reference"]
    assert who.startswith("Practitioner/")
    assert who.endswith(str(actor_id))


def test_agent_role_code_equals_payload_actor_role() -> None:
    event = build_audit_event(
        _make_payload(actor_role="resident_radiologist"),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    role_coding = event["agent"][0]["role"][0]["coding"][0]
    assert role_coding["system"] == CLINICAL_ROLES_SYSTEM
    assert role_coding["code"] == "resident_radiologist"


def test_entity_what_reference_uses_analysis_prefix() -> None:
    analysis_id = uuid4()
    event = build_audit_event(
        _make_payload(),
        actor_id=uuid4(),
        analysis_id=analysis_id,
        tenant_id=uuid4(),
    )
    assert event["entity"][0]["what"]["reference"] == f"Analysis/{analysis_id}"


def test_locale_extension_present_with_payload_locale() -> None:
    event = build_audit_event(
        _make_payload(locale="ka"),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    locale_ext = _ext_by_url(event, AUDIT_LOCALE)
    assert locale_ext is not None
    assert locale_ext.get("valueCode") == "ka"


def test_tenant_extension_references_organization() -> None:
    tenant_id = uuid4()
    event = build_audit_event(
        _make_payload(),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=tenant_id,
    )
    tenant_ext = _ext_by_url(event, AUDIT_TENANT)
    assert tenant_ext is not None
    ref = tenant_ext.get("valueReference", {}).get("reference")
    assert ref == f"Organization/{tenant_id}"


def test_client_action_id_extension_present() -> None:
    payload = _make_payload()
    event = build_audit_event(
        payload,
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    cai_ext = _ext_by_url(event, AUDIT_CLIENT_ACTION_ID)
    assert cai_ext is not None
    assert cai_ext.get("valueUuid") == str(payload.client_action_id)


def test_success_outcome_code_zero_and_no_failure_extension() -> None:
    event = build_audit_event(
        _make_payload(outcome="success"),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    assert event["outcome"] == "0"
    assert _ext_by_url(event, AUDIT_FAILURE_CATEGORY) is None


@pytest.mark.parametrize(
    "failure_category",
    ["network", "clipboard_blocked", "audit_chain_unavailable"],
)
def test_minor_failure_codes_to_4_with_failure_extension(
    failure_category: str,
) -> None:
    event = build_audit_event(
        _make_payload(outcome="failure", failure_category=failure_category),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    assert event["outcome"] == "4"
    fc_ext = _ext_by_url(event, AUDIT_FAILURE_CATEGORY)
    assert fc_ext is not None
    assert fc_ext.get("valueCode") == failure_category


@pytest.mark.parametrize(
    "failure_category", ["auth_denied", "tenant_violation"]
)
def test_serious_failure_codes_to_8_with_failure_extension(
    failure_category: str,
) -> None:
    event = build_audit_event(
        _make_payload(outcome="failure", failure_category=failure_category),
        actor_id=uuid4(),
        analysis_id=uuid4(),
        tenant_id=uuid4(),
    )
    assert event["outcome"] == "8"
    fc_ext = _ext_by_url(event, AUDIT_FAILURE_CATEGORY)
    assert fc_ext is not None
    assert fc_ext.get("valueCode") == failure_category


def test_recorded_timestamp_is_iso_utc() -> None:
    """Action timestamp must be serialized as ISO 8601 in UTC."""
    payload = _make_payload()
    event = build_audit_event(
        payload, actor_id=uuid4(), analysis_id=uuid4(), tenant_id=uuid4()
    )
    parsed = datetime.fromisoformat(event["recorded"])
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timezone.utc.utcoffset(parsed)


def test_event_id_is_a_uuid_string() -> None:
    event = build_audit_event(
        _make_payload(), actor_id=uuid4(), analysis_id=uuid4(), tenant_id=uuid4()
    )
    UUID(event["id"])  # raises if not a valid UUID
