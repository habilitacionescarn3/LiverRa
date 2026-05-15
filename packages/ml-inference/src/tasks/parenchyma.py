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
# Voxel volume in mL for the resampled 128³ volume — single source of truth
# in ``src/orchestrator/constants.py``. Stages that have the *native*
# SimpleITK image use ``np.prod(image.GetSpacing()) / 1000`` and bypass this
# fallback (L-CASCADE-1).
from src.orchestrator.constants import _DEFAULT_VOXEL_VOLUME_ML  # noqa: E402


def _download_phase_volumes(
    s3_client: Any,
    analysis_id: UUID,
    study_id: UUID,
) -> tuple[np.ndarray, Any]:
    """Return an ``(4, D, H, W)`` float16 array of the 4 phase volumes
    AND a reference SimpleITK image carrying the resampled grid's
    origin/spacing/direction so downstream mask uploads can write
    NIfTI files with proper patient-space alignment (else viewers
    overlay the 128³ mask at world origin and it floats off-CT).

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
    # Track ALL successfully-read source images alongside their phase
    # names. We pass both to ``select_reference_phase`` so the cascade-
    # wide ``LIVERRA_REFERENCE_PHASE`` env var (default ``portal_venous``)
    # decides the reference grid — without that lock, parenchyma would
    # pick arterial (largest) while vessels + couinaud hardcode
    # portal_venous, producing Z-axis-mismatched masks.
    source_images: list[Any] = []
    source_phase_names: list[str] = []
    for phase in phases:
        key = f"studies/{study_id}/phases/{phase}.nii.gz"
        try:
            obj = s3_client.get_object(Bucket=bucket, Key=key)
        except Exception as exc:
            logger.warning("missing phase %s for study %s: %s", phase, study_id, exc)
            channels.append(np.zeros(TARGET_SHAPE, dtype=np.float16))
            continue
        raw = obj["Body"].read()
        # SimpleITK's ReadImage requires a filesystem path, not BytesIO
        # (passing BytesIO causes a segfault on libsitk 2.5+). Use a temp
        # file scoped to this iteration.
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
            tf.write(raw)
            tf.flush()
            image = sitk.ReadImage(tf.name)  # type: ignore[arg-type]
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
        # F10 — preprocessing helper exists at services/ct_preprocessing.py
        # but is currently NOT wired in: empirical testing showed the
        # loaded model on Triton produces denser (more wrong) output
        # with normalization than without. This indicates the model.pt
        # weights may not be real STU-Net liver weights — assigned to
        # Irakli to investigate. When real weights land, re-enable via:
        #   from src.services.ct_preprocessing import normalize_ct_for_stunet
        #   arr = normalize_ct_for_stunet(sitk.GetArrayFromImage(resampled))
        arr = sitk.GetArrayFromImage(resampled).astype(np.float16)
        # GetArrayFromImage returns (Z, Y, X) which matches (D, H, W).
        if arr.shape != TARGET_SHAPE:
            # Defensive crop/pad — resampler should have sized correctly
            # but model inputs must be exact.
            arr = _center_pad_or_crop(arr, TARGET_SHAPE)
        channels.append(arr)
        source_images.append(image)
        source_phase_names.append(phase)
    if not source_images:
        # All phases missing — synthesize a neutral reference so callers
        # can still construct (misaligned) masks. In practice the cascade
        # should fail earlier in stage 0 (ingest) when no phases exist.
        reference_image = sitk.Image(
            TARGET_SHAPE[2], TARGET_SHAPE[1], TARGET_SHAPE[0], sitk.sitkFloat32,
        )
    else:
        from src.services.phase_selection import select_reference_phase
        reference_image = select_reference_phase(source_images, source_phase_names)
    return np.stack(channels, axis=0), reference_image


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
    source_image: Any,
) -> str:
    """Persist the binary mask to S3 as NIfTI at SOURCE DICOM resolution.

    The Triton model produces a 128³ mask. Without resampling, viewers
    show the mask as sparse dots scattered through high-resolution CT
    slices (every ~3rd CT slice has a mask voxel; the rest show nothing).
    We rebuild the 128³ mask geometry from `source_image`, then resample
    it back to source grid with nearest-neighbor so every CT slice gets
    a dense, anatomically correct overlay. Compresses well (binary +
    gzip) so file size stays in the single-digit MB range.
    """
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )

    bucket = os.environ.get("LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1")
    key = f"analyses/{analysis_id}/parenchyma_mask.nii.gz"

    # Build mask at 128³ in the same patient-space extent as source.
    mask_image_128 = sitk.GetImageFromArray(mask.astype(np.uint8))
    mask_image_128.SetOrigin(source_image.GetOrigin())
    mask_image_128.SetDirection(source_image.GetDirection())
    mask_image_128.SetSpacing(
        [
            sp * sz / TARGET_SHAPE[2 - i]
            for i, (sp, sz) in enumerate(
                zip(source_image.GetSpacing(), source_image.GetSize(), strict=True)
            )
        ]
    )

    # Resample to source grid (nearest-neighbor preserves binary).
    upsampled = sitk.Resample(
        mask_image_128,
        source_image,  # use as target geometry
        sitk.Transform(),
        sitk.sitkNearestNeighbor,
        0,
        mask_image_128.GetPixelID(),
    )

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        sitk.WriteImage(upsampled, tf.name)
        tf.flush()
        with open(tf.name, "rb") as fh:
            raw = fh.read()
    s3_client.put_object(Bucket=bucket, Key=key, Body=raw)
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
    volume, reference_image = await loop.run_in_executor(
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
    # The Triton model.pt currently loaded produces noisy output (likely
    # stub or wrong-task weights — assigned to Irakli to verify). The
    # post-processing below is a defensive cleanup that keeps the
    # cascade producing visualisable results until real weights land.
    # When real STU-Net weights are deployed, drop ``LIVERRA_PARENCHYMA_*``
    # tunings to nnU-Net defaults (threshold=0.5, no opening / Z trim).
    threshold = float(os.environ.get("LIVERRA_PARENCHYMA_THRESHOLD", "0.7"))
    mask = (prob_mask[0, 0] > threshold).astype(np.uint8)

    try:
        from scipy.ndimage import (
            label as ndi_label,
            binary_fill_holes,
            binary_opening,
            generate_binary_structure,
        )
        # Erode thin bridges between liver and surrounding noise.
        struct = generate_binary_structure(3, 1)
        opened = binary_opening(mask, structure=struct, iterations=1)
        if opened.sum() > 0:
            mask = opened.astype(np.uint8)

        # Keep only the largest connected component (assumed liver).
        labels_arr, n_components = ndi_label(mask)
        if n_components > 1:
            sizes = np.bincount(labels_arr.ravel())
            sizes[0] = 0
            keep_label = int(sizes.argmax())
            mask = (labels_arr == keep_label).astype(np.uint8)
            logger.info(
                "parenchyma cleanup: kept largest of %d components (%d voxels)",
                n_components, int(sizes[keep_label]),
            )

        # Z-band trim around the densest slice (the real liver center).
        z_band = int(os.environ.get("LIVERRA_PARENCHYMA_Z_BAND", "25"))
        per_z = mask.sum(axis=(1, 2))
        if per_z.sum() > 0:
            peak_z = int(np.argmax(per_z))
            z_lo = max(0, peak_z - z_band)
            z_hi = min(mask.shape[0], peak_z + z_band + 1)
            trimmed = np.zeros_like(mask)
            trimmed[z_lo:z_hi] = mask[z_lo:z_hi]
            kept = int(trimmed.sum())
            dropped = int(mask.sum()) - kept
            logger.info(
                "parenchyma cleanup: Z-band trim peak_z=%d band=±%d kept=%d dropped=%d",
                peak_z, z_band, kept, dropped,
            )
            mask = trimmed

        mask = binary_fill_holes(mask).astype(np.uint8)
    except Exception as exc:  # noqa: BLE001 — cleanup is best-effort
        logger.warning("parenchyma CC cleanup skipped: %s", exc)

    # Diagnostic: a real liver spans ~15-20 cm, never the full abdominal
    # CT. If the mask still occupies >60% of the CT Z-range, surface a
    # warning — most likely indicates a model-side regression (since F10
    # normalization should keep the output within the liver region).
    if mask.sum() > 0:
        z_with_mask = np.where(mask.sum(axis=(1, 2)) > 0)[0]
        z_extent = int(z_with_mask.max() - z_with_mask.min() + 1) if len(z_with_mask) else 0
        z_total = int(mask.shape[0])
        if z_total and z_extent / z_total > 0.6:
            logger.warning(
                "parenchyma: mask Z-extent suspicious — spans %d/%d slices "
                "(%.0f%%); check CT preprocessing or model weights",
                z_extent, z_total, z_extent / z_total * 100,
            )

    nonzero = int(mask.sum())
    total_volume_ml = float(nonzero * _DEFAULT_VOXEL_VOLUME_ML)

    # ---- Persist mask + checkpoint (T165 wiring) ---------------------
    output_uri = await loop.run_in_executor(
        None, _upload_mask, s3_client, analysis_uuid, mask, reference_image
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
            # Persist a `liver` segmentation row so the Segments tab can
            # surface the parenchyma volume right after this stage. Idempotent
            # via a NOT EXISTS guard so a Celery retry doesn't double-insert.
            from sqlalchemy import text as _text  # local import: keep top-of-file lean
            await session.execute(
                _text(
                    """
                    INSERT INTO segmentation
                      (analysis_id, anatomy_category, anatomy_detail, volume_ml,
                       mask_url, mask_uri, sop_instance_uid, generation_source)
                    SELECT :aid, 'liver', NULL, :vol, :uri, :uri, '', 'ai'
                    WHERE NOT EXISTS (
                      SELECT 1 FROM segmentation
                      WHERE analysis_id = :aid AND anatomy_category = 'liver'
                    )
                    """
                ),
                {
                    "aid": str(analysis_uuid),
                    "vol": float(total_volume_ml),
                    "uri": output_uri,
                },
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
