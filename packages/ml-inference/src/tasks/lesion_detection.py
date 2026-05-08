# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Lesion-detection Celery task (T213).

Stage 5 of the cascade. Loads the 4-phase CT volume and the Stage-1
parenchyma mask from S3, crops both to the parenchyma bounding box,
resamples the crop to 128³, runs the STU-Net lesion model via Triton,
post-processes the instance-indexed mask into connected components,
persists one per-lesion binary mask to S3, and writes one ``Lesion``
row per component with ``discovery_source='ai'``.

Plain-English analogy:
    This task is a pathologist's second read — after the first pass
    outlined the liver, this pass circles each suspicious spot inside
    it, measures the widest spread (longest diameter), and files one
    index card per lesion so the next reader can classify them in
    turn.

Budget (research §C.2): 20 s soft / 30 s hard.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
from typing import Any
from uuid import UUID, uuid4

import boto3
import numpy as np

try:
    import SimpleITK as sitk  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - dev env without SimpleITK
    sitk = None  # type: ignore[assignment]

try:
    import nibabel as nib  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    nib = None  # type: ignore[assignment]

try:
    from scipy import ndimage  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - dev env without SciPy
    ndimage = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.services.triton import TritonClient, TritonInferenceError
from src.workers.app import app

logger = logging.getLogger(__name__)


TRITON_URL = os.environ.get("TRITON_URL", "triton:8001")
MODEL_NAME = "liverra-stunet-lesions"

# Input volume shape for the Triton model (D, H, W).
TARGET_SHAPE: tuple[int, int, int] = (128, 128, 128)

# Minimum connected-component voxel count before we treat something as
# a lesion (kills specks < ~1 mm³ that are almost certainly noise).
_MIN_COMPONENT_VOXELS = 20

# Per-voxel volume assumption for the resampled crop. The real volume
# computed downstream uses the actual spacing from the CT; this is a
# coarse stand-in for post-processing sanity only.
_DEFAULT_VOXEL_MM = 2.0


def _download_nii(s3_client: Any, bucket: str, key: str) -> Any | None:
    """Fetch a NIfTI volume from S3, returning a SimpleITK Image or None."""
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )
    try:
        obj = s3_client.get_object(Bucket=bucket, Key=key)
    except Exception as exc:
        logger.warning("S3 get_object failed key=%s: %s", key, exc)
        return None
    # Same fix as parenchyma: SimpleITK 2.5+ segfaults on BytesIO; use a
    # short-lived temp file scoped to this read.
    raw = obj["Body"].read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        return sitk.ReadImage(tf.name)  # type: ignore[arg-type]


def _parenchyma_bbox(mask: np.ndarray) -> tuple[slice, slice, slice]:
    """Return the tight 3D bounding-box slice around the liver mask."""
    nonzero = np.argwhere(mask > 0)
    if nonzero.size == 0:
        raise ValueError("parenchyma mask is empty — cannot crop")
    mins = nonzero.min(axis=0)
    maxs = nonzero.max(axis=0) + 1
    return (
        slice(int(mins[0]), int(maxs[0])),
        slice(int(mins[1]), int(maxs[1])),
        slice(int(mins[2]), int(maxs[2])),
    )


def _crop_and_resample(
    volume: np.ndarray,
    bbox: tuple[slice, slice, slice],
    target: tuple[int, int, int],
) -> np.ndarray:
    """Crop a (D, H, W) volume to bbox and resample to ``target`` shape.

    Uses nearest-neighbour resize via simple decimation/zero-pad — the
    real deployment path hands the job to SimpleITK, but for placeholder
    / test paths the operation must still be deterministic and
    dependency-free.
    """
    cropped = volume[bbox]
    if cropped.shape == target:
        return cropped.astype(np.float16, copy=False)

    if sitk is not None and all(d > 0 for d in cropped.shape):
        # SimpleITK path: preserve spacing semantics where we can.
        img = sitk.GetImageFromArray(cropped.astype(np.float32))
        new_spacing = [
            max(orig_sp * orig_sz / max(tgt_sz, 1), 1e-3)
            for orig_sp, orig_sz, tgt_sz in zip(
                img.GetSpacing(),
                img.GetSize(),
                (target[2], target[1], target[0]),
                strict=True,
            )
        ]
        resampled = sitk.Resample(
            img,
            [target[2], target[1], target[0]],
            sitk.Transform(),
            sitk.sitkLinear,
            img.GetOrigin(),
            new_spacing,
            img.GetDirection(),
            0.0,
            img.GetPixelID(),
        )
        return sitk.GetArrayFromImage(resampled).astype(np.float16)

    # Fallback: center-pad-or-crop (tests / dev)
    out = np.zeros(target, dtype=np.float16)
    src_shape = cropped.shape
    offsets = [(t - s) // 2 for s, t in zip(src_shape, target, strict=True)]
    slices_out = tuple(
        slice(max(0, off), max(0, off) + min(s, t))
        for off, s, t in zip(offsets, src_shape, target, strict=True)
    )
    slices_in = tuple(
        slice(0, min(s, t)) for s, t in zip(src_shape, target, strict=True)
    )
    out[slices_out] = cropped[slices_in].astype(np.float16)
    return out


def _connected_components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Label 3D connected components in a binary mask.

    Returns ``(labels, count)``. Falls back to a simple flood-fill when
    SciPy is unavailable.
    """
    if ndimage is not None:
        structure = ndimage.generate_binary_structure(3, 1)
        labels, count = ndimage.label(mask > 0, structure=structure)
        return labels.astype(np.int32), int(count)

    # Minimal pure-numpy fallback: iterative flood fill.
    labels = np.zeros(mask.shape, dtype=np.int32)
    next_label = 0
    shape = mask.shape
    visited = np.zeros(shape, dtype=bool)
    stack: list[tuple[int, int, int]] = []
    for z in range(shape[0]):
        for y in range(shape[1]):
            for x in range(shape[2]):
                if mask[z, y, x] and not visited[z, y, x]:
                    next_label += 1
                    stack.append((z, y, x))
                    while stack:
                        cz, cy, cx = stack.pop()
                        if (
                            cz < 0
                            or cy < 0
                            or cx < 0
                            or cz >= shape[0]
                            or cy >= shape[1]
                            or cx >= shape[2]
                        ):
                            continue
                        if visited[cz, cy, cx] or not mask[cz, cy, cx]:
                            continue
                        visited[cz, cy, cx] = True
                        labels[cz, cy, cx] = next_label
                        stack.extend(
                            [
                                (cz + 1, cy, cx),
                                (cz - 1, cy, cx),
                                (cz, cy + 1, cx),
                                (cz, cy - 1, cx),
                                (cz, cy, cx + 1),
                                (cz, cy, cx - 1),
                            ]
                        )
    return labels, next_label


def _bbox_of_label(labels: np.ndarray, label_value: int) -> list[int]:
    """Return ``[z_min, y_min, x_min, z_max, y_max, x_max]`` for a label."""
    nonzero = np.argwhere(labels == label_value)
    if nonzero.size == 0:
        return [0, 0, 0, 0, 0, 0]
    mins = nonzero.min(axis=0).tolist()
    maxs = (nonzero.max(axis=0) + 1).tolist()
    return [int(mins[0]), int(mins[1]), int(mins[2]),
            int(maxs[0]), int(maxs[1]), int(maxs[2])]


def _longest_diameter_mm(bbox: list[int], voxel_mm: float) -> float:
    """Longest axis-aligned diameter in mm (max of bbox extents)."""
    dz = (bbox[3] - bbox[0]) * voxel_mm
    dy = (bbox[4] - bbox[1]) * voxel_mm
    dx = (bbox[5] - bbox[2]) * voxel_mm
    return float(max(dz, dy, dx))


def _upload_lesion_mask(
    s3_client: Any,
    analysis_id: UUID,
    lesion_id: UUID,
    mask: np.ndarray,
    reference_image: Any,
    parenchyma_bbox: tuple[slice, slice, slice] | None = None,
) -> str:
    """Persist one per-lesion binary mask to S3 as NIfTI at SOURCE CT
    resolution.

    The 128³ lesion mask covers the parenchyma's bounding-box region
    in source space. We map that bbox into SimpleITK physical
    coordinates via ``reference_image.TransformIndexToPhysicalPoint``,
    set the 128³ mask's origin/direction/spacing to match, then
    resample to the source CT grid with nearest-neighbor — so the
    yellow lesion contour in the report sits exactly on the lesion in
    the CT instead of drifting 1-2 cm.

    When ``parenchyma_bbox`` is omitted (legacy / test paths) we fall
    back to the previous approximate-geometry behaviour.
    """
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )
    bucket = os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
    )
    key = f"analyses/{analysis_id}/lesions/{lesion_id}.nii.gz"
    mask_image = sitk.GetImageFromArray(mask.astype(np.uint8))

    if reference_image is not None and parenchyma_bbox is not None:
        # F5 — affine-aware path. Compute the bbox start in patient space
        # via reference_image's affine, set the 128³ mask there, then
        # resample to the full source CT grid.
        z_slice, y_slice, x_slice = parenchyma_bbox
        # SimpleITK uses (x, y, z) index order; numpy bbox is (z, y, x).
        sitk_start_idx = [int(x_slice.start), int(y_slice.start), int(z_slice.start)]
        new_origin = reference_image.TransformIndexToPhysicalPoint(sitk_start_idx)

        ref_spacing = reference_image.GetSpacing()  # (sx, sy, sz)
        extent_x = max(1, x_slice.stop - x_slice.start)
        extent_y = max(1, y_slice.stop - y_slice.start)
        extent_z = max(1, z_slice.stop - z_slice.start)
        new_spacing = [
            extent_x * ref_spacing[0] / TARGET_SHAPE[2],  # x
            extent_y * ref_spacing[1] / TARGET_SHAPE[1],  # y
            extent_z * ref_spacing[2] / TARGET_SHAPE[0],  # z
        ]
        mask_image.SetOrigin(new_origin)
        mask_image.SetDirection(reference_image.GetDirection())
        mask_image.SetSpacing(new_spacing)

        # Resample the 128³ bbox-cropped mask onto the full source CT grid.
        upsampled = sitk.Resample(
            mask_image,
            reference_image,
            sitk.Transform(),
            sitk.sitkNearestNeighbor,
            0,
            mask_image.GetPixelID(),
        )
        mask_image = upsampled
    elif reference_image is not None:
        # Legacy approximate path for callers that don't pass the bbox.
        ref_size = reference_image.GetSize()
        ref_spacing = reference_image.GetSpacing()
        mask_size = mask_image.GetSize()
        new_spacing = [
            ref_spacing[i] * ref_size[i] / max(mask_size[i], 1)
            for i in range(3)
        ]
        mask_image.SetOrigin(reference_image.GetOrigin())
        mask_image.SetDirection(reference_image.GetDirection())
        mask_image.SetSpacing(new_spacing)

    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        sitk.WriteImage(mask_image, tf.name)
        tf.flush()
        with open(tf.name, "rb") as fh:
            raw_bytes = fh.read()
    s3_client.put_object(Bucket=bucket, Key=key, Body=raw_bytes)
    return f"s3://{bucket}/{key}"


async def _insert_lesion_row(
    session: Any,
    *,
    lesion_id: UUID,
    analysis_id: UUID,
    bbox: list[int],
    diameter_mm: float,
    mask_uri: str,
) -> None:
    """INSERT one Lesion row (discovery_source='ai')."""
    await session.execute(
        text(
            """
            INSERT INTO lesion (
                id,
                analysis_id,
                bbox3d,
                diameter_mm,
                mask_uri,
                discovery_source
            ) VALUES (
                :id,
                :analysis_id,
                CAST(:bbox3d AS jsonb),
                :diameter_mm,
                :mask_uri,
                'ai'
            )
            """
        ),
        {
            "id": str(lesion_id),
            "analysis_id": str(analysis_id),
            "bbox3d": json.dumps({"coords": bbox}),
            "diameter_mm": round(diameter_mm, 2),
            "mask_uri": mask_uri,
        },
    )


async def _run(
    analysis_id: str,
    study_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Orchestrate the Stage-5 (lesion detection) pipeline."""
    analysis_uuid = UUID(analysis_id)
    study_uuid = UUID(study_id)

    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    phases_bucket = os.environ.get(
        "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
    )
    analyses_bucket = os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
    )

    loop = asyncio.get_running_loop()

    # ---- Load parenchyma mask from Stage 1 ---------------------------
    def _load_parenchyma() -> tuple[np.ndarray | None, Any]:
        img = _download_nii(
            s3_client,
            analyses_bucket,
            f"analyses/{analysis_uuid}/parenchyma_mask.nii.gz",
        )
        if img is None:
            return None, None
        return sitk.GetArrayFromImage(img).astype(np.uint8), img

    parenchyma_mask, reference_image = await loop.run_in_executor(None, _load_parenchyma)
    if parenchyma_mask is None or parenchyma_mask.sum() == 0:
        raise RuntimeError(
            "Stage-1 parenchyma mask missing or empty; cannot run lesion "
            "detection"
        )

    bbox = _parenchyma_bbox(parenchyma_mask)

    # ---- Load 4 phases, crop each to parenchyma bbox -----------------
    def _load_phase_channels() -> np.ndarray:
        phases = ("non_contrast", "arterial", "portal_venous", "delayed")
        channels: list[np.ndarray] = []
        for phase in phases:
            key = f"studies/{study_uuid}/phases/{phase}.nii.gz"
            img = _download_nii(s3_client, phases_bucket, key)
            if img is None:
                channels.append(np.zeros(TARGET_SHAPE, dtype=np.float16))
                continue
            arr = sitk.GetArrayFromImage(img)  # type: ignore[union-attr]
            cropped = _crop_and_resample(arr, bbox, TARGET_SHAPE)
            # F10 — normalization disabled until real weights land
            # (see parenchyma.py).
            channels.append(cropped)
        return np.stack(channels, axis=0)

    volume = await loop.run_in_executor(None, _load_phase_channels)
    volume_batched = volume[np.newaxis, ...]  # (1, 4, D, H, W)

    # ---- Triton inference -------------------------------------------
    triton = TritonClient(TRITON_URL)
    try:
        outputs = await triton.infer(
            MODEL_NAME,
            [volume_batched],
            input_names=["INPUT__0"],
            output_names=["OUTPUT__0"],
        )
    except TritonInferenceError:
        raise
    finally:
        await triton.close()

    # Expected shape (1, 1, D, H, W) uint8 — instance-indexed.
    raw = outputs[0]
    if raw.ndim >= 3:
        instance_mask = np.asarray(raw).squeeze().astype(np.int32)
    else:  # pragma: no cover - defensive
        instance_mask = np.asarray(raw, dtype=np.int32)

    # Binarize + re-label with connected components so we have
    # contiguous 1..L labels even if the model emits non-contiguous
    # instance ids.
    binary = (instance_mask > 0).astype(np.uint8)
    labels, n_components = _connected_components(binary)

    # ---- Per-lesion post-processing + DB writes ---------------------
    lesions_out: list[dict[str, Any]] = []
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        async with session.begin():
            for label_value in range(1, n_components + 1):
                component_mask = (labels == label_value).astype(np.uint8)
                voxel_count = int(component_mask.sum())
                if voxel_count < _MIN_COMPONENT_VOXELS:
                    continue

                lesion_bbox = _bbox_of_label(labels, label_value)
                diameter_mm = _longest_diameter_mm(
                    lesion_bbox, _DEFAULT_VOXEL_MM
                )

                lesion_id = uuid4()
                mask_uri = await loop.run_in_executor(
                    None,
                    _upload_lesion_mask,
                    s3_client,
                    analysis_uuid,
                    lesion_id,
                    component_mask,
                    reference_image,
                    bbox,  # F5 — pass parenchyma bbox so upload can
                           # resample to source CT grid via affine.
                )
                await _insert_lesion_row(
                    session,
                    lesion_id=lesion_id,
                    analysis_id=analysis_uuid,
                    bbox=lesion_bbox,
                    diameter_mm=diameter_mm,
                    mask_uri=mask_uri,
                )
                lesions_out.append(
                    {
                        "lesion_id": str(lesion_id),
                        "bbox3d": lesion_bbox,
                        "diameter_mm": diameter_mm,
                        "mask_uri": mask_uri,
                        "voxel_count": voxel_count,
                    }
                )

            # ---- Pipeline-checkpoint write + GPU-release atomicity ----
            checkpoint_uri = (
                f"s3://{analyses_bucket}/analyses/{analysis_uuid}/lesions/"
            )
            await checkpoint.write(
                analysis_id=analysis_uuid,
                stage_no=5,
                stage="lesion_detection",
                output_uri=checkpoint_uri,
                model_version=None,
                session=session,
                model_name="stu-net-lesions",
            )

    return {
        "analysis_id": str(analysis_uuid),
        "study_id": str(study_uuid),
        "lesion_count": len(lesions_out),
        "lesions": lesions_out,
        # No numeric sanity block — lesion_detection sanity is the
        # ≥95% parenchyma-containment check, which the orchestrator
        # verifies in cascade.check_lesion_containment (T216).
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.detect_lesions",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def detect_lesions(
    self: "Task",
    analysis_id: str,
    study_id: str,
    **_kwargs: Any,
) -> dict[str, Any]:
    """Celery entry point for the lesion-detection stage.

    On any uncaught exception the cascade marks the analysis as
    ``partial_result`` and downstream classification is skipped with
    an empty lesion list (per T216 failure-mode contract).
    """
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "detect_lesions task=%s analysis=%s study=%s",
        correlation_id,
        analysis_id,
        study_id,
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            "lesion_detection",
            UUID(analysis_id),
            _run,
            analysis_id,
            study_id,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


__all__ = ["detect_lesions"]
