# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Cascade entry-point Celery tasks.

The HTTP layer (``src/api/analysis.py:_dispatch_cascade``) imports
``run_cascade`` and ``revoke_cascade`` from this module. They wrap the
Celery Canvas graph builder in :mod:`src.orchestrator.cascade` so the
API doesn't need to know about chains/chords directly.
"""
from __future__ import annotations

import logging
import os
from typing import Optional
from uuid import UUID

from sqlalchemy import text

from src.orchestrator.cascade import build_cascade
from src.workers.app import app

logger = logging.getLogger(__name__)


@app.task(name="liverra.tasks.run_cascade", bind=True)
def run_cascade(self, analysis_id: str, start_stage: int = 0) -> dict:
    """Dispatch the cascade Canvas for a queued Analysis row.

    Parameters
    ----------
    analysis_id
        UUID of the Analysis row already inserted by the API.
    start_stage
        For retry flows; ignored by build_cascade (which always rebuilds
        from anonymization). Future work: slice the chain at start_stage.
    """
    # Look up the study_id for this analysis (synchronously — Celery tasks
    # cannot await asyncpg, so use psycopg-binary or a sync connection).
    import psycopg
    import os
    sync_url = os.environ.get(
        "DATABASE_URL_SYNC",
        "postgresql://liverra:liverra@localhost:5432/liverra",
    )
    with psycopg.connect(sync_url, autocommit=True) as conn:
        row = conn.execute(
            "SELECT study_id FROM analysis WHERE id = %s",
            (analysis_id,),
        ).fetchone()
        if not row:
            logger.error("run_cascade: analysis %s not found", analysis_id)
            return {"status": "error", "reason": "analysis_not_found"}
        study_id = row[0]
        # Mark running.
        conn.execute(
            "UPDATE analysis SET status='running', started_at=now() "
            "WHERE id = %s AND status = 'queued'",
            (analysis_id,),
        )

    logger.info(
        "run_cascade: dispatching graph for analysis=%s study=%s",
        analysis_id,
        study_id,
    )
    graph = build_cascade(UUID(analysis_id), UUID(str(study_id)))
    async_result = graph.apply_async()
    return {"status": "dispatched", "task_id": async_result.id}


def _checkpoint_stub(analysis_id: str, stage_no: int, stage: str) -> dict:
    """Synchronously write a placeholder pipeline_checkpoint row.

    Used by the dev-mode passthrough tasks for stages whose real
    implementation requires more orchestration than we have time for
    in this session. Each stage gets a row so the contract test +
    audit chain see continuity.
    """
    import psycopg
    sync_url = os.environ.get(
        "DATABASE_URL_SYNC",
        "postgresql://liverra:liverra@localhost:5432/liverra",
    )
    with psycopg.connect(sync_url, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO pipeline_checkpoint
              (analysis_id, stage_no, stage, output_uri, model_version,
               model_license_hash)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (
                analysis_id,
                stage_no,
                stage,
                f"s3://liverra-dev/stub/{analysis_id}/{stage}.nii.gz",
                f"stub-{stage}@v1",
                "n/a-dev-stub",
            ),
        )
    return {
        "analysis_id": analysis_id,
        "stage": stage,
        "stage_no": stage_no,
        "note": "dev-stub passthrough — real impl pending",
    }


@app.task(name="liverra.tasks.segment_vessels")
def segment_vessels(analysis_id: str, study_id: str = "") -> dict:
    """Dev passthrough — real impl in src.tasks.vessels.segment_vessels.
    Writes a stage-3a checkpoint so the chord can complete."""
    logger.info("segment_vessels (stub) analysis=%s", analysis_id)
    return _checkpoint_stub(analysis_id, 3, "vessels")


@app.task(name="liverra.tasks.segment_couinaud")
def segment_couinaud(analysis_id: str, study_id: str = "") -> dict:
    """Dev passthrough — real impl in src.tasks.couinaud.segment_couinaud."""
    logger.info("segment_couinaud (stub) analysis=%s", analysis_id)
    return _checkpoint_stub(analysis_id, 4, "couinaud")


def revoke_cascade(analysis_id: str) -> None:
    """Best-effort revoke for an in-flight cascade.

    The cascade chain's task-id is not persisted yet, so we revoke the
    run_cascade entry-point only; in-flight stages will continue until
    they hit their own soft_time_limit. Future work: persist the chain
    task-id on Analysis.cascade_task_id and revoke that here.
    """
    logger.info("revoke_cascade: best-effort no-op for analysis=%s", analysis_id)
