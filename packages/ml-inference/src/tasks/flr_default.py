# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Initial-FLR Celery task (stage 7 of the dormant Triton cascade).

B-CLIN-3 + B-CLIN-4 (audit 2026-05-14): the previous implementation here
multiplied voxel counts by a hardcoded ``(2.3 ** 3) / 1000`` mL voxel and
sliced the parenchyma at its axial midpoint as a stand-in FLR. Both
were wrong:

  - Real CT voxel spacing varies 0.7–5 mm — the hardcoded 2.3³ mm³
    voxel produces volumes ~10× too large at 5 mm and ~30× too small at
    0.7 mm.
  - The axial-midpoint heuristic has no clinical basis. ESSO/ALPPS FLR
    is the per-segment sum of the remnant Couinaud segments under a
    given resection pattern, not "everything superior of the bbox
    centroid."

This module now wraps :func:`src.orchestrator.flr_segment_aware.compute_flr`
and pulls (a) actual NIfTI voxel spacing via ``nibabel`` and (b) the
Couinaud label map written by the Couinaud stage's checkpoint. The live
cascade (``scripts/real_cascade.py``) already does this in-line; this
Celery task path is kept around for the dormant Triton cascade graph
in :func:`src.orchestrator.cascade.build_cascade`.

The default resection pattern is ``right_hepatectomy`` — the most
common clinical resection. Surgeon-driven plane drag re-computes FLR
client-side (WebGPU) at <20 ms per drag, so this task only seeds the
initial value.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any
from uuid import UUID

import boto3
import numpy as np

try:
    import nibabel as nib  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    nib = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.orchestrator.flr_segment_aware import compute_flr
from src.workers.app import app

logger = logging.getLogger(__name__)


DEFAULT_PATTERN = "right_hepatectomy"


def _download_mask_with_spacing(
    s3_client: Any, uri: str
) -> tuple[np.ndarray, tuple[float, float, float]]:
    """Read a NIfTI mask from S3 and return (array, (sx, sy, sz)) mm.

    Uses a temp file + nib.load() rather than Nifti1Image.from_bytes(),
    because the latter only handles uncompressed NIfTI bytes — masks
    written by SimpleITK to .nii.gz are properly gzipped and would fail
    with HeaderDataError. ``get_zooms`` returns the voxel spacing in the
    NIfTI's own axis order; we return it positionally so the FLR
    computation can multiply by it (mL math).
    """
    if nib is None:
        raise RuntimeError("nibabel is not installed")
    assert uri.startswith("s3://"), f"expected s3:// URI, got {uri!r}"
    bucket_key = uri[len("s3://"):]
    bucket, _, key = bucket_key.partition("/")
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        nii = nib.load(tf.name)  # type: ignore[attr-defined]
        data = np.asarray(nii.get_fdata(), dtype=np.uint8)
        zooms = nii.header.get_zooms()[:3]
    spacing = (float(zooms[0]), float(zooms[1]), float(zooms[2]))
    return data, spacing


async def _persist_flr(
    analysis_id: UUID,
    plane_pose: dict[str, Any],
    flr_ml: float,
    total_ml: float,
    pattern: str,
) -> None:
    """INSERT an ``flr_calculation`` row in the same txn as checkpoint."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        async with session.begin():
            # C-CLIN-1: derive flr_pct from the SAME total_ml we store,
            # so any frontend "flr_ml / total_ml * 100" sanity check
            # holds exactly.
            pct = (flr_ml / total_ml * 100.0) if total_ml > 0 else 0.0
            await session.execute(
                text(
                    """
                    INSERT INTO flr_calculation (
                        analysis_id,
                        plane_pose,
                        total_ml,
                        flr_ml,
                        flr_pct,
                        remnant_volume_ml,
                        remnant_pct_functional,
                        author,
                        computed_at
                    )
                    VALUES (:aid, CAST(:pose AS jsonb), :total, :flr, :pct,
                            :flr, :pct, 'ai_default', now())
                    ON CONFLICT DO NOTHING
                    """
                ),
                {
                    "aid": str(analysis_id),
                    "pose": _json_dumps(plane_pose),
                    "total": total_ml,
                    "flr": flr_ml,
                    "pct": pct,
                },
            )
            await checkpoint.write(
                analysis_id=analysis_id,
                stage_no=7,
                stage="flr_init",
                output_uri=f"flr://analyses/{analysis_id}",
                model_version=f"flr-segment-aware-{pattern}@v1",
                session=session,
                model_license_hash="n/a-heuristic",
            )


def _json_dumps(obj: dict[str, Any]) -> str:
    import json

    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


async def _resolve_uri(analysis_uuid: UUID, stage: str) -> str:
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        row = await session.execute(
            text(
                """
                SELECT output_uri FROM pipeline_checkpoint
                WHERE analysis_id = :aid AND stage = :stage
                """
            ),
            {"aid": str(analysis_uuid), "stage": stage},
        )
        found = row.first()
        if not found:
            raise RuntimeError(
                f"Cannot compute FLR before '{stage}' stage is checkpointed"
            )
        return found[0]


async def _run(
    analysis_id: str,
    study_id: str,
    parenchyma_mask_uri: str | None = None,
    couinaud_mask_uri: str | None = None,
    pattern: str = DEFAULT_PATTERN,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    analysis_uuid = UUID(analysis_id)

    if parenchyma_mask_uri is None:
        parenchyma_mask_uri = await _resolve_uri(analysis_uuid, "parenchyma")
    if couinaud_mask_uri is None:
        # Couinaud stage is mandatory for segment-aware FLR. If the
        # cascade graph routed here without a Couinaud checkpoint the
        # caller broke the contract — fail loudly rather than fall back
        # to a clinically-meaningless heuristic.
        couinaud_mask_uri = await _resolve_uri(analysis_uuid, "couinaud")

    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    loop = asyncio.get_running_loop()

    # B-CLIN-3: load actual voxel spacing from the parenchyma NIfTI
    # rather than assuming 2.3³ mm³. Couinaud + parenchyma share the
    # same grid so either NIfTI yields the correct spacing.
    parenchyma_arr, spacing_mm = await loop.run_in_executor(
        None, _download_mask_with_spacing, s3_client, parenchyma_mask_uri
    )
    couinaud_arr, _ = await loop.run_in_executor(
        None, _download_mask_with_spacing, s3_client, couinaud_mask_uri
    )
    if parenchyma_arr.shape != couinaud_arr.shape:
        raise RuntimeError(
            f"parenchyma/Couinaud shape mismatch: "
            f"{parenchyma_arr.shape} vs {couinaud_arr.shape}"
        )

    voxel_ml = float(spacing_mm[0] * spacing_mm[1] * spacing_mm[2]) / 1000.0

    # B-CLIN-4: replace axial-midpoint heuristic with segment-aware FLR.
    plane_pose, flr_ml, total_ml = compute_flr(
        couinaud_arr, voxel_ml, pattern=pattern
    )

    await _persist_flr(analysis_uuid, plane_pose, flr_ml, total_ml, pattern)

    return {
        "analysis_id": str(analysis_uuid),
        "plane_pose": plane_pose,
        "flr_ml": flr_ml,
        "total_ml": total_ml,
        "sanity": {"flr_ml": flr_ml, "total_ml": total_ml},
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.compute_initial_flr",
    retry_backoff=True,
    retry_backoff_max=120,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def compute_initial_flr(
    self: "Task",
    analysis_id: str,
    study_id: str,
    parenchyma_mask_uri: str | None = None,
    couinaud_mask_uri: str | None = None,
    pattern: str = DEFAULT_PATTERN,
) -> dict[str, Any]:
    """Celery entry point for the segment-aware initial-FLR stage."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "compute_initial_flr task=%s analysis=%s pattern=%s",
        correlation_id, analysis_id, pattern,
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            "flr_init",
            UUID(analysis_id),
            _run,
            analysis_id,
            study_id,
            parenchyma_mask_uri,
            couinaud_mask_uri,
            pattern,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


__all__ = ["compute_initial_flr", "DEFAULT_PATTERN"]
