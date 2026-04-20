# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Celery task orchestrating report finalization (T426).

Plain-English:
    When a surgeon clicks "Finalize" on the wizard, the API enqueues
    this task and returns 202 Accepted. We then:

      1. Build the DICOM-SEG via :mod:`seg_builder`.
      2. Build the DICOM-SR (referencing the SEG) via :mod:`sr_builder`.
      3. Render the PDF via :mod:`pdf_builder` in the surgeon's locale.
      4. Upload all 3 artifacts to S3 under
         ``s3://liverra-imaging-eu-central-1/<tenant>/reports/<id>/``.
      5. Persist the ``Report`` row + one ``ReportDelivery`` row per
         ``(artifact, tenant.pacs_destination)`` pair (status=pending).
      6. Emit a ``report_finalize`` AuditEvent via the chain-of-hashes
         writer.

    Idempotency key: ``(analysis_id, finalize_version)``. If the caller
    re-POSTs the same finalize twice, we return the existing Report
    without re-building.

    This task is intentionally lean on behavior — it stitches together
    the specialist builders. Detailed SNOMED + DICOM field control
    lives in each builder module.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

try:  # pragma: no cover
    import boto3  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    boto3 = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text

from src.db.session import get_sessionmaker

logger = logging.getLogger(__name__)

S3_BUCKET = "liverra-imaging-eu-central-1"


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------


def _s3_upload(bucket: str, key: str, body: bytes, content_type: str) -> str:
    if boto3 is None:  # pragma: no cover
        raise RuntimeError("finalize_report requires boto3 in production")
    client = boto3.client("s3")
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=content_type,
        ServerSideEncryption="aws:kms",
    )
    return f"s3://{bucket}/{key}"


def _sha256(body: bytes) -> bytes:
    return hashlib.sha256(body).digest()


# ---------------------------------------------------------------------------
# Core orchestration
# ---------------------------------------------------------------------------


async def _finalize(analysis_id: UUID, review_id: UUID, user_id: UUID, tenant_id: UUID, locale: str) -> UUID:
    """Main orchestration body — returns the new ``report_id``."""
    from src.services.audit.chain_of_hashes import AuditChainWriter
    from src.services.export.pdf_builder import PDFBuildInput, build_pdf
    from src.services.seg_sr.seg_builder import (
        AlgorithmId,
        LesionSegmentInput,
        SegBuildInput,
        build_seg,
    )
    from src.services.seg_sr.sr_builder import (
        FLRMeasurement,
        LesionMeasurement,
        SRBuildInput,
        VolumeMeasurement,
        build_sr,
    )
    from src.services.mbom.reader import get_default_reader as _mbom  # type: ignore[attr-defined]

    maker = get_sessionmaker()
    async with maker() as session:
        # 1. Idempotency — reuse existing finalized Report.
        existing = (
            await session.execute(
                text(
                    """
                    SELECT id FROM report
                    WHERE analysis_id = :aid AND status IN ('finalizing','finalized')
                    ORDER BY created_at DESC LIMIT 1
                    """
                ),
                {"aid": str(analysis_id)},
            )
        ).mappings().first()
        if existing:
            logger.info("finalize idempotent reuse report=%s", existing["id"])
            return UUID(str(existing["id"]))

        # 2. Pull the minimum data required (the builders need more; for this
        #    scaffold we read what exists and let the builders raise on gaps).
        #    Production wiring: SEG/SR require aligned masks from S3 — loaded
        #    by a fetcher outside this task's scope.
        analysis = (
            await session.execute(
                text(
                    """
                    SELECT a.id, a.study_id, a.pipeline_version, s.tenant_id,
                           s.preserve_institution_name
                    FROM analysis a
                    JOIN study s ON s.id = a.study_id
                    WHERE a.id = :aid
                    """
                ),
                {"aid": str(analysis_id)},
            )
        ).mappings().first()
        if analysis is None:
            raise LookupError(f"analysis {analysis_id} not found at finalize time")

        # NOTE: The actual mask / DICOM fetch step is delegated to a helper
        # that production Celery ships in ``tasks/finalize_report_fetcher``
        # (not part of this scaffold PR). The builders raise a clean
        # RuntimeError when they're called without masks — caller surfaces
        # to the user as an ``analysis-implausible-output`` error slug.
        raise NotImplementedError(
            "finalize_report awaits the mask-fetcher integration (T426-fetcher-follow-up)"
        )


# ---------------------------------------------------------------------------
# Celery entrypoint
# ---------------------------------------------------------------------------


try:
    from src.workers.app import app
except ImportError:  # pragma: no cover
    app = None  # type: ignore[assignment]


def finalize_report_impl(
    analysis_id: str,
    review_id: str,
    user_id: str,
    tenant_id: str,
    locale: str = "en",
) -> str:
    """Sync shim used by :func:`finalize_report.delay` + unit tests."""
    rid = asyncio.run(
        _finalize(
            UUID(analysis_id),
            UUID(review_id),
            UUID(user_id),
            UUID(tenant_id),
            locale,
        )
    )
    return str(rid)


if app is not None:  # pragma: no cover — Celery registration
    @app.task(
        bind=True,
        name="liverra.tasks.finalize_report",
        autoretry_for=(),
        acks_late=True,
    )
    def finalize_report(
        self: Task,
        analysis_id: str,
        review_id: str,
        user_id: str,
        tenant_id: str,
        locale: str = "en",
    ) -> str:  # type: ignore[override]
        """Celery entrypoint for finalize. Returns ``report_id`` as str."""
        return finalize_report_impl(analysis_id, review_id, user_id, tenant_id, locale)


__all__ = ["finalize_report_impl", "S3_BUCKET"]
