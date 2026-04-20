# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Parenchyma-segmentation Celery task (T162).

Stage 2 of the cascade. Loads the 4-phase CT volume from S3, resamples
to the 128³ contract required by the STU-Net Triton model, runs
inference, and writes the binary parenchyma mask back to S3 under
``analyses/{analysis_id}/parenchyma_mask.nii.gz``.

Plain-English analogy:
    This task is a radiographer who trims the CT images to a standard
    size, hands them to the AI for a "outline the liver" pass, then
    files the result in the patient folder — all within 35 seconds.

Budget (research §C.2): 35 s soft / 45 s hard.
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
    import SimpleITK as sitk  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover — dev env without SimpleITK
    sitk = None  # type: ignore[assignment]

try:
    import nibabel as nib  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    nib = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.services.triton import TritonClient, TritonInferenceError
from src.workers.app import app

logger = logging.getLogger(__name__)


TRITON_URL = os.environ.get("TRITON_URL", "triton:8001")
MODEL_NAME = "liverra-stunet-parenchyma"
TARGET_SHAPE = (128, 128, 128)  # D, H, W per config.pbtxt
# Voxel volume in mL for the resampled 128³ volume assuming ~300 mm
# abdominal FOV — this is a rough per-voxel weight just for sanity;
# the high-resolution volume written back to S3 uses the original grid.
_DEFAULT_VOXEL_VOLUME_ML = (2.3 ** 3) / 1000.0  # ~0.012 mL / voxel


def _download_phase_volumes(
    s3_client: Any,
    analysis_id: UUID,
    study_id: UUID,
) -> np.ndarray:
    """Return an ``(4, D, H, W)`` float16 array of the 4 phase volumes.

    Phases that are missing for a study are filled with zeros (matches
    Stage 1 contract: ``phase_hint`` can be all-zero for that channel).
    """
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )

    bucket = os.environ.get("LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1")
    phases = ("non_contrast", "arterial", "portal_venous", "delayed")
    channels: list[np.ndarray] = []
    for phase in phases:
        key = f"studies/{study_id}/phases/{phase}.nii.gz"
        try:
            obj = s3_client.get_object(Bucket=bucket, Key=key)
        except Exception as exc:
            logger.warning("missing phase %s for study %s: %s", phase, study_id, exc)
            channels.append(np.zeros(TARGET_SHAPE, dtype=np.float16))
            continue
        raw = obj["Body"].read()
        image = sitk.ReadImage(io.BytesIO(raw))  # type: ignore[arg-type]
        resampled = sitk.Resample(
            image,
            [TARGET_SHAPE[2], TARGET_SHAPE[1], TARGET_SHAPE[0]],
            sitk.Transform(),
            sitk.sitkLinear,
            image.GetOrigin(),
            [
                orig_sp * orig_sz / tgt_sz
                for orig_sp, orig_sz, tgt_sz in zip(
                    image.GetSpacing(),
                    image.GetSize(),
                    (TARGET_SHAPE[2], TARGET_SHAPE[1], TARGET_SHAPE[0]),
                    strict=True,
                )
            ],
            image.GetDirection(),
            0.0,
            image.GetPixelID(),
        )
        arr = sitk.GetArrayFromImage(resampled).astype(np.float16)
        # GetArrayFromImage returns (Z, Y, X) which matches (D, H, W).
        if arr.shape != TARGET_SHAPE:
            # Defensive crop/pad — resampler should have sized correctly
            # but model inputs must be exact.
            arr = _center_pad_or_crop(arr, TARGET_SHAPE)
        channels.append(arr)
    return np.stack(channels, axis=0)


def _center_pad_or_crop(arr: np.ndarray, target: tuple[int, int, int]) -> np.ndarray:
    out = np.zeros(target, dtype=arr.dtype)
    slices_in: list[slice] = []
    slices_out: list[slice] = []
    for dim in range(3):
        src = arr.shape[dim]
        tgt = target[dim]
        if src >= tgt:
            start = (src - tgt) // 2
            slices_in.append(slice(start, start + tgt))
            slices_out.append(slice(0, tgt))
        else:
            start = (tgt - src) // 2
            slices_in.append(slice(0, src))
            slices_out.append(slice(start, start + src))
    out[tuple(slices_out)] = arr[tuple(slices_in)]
    return out


def _upload_mask(
    s3_client: Any,
    analysis_id: UUID,
    mask: np.ndarray,
) -> str:
    """Persist the binary mask to S3 as NIfTI. Returns the S3 URI."""
    if nib is None:
        raise RuntimeError(
            "nibabel is not installed; add `nibabel` to requirements.txt"
        )

    bucket = os.environ.get("LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1")
    key = f"analyses/{analysis_id}/parenchyma_mask.nii.gz"

    nii = nib.Nifti1Image(mask.astype(np.uint8), affine=np.eye(4))  # type: ignore[attr-defined]
    buf = io.BytesIO()
    nib.save(nii, buf)  # type: ignore[attr-defined]
    buf.seek(0)
    s3_client.put_object(Bucket=bucket, Key=key, Body=buf.getvalue())
    return f"s3://{bucket}/{key}"


async def _run(
    analysis_id: str,
    study_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    analysis_uuid = UUID(analysis_id)
    study_uuid = UUID(study_id)

    # ---- Load volume from S3 (blocking; run in thread) ----------------
    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    loop = asyncio.get_running_loop()
    volume = await loop.run_in_executor(
        None, _download_phase_volumes, s3_client, analysis_uuid, study_uuid
    )
    # Add leading batch dim → (1, 4, D, H, W).
    volume_batched = volume[np.newaxis, ...]

    # ---- Triton inference --------------------------------------------
    triton = TritonClient(TRITON_URL)
    try:
        outputs = await triton.infer(
            MODEL_NAME,
            [volume_batched],
            input_names=["INPUT__0"],
            output_names=["OUTPUT__0"],
        )
    except TritonInferenceError:
        # The orchestrator's run_stage will translate this into a
        # SanityFailure / partial-result flow via the exception handler.
        raise
    finally:
        await triton.close()

    prob_mask = outputs[0]
    # Expected shape (1, 1, D, H, W) fp16; binarize at 0.5.
    mask = (prob_mask[0, 0] > 0.5).astype(np.uint8)
    nonzero = int(mask.sum())
    total_volume_ml = float(nonzero * _DEFAULT_VOXEL_VOLUME_ML)

    # ---- Persist mask + checkpoint (T165 wiring) ---------------------
    output_uri = await loop.run_in_executor(
        None, _upload_mask, s3_client, analysis_uuid, mask
    )
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        async with session.begin():
            await checkpoint.write(
                analysis_id=analysis_uuid,
                stage_no=2,
                stage="parenchyma",
                output_uri=output_uri,
                model_version=None,
                session=session,
                model_name="stu-net-parenchyma",
            )

    return {
        "analysis_id": str(analysis_uuid),
        "study_id": str(study_uuid),
        "output_uri": output_uri,
        "sanity": {
            "total_volume_ml": total_volume_ml,
            "nonzero_voxel_count": nonzero,
        },
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.segment_parenchyma",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def segment_parenchyma(
    self: "Task",
    analysis_id: str,
    study_id: str,
) -> dict[str, Any]:
    """Celery entry point for the parenchyma stage."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "segment_parenchyma task=%s analysis=%s study=%s",
        correlation_id,
        analysis_id,
        study_id,
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            "parenchyma",
            UUID(analysis_id),
            _run,
            analysis_id,
            study_id,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


__all__ = ["segment_parenchyma"]
