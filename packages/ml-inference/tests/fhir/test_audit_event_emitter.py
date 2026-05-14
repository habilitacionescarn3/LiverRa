# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.services.fhir.audit_event_emitter`.

The emitter is the single funnel that pairs a FHIR AuditEvent with a
chain-of-hashes row. Tests cover:

  * PHI scrubbing runs before Medplum POST and before chain write.
  * Medplum POST receiving no ``id`` raises (FR-029b fail-closed).
  * Required FHIR R4 fields are emitted (``type``, ``source``,
    ``recorded``, ``agent``, ``entity``, ``subtype``, ``outcome``).
  * LiverRa extensions (permission key + model version) attach when
    set on the ``DomainAuditEvent``.

We do NOT touch real Postgres or Medplum — every collaborator is
swapped for a small in-memory test double.
"""
from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from src.observability.phi_scrubber import PHIScrubber
from src.services.audit.chain_of_hashes import AuditChainRow
from src.services.fhir.audit_event_emitter import (
    AuditEventEmitter,
    DomainAuditEvent,
)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _FakeMedplum:
    """In-memory Medplum stand-in. Captures every POST."""

    def __init__(self, *, return_id: str | None = "fhir-id-42") -> None:
        self.return_id = return_id
        self.posted: list[dict[str, Any]] = []

    async def create_resource(self, resource):  # noqa: ANN001 — protocol
        self.posted.append(dict(resource))
        if self.return_id is None:
            return {}  # simulate Medplum returning no id
        return {**dict(resource), "id": self.return_id}


class _FakeChainWriter:
    """In-memory chain writer. Captures every write."""

    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []

    async def write(self, *, event_dict, tenant_id, session):  # noqa: ANN001
        self.writes.append(
            {"event_dict": dict(event_dict), "tenant_id": tenant_id, "session": session}
        )
        return AuditChainRow(
            tenant_id=tenant_id,
            sequence_no=len(self.writes),
            leaf_hash=b"\x00" * 32,
            prev_leaf_hash=b"\x00" * 32,
            canonical_json="{}",
            written_at=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
        )


def _event(**over: Any) -> DomainAuditEvent:
    """Build a minimal valid ``DomainAuditEvent`` with overrides."""
    return DomainAuditEvent(
        action_code=over.get("action_code", "inference_stage_start"),
        outcome=over.get("outcome", "0"),
        actor_reference=over.get("actor_reference", "Device/liverra-worker"),
        entity_references=over.get("entity_references", ["Basic/analysis-a-1"]),
        permission_key=over.get("permission_key"),
        model_version=over.get("model_version"),
        extra_extensions=over.get("extra_extensions", []),
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_emit_writes_through_scrubber_to_medplum_then_chain() -> None:
    medplum = _FakeMedplum(return_id="fhir-123")
    chain = _FakeChainWriter()
    scrubber = PHIScrubber()
    emitter = AuditEventEmitter(medplum, chain, scrubber)

    tenant = uuid4()
    row = await emitter.emit(_event(), tenant_id=tenant, session=object())

    # Medplum POST happened exactly once, with a FHIR resource.
    assert len(medplum.posted) == 1
    posted = medplum.posted[0]
    assert posted["resourceType"] == "AuditEvent"
    # Chain write happened exactly once.
    assert len(chain.writes) == 1
    # The Medplum-issued id is mirrored into the chain payload (binds the
    # chain row to the FHIR resource identity).
    chain_payload = chain.writes[0]["event_dict"]
    assert chain_payload["id"] == "fhir-123"
    assert chain.writes[0]["tenant_id"] == tenant
    assert row.tenant_id == tenant


# ---------------------------------------------------------------------------
# Required FHIR R4 fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_required_fhir_r4_fields_present_on_posted_resource() -> None:
    medplum = _FakeMedplum()
    chain = _FakeChainWriter()
    emitter = AuditEventEmitter(medplum, chain, PHIScrubber())

    await emitter.emit(_event(), tenant_id=uuid4(), session=object())
    posted = medplum.posted[0]

    # Every R4-required AuditEvent field present.
    assert posted["resourceType"] == "AuditEvent"
    assert "type" in posted
    assert posted["type"]["system"].endswith("/CodeSystem/audit-event-type")
    assert "subtype" in posted and isinstance(posted["subtype"], list)
    assert "recorded" in posted
    assert posted["recorded"].endswith("Z")  # ISO 8601 UTC
    assert "outcome" in posted
    assert "agent" in posted and isinstance(posted["agent"], list)
    assert posted["agent"][0]["who"]["reference"].startswith("Device/")
    assert "source" in posted
    assert posted["source"]["observer"]["reference"].startswith("Device/")
    assert "entity" in posted
    assert posted["entity"][0]["what"]["reference"] == "Basic/analysis-a-1"


# ---------------------------------------------------------------------------
# Extensions wiring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_permission_key_and_model_version_attach_as_extensions() -> None:
    """LiverRa-specific extensions show up in the FHIR payload when set."""
    medplum = _FakeMedplum()
    chain = _FakeChainWriter()
    emitter = AuditEventEmitter(medplum, chain, PHIScrubber())

    event = _event(permission_key="report.read", model_version="abc-sha-1234")
    await emitter.emit(event, tenant_id=uuid4(), session=object())

    posted = medplum.posted[0]
    assert "extension" in posted
    urls = [e["url"] for e in posted["extension"]]
    assert any("permission-checked" in u for u in urls)
    assert any("model-version" in u for u in urls)


# ---------------------------------------------------------------------------
# FR-029b — fail-closed on missing Medplum id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_medplum_id_raises_before_chain_write() -> None:
    """FR-029b: chain row must NOT be written without a FHIR anchor id."""
    medplum = _FakeMedplum(return_id=None)
    chain = _FakeChainWriter()
    emitter = AuditEventEmitter(medplum, chain, PHIScrubber())

    with pytest.raises(RuntimeError, match="returned no id"):
        await emitter.emit(_event(), tenant_id=uuid4(), session=object())

    # Chain MUST NOT have been written.
    assert chain.writes == []


# ---------------------------------------------------------------------------
# PHI scrubber failure propagates
# ---------------------------------------------------------------------------


class _FailingScrubber:
    """Stand-in that always raises ``ScrubberFailure`` — emulates a regex
    crash inside the real scrubber. We assert the failure propagates and
    the chain stays untouched."""

    def scrub_dict(self, _obj):  # noqa: ANN001
        from src.observability.phi_scrubber import ScrubberFailure

        raise ScrubberFailure("simulated scrub crash")


@pytest.mark.asyncio
async def test_scrubber_failure_propagates_and_blocks_writes() -> None:
    medplum = _FakeMedplum()
    chain = _FakeChainWriter()
    emitter = AuditEventEmitter(medplum, chain, _FailingScrubber())  # type: ignore[arg-type]

    from src.observability.phi_scrubber import ScrubberFailure

    with pytest.raises(ScrubberFailure):
        await emitter.emit(_event(), tenant_id=uuid4(), session=object())

    # Neither Medplum NOR chain saw the event.
    assert medplum.posted == []
    assert chain.writes == []


# ---------------------------------------------------------------------------
# PHI scrubbing actually applied
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_phi_scrubber_redacts_mrn_label_in_entity_refs() -> None:
    """When a domain event smuggles a string carrying a labelled MRN, the
    scrubber redacts it before Medplum sees it. End-to-end PHI surface."""
    medplum = _FakeMedplum()
    chain = _FakeChainWriter()
    emitter = AuditEventEmitter(medplum, chain, PHIScrubber())

    # Pass a free-text extension with an MRN-labelled string. The PHI
    # scrubber recognises labels like "MRN:1234567" and replaces the
    # entire match span.
    leaky_event = _event(
        extra_extensions=[{"url": "http://liverra.ai/test", "valueString": "MRN:1234567"}]
    )
    await emitter.emit(leaky_event, tenant_id=uuid4(), session=object())
    posted = medplum.posted[0]
    leaky_ext_values = [
        e.get("valueString")
        for e in posted.get("extension", [])
        if e.get("url") == "http://liverra.ai/test"
    ]
    # The original "1234567" digits MUST NOT survive into the FHIR
    # payload that Medplum sees.
    for value in leaky_ext_values:
        assert "1234567" not in (value or "")
