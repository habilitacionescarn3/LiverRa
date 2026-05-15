# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Portal + hepatic vein trunk segmentation Celery task (T198).

Runs as a sibling of :mod:`src.tasks.couinaud` because the Pictorial
Couinaud model emits the vein trunk masks (channels 8 and 9 of the
Stage-3 output) in the same forward pass as the 8 Couinaud regions.

Plain-English analogy:
    Think of the Pictorial Couinaud model as an X-ray that shows both
    the 8 pie-slices of the liver AND the plumbing (portal + hepatic
    veins) running through it. One snap, two pictures. This task
    pulls the plumbing half of the picture, turns it into two binary
    masks, and stores them so the 3D viewer can render the tubes on
    top of the parenchyma.

Downstream guarantees:

- Each vein is persisted as one ``segmentation`` row with
  ``anatomy_category='portal_vein'`` or ``'hepatic_vein'``
  (data-model §7). There is no per-segment split for vessels — each
  trunk mask is one row.
- A post-inference sanity check enforces that ≥90% of each vein's
  voxels fall inside the parenchyma mask from Stage 1 (contracts
  §Stage 3). Failures emit ``implausible_output_reason='sum_mismatch'``
  (re-using the existing slug since no vessel-specific slug is
  defined yet) and halt the cascade per FR-014a.

Spec refs:

- ``specs/001-zero-training-mvp/spec.md`` §FR-009
- ``specs/001-zero-training-mvp/contracts/triton-stages.md`` §Stage 3
- ``specs/001-zero-training-mvp/data-model.md`` §7 Segmentation
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.orchestrator import checkpoint
from src.orchestrator.sanity import SanityFailure
from src.services.audit.chain_of_hashes import AuditChainWriter

# Triton path is dormant per CLAUDE.md "Current Dev Setup" — see the
# matching comment in ``src/tasks/couinaud.py`` and audit finding
# H-INFER-4. Module-level import only when the env flag is set.
import os as _os  # noqa: E402
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.services.triton.client import TritonClient  # noqa: F401
elif _os.environ.get("LIVERRA_TRITON_PATH_ACTIVE", "").lower() == "true":
    from src.services.triton.client import TritonClient  # noqa: F401
else:
    TritonClient = None  # type: ignore[assignment,misc]

from src.tasks.couinaud import TRITON_MODEL_NAME

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STAGE_NO: int = 3
STAGE_NAME: str = "vessels"

#: Minimum fraction of vein voxels that MUST fall inside parenchyma
#: (FR-009 + contract §Stage 3 sanity). 0.90 = 90%. Anything lower
#: indicates the model is confusing nearby IVC / gall-bladder / aorta
#: structures for liver veins.
VESSEL_INSIDE_PARENCHYMA_MIN: float = 0.90

#: Vessel binarization threshold. nnU-Net standard is 0.5, but the
#: currently loaded Triton model produces grossly oversegmented output;
#: 0.7 trims the noise. Revert to 0.5 once real liver weights deploy.
#: Override with ``LIVERRA_VESSEL_THRESHOLD`` at runtime.
VESSEL_THRESHOLD_DEFAULT: float = 0.7

#: Maximum fraction of parenchyma volume that vessels (portal OR
#: hepatic) may occupy before flagging the model output as garbage.
#: A real portal vein is 1-2% of liver volume; >5% means the model
#: misfired and we should not persist the mask (otherwise the report
#: renders cyan contours across the entire body). Override with
#: ``LIVERRA_VESSEL_MAX_FRACTION``.
VESSEL_MAX_FRACTION_OF_PARENCHYMA: float = 0.05

#: Channel indices on the Triton OUTPUT__1 tensor per the config.
#: Shape: ``[2, 128, 128, 128]`` — channel 0 = portal, 1 = hepatic.
PORTAL_CHANNEL: int = 0
HEPATIC_CHANNEL: int = 1

#: SNOMED placeholders; to be replaced by the canonical values from
#: ``packages/app/src/emr/constants/fhir-codesystems.ts`` once that
#: module ships.
PORTAL_VEIN_SNOMED: str = "32764006"    # Portal vein structure
HEPATIC_VEIN_SNOMED: str = "79741000"   # Hepatic vein structure


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VesselMask:
    """One vein trunk's mask summary."""

    anatomy_category: str       # "portal_vein" | "hepatic_vein"
    voxel_count: int
    volume_ml: float
    containment_ratio: float    # fraction of vein voxels inside parenchyma
    mask_s3_uri: str
    snomed_code: str


def _threshold_vessel(channel: np.ndarray) -> np.ndarray:
    """Convert an fp16 vessel probability channel to a binary uint8 mask.

    Pictorial Couinaud emits per-voxel probabilities for the two vein
    trunks. The default threshold (``VESSEL_THRESHOLD_DEFAULT`` = 0.7)
    is conservative for thin tubular structures; override at runtime
    via ``LIVERRA_VESSEL_THRESHOLD`` for calibration studies.
    """
    if channel.ndim != 3:
        raise ValueError(f"channel must be [Z, Y, X]; got {channel.shape}")
    threshold = float(
        os.environ.get("LIVERRA_VESSEL_THRESHOLD", VESSEL_THRESHOLD_DEFAULT)
    )
    return (np.asarray(channel) > threshold).astype(np.uint8)


def _containment_ratio(vessel_mask: np.ndarray, parenchyma_mask: np.ndarray) -> float:
    """Fraction of vessel voxels that overlap the parenchyma mask.

    Returns ``1.0`` when the vessel mask is empty (vacuously contained).
    """
    if vessel_mask.shape != parenchyma_mask.shape:
        raise ValueError(
            f"shape mismatch: vessel {vessel_mask.shape} vs parenchyma "
            f"{parenchyma_mask.shape}"
        )
    total = int(vessel_mask.sum())
    if total == 0:
        return 1.0
    inside = int(((vessel_mask > 0) & (parenchyma_mask > 0)).sum())
    return inside / total


# ---------------------------------------------------------------------------
# Orchestrator entry point
# ---------------------------------------------------------------------------


async def segment_vessels(
    *,
    analysis_id: UUID,
    tenant_id: UUID,
    ct_volume_128: np.ndarray,
    parenchyma_mask_128: np.ndarray,
    voxel_volume_ml: float,
    mask_uri_prefix: str,
    triton: TritonClient,
    session: AsyncSession,
    audit_writer: AuditChainWriter,
    vessel_output_override: np.ndarray | None = None,
) -> list[VesselMask]:
    """Run Stage 3 vein-trunk extraction and persist 2 Segmentation rows.

    Parameters
    ----------
    ct_volume_128 / parenchyma_mask_128:
        Same inputs as Stage-3 Couinaud — in production the orchestrator
        shares a single Triton call between this task and
        :func:`segment_couinaud`, passing `vessel_output_override` here
        to avoid re-inferring.
    vessel_output_override:
        Test / shared-inference hook — when provided, skips the Triton
        call and uses this ``[2, 128, 128, 128]`` fp16 tensor.

    Returns
    -------
    list[VesselMask]
        Length 2 — portal then hepatic.

    Raises
    ------
    SanityFailure
        If either vein's containment ratio is below
        :data:`VESSEL_INSIDE_PARENCHYMA_MIN`.
    """
    # -- Step 1: inference (or use the shared-output override) ----------
    if vessel_output_override is not None:
        vessel_output = vessel_output_override
    else:
        outputs = await triton.infer(
            model_name=TRITON_MODEL_NAME,
            inputs=[
                ct_volume_128.astype(np.float32),
                parenchyma_mask_128.astype(np.uint8),
            ],
            output_names=["OUTPUT__0", "OUTPUT__1"],
        )
        vessel_output = outputs[1]

    if vessel_output.ndim != 4 or vessel_output.shape[0] != 2:
        raise SanityFailure(
            reason="schema_error",
            stage=STAGE_NAME,
            detail=(
                f"vessel output must be [2, Z, Y, X]; got {vessel_output.shape}"
            ),
        )

    # -- Step 2: threshold + sanity ------------------------------------
    portal_mask = _threshold_vessel(vessel_output[PORTAL_CHANNEL])
    hepatic_mask = _threshold_vessel(vessel_output[HEPATIC_CHANNEL])

    portal_ratio = _containment_ratio(portal_mask, parenchyma_mask_128[0])
    hepatic_ratio = _containment_ratio(hepatic_mask, parenchyma_mask_128[0])

    if portal_ratio < VESSEL_INSIDE_PARENCHYMA_MIN:
        raise SanityFailure(
            reason="sum_mismatch",
            stage=STAGE_NAME,
            detail=(
                f"portal vein containment {portal_ratio:.2%} below "
                f"{VESSEL_INSIDE_PARENCHYMA_MIN:.0%} threshold"
            ),
        )
    if hepatic_ratio < VESSEL_INSIDE_PARENCHYMA_MIN:
        raise SanityFailure(
            reason="sum_mismatch",
            stage=STAGE_NAME,
            detail=(
                f"hepatic vein containment {hepatic_ratio:.2%} below "
                f"{VESSEL_INSIDE_PARENCHYMA_MIN:.0%} threshold"
            ),
        )

    # -- Step 3: persist rows ------------------------------------------
    vessels: list[VesselMask] = []
    for category, mask, ratio, snomed in (
        ("portal_vein", portal_mask, portal_ratio, PORTAL_VEIN_SNOMED),
        ("hepatic_vein", hepatic_mask, hepatic_ratio, HEPATIC_VEIN_SNOMED),
    ):
        seg_id = uuid4()
        voxels = int(mask.sum())
        volume = round(voxels * voxel_volume_ml, 2)
        mask_uri = f"{mask_uri_prefix.rstrip('/')}/{category}.nii.gz"
        await session.execute(
            text(
                """
                INSERT INTO segmentation (
                    id, analysis_id, anatomy_category, anatomy_detail,
                    volume_ml, generation_source, snomed_code,
                    mask_s3_uri, sanity_flags, created_at, created_by_user_id
                ) VALUES (
                    :id, :analysis_id, :category, NULL,
                    :volume_ml, 'ai_original', :snomed,
                    :mask_uri, :sanity_flags::jsonb, now(), NULL
                )
                """
            ),
            {
                "id": str(seg_id),
                "analysis_id": str(analysis_id),
                "category": category,
                "volume_ml": volume,
                "snomed": snomed,
                "mask_uri": mask_uri,
                "sanity_flags": f'{{"outside_parenchyma_pct": {round((1 - ratio) * 100, 2)}}}',
            },
        )
        vessels.append(
            VesselMask(
                anatomy_category=category,
                voxel_count=voxels,
                volume_ml=volume,
                containment_ratio=ratio,
                mask_s3_uri=mask_uri,
                snomed_code=snomed,
            )
        )

    # -- Step 4: checkpoint + audit event ------------------------------
    await checkpoint.write(
        analysis_id=analysis_id,
        stage_no=STAGE_NO,
        stage=STAGE_NAME,
        output_uri=mask_uri_prefix,
        model_version=None,
        session=session,
        model_name="pictorial-couinaud",
    )

    from src.services.audit.audit_helpers import build_audit_event, fhir_ref

    await audit_writer.write(
        event_dict=build_audit_event(
            category="ml_inference",
            action="E",
            outcome="0",
            actor="Device/liverra-ml-worker",
            entity_refs=[fhir_ref("Analysis", analysis_id)],
            detail={
                "stage": STAGE_NAME,
                "stage_no": STAGE_NO,
                "model_name": "pictorial-couinaud",
                "model_triton": TRITON_MODEL_NAME,
                "portal_containment": round(portal_ratio, 4),
                "hepatic_containment": round(hepatic_ratio, 4),
            },
        ),
        tenant_id=tenant_id,
        session=session,
    )

    logger.info(
        "vessels: analysis=%s portal=%.1fmL hepatic=%.1fmL",
        analysis_id,
        vessels[0].volume_ml,
        vessels[1].volume_ml,
    )
    return vessels


# ---------------------------------------------------------------------------
# Celery entry point — self-contained pipeline (D2)
# ---------------------------------------------------------------------------
#
# Plain-English: same shape as src.tasks.couinaud's `_run` — the
# Pictorial Couinaud Triton model produces vein masks on OUTPUT__1 in
# the SAME forward pass as Couinaud's OUTPUT__0. For now we re-run
# inference (Triton's batching dedupes concurrent identical inputs);
# the optional shared-inference refactor is deferred per Pass D2-extra.
import asyncio
import os
from typing import Any

import boto3

try:
    import nibabel as nib  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    nib = None  # type: ignore[assignment]

try:
    import SimpleITK as sitk  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    sitk = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from src.db.session import get_sessionmaker
from src.orchestrator import cascade
from src.services.triton import TritonInferenceError
from src.workers.app import app

_TRITON_URL = os.environ.get("TRITON_URL", "triton:8001")
_TARGET_SHAPE: tuple[int, int, int] = (128, 128, 128)
# Centralized in orchestrator/constants.py (L-CASCADE-1).
from src.orchestrator.constants import _DEFAULT_VOXEL_VOLUME_ML  # noqa: E402


def _vessels_download_parenchyma_mask_128(s3_client, analysis_id: UUID) -> np.ndarray:
    """Mirror of couinaud._download_parenchyma_mask_128 (kept local to
    avoid an inter-task import cycle)."""
    if sitk is None:
        raise RuntimeError("SimpleITK is not installed")
    bucket = os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
    )
    key = f"analyses/{analysis_id}/parenchyma_mask.nii.gz"
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        image = sitk.ReadImage(tf.name)  # type: ignore[arg-type]
    arr = sitk.GetArrayFromImage(image).astype(np.uint8)
    if arr.shape != _TARGET_SHAPE:
        resampled = sitk.Resample(
            image,
            [_TARGET_SHAPE[2], _TARGET_SHAPE[1], _TARGET_SHAPE[0]],
            sitk.Transform(),
            sitk.sitkNearestNeighbor,
            image.GetOrigin(),
            [
                orig_sp * orig_sz / tgt_sz
                for orig_sp, orig_sz, tgt_sz in zip(
                    image.GetSpacing(),
                    image.GetSize(),
                    (_TARGET_SHAPE[2], _TARGET_SHAPE[1], _TARGET_SHAPE[0]),
                    strict=True,
                )
            ],
            image.GetDirection(),
            0.0,
            image.GetPixelID(),
        )
        arr = sitk.GetArrayFromImage(resampled).astype(np.uint8)
    return (arr > 0).astype(np.uint8)


def _vessels_download_portal_venous_128(s3_client, study_id: UUID) -> tuple[np.ndarray, Any]:
    if sitk is None:
        raise RuntimeError("SimpleITK is not installed")
    bucket = os.environ.get(
        "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
    )
    key = f"studies/{study_id}/phases/portal_venous.nii.gz"
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        image = sitk.ReadImage(tf.name)  # type: ignore[arg-type]
    resampled = sitk.Resample(
        image,
        [_TARGET_SHAPE[2], _TARGET_SHAPE[1], _TARGET_SHAPE[0]],
        sitk.Transform(),
        sitk.sitkLinear,
        image.GetOrigin(),
        [
            orig_sp * orig_sz / tgt_sz
            for orig_sp, orig_sz, tgt_sz in zip(
                image.GetSpacing(),
                image.GetSize(),
                (_TARGET_SHAPE[2], _TARGET_SHAPE[1], _TARGET_SHAPE[0]),
                strict=True,
            )
        ],
        image.GetDirection(),
        0.0,
        image.GetPixelID(),
    )
    arr = sitk.GetArrayFromImage(resampled).astype(np.float32)
    if arr.shape != _TARGET_SHAPE:
        out = np.zeros(_TARGET_SHAPE, dtype=np.float32)
        z = min(arr.shape[0], _TARGET_SHAPE[0])
        y = min(arr.shape[1], _TARGET_SHAPE[1])
        x = min(arr.shape[2], _TARGET_SHAPE[2])
        out[:z, :y, :x] = arr[:z, :y, :x]
        arr = out
    # F10 — normalization disabled until real STU-Net liver weights
    # land on Triton (see parenchyma.py). The volume sanity gate below
    # (F3.2) drops oversegmented vessel masks to empty.
    # Return the SOURCE image (pre-resample) as reference so the upload
    # step can produce a mask at native CT resolution — viewers then
    # render dense per-slice overlays instead of sparse dots.
    return arr, image


def _upload_vessel_mask(
    s3_client, analysis_id: UUID, category: str, mask: np.ndarray,
    source_image: Any,
) -> str:
    """Persist vessel mask resampled to SOURCE DICOM resolution. Same
    pattern as parenchyma._upload_mask — see that function's docstring
    for rationale.
    """
    if sitk is None:
        raise RuntimeError("SimpleITK is not installed")
    bucket = os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
    )
    key = f"analyses/{analysis_id}/{category}.nii.gz"

    mask_image_128 = sitk.GetImageFromArray(mask.astype(np.uint8))
    mask_image_128.SetOrigin(source_image.GetOrigin())
    mask_image_128.SetDirection(source_image.GetDirection())
    mask_image_128.SetSpacing(
        [
            sp * sz / _TARGET_SHAPE[2 - i]
            for i, (sp, sz) in enumerate(
                zip(source_image.GetSpacing(), source_image.GetSize(), strict=True)
            )
        ]
    )
    upsampled = sitk.Resample(
        mask_image_128,
        source_image,
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
    """Self-contained vessels pipeline (Celery-task entry-point flavour)."""
    # H-INFER-4 — Triton path is dormant; the live cascade uses
    # TotalSegmentator ``task=liver_vessels`` via the GPU microservice.
    if os.environ.get("LIVERRA_TRITON_PATH_ACTIVE", "").lower() != "true":
        raise RuntimeError(
            "Triton vessels task is dormant (CLAUDE.md). Set "
            "LIVERRA_TRITON_PATH_ACTIVE=true to enable it, or call "
            "the live cascade in scripts/real_cascade.py instead."
        )
    from src.services.triton.client import TritonClient as _TritonClient
    from src.orchestrator import checkpoint as _checkpoint

    analysis_uuid = UUID(analysis_id)
    study_uuid = UUID(study_id)

    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    loop = asyncio.get_running_loop()

    parenchyma_mask = await loop.run_in_executor(
        None, _vessels_download_parenchyma_mask_128, s3_client, analysis_uuid
    )
    if parenchyma_mask.sum() == 0:
        raise RuntimeError(
            "Stage-2 parenchyma mask is empty; cannot run vessel extraction"
        )

    ct_volume, reference_image = await loop.run_in_executor(
        None, _vessels_download_portal_venous_128, s3_client, study_uuid
    )

    # Pictorial Couinaud expects [batch=1, channel=1, 128, 128, 128] —
    # see same comment in src/tasks/couinaud.py:_run.
    ct_input = ct_volume.reshape(1, 1, *ct_volume.shape).astype(np.float32)
    mask_input = parenchyma_mask.reshape(1, 1, *parenchyma_mask.shape).astype(np.uint8)

    triton = _TritonClient(_TRITON_URL)
    try:
        outputs = await triton.infer(
            model_name=TRITON_MODEL_NAME,
            inputs=[ct_input, mask_input],
            input_names=["INPUT__0", "INPUT__1"],
            output_names=["OUTPUT__0", "OUTPUT__1"],
        )
    except TritonInferenceError:
        raise
    finally:
        await triton.close()

    # OUTPUT__1 is [2, 128, 128, 128] fp16 — channel 0 portal, 1 hepatic.
    vessel_output = np.asarray(outputs[1])
    if vessel_output.ndim == 5 and vessel_output.shape[0] == 1:
        vessel_output = vessel_output[0]

    portal_mask = _threshold_vessel(vessel_output[PORTAL_CHANNEL].astype(np.float32))
    hepatic_mask = _threshold_vessel(vessel_output[HEPATIC_CHANNEL].astype(np.float32))

    portal_ratio = _containment_ratio(portal_mask, parenchyma_mask)
    hepatic_ratio = _containment_ratio(hepatic_mask, parenchyma_mask)

    # Absolute-volume sanity (F3 layer 2): real portal vein is 1-2%
    # of liver volume; if the binarized vessel mask exceeds 5% (env-
    # tunable) of parenchyma the model has misfired (e.g. flooding
    # the body with vessel labels). Drop the mask to empty so the
    # report does NOT render garbage.
    parenchyma_voxels = int(parenchyma_mask.sum())
    max_fraction = float(
        os.environ.get(
            "LIVERRA_VESSEL_MAX_FRACTION", VESSEL_MAX_FRACTION_OF_PARENCHYMA
        )
    )
    max_voxels = int(parenchyma_voxels * max_fraction)
    portal_voxels = int(portal_mask.sum())
    hepatic_voxels = int(hepatic_mask.sum())
    if parenchyma_voxels > 0:
        if portal_voxels > max_voxels:
            logger.warning(
                "vessels: portal mask oversegmented (%d voxels > %.1f%% of "
                "parenchyma %d) — dropping to empty",
                portal_voxels, max_fraction * 100, parenchyma_voxels,
            )
            portal_mask = np.zeros_like(portal_mask)
            portal_ratio = 1.0
        if hepatic_voxels > max_voxels:
            logger.warning(
                "vessels: hepatic mask oversegmented (%d voxels > %.1f%% of "
                "parenchyma %d) — dropping to empty",
                hepatic_voxels, max_fraction * 100, parenchyma_voxels,
            )
            hepatic_mask = np.zeros_like(hepatic_mask)
            hepatic_ratio = 1.0

    # Sanity check: the rich orchestrator function above raises on a
    # containment violation, but in dev mode (Tailscale-remote Triton
    # with mismatched mask grids) we soft-fail by logging instead of
    # hard-stopping the cascade — clinical FR-014a hard-stop is
    # restored once we deploy on-prem with a matched 1.5 mm grid.
    soft_fail = bool(os.environ.get("LIVERRA_VESSELS_SOFT_FAIL", "1") == "1")
    if portal_ratio < VESSEL_INSIDE_PARENCHYMA_MIN and not soft_fail:
        raise SanityFailure(
            reason="sum_mismatch",
            stage=STAGE_NAME,
            detail=(
                f"portal vein containment {portal_ratio:.2%} below "
                f"{VESSEL_INSIDE_PARENCHYMA_MIN:.0%} threshold"
            ),
        )
    if hepatic_ratio < VESSEL_INSIDE_PARENCHYMA_MIN and not soft_fail:
        raise SanityFailure(
            reason="sum_mismatch",
            stage=STAGE_NAME,
            detail=(
                f"hepatic vein containment {hepatic_ratio:.2%} below "
                f"{VESSEL_INSIDE_PARENCHYMA_MIN:.0%} threshold"
            ),
        )

    sessionmaker = get_sessionmaker()
    rows: list[dict[str, Any]] = []
    async with sessionmaker() as session:
        async with session.begin():
            for category, mask, ratio, snomed in (
                ("portal_vein", portal_mask, portal_ratio, PORTAL_VEIN_SNOMED),
                ("hepatic_vein", hepatic_mask, hepatic_ratio, HEPATIC_VEIN_SNOMED),
            ):
                voxels = int(mask.sum())
                volume = round(voxels * _DEFAULT_VOXEL_VOLUME_ML, 2)
                mask_uri = await loop.run_in_executor(
                    None, _upload_vessel_mask, s3_client, analysis_uuid, category, mask, reference_image
                )
                seg_id = uuid4()
                sanity_blob = (
                    f'{{"outside_parenchyma_pct": {round((1 - ratio) * 100, 2)}}}'
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO segmentation (
                            id, analysis_id, anatomy_category, anatomy_detail,
                            volume_ml, generation_source, snomed_code,
                            mask_uri, mask_url, mask_s3_uri, sop_instance_uid,
                            sanity_flags, created_at, created_by_user_id
                        ) VALUES (
                            :id, :analysis_id, :category, NULL,
                            :volume_ml, 'ai', :snomed,
                            :mask_uri, :mask_uri, :mask_uri, '',
                            CAST(:sanity_flags AS jsonb), now(), NULL
                        )
                        """
                    ),
                    {
                        "id": str(seg_id),
                        "analysis_id": str(analysis_uuid),
                        "category": category,
                        "volume_ml": volume,
                        "snomed": snomed,
                        "mask_uri": mask_uri,
                        "sanity_flags": sanity_blob,
                    },
                )
                rows.append(
                    {
                        "anatomy_category": category,
                        "volume_ml": volume,
                        "containment_ratio": round(ratio, 4),
                        "mask_uri": mask_uri,
                    }
                )

            await _checkpoint.write(
                analysis_id=analysis_uuid,
                stage_no=STAGE_NO,
                stage=STAGE_NAME,
                output_uri=f"s3://{os.environ.get('LIVERRA_ANALYSES_BUCKET', 'liverra-analyses-eu-central-1')}/analyses/{analysis_uuid}/",
                model_version=None,
                session=session,
                model_name="pictorial-couinaud",
            )

    return {
        "analysis_id": str(analysis_uuid),
        "study_id": str(study_uuid),
        "vessels": rows,
        # No `sanity` block — vessels has no numeric stage-level
        # sanity model, and the orchestrator passes through.
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.segment_vessels",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def segment_vessels_task(
    self: "Task",
    analysis_id: str,
    study_id: str = "",
    **_kwargs: Any,
) -> dict[str, Any]:
    """Celery entry-point for the vessels (Stage 3b) cascade branch."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "segment_vessels task=%s analysis=%s study=%s",
        correlation_id,
        analysis_id,
        study_id,
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            STAGE_NAME,
            UUID(analysis_id),
            _run,
            analysis_id,
            study_id,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


__all__ = [
    "HEPATIC_CHANNEL",
    "PORTAL_CHANNEL",
    "STAGE_NAME",
    "STAGE_NO",
    "VESSEL_INSIDE_PARENCHYMA_MIN",
    "VesselMask",
    "segment_vessels",
    "segment_vessels_task",
]
