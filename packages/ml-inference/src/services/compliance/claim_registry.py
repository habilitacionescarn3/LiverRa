# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""RegulatoryClaimRegistry CRUD (T342, T344).

Plain-English:
    Each of our 7 AI claims (parenchyma volumetry, FLR, Couinaud
    segmentation, vessel identification, lesion detection, lesion
    classification, surgical planning) has its own regulatory status:
    ``ruo`` (default), ``under_conformity_assessment``, or ``cleared``.

    This module is the tiny CRUD layer behind the compliance toggle
    UI (T349). A flip from ``ruo`` → ``cleared`` narrows the disclaimer
    on every future export (FR-028b) — therefore:

      - PUT is permission-gated (``compliance.toggle_claim_registry``)
        and step-up-protected at the router layer (T343).
      - Every flip emits a ``model_version_update`` AuditEvent through
        the chain-of-hashes writer (T344) so the change is
        forensically attributable.

Spec refs: FR-028b, data-model.md §17, research.md §A.3.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


# The seven canonical claim keys (FR-028b + data-model §17).
ALL_CLAIM_KEYS: tuple[str, ...] = (
    "parenchyma_volumetry",
    "flr",
    "couinaud_segmentation",
    "vessel_identification",
    "lesion_detection",
    "lesion_classification",
    "surgical_planning",
)

VALID_STATUSES: tuple[str, ...] = (
    "ruo",
    "under_conformity_assessment",
    "cleared",
)


class StaleClaimVersion(Exception):
    """Raised by ``update`` when client_version != current row version (H-LOCK-5)."""


@dataclass(frozen=True)
class ClaimRegistryRow:
    """One row in ``regulatory_claim_registry``."""

    tenant_id: UUID
    claim_key: str
    status: str
    effective_from: datetime
    regulatory_reference: Optional[str] = None

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "claim_key": self.claim_key,
            "status": self.status,
            "effective_from": self.effective_from.isoformat(),
            "regulatory_reference": self.regulatory_reference,
        }


async def read(
    *, session: AsyncSession, tenant_id: UUID
) -> list[ClaimRegistryRow]:
    """Return all 7 rows for ``tenant_id``.

    Missing rows are filled in with ``status='ruo'`` defaults — fail-safe
    per FR-028b: an un-seeded tenant never accidentally relaxes claims.
    """
    rows = (
        await session.execute(
            text(
                """
                SELECT claim_key, status, effective_from, regulatory_reference
                FROM regulatory_claim_registry
                WHERE tenant_id = :tid
                """
            ),
            {"tid": str(tenant_id)},
        )
    ).mappings().all()
    by_key: dict[str, ClaimRegistryRow] = {
        r["claim_key"]: ClaimRegistryRow(
            tenant_id=tenant_id,
            claim_key=r["claim_key"],
            status=r["status"],
            effective_from=r["effective_from"],
            regulatory_reference=r.get("regulatory_reference"),
        )
        for r in rows
    }
    # Ensure exactly 7 rows come out (fail-safe defaults).
    out: list[ClaimRegistryRow] = []
    now = datetime.now(tz=timezone.utc)
    for key in ALL_CLAIM_KEYS:
        if key in by_key:
            out.append(by_key[key])
        else:
            out.append(
                ClaimRegistryRow(
                    tenant_id=tenant_id,
                    claim_key=key,
                    status="ruo",
                    effective_from=now,
                    regulatory_reference=None,
                )
            )
    return out


async def update(
    *,
    session: AsyncSession,
    tenant_id: UUID,
    actor_user_id: Optional[str],
    claim_key: str,
    status: str,
    regulatory_reference: Optional[str] = None,
    audit_writer=None,
    client_version: int = 1,
) -> ClaimRegistryRow:
    """Upsert one row + emit a ``model_version_update`` AuditEvent.

    Parameters
    ----------
    audit_writer:
        Optional ``AuditChainWriter`` instance. When provided (by the
        FastAPI handler — T448), we append a chain row in the same
        transaction. When ``None`` (bootstrap / tests) we still upsert
        but skip the audit write — the caller is expected to handle
        fail-closed semantics at the transport layer.

    Raises
    ------
    ValueError
        If ``claim_key`` or ``status`` is not in the allowed enums.
    """
    if claim_key not in ALL_CLAIM_KEYS:
        raise ValueError(f"Invalid claim_key: {claim_key}")
    if status not in VALID_STATUSES:
        raise ValueError(f"Invalid status: {status}")

    now = datetime.now(tz=timezone.utc)

    # H-LOCK-5: optimistic-concurrency on (tenant_id, claim_key). If the
    # row exists, CAS-bump ``client_version`` atomically; otherwise insert
    # a fresh row at version 1 (caller must have sent client_version=1
    # to ack "I know this is new"). Two admins toggling the same claim
    # at the same time both send the same version; only one bump wins.
    existing = (
        await session.execute(
            text(
                """
                SELECT client_version FROM regulatory_claim_registry
                 WHERE tenant_id = :tid AND claim_key = :key
                """
            ),
            {"tid": str(tenant_id), "key": claim_key},
        )
    ).first()

    if existing is None:
        # First write — insert at version 1. Reject if caller signalled
        # they observed any other version (likely race or replay).
        if int(client_version) != 1:
            raise StaleClaimVersion(
                "Claim row does not yet exist; client_version must be 1."
            )
        await session.execute(
            text(
                """
                INSERT INTO regulatory_claim_registry
                    (tenant_id, claim_key, status, effective_from,
                     updated_by_user_id, regulatory_reference,
                     client_version)
                VALUES
                    (:tid, :key, :status, :eff, :uid, :ref, 1)
                """
            ),
            {
                "tid": str(tenant_id),
                "key": claim_key,
                "status": status,
                "eff": now,
                "uid": actor_user_id,
                "ref": regulatory_reference,
            },
        )
    else:
        current_version = int(existing[0]) if existing[0] is not None else 1
        if int(client_version) != current_version:
            raise StaleClaimVersion(
                "Stale claim revision — refresh and retry "
                f"(server={current_version}, client={int(client_version)})"
            )
        cas = (
            await session.execute(
                text(
                    """
                    UPDATE regulatory_claim_registry
                       SET status = :status,
                           effective_from = :eff,
                           updated_by_user_id = :uid,
                           regulatory_reference = :ref,
                           client_version = client_version + 1
                     WHERE tenant_id = :tid
                       AND claim_key = :key
                       AND client_version = :cv
                     RETURNING client_version
                    """
                ),
                {
                    "tid": str(tenant_id),
                    "key": claim_key,
                    "status": status,
                    "eff": now,
                    "uid": actor_user_id,
                    "ref": regulatory_reference,
                    "cv": int(client_version),
                },
            )
        ).first()
        if cas is None:
            # Concurrent writer beat us between SELECT and UPDATE.
            raise StaleClaimVersion(
                "Concurrent update detected — refresh and retry."
            )

    # T344 — emit a chain-of-hashes AuditEvent so the toggle is forensic.
    if audit_writer is not None:
        from src.services.audit.audit_helpers import build_audit_event

        event = build_audit_event(
            category="model_version_update",
            actor=actor_user_id if actor_user_id else None,
            entity_refs=[
                # RegulatoryClaimRegistry isn't a standard FHIR resource;
                # use the catch-all Basic with a typed slug prefix.
                f"Basic/regulatory-claim-{tenant_id}-{claim_key}"
            ],
            detail={
                "status": status,
                "regulatory_reference": regulatory_reference or "",
            },
            recorded=now.isoformat(),
            outcome="0",
        )
        try:
            await audit_writer.write(event, tenant_id, session)
        except Exception:
            # Fail-closed per FR-029b — re-raise so caller's transaction
            # rolls back the claim-registry update too.
            logger.exception("claim_registry audit write failed — rolling back")
            raise

    return ClaimRegistryRow(
        tenant_id=tenant_id,
        claim_key=claim_key,
        status=status,
        effective_from=now,
        regulatory_reference=regulatory_reference,
    )


async def on_mbom_version_bumped(
    *,
    session: AsyncSession,
    previous_versions: dict[str, str],
    new_versions: dict[str, str],
) -> dict[str, Any]:
    """Invoked when ``scripts/model-bom.sh`` bumps one or more model
    versions in MBoM.json.

    Plain-English:
        Each hospital has a "confidence dial" we calibrated against
        the old LiLNet weight. When LiLNet changes, the old dial is
        stale — we fire the temperature-recalibration task per tenant
        to re-fit it on their held-out validation samples.

    This function does NOT do the recalibration itself. It enqueues
    :func:`src.tasks.recalibrate_temperature.recalibrate_all_tenants`
    so the caller's request returns fast and the fanout happens on
    the Celery worker pool.

    T467 wiring per research §C.7.

    Parameters
    ----------
    previous_versions, new_versions:
        Maps of model-name → MBoM-version string. Comparison is done
        key-by-key.

    Returns
    -------
    dict
        Summary of dispatched tasks (empty list if lilnet-classify
        version did not change).
    """
    dispatched: list[str] = []
    relevant_models = {"lilnet-classify"}
    changed = [
        name
        for name in relevant_models
        if previous_versions.get(name) != new_versions.get(name)
        and new_versions.get(name) is not None
    ]
    if not changed:
        logger.info(
            "on_mbom_version_bumped: no calibration-sensitive model "
            "changed (checked %s)",
            sorted(relevant_models),
        )
        return {"dispatched": [], "changed_models": []}

    # Import here to avoid a hard dependency when this module is used
    # in contexts without celery installed (tests, scripts).
    try:
        from src.tasks.recalibrate_temperature import (
            recalibrate_all_tenants,
        )
    except ImportError:
        logger.warning(
            "recalibrate_temperature task not importable; skipping "
            "fanout (celery may not be installed in this runtime)"
        )
        return {
            "dispatched": [],
            "changed_models": changed,
            "skipped_reason": "celery_unavailable",
        }

    async_result = recalibrate_all_tenants.apply_async()
    dispatched.append(str(async_result.id))
    logger.info(
        "on_mbom_version_bumped: recalibrate_all_tenants dispatched "
        "task=%s changed_models=%s",
        dispatched[0],
        changed,
    )
    return {
        "dispatched": dispatched,
        "changed_models": changed,
    }


__all__ = [
    "ALL_CLAIM_KEYS",
    "VALID_STATUSES",
    "ClaimRegistryRow",
    "on_mbom_version_bumped",
    "read",
    "update",
]
