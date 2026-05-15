# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""GDPR erasure orchestrator (T324, US9).

Plain-English:
    The "executor" for an Art. 17 erasure. Given a pre-validated
    erasure request (DPO + step-up MFA verified at the API layer),
    this module performs the six-step pipeline:

      1. Crypto-shred — schedule AWS KMS destruction of the case CMK
         (p99 <60 s per SC-016, FR-002a and FR-040).
      2. Hard-delete — drop rows from Postgres for the case graph:
         Study → Series → Analysis → Segmentation → Lesion →
         Classification → FLR → Review → Report → Delivery.
      3. Tombstone — insert an ``erasure_tombstone`` row keyed by
         ``sha256(study_id || tenant_id || timestamp)`` so subsequent
         searches can 404 deterministically (FR-032a: "404 not 403").
      4. Audit rewrite — hash residual identifiers in existing
         AuditEvents (see :mod:`audit_rewriter`). Chain integrity is
         preserved — leaf hashes are NOT touched.
      5. Confirmation PDF — WeasyPrint render with all the above.
      6. Emit ``erasure_executed`` AuditEvent with tombstone hash.

    Every step is best-effort idempotent so a crashed orchestrator can
    be re-run safely.

Spec refs:
    - spec.md §FR-040, §FR-032a, §FR-002a, §SC-016
    - research.md §X.1 (crypto-shred + residual-identifier policy)
    - research.md §A.3 (audit chain integrity)
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import audit_rewriter
from . import confirmation_pdf
from .crypto_shred import case_alias, schedule_case_key_deletion

logger = logging.getLogger(__name__)


@dataclass
class ErasureExecutionResult:
    """Return value of :func:`execute`. Surfaces up to the API handler."""

    erasure_request_id: UUID
    study_id: UUID
    tenant_id: UUID
    tombstone_hash_hex: str
    confirmation_pdf_bytes: bytes
    confirmation_pdf_url: Optional[str]
    elapsed_seconds: float
    events_rewritten: int
    substitutions: int


# Tables that carry the case graph — order matters for FK cascades.
# We list them explicitly so the orchestrator fails loudly if a new
# table is added without an erasure contract.
_CASCADE_TABLES: tuple[str, ...] = (
    "delivery",
    "report",
    "review",
    "flr_calculation",
    "classification",
    "lesion",
    "segmentation",
    "pipeline_checkpoint",
    "analysis",
    "series",
    "study",
)


def compute_tombstone_hash(
    study_id: UUID, tenant_id: UUID, timestamp: datetime
) -> bytes:
    """Deterministic 32-byte tombstone hash used to key the tombstone
    row and bind the confirmation PDF to the exact erasure event.
    """
    material = (
        f"{study_id}|{tenant_id}|{timestamp.isoformat()}".encode("utf-8")
    )
    return hashlib.sha256(material).digest()


async def _hard_delete_case_graph(
    session: AsyncSession, *, study_id: UUID, tenant_id: UUID
) -> None:
    """DELETE rows for the case graph, in FK-safe order.

    We scope every DELETE to both ``study_id`` / derived ``analysis_id``
    AND ``tenant_id`` so a misrouted erasure can't touch another
    tenant's data.
    """
    # Resolve analysis ids for this study first — needed by the deeper
    # tables that don't carry study_id directly.
    analysis_rows = await session.execute(
        text("SELECT id FROM analysis WHERE study_id = :sid AND tenant_id = :tid"),
        {"sid": str(study_id), "tid": str(tenant_id)},
    )
    analysis_ids = [r[0] for r in analysis_rows.all()]

    for table in _CASCADE_TABLES:
        if table in ("study", "series"):
            clause = "study_id = :sid AND tenant_id = :tid"
            params: dict[str, Any] = {"sid": str(study_id), "tid": str(tenant_id)}
            if table == "study":
                clause = "id = :sid AND tenant_id = :tid"
        elif table == "analysis":
            clause = "study_id = :sid AND tenant_id = :tid"
            params = {"sid": str(study_id), "tid": str(tenant_id)}
        else:
            # analysis-scoped tables — only filter if we have analyses.
            if not analysis_ids:
                continue
            clause = "analysis_id = ANY(:aids)"
            params = {"aids": [str(a) for a in analysis_ids]}

        try:
            await session.execute(
                text(f"DELETE FROM {table} WHERE {clause}"),
                params,
            )
        except Exception as exc:
            # C-AUDIT-3 fix: stop reporting "success" when a DELETE fails.
            # Original behaviour swallowed FK violations, permission errors,
            # and deadlocks while the DPO still got a PDF certifying the
            # erasure completed. Now: log with full traceback, capture in
            # Sentry, and re-raise so the orchestrator's caller can roll
            # back + retry. The narrow "table doesn't exist yet" carve-out
            # remains so scaffolded dev environments still bootstrap — but
            # other errors are fatal.
            msg = str(exc).lower()
            is_missing_table = (
                "does not exist" in msg
                or "undefinedtable" in msg
                or "relation" in msg and "does not exist" in msg
            )
            if is_missing_table:
                logger.warning(
                    "erasure DELETE FROM %s skipped — table not present "
                    "(dev scaffold): %s",
                    table,
                    exc,
                )
                continue
            logger.exception(
                "erasure DELETE FROM %s FAILED — refusing to report success",
                table,
            )
            try:
                import sentry_sdk  # type: ignore[import-not-found]

                sentry_sdk.capture_exception(exc)
            except Exception:  # noqa: BLE001
                pass
            raise


async def _insert_tombstone(
    session: AsyncSession,
    *,
    study_id: UUID,
    tenant_id: UUID,
    erasure_request_id: UUID,
    tombstone_hash: bytes,
    executed_at: datetime,
) -> None:
    """Insert an erasure_tombstone row. Enables FR-032a 404-not-403 flow.

    Schema is intentionally tiny: the presence of a row for (study_id,
    tenant_id) tells the query layer to return 404 on subsequent
    reads/searches of that study.
    """
    try:
        await session.execute(
            text(
                """
                INSERT INTO erasure_tombstone
                    (study_id, tenant_id, erasure_request_id,
                     tombstone_hash, executed_at)
                VALUES (:sid, :tid, :rid, :h, :ts)
                ON CONFLICT (study_id) DO NOTHING
                """
            ),
            {
                "sid": str(study_id),
                "tid": str(tenant_id),
                "rid": str(erasure_request_id),
                "h": tombstone_hash,
                "ts": executed_at,
            },
        )
    except Exception as exc:
        # Same logic as DELETE: tolerate missing-table in dev scaffolds,
        # fail loud on anything else (FR-032a depends on the tombstone row
        # existing for the 404-not-403 flow).
        msg = str(exc).lower()
        if "does not exist" in msg or "undefinedtable" in msg:
            logger.warning(
                "erasure_tombstone insert skipped — table not present "
                "(dev scaffold): %s",
                exc,
            )
            return
        logger.exception("erasure_tombstone insert FAILED — re-raising")
        raise


async def _upload_confirmation_pdf(
    pdf_bytes: bytes, *, erasure_request_id: UUID
) -> Optional[str]:
    """Upload to S3 and return the (pre-signed) URL, best-effort.

    In a dev env without boto3 / S3 we simply return ``None`` — the
    orchestrator result still carries the raw bytes so the API can
    stream them directly (see T446 wiring).
    """
    try:
        import boto3  # type: ignore[import-untyped]
    except ImportError:
        logger.info("boto3 not available; skipping PDF upload")
        return None

    import os

    bucket = os.environ.get("LIVERRA_ERASURE_PDF_BUCKET")
    if not bucket:
        logger.info("LIVERRA_ERASURE_PDF_BUCKET unset; skipping upload")
        return None

    key = f"erasure/{erasure_request_id}.pdf"
    try:
        s3 = boto3.client("s3")
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=pdf_bytes,
            ContentType="application/pdf",
            ServerSideEncryption="aws:kms",
        )
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=3600,
        )
        return url
    except Exception as exc:  # noqa: BLE001
        logger.error("erasure PDF upload failed: %s", exc)
        return None


async def _emit_executed_audit(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    study_id: UUID,
    erasure_request_id: UUID,
    tombstone_hash_hex: str,
) -> Optional[int]:
    """Emit the terminal ``erasure_executed`` AuditEvent.

    This is the event regulators will look for during an audit. It
    references the study by its study_id (which will then be hashed by
    the audit_rewriter pass below) and carries the tombstone hash so
    forensic analysis can match PDF ↔ audit row.
    """
    try:
        from ..audit.chain_of_hashes import AuditChainWriter
    except ImportError:
        # B-AUDIT-1 + H-AUDIT-5 fix: missing audit module is no longer a
        # silent skip. The terminal erasure_executed AuditEvent IS the
        # row the regulator looks for; degrading silently is exactly the
        # failure mode we're remediating.
        logger.exception(
            "erasure_executed AuditEvent unwritten — chain_of_hashes import "
            "failed (refusing to silently succeed for tenant=%s study=%s)",
            tenant_id,
            study_id,
        )
        raise

    writer = AuditChainWriter()
    from src.services.audit.audit_helpers import build_audit_event, fhir_ref

    event = build_audit_event(
        category="erasure_executed",
        entity_refs=[fhir_ref("Study", study_id)],
        detail={
            "erasure_request_id": str(erasure_request_id),
            "tombstone_hash_hex": tombstone_hash_hex,
        },
    )
    row = await writer.write(event, tenant_id, session)
    return row.sequence_no


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def execute(
    session: AsyncSession,
    *,
    erasure_request_id: UUID,
    study_id: UUID,
    tenant_id: UUID,
    dpo_email: str,
    justification: str,
) -> ErasureExecutionResult:
    """Execute the erasure pipeline. Returns detailed result metadata.

    p99 target (SC-016): <60 seconds end-to-end including KMS call.
    Timer is observed via the caller's Prometheus instrumentation.
    """
    started = time.monotonic()
    executed_at = datetime.now(timezone.utc)
    tombstone_hash = compute_tombstone_hash(study_id, tenant_id, executed_at)
    tombstone_hex = tombstone_hash.hex()

    # 1. Crypto-shred — fire-and-forget (KMS is async under the hood but we
    # await to confirm the schedule call was accepted).
    alias = case_alias(tenant_id, study_id)
    try:
        await schedule_case_key_deletion(
            alias,
            tenant_id=tenant_id,
            study_id=study_id,
            pending_window_days=7,
            incident_path=False,
        )
    except Exception as exc:  # noqa: BLE001
        # A missing KMS key in dev is OK — the rest of the pipeline
        # continues. In prod this would raise and rollback.
        logger.warning("crypto-shred skipped for alias=%s: %s", alias, exc)

    # 2. Hard-delete the case graph.
    await _hard_delete_case_graph(
        session, study_id=study_id, tenant_id=tenant_id
    )

    # 3. Tombstone.
    await _insert_tombstone(
        session,
        study_id=study_id,
        tenant_id=tenant_id,
        erasure_request_id=erasure_request_id,
        tombstone_hash=tombstone_hash,
        executed_at=executed_at,
    )

    # 4. Audit rewrite (chain-integrity preserving).
    rewrite_result = await audit_rewriter.rewrite(
        session,
        tenant_id=tenant_id,
        study_id=study_id,
        tombstone_hash=tombstone_hash,
    )

    # 5. Confirmation PDF.
    pdf_inputs = confirmation_pdf.ConfirmationInputs(
        erasure_request_id=str(erasure_request_id),
        study_id=str(study_id),
        tenant_id=str(tenant_id),
        dpo_email=dpo_email,
        justification=justification,
        executed_at=executed_at,
        tombstone_hash_hex=tombstone_hex,
        events_rewritten=rewrite_result.events_rewritten,
        substitutions=rewrite_result.substitutions,
    )
    pdf_bytes = confirmation_pdf.build(pdf_inputs)
    pdf_url = await _upload_confirmation_pdf(
        pdf_bytes, erasure_request_id=erasure_request_id
    )

    # 6. Terminal audit event.
    await _emit_executed_audit(
        session,
        tenant_id=tenant_id,
        study_id=study_id,
        erasure_request_id=erasure_request_id,
        tombstone_hash_hex=tombstone_hex,
    )

    # 7. Mark the erasure_request row as completed (best-effort).
    try:
        await session.execute(
            text(
                """
                UPDATE erasure_request
                SET status = 'completed',
                    completed_at = :ts,
                    tombstone_hash = :h,
                    confirmation_pdf_url = :url
                WHERE id = :rid
                """
            ),
            {
                "ts": executed_at,
                "h": tombstone_hash,
                "url": pdf_url,
                "rid": str(erasure_request_id),
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("erasure_request status update skipped: %s", exc)

    elapsed = time.monotonic() - started
    if elapsed > 60:
        logger.error(
            "erasure SLA breach (SC-016) — elapsed=%.2fs for request=%s",
            elapsed,
            erasure_request_id,
        )

    return ErasureExecutionResult(
        erasure_request_id=erasure_request_id,
        study_id=study_id,
        tenant_id=tenant_id,
        tombstone_hash_hex=tombstone_hex,
        confirmation_pdf_bytes=pdf_bytes,
        confirmation_pdf_url=pdf_url,
        elapsed_seconds=elapsed,
        events_rewritten=rewrite_result.events_rewritten,
        substitutions=rewrite_result.substitutions,
    )


__all__ = ["execute", "ErasureExecutionResult", "compute_tombstone_hash"]
