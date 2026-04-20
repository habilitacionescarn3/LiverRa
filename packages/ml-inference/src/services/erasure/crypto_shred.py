# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-case KMS envelope encryption + crypto-shred utilities.

Plain-English:
    Every Study gets its own AWS KMS Customer Master Key (CMK) that we
    create at ingest time. All DICOM bytes + derived artefacts for that
    Study are encrypted with a Data Encryption Key (DEK) wrapped by the
    CMK. To permanently erase a case we just destroy the CMK — all
    ciphertext in S3 and in backups becomes mathematical noise, without
    having to rewrite or delete any objects.

    Two deletion paths:
      1. Standard GDPR erasure (FR-040)  → 7-day pending window (lets
         operators roll back in case of mistake).
      2. PHI-contamination incident (FR-002a) → p99 < 60 s: we call
         ``disable_key`` FIRST (access revoked immediately) and THEN
         schedule the 7-day destruction. The "access revoked" step is
         the compliance-meaningful event; the 7-day window exists only
         so AWS can fulfil the destruction asynchronously.

References:
    - specs/001-zero-training-mvp/research.md §X.1
    - spec.md §FR-002a (60 s crypto-shred on PHI leak), §FR-040 (GDPR)
    - AWS KMS:  ``CreateKey``, ``CreateAlias``, ``DisableKey``,
      ``ScheduleKeyDeletion``
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from uuid import UUID

try:  # Soft-import so unit tests can patch ``boto3`` or run without AWS.
    import boto3  # type: ignore[import-untyped]
    from botocore.exceptions import ClientError  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore[assignment]
    ClientError = Exception  # type: ignore[assignment,misc]

try:
    from prometheus_client import Counter, Histogram  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    Counter = Histogram = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prometheus metrics (module-level — only instantiated once, and only if
# prometheus_client is installed; the collector registry ignores duplicates
# on module reload in tests).
# ---------------------------------------------------------------------------

if Histogram is not None:
    CRYPTO_SHRED_LATENCY = Histogram(
        "crypto_shred_latency_seconds",
        "End-to-end latency of a case-key destruction call",
        ["path"],  # "standard" (7d pending) | "incident" (FR-002a 60s)
        buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120),
    )
    CASE_KEY_CREATED = Counter(
        "crypto_shred_case_keys_created_total",
        "Per-case KMS CMKs created at ingest",
    )
    CASE_KEY_DESTROYED = Counter(
        "crypto_shred_case_keys_destroyed_total",
        "Per-case KMS CMKs whose deletion has been scheduled",
        ["path"],
    )
else:  # pragma: no cover
    CRYPTO_SHRED_LATENCY = CASE_KEY_CREATED = CASE_KEY_DESTROYED = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _kms_client() -> Any:
    """Return a lazily-constructed boto3 KMS client for the configured region."""
    if boto3 is None:
        raise RuntimeError("boto3 is not installed; crypto-shred unavailable")
    # boto3 session reads AWS_REGION / AWS_DEFAULT_REGION per IAM principal
    # config. We rely on the deployment to pin eu-central-1 (GDPR residency).
    return boto3.client("kms")


def case_alias(tenant_id: UUID, study_id: UUID) -> str:
    """Stable alias for a case CMK.

    AWS KMS aliases must start with ``alias/``; the per-case naming
    convention lives in research §X.1 and is used as a lookup key in
    the Postgres ``study`` table.
    """
    return f"alias/liverra/case/{tenant_id}/{study_id}"


async def _emit_audit(
    event_name: str,
    *,
    tenant_id: UUID,
    study_id: UUID,
    alias: str,
    path: str,
    outcome: str,
    detail: dict[str, Any] | None = None,
) -> None:
    """Emit a FHIR AuditEvent via the chain-of-hashes writer.

    Imported lazily so unit tests of the KMS logic don't need the full
    audit stack. Fail-safe: logs but does not raise on audit unavailability.
    """
    try:
        # Local import to avoid a circular dep at module load.
        from ..audit.chain_of_hashes import AuditChainWriter  # type: ignore
        from ...db.session import get_sessionmaker  # type: ignore

        sessionmaker = get_sessionmaker()
        async with sessionmaker() as session:
            writer = AuditChainWriter()
            event = {
                "resourceType": "AuditEvent",
                "type": {"code": event_name},
                "recorded": None,  # populated by canonicalization layer
                "outcome": outcome,
                "entity": [
                    {
                        "what": {"reference": f"Study/{study_id}"},
                        "detail": [
                            {"type": "kms_alias", "valueString": alias},
                            {"type": "path", "valueString": path},
                            *[
                                {"type": k, "valueString": str(v)}
                                for k, v in (detail or {}).items()
                            ],
                        ],
                    }
                ],
            }
            await writer.write(event, tenant_id=tenant_id, session=session)
            await session.commit()
    except Exception as exc:  # noqa: BLE001 — audit must never break crypto-shred
        logger.warning(
            "Failed to emit %s AuditEvent (alias redacted): %s",
            event_name,
            str(exc)[:120],
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def create_case_key(study_id: UUID, tenant_id: UUID) -> str:
    """Create a per-case KMS CMK with automatic rotation and return its alias.

    Idempotent: if the alias already exists (e.g., retry of a partially
    completed ingest), we look up the existing key rather than creating
    a new one. This matters because ``CreateKey`` is not idempotent and
    we don't want orphan keys eating the KMS quota.
    """
    loop = asyncio.get_running_loop()
    client = await loop.run_in_executor(None, _kms_client)
    alias = case_alias(tenant_id, study_id)

    def _blocking_create() -> str:
        # Check for existing alias first (retry-safety).
        try:
            client.describe_key(KeyId=alias)
            return alias
        except ClientError as exc:
            err = exc.response.get("Error", {}).get("Code", "")
            if err != "NotFoundException":
                raise

        key = client.create_key(
            Description=f"LiverRa case key — tenant={tenant_id} study={study_id}",
            KeyUsage="ENCRYPT_DECRYPT",
            Origin="AWS_KMS",
            MultiRegion=False,
            Tags=[
                {"TagKey": "liverra:tenant", "TagValue": str(tenant_id)},
                {"TagKey": "liverra:study", "TagValue": str(study_id)},
                {"TagKey": "liverra:purpose", "TagValue": "case-envelope"},
            ],
        )
        key_id = key["KeyMetadata"]["KeyId"]

        # Automatic annual rotation (KMS default period is 1 year;
        # meets NIST SP 800-57 recommendations for symmetric envelope keys).
        client.enable_key_rotation(KeyId=key_id)
        client.create_alias(AliasName=alias, TargetKeyId=key_id)
        return alias

    try:
        out = await loop.run_in_executor(None, _blocking_create)
        if CASE_KEY_CREATED is not None:
            CASE_KEY_CREATED.inc()
        await _emit_audit(
            "case_key_created",
            tenant_id=tenant_id,
            study_id=study_id,
            alias=out,
            path="ingest",
            outcome="0",  # FHIR AuditEvent outcome "success"
        )
        return out
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "create_case_key failed (tenant=%s study=%s): %s",
            tenant_id, study_id, str(exc)[:200],
        )
        await _emit_audit(
            "case_key_created",
            tenant_id=tenant_id,
            study_id=study_id,
            alias=alias,
            path="ingest",
            outcome="12",  # FHIR AuditEvent outcome "serious-failure"
            detail={"error": type(exc).__name__},
        )
        raise


async def schedule_case_key_deletion(
    alias: str,
    *,
    tenant_id: UUID,
    study_id: UUID,
    pending_window_days: int = 7,
    incident_path: bool = False,
) -> None:
    """Schedule destruction of a case CMK.

    Parameters
    ----------
    alias:
        The alias returned by :func:`create_case_key`.
    pending_window_days:
        AWS requires 7–30 days. Default 7 (shortest allowed, matches
        our compliance minimum). The window only delays the actual
        destruction — access is revoked immediately via ``disable_key``.
    incident_path:
        ``True`` for FR-002a 60-second path. In that case we call
        ``disable_key`` synchronously before scheduling deletion so that
        any in-flight workload loses access within a single API round-trip.
    """
    loop = asyncio.get_running_loop()
    client = await loop.run_in_executor(None, _kms_client)
    path = "incident" if incident_path else "standard"
    started = time.monotonic()

    def _blocking() -> None:
        # 1. Immediate access revocation (FR-002a 60 s path).
        #    We always do this, even on the standard path — once a deletion
        #    is scheduled, the key should not be usable.
        try:
            client.disable_key(KeyId=alias)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if code not in ("DisabledException",):
                raise

        # 2. Schedule destruction.
        client.schedule_key_deletion(
            KeyId=alias,
            PendingWindowInDays=pending_window_days,
        )

    try:
        await loop.run_in_executor(None, _blocking)
        elapsed = time.monotonic() - started
        if CRYPTO_SHRED_LATENCY is not None:
            CRYPTO_SHRED_LATENCY.labels(path=path).observe(elapsed)
        if CASE_KEY_DESTROYED is not None:
            CASE_KEY_DESTROYED.labels(path=path).inc()

        if incident_path and elapsed > 60:
            # Spec §FR-002a SLA breach: alarm fires via CloudWatch. Here we
            # log a loud warning so Sentry captures the latency.
            logger.error(
                "crypto_shred incident path exceeded 60s SLA: elapsed=%.2fs", elapsed,
            )

        await _emit_audit(
            "crypto_shred_executed",
            tenant_id=tenant_id,
            study_id=study_id,
            alias=alias,
            path=path,
            outcome="0",
            detail={"elapsed_seconds": f"{elapsed:.3f}", "pending_window_days": pending_window_days},
        )
    except Exception as exc:  # noqa: BLE001
        elapsed = time.monotonic() - started
        if CRYPTO_SHRED_LATENCY is not None:
            CRYPTO_SHRED_LATENCY.labels(path=path).observe(elapsed)
        logger.error(
            "schedule_case_key_deletion failed (alias=%s path=%s): %s",
            alias, path, str(exc)[:200],
        )
        await _emit_audit(
            "crypto_shred_executed",
            tenant_id=tenant_id,
            study_id=study_id,
            alias=alias,
            path=path,
            outcome="12",
            detail={"error": type(exc).__name__, "elapsed_seconds": f"{elapsed:.3f}"},
        )
        raise


__all__ = [
    "case_alias",
    "create_case_key",
    "schedule_case_key_deletion",
]
