# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Default initial-FLR Celery task (T163).

Stage 7 of the cascade. Computes the seed resection plane using a
simple heuristic: an axial plane at the vertical midpoint of the
parenchyma bounding box. The future liver remnant (FLR) is the voxel
count on one side of that plane, multiplied by voxel volume.

Plain-English analogy:
    Before the surgeon drags the resection plane to the final position,
    we plant a "reasonable first guess" flag at the middle of the
    liver. The surgeon then nudges it, and a faster WebGPU calculation
    (research §C.5) refines the number at <20 ms per drag.

Budget (research §C.2): 5 s soft / 10 s hard.

Why not use the mid-hepatic-vein directly here?
    Stage 3 (Couinaud) produces the hepatic-vein mask. Because this
    placeholder fires *before* vessel awareness in the partial-result
    flow, we fall back to the parenchyma centroid on the Z axis. When
    Couinaud output is available the number will be re-derived at the
    client (WebGPU), so the heuristic is only a seed.
"""
from __future__ import annotations

import asyncio
import io
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
from src.workers.app import app

logger = logging.getLogger(__name__)


_DEFAULT_VOXEL_VOLUME_ML = (2.3 ** 3) / 1000.0  # match parenchyma task


def _download_mask(s3_client: Any, uri: str) -> np.ndarray:
    """Read a NIfTI mask from S3. Uses a temp file + nib.load() rather
    than Nifti1Image.from_bytes(), because the latter only handles
    uncompressed NIfTI bytes — masks written by SimpleITK to .nii.gz
    are properly gzipped and would fail with HeaderDataError."""
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
    return data


def _compute_default_plane(mask: np.ndarray) -> tuple[dict[str, Any], int, int]:
    """Return (plane_pose, flr_voxels, total_voxels).

    Heuristic: axial plane at Z = midpoint of parenchyma bounding box.
    FLR = voxels with z < plane (the "superior" half, arbitrary-but-deterministic).
    """
    coords = np.argwhere(mask > 0)
    if coords.size == 0:
        return (
            {"axis": "axial", "z_index": 0, "heuristic": "parenchyma_empty"},
            0,
            0,
        )
    z_min = int(coords[:, 0].min())
    z_max = int(coords[:, 0].max())
    z_plane = (z_min + z_max) // 2

    flr_mask = mask.copy()
    flr_mask[z_plane:, :, :] = 0  # keep only the superior half as FLR
    flr_voxels = int(flr_mask.sum())
    total_voxels = int(mask.sum())

    plane_pose = {
        "axis": "axial",
        "z_index": z_plane,
        "bbox_z": [z_min, z_max],
        "heuristic": "axial_midpoint",
    }
    return plane_pose, flr_voxels, total_voxels


async def _persist_flr(
    analysis_id: UUID,
    plane_pose: dict[str, Any],
    flr_ml: float,
    total_ml: float,
) -> None:
    """INSERT an ``flr_calculation`` row in the same txn as checkpoint."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        async with session.begin():
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
                model_version="heuristic-axial-midpoint@v1",
                session=session,
                model_license_hash="n/a-heuristic",
            )


def _json_dumps(obj: dict[str, Any]) -> str:
    import json

    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


async def _run(
    analysis_id: str,
    study_id: str,
    parenchyma_mask_uri: str | None = None,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    analysis_uuid = UUID(analysis_id)

    if parenchyma_mask_uri is None:
        # Convention: cascade chain passes the parenchyma output through
        # ``previous_result`` — look it up from the checkpoint table when
        # we were invoked stand-alone (e.g. replay after partial failure).
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as session:
            row = await session.execute(
                text(
                    """
                    SELECT output_uri FROM pipeline_checkpoint
                    WHERE analysis_id = :aid AND stage = 'parenchyma'
                    """
                ),
                {"aid": str(analysis_uuid)},
            )
            found = row.first()
            if not found:
                raise RuntimeError(
                    "Cannot compute FLR before parenchyma stage is checkpointed"
                )
            parenchyma_mask_uri = found[0]

    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    loop = asyncio.get_running_loop()
    mask = await loop.run_in_executor(
        None, _download_mask, s3_client, parenchyma_mask_uri
    )

    plane_pose, flr_voxels, total_voxels = _compute_default_plane(mask)
    flr_ml = float(flr_voxels * _DEFAULT_VOXEL_VOLUME_ML)
    total_ml = float(total_voxels * _DEFAULT_VOXEL_VOLUME_ML)

    # T165 wiring: one transaction commits both the FLR row and the
    # checkpoint for stage 7.
    await _persist_flr(analysis_uuid, plane_pose, flr_ml, total_ml)

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
) -> dict[str, Any]:
    """Celery entry point for the default-FLR stage."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "compute_initial_flr task=%s analysis=%s", correlation_id, analysis_id
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            "flr_init",
            UUID(analysis_id),
            _run,
            analysis_id,
            study_id,
            parenchyma_mask_uri,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


__all__ = ["compute_initial_flr"]
