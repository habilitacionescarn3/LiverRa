# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Anonymization Celery task (T161).

Stage 1 (stage_no=1) of the cascade. Wraps the anon-sidecar HTTP
webhook (built by T143) and updates ``study.ingestion_outcome`` when
anonymization completes. On success, the chain triggers the next
stage (parenchyma).

Plain-English analogy:
    This task is the receiving clerk at a hospital mailroom. It hands
    each incoming study to the scrubbing team (anon-sidecar), waits for
    the "clean" stamp, then drops the clean envelope into the analysis
    inbox.

Budget (research §C.2): 15 s soft / 20 s hard.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any
from uuid import UUID

import httpx

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.workers.app import app

logger = logging.getLogger(__name__)


ANON_SIDECAR_URL = os.environ.get(
    "ANON_SIDECAR_URL", "http://localhost:7070/anonymize"
)
ANON_POLL_INTERVAL_S = 1.0
# Default 14 s stays below the 15 s prod soft budget. Local-dev with
# real DICOM anonymization on 2000+ slice studies needs longer.
ANON_POLL_TIMEOUT_S = float(os.environ.get("ANON_POLL_TIMEOUT_S", "14"))


async def _run(
    analysis_id: str,
    study_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Submit the study to the anon-sidecar and wait for completion."""
    analysis_uuid = UUID(analysis_id)
    study_uuid = UUID(study_id)

    async def _invoke_sidecar() -> dict[str, Any]:
        # Local-dev bypass: when ANON_SIDECAR_BYPASS=true (no CTP sidecar
        # in the laptop docker-compose), short-circuit with a synthetic
        # "done" response so the rest of the cascade can run on the real
        # 4-phase NIfTI volumes that dicom_to_nifti.py already staged in
        # MinIO during ingestion. Never enable in prod — PHI must be
        # scrubbed before any inference touches the volume.
        bypass = os.environ.get("ANON_SIDECAR_BYPASS", "").lower() in {"1", "true", "yes"}
        if bypass:
            logger.warning(
                "anonymization bypassed (ANON_SIDECAR_BYPASS=true) — analysis=%s",
                analysis_uuid,
            )
            return {
                "status": "done",
                "output_uri": f"passthrough://no-anon-sidecar/{study_uuid}",
            }

        async with httpx.AsyncClient(timeout=ANON_POLL_TIMEOUT_S) as client:
            resp = await client.post(
                ANON_SIDECAR_URL,
                json={
                    "study_id": str(study_uuid),
                    "analysis_id": str(analysis_uuid),
                },
                headers={"x-correlation-id": correlation_id or ""},
            )
            resp.raise_for_status()
            body = resp.json()

        # The sidecar may return { status: "done", output_uri: ... }
        # immediately, or { status: "in_progress", poll_url: ... } for
        # longer runs. Poll the latter until done or timeout.
        if body.get("status") == "done":
            return body

        poll_url: str | None = body.get("poll_url")
        if not poll_url:
            raise RuntimeError(
                "anon-sidecar returned in_progress with no poll_url"
            )
        deadline = asyncio.get_event_loop().time() + ANON_POLL_TIMEOUT_S
        async with httpx.AsyncClient(timeout=ANON_POLL_INTERVAL_S * 2) as client:
            while asyncio.get_event_loop().time() < deadline:
                resp = await client.get(poll_url)
                resp.raise_for_status()
                poll_body = resp.json()
                if poll_body.get("status") == "done":
                    return poll_body
                await asyncio.sleep(ANON_POLL_INTERVAL_S)
        raise TimeoutError("anon-sidecar polling exceeded budget")

    async def _inner() -> dict[str, Any]:
        result = await _invoke_sidecar()
        output_uri = result["output_uri"]

        # T165 wiring: checkpoint + GPU-release atomicity. Anonymization
        # holds no GPU lease, but we still open a transaction to keep
        # the write semantics uniform across stages.
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as session:
            async with session.begin():
                await checkpoint.write(
                    analysis_id=analysis_uuid,
                    stage_no=1,
                    stage="anonymization",
                    output_uri=output_uri,
                    model_version="ctp+presidio@v1",
                    session=session,
                    model_license_hash="n/a-rules-based",
                )
        return {
            "analysis_id": str(analysis_uuid),
            "study_id": str(study_uuid),
            "output_uri": output_uri,
            # No numeric sanity block — anonymization is rules-based.
        }

    return await cascade.run_stage(
        "anonymization",
        analysis_uuid,
        _inner,
        correlation_id=correlation_id,
    )


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.anonymize_study",
    autoretry_for=(httpx.HTTPError, TimeoutError),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def anonymize_study(
    self: "Task",
    analysis_id: str,
    study_id: str,
) -> dict[str, Any]:
    """Celery entry point (sync) delegating to the async implementation.

    ``bind=True`` exposes ``self.request.id`` so downstream audit events
    can correlate with the Celery task id.
    """
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "anonymize_study task=%s analysis=%s study=%s",
        correlation_id,
        analysis_id,
        study_id,
    )
    return asyncio.run(
        _run(analysis_id, study_id, correlation_id=correlation_id)
    )


__all__ = ["anonymize_study"]
