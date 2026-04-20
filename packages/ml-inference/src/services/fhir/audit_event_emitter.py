# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""FHIR AuditEvent emitter (T066).

Converts a domain audit event into a FHIR R4 ``AuditEvent`` resource,
PHI-scrubs it, POSTs it to Medplum, then appends a tamper-evident row
to the chain-of-hashes — all in the caller's single transaction.

Plain-English analogy:
    Imagine recording a shop-floor event in two places: once in the
    compliance binder (FHIR / Medplum) and once in the sealed ledger
    (chain-of-hashes). If either write fails, we roll back the work
    that produced the event and alert the operator. No partial writes.

Implementation notes:
    - Domain event shape is ``DomainAuditEvent`` (dataclass) — the
      callers translate their business payloads into it.
    - We use a small ``MedplumClient``-like protocol to avoid a hard
      dependency on any one HTTP client here. A concrete client is
      injected at wiring time (T068 lifespan).
    - Fail-closed per FR-029b: every error propagates; caller's txn
      rolls back; audit row never diverges from the event it describes.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Mapping, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from src.observability.phi_scrubber import PHIScrubber, ScrubberFailure
from src.services.audit.chain_of_hashes import AuditChainRow, AuditChainWriter
from src.services.fhir.constants import LIVERRA_EXTENSIONS

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Protocol + domain DTO
# ---------------------------------------------------------------------------


class MedplumClient(Protocol):
    """Minimal Medplum surface we rely on."""

    async def create_resource(self, resource: Mapping[str, Any]) -> Mapping[str, Any]:
        """POST to Medplum. MUST return the persisted resource including its ``id``."""
        ...


@dataclass
class DomainAuditEvent:
    """In-process representation of an auditable action."""

    action_code: str
    """One of the enum values from data-model §14 (e.g. ``inference_stage_start``)."""

    outcome: str
    """FHIR AuditEvent outcome code: ``0`` success / ``4`` minor / ``8`` serious / ``12`` major."""

    actor_reference: str
    """FHIR reference — e.g. ``Practitioner/abc`` or ``Device/triton-worker``."""

    entity_references: list[str] = field(default_factory=list)
    """FHIR references to the subjects of the action (Patient, ImagingStudy, Analysis…)."""

    permission_key: str | None = None
    """Value for ``AUDIT_PERMISSION_CHECKED`` extension (RBAC enum key)."""

    model_version: str | None = None
    """Value for ``AUDIT_MODEL_VERSION`` extension (MBoM build SHA)."""

    occurred_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    extra_extensions: list[Mapping[str, Any]] = field(default_factory=list)
    """Additional FHIR extension objects the caller wants to attach."""


# ---------------------------------------------------------------------------
# Emitter
# ---------------------------------------------------------------------------


class AuditEventEmitter:
    """Emits FHIR AuditEvents paired with chain-of-hashes rows."""

    def __init__(
        self,
        medplum_client: MedplumClient,
        chain_writer: AuditChainWriter,
        phi_scrubber: PHIScrubber,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._medplum = medplum_client
        self._chain_writer = chain_writer
        self._scrubber = phi_scrubber
        self._now = now or (lambda: datetime.now(timezone.utc))

    async def emit(
        self,
        event: DomainAuditEvent,
        tenant_id: UUID,
        session: AsyncSession,
    ) -> AuditChainRow:
        """Emit ``event`` for ``tenant_id`` within the caller's ``session``.

        Steps (all fail-closed — any exception propagates):
            1. Build FHIR AuditEvent dict (with LiverRa extensions).
            2. Scrub PHI from the dict.
            3. POST to Medplum; capture returned ``id``.
            4. Append the scrubbed-and-identified event to the chain.
        """
        try:
            fhir_event = self._to_fhir(event)
        except Exception:
            logger.exception("audit_emitter.build_fhir_failed")
            raise

        try:
            scrubbed = self._scrubber.scrub_dict(fhir_event)
        except ScrubberFailure:
            # PHI scrubber already logged + incremented the fail counter.
            # We re-raise to roll back the caller's txn.
            raise
        except Exception:
            logger.exception("audit_emitter.scrub_failed")
            raise

        try:
            persisted = await self._medplum.create_resource(scrubbed)
        except Exception:
            logger.exception("audit_emitter.medplum_post_failed")
            raise

        returned_id = persisted.get("id") if isinstance(persisted, Mapping) else None
        if not returned_id:
            raise RuntimeError(
                "Medplum create_resource returned no id — refusing to write "
                "chain row without a FHIR anchor (FR-029b)."
            )

        # Include the Medplum id in the canonical payload so the chain
        # authoritatively binds to the FHIR resource identity.
        chain_payload = dict(scrubbed)
        chain_payload["id"] = returned_id

        try:
            row = await self._chain_writer.write(
                event_dict=chain_payload,
                tenant_id=tenant_id,
                session=session,
            )
        except Exception:
            logger.exception("audit_emitter.chain_write_failed")
            raise

        return row

    # -- internals -------------------------------------------------------

    def _to_fhir(self, event: DomainAuditEvent) -> dict[str, Any]:
        """Build a FHIR R4 AuditEvent dict (not yet scrubbed)."""
        extensions: list[Mapping[str, Any]] = []
        if event.permission_key is not None:
            extensions.append(
                {
                    "url": LIVERRA_EXTENSIONS.AUDIT_PERMISSION_CHECKED,
                    "valueString": event.permission_key,
                }
            )
        if event.model_version is not None:
            extensions.append(
                {
                    "url": LIVERRA_EXTENSIONS.AUDIT_MODEL_VERSION,
                    "valueString": event.model_version,
                }
            )
        extensions.extend(event.extra_extensions)

        recorded = event.occurred_at.astimezone(timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )

        resource: dict[str, Any] = {
            "resourceType": "AuditEvent",
            "type": {
                "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
                "code": "rest",
                "display": "RESTful Operation",
            },
            "subtype": [
                {
                    "system": f"{LIVERRA_EXTENSIONS.AUDIT_PERMISSION_CHECKED.rsplit('/', 2)[0]}"
                    f"/CodeSystem/audit-action",
                    "code": event.action_code,
                }
            ],
            "recorded": recorded,
            "outcome": event.outcome,
            "agent": [
                {
                    "who": {"reference": event.actor_reference},
                    "requestor": True,
                }
            ],
            "source": {
                "observer": {"reference": "Device/liverra-ml-inference"},
            },
            "entity": [
                {"what": {"reference": ref}} for ref in event.entity_references
            ],
        }
        if extensions:
            resource["extension"] = list(extensions)
        return resource


__all__ = ["AuditEventEmitter", "DomainAuditEvent", "MedplumClient"]
