# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Shared FHIR R4 AuditEvent dict builder.

Used by the inline `_emit_*_audit` helpers in `api/*.py` and the
chain-of-hashes producers in `tasks/*.py`. Centralising the wire shape
here closes the FHIR R4 conformance gaps catalogued by CC-5:

  * C-FHIR-1 — every event now carries the required ``type`` field
    (``terminology.hl7.org/CodeSystem/audit-event-type``).
  * C-FHIR-2 — every event carries ``source.observer``.
  * C-FHIR-3 / H-FHIR-6..15 — the R5-only ``category`` field is no longer
    emitted; the legacy ``category`` slug is now placed into
    ``subtype[].code`` under a LiverRa CodeSystem URL.
  * C-FHIR-4 / H-FHIR-16..22 — the obsolete ``liverra:foo`` extension
    URL scheme is replaced with proper FHIR URLs anchored at
    ``http://liverra.ai/fhir/StructureDefinition/``. We accept any short
    ``liverra:foo`` slug from callers and silently rewrite to the
    canonical URL so call-site refactors are reduced.
  * H-FHIR-23..27 — invalid FHIR resource references (``Analysis/``,
    ``Report/``, ``ReportDelivery/``) are rewritten via ``fhir_ref()``
    to ``Basic/analysis-<id>`` / ``DiagnosticReport/<id>`` /
    ``Basic/report-delivery-<id>`` so strict validators accept them.
  * H-FHIR-30 — when no user is known we set ``requestor=True`` and omit
    the ``who`` slot (rather than ``who: None`` which is invalid R4).

The historical ``category`` slug (e.g. ``model_recalibrated``,
``erasure_executed``, ``readout_clipboard_export``) is the legacy
*action* name used in DB queries and admin filters. We keep emitting
it in two FHIR-valid slots so existing consumers continue to work:

  * ``subtype[0].code`` — strict FHIR R4 binding.
  * ``meta.tag[0].code`` — easy-to-grep code-only filter for queries
    that previously matched on the top-level ``category`` field.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, Mapping
from uuid import UUID, uuid4

# ----------------------------------------------------------------------------
# FHIR CodeSystem URLs
# ----------------------------------------------------------------------------

FHIR_BASE: str = "http://liverra.ai/fhir"
EXT_BASE: str = f"{FHIR_BASE}/StructureDefinition"
AUDIT_TYPE_SYSTEM: str = "http://terminology.hl7.org/CodeSystem/audit-event-type"
AUDIT_SUBTYPE_SYSTEM: str = f"{FHIR_BASE}/CodeSystem/audit-subtypes"
AUDIT_CATEGORY_TAG_SYSTEM: str = f"{FHIR_BASE}/CodeSystem/audit-categories"

# Source observer string for backend-side AuditEvents.
DEFAULT_OBSERVER_DEVICE: str = "Device/liverra-ml-inference"


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fhir_ref(resource_type: str, resource_id: str | UUID) -> str:
    """Return a valid FHIR ``ResourceType/id`` reference.

    The repo historically emitted ``Analysis/<id>``, ``Report/<id>`` and
    ``ReportDelivery/<id>`` — none of which are valid FHIR R4 resource
    types. We rewrite to:

    * ``Analysis``        → ``Basic/analysis-<id>``
    * ``Report``          → ``DiagnosticReport/<id>``
    * ``ReportDelivery``  → ``Basic/report-delivery-<id>``
    * ``ErasureRequest``  → ``Basic/erasure-request-<id>``
    * ``Study``           → ``ImagingStudy/<id>``  (canonical FHIR)
    * ``Tenant``          → ``Organization/<id>``  (canonical FHIR)
    """
    rid = str(resource_id)
    if resource_type == "Analysis":
        return f"Basic/analysis-{rid}"
    if resource_type == "Report":
        return f"DiagnosticReport/{rid}"
    if resource_type == "ReportDelivery":
        return f"Basic/report-delivery-{rid}"
    if resource_type == "ErasureRequest":
        return f"Basic/erasure-request-{rid}"
    if resource_type == "Study":
        return f"ImagingStudy/{rid}"
    if resource_type == "Tenant":
        return f"Organization/{rid}"
    return f"{resource_type}/{rid}"


def canonicalize_extension_url(url: str) -> str:
    """Rewrite legacy ``liverra:slug`` URLs to canonical FHIR URLs.

    Strict FHIR validators reject ``Extension.url`` that isn't a valid
    URI. The historical ``liverra:`` URN scheme registered nowhere is
    rewritten to ``http://liverra.ai/fhir/StructureDefinition/<slug>``
    so the existing call sites keep working without a 14-site refactor.
    """
    if isinstance(url, str) and url.startswith("liverra:"):
        slug = url[len("liverra:") :].replace(".", "-").replace("_", "-")
        return f"{EXT_BASE}/{slug}"
    return url


def _normalize_extensions(
    extensions: Iterable[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ext in extensions or ():
        d = dict(ext)
        if "url" in d:
            d["url"] = canonicalize_extension_url(d["url"])
        out.append(d)
    return out


def _agent(actor: str | None) -> list[dict[str, Any]]:
    """Build the ``agent`` array.

    When ``actor`` is None we set ``requestor=True`` and omit ``who``
    (R4 allows agent-with-no-who as long as another agent field is
    present) — replaces the previous invalid ``"who": None``.
    """
    if actor:
        return [{"who": {"reference": actor}, "requestor": True}]
    return [{"requestor": True}]


# ----------------------------------------------------------------------------
# Public builder
# ----------------------------------------------------------------------------


def build_audit_event(
    *,
    category: str,
    actor: str | None = None,
    entity_refs: Iterable[str] = (),
    action: str = "E",
    outcome: str = "0",
    extensions: Iterable[Mapping[str, Any]] | None = None,
    recorded: str | None = None,
    event_id: UUID | None = None,
    detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return a FHIR R4-conformant ``AuditEvent`` dict.

    Parameters
    ----------
    category:
        Legacy LiverRa action slug. Emitted into:
          * ``subtype[0].code``  (strict FHIR R4 placement)
          * ``meta.tag[0].code`` (easy filter for downstream queries)
    actor:
        FHIR reference string (e.g. ``Practitioner/abc``) or None.
    entity_refs:
        Iterable of FHIR references to set on ``entity[].what.reference``.
    action, outcome:
        FHIR AuditEvent.action / .outcome codes — defaults ``E`` /
        ``0`` (Execute / Success).
    extensions:
        Optional list of ``{"url": str, "valueX": ...}`` extension
        dicts. Legacy ``liverra:foo`` URLs are rewritten transparently.
    detail:
        Optional ``{name: value}`` mapping → attached to the FIRST
        entity slot as ``entity[0].detail[]`` typed entries.
    """
    event: dict[str, Any] = {
        "resourceType": "AuditEvent",
        "id": str(event_id or uuid4()),
        "meta": {
            "tag": [
                {
                    "system": AUDIT_CATEGORY_TAG_SYSTEM,
                    "code": category,
                }
            ]
        },
        "type": {
            "system": AUDIT_TYPE_SYSTEM,
            "code": "rest",
            "display": "RESTful Operation",
        },
        "subtype": [
            {
                "system": AUDIT_SUBTYPE_SYSTEM,
                "code": category,
            }
        ],
        "action": action,
        "recorded": recorded or _now_iso(),
        "outcome": outcome,
        "agent": _agent(actor),
        "source": {
            "observer": {"reference": DEFAULT_OBSERVER_DEVICE},
        },
        "entity": [{"what": {"reference": ref}} for ref in entity_refs],
    }

    if detail and event["entity"]:
        # Attach detail to the first entity per FHIR R4 placement rules.
        event["entity"][0]["detail"] = [
            {"type": str(k), "valueString": str(v)} for k, v in detail.items()
        ]

    norm = _normalize_extensions(extensions)
    if norm:
        event["extension"] = norm

    return event


__all__ = [
    "AUDIT_CATEGORY_TAG_SYSTEM",
    "AUDIT_SUBTYPE_SYSTEM",
    "AUDIT_TYPE_SYSTEM",
    "DEFAULT_OBSERVER_DEVICE",
    "EXT_BASE",
    "FHIR_BASE",
    "build_audit_event",
    "canonicalize_extension_url",
    "fhir_ref",
]
