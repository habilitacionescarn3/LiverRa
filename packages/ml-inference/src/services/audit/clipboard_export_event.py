"""clipboard_export_event — emit a FHIR R4 AuditEvent for the
ACR-readout Copy-to-Clipboard action (feature 002-acr-structured-readout).

Contract: ``specs/002-acr-structured-readout/contracts/audit-event.md``.

This module is the single source of truth for the wire shape. It is
called from the POST /report/clipboard-export route handler in
``api/analysis.py`` and from the PDF render path when a server-side
download initiated by a user click fails (FR-020c).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .chain_of_hashes import AuditChainRow, AuditChainWriter
from .fhir_extensions import (
    AUDIT_CHAIN_LEAF_HASH,
    AUDIT_CHAIN_SEQUENCE_NO,
    AUDIT_CLIENT_ACTION_ID,
    AUDIT_FAILURE_CATEGORY,
    AUDIT_LOCALE,
    AUDIT_SUBTYPE_SYSTEM,
    AUDIT_TENANT,
    CLINICAL_ROLES_SYSTEM,
)

FailureCategory = Literal[
    "network",
    "clipboard_blocked",
    "audit_chain_unavailable",
    "auth_denied",
    "tenant_violation",
]

Outcome = Literal["success", "failure"]


class ClipboardExportAuditPayload(BaseModel):
    """Body of POST /api/v1/analyses/{id}/report/clipboard-export.

    Mirrors the TS-side ``ClipboardExportAuditPayload`` in
    ``acrClipboardService.ts``.
    """

    client_action_id: UUID = Field(
        ..., description="Stable UUID per click; identical across durable retries"
    )
    actor_role: str
    locale: Literal["en", "ru", "ka", "de"]
    action_timestamp: datetime
    outcome: Outcome
    failure_category: Optional[FailureCategory] = None


class ClipboardExportResponse(BaseModel):
    audit_event_id: UUID
    sequence_no: int
    outcome: Outcome
    persisted_at: datetime


def _outcome_code(payload: ClipboardExportAuditPayload) -> str:
    """FHIR AuditEvent.outcome code per contracts/audit-event.md §2."""
    if payload.outcome == "success":
        return "0"
    severe = {"auth_denied", "tenant_violation"}
    return "8" if payload.failure_category in severe else "4"


def build_audit_event(
    payload: ClipboardExportAuditPayload,
    *,
    actor_id: UUID,
    analysis_id: UUID,
    tenant_id: UUID,
    audit_event_id: UUID | None = None,
) -> dict[str, Any]:
    """Construct the FHIR R4 AuditEvent dict per contract §1/§2.

    The chain bookkeeping (sequence_no / leaf_hash) is added by the
    AuditChainWriter after this dict is canonicalised — those extensions
    are appended post-hash to the returned row, NOT to the canonical
    body (avoids the chicken-and-egg of "hash includes its own hash").
    """
    event_id = audit_event_id or uuid4()
    extensions: list[dict[str, Any]] = [
        {"url": AUDIT_LOCALE, "valueCode": payload.locale},
        {"url": AUDIT_TENANT, "valueReference": {"reference": f"Organization/{tenant_id}"}},
        {"url": AUDIT_CLIENT_ACTION_ID, "valueUuid": str(payload.client_action_id)},
    ]
    if payload.outcome == "failure" and payload.failure_category:
        extensions.append(
            {"url": AUDIT_FAILURE_CATEGORY, "valueCode": payload.failure_category}
        )

    event: dict[str, Any] = {
        "resourceType": "AuditEvent",
        "id": str(event_id),
        "type": {
            "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
            "code": "rest",
            "display": "RESTful Operation",
        },
        "subtype": [
            {
                "system": AUDIT_SUBTYPE_SYSTEM,
                "code": "readout-clipboard-export",
                "display": "Structured readout copied to clipboard",
            }
        ],
        "category": "readout_clipboard_export",
        "action": "R",
        "recorded": payload.action_timestamp.astimezone(timezone.utc).isoformat(),
        "outcome": _outcome_code(payload),
        "agent": [
            {
                "type": {
                    "coding": [
                        {
                            "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
                            "code": "AUT",
                            "display": "author",
                        }
                    ]
                },
                "who": {"reference": f"Practitioner/{actor_id}"},
                "role": [
                    {
                        "coding": [
                            {
                                "system": CLINICAL_ROLES_SYSTEM,
                                "code": payload.actor_role,
                                "display": payload.actor_role,
                            }
                        ]
                    }
                ],
                "requestor": True,
            }
        ],
        "source": {
            "site": "liverra-app",
            "observer": {"display": "LiverRa Web Application"},
            "type": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/security-source-type",
                    "code": "4",
                    "display": "Application Server",
                }
            ],
        },
        "entity": [
            {
                "what": {"reference": f"Analysis/{analysis_id}"},
                "type": {
                    "system": "http://terminology.hl7.org/CodeSystem/audit-entity-type",
                    "code": "4",
                    "display": "Other",
                },
                "role": {
                    "system": "http://terminology.hl7.org/CodeSystem/object-role",
                    "code": "4",
                    "display": "Domain Resource",
                },
                "description": "Structured readout exported via clipboard",
            }
        ],
        "extension": extensions,
    }
    return event


async def emit_clipboard_export(
    payload: ClipboardExportAuditPayload,
    *,
    actor_id: UUID,
    analysis_id: UUID,
    tenant_id: UUID,
    session: AsyncSession,
    audit_chain_writer: AuditChainWriter | None = None,
) -> tuple[UUID, AuditChainRow | None]:
    """Append the clipboard-export AuditEvent to the chain.

    Idempotent on ``client_action_id``: a duplicate POST returns the
    previously assigned audit_event_id without appending a new chain
    row.

    Returns
    -------
    tuple[UUID, AuditChainRow | None]
        ``(audit_event_id, row)``. ``row`` is ``None`` when the call
        was a replay (existing event_id returned unchanged).
    """
    # Idempotency check — look for prior row with the same client_action_id.
    existing = await session.execute(
        text(
            """
            SELECT canonical_json, sequence_no
              FROM audit_event_chain
             WHERE tenant_id = :tid
               AND canonical_json LIKE :pattern
             ORDER BY sequence_no DESC
             LIMIT 1
            """
        ),
        {
            "tid": str(tenant_id),
            # Match canonical-JSON encoding (no space after colon) — drift
            # between this LIKE pattern and the canonical_json() output is
            # what caused B-AUDIT-2 (idempotency replays silently missed).
            "pattern": f'%"valueUuid":"{payload.client_action_id}"%',
        },
    )
    prior = existing.first()
    if prior is not None:
        import json
        body = json.loads(prior[0])
        return (UUID(body["id"]), None)

    event = build_audit_event(
        payload,
        actor_id=actor_id,
        analysis_id=analysis_id,
        tenant_id=tenant_id,
    )

    writer = audit_chain_writer or AuditChainWriter()
    row = await writer.write(event, tenant_id, session)
    return (UUID(event["id"]), row)


__all__ = [
    "ClipboardExportAuditPayload",
    "ClipboardExportResponse",
    "build_audit_event",
    "emit_clipboard_export",
    "FailureCategory",
    "Outcome",
]
