# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Ingest Celery task — stage 0 of the cascade.

Pulls DICOM from Orthanc, converts to 4-phase NIfTI, uploads to MinIO,
and updates ``study.phase_coverage`` so downstream stages know which
phases are available. Replaces the previously-synchronous call from
``api/analysis.py:POST /from-orthanc`` so very large studies (~600
slices/phase) don't blow past HTTP timeouts and so failures retry
automatically.

Budget: 5 min soft / 10 min hard — large abdominal CT can take minutes
to convert. The cascade chain executes this BEFORE anonymization so
any anon work runs against the staged NIfTI volumes.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

import httpx

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.workers.app import app

logger = logging.getLogger(__name__)


async def _run(
    analysis_id: str,
    study_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    analysis_uuid = UUID(analysis_id)
    study_uuid = UUID(study_id)

    async def _inner() -> dict[str, Any]:
        # Resolve the DICOM StudyInstanceUID from the Postgres study row
        # so the converter has what it needs to call Orthanc.
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as session:
            row = (
                await session.execute(
                    text("SELECT study_instance_uid FROM study WHERE id = :sid"),
                    {"sid": str(study_uuid)},
                )
            ).one_or_none()
        if row is None:
            raise RuntimeError(f"study {study_uuid} not found")
        study_instance_uid: str = row[0]

        # The converter uses synchronous httpx + boto3 + SimpleITK and is
        # CPU/IO heavy. Run it in a thread so the Celery event loop isn't
        # blocked when this task is colocated with async work.
        from src.services.dicom_to_nifti import stage_orthanc_study_to_minio

        loop = asyncio.get_running_loop()
        staged_phases: dict[str, str] = await loop.run_in_executor(
            None,
            stage_orthanc_study_to_minio,
            study_instance_uid,
            study_uuid,
        )

        if not staged_phases:
            # No usable series found in Orthanc — surface as a hard error
            # so the cascade chain stops here rather than running Triton
            # on zero-arrays at parenchyma.
            raise RuntimeError(
                f"ingest produced 0 phases for study {study_uuid} "
                f"(uid={study_instance_uid}); check Orthanc series descriptions"
            )

        # Persist phase_coverage + checkpoint atomically.
        async with sessionmaker() as session:
            async with session.begin():
                await session.execute(
                    text(
                        "UPDATE study SET phase_coverage = CAST(:pc AS jsonb) "
                        "WHERE id = :sid"
                    ),
                    {
                        "sid": str(study_uuid),
                        "pc": json.dumps({p: True for p in staged_phases}),
                    },
                )
                # Use the first staged phase URI as the checkpoint output
                # marker — downstream stages pull all 4 from the bucket.
                first_phase = next(iter(staged_phases.values()))
                await checkpoint.write(
                    analysis_id=analysis_uuid,
                    stage_no=0,
                    stage="ingest",
                    output_uri=first_phase,
                    model_version="dcm2nifti-simpleitk@v1",
                    session=session,
                    model_license_hash="n/a-conversion",
                )

        logger.info(
            "ingest: analysis=%s staged %d phases: %s",
            analysis_uuid, len(staged_phases), sorted(staged_phases.keys()),
        )
        return {
            "analysis_id": str(analysis_uuid),
            "study_id": str(study_uuid),
            "phase_coverage": list(staged_phases.keys()),
        }

    return await cascade.run_stage(
        "ingest",
        analysis_uuid,
        _inner,
        correlation_id=correlation_id,
    )


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.ingest_study",
    autoretry_for=(httpx.HTTPError, OSError),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def ingest_study(
    self: "Task",
    analysis_id: str,
    study_id: str,
) -> dict[str, Any]:
    """Celery entrypoint — runs the async ingest in a fresh event loop."""
    return asyncio.run(_run(analysis_id, study_id))
