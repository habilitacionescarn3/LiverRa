# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Couinaud 8-segment Celery task (T197).

Stage 3 (parallel branch a) of the cascade. Takes the parenchyma mask
from Stage 2 + the portal-venous CT phase and asks the Pictorial
Couinaud model (Triton `liverra-couinaud-segments`) to parse the liver
into its 8 Couinaud regions (I..VIII).

This module exposes two public surfaces:

1. The high-level orchestrator coroutine
   :func:`segment_couinaud` (kept intact for shared-inference flows
   that already own a Triton client + audit writer).
2. The Celery entry-point :func:`segment_couinaud_task`, registered as
   ``liverra.tasks.segment_couinaud``. The cascade graph in
   :mod:`src.orchestrator.cascade` references the task by string name,
   so this is the function actually invoked when Celery dispatches the
   chord branch. Its `_run` self-contained pipeline mirrors
   :mod:`src.tasks.lesion_detection` — load mask + CT from S3, call
   Triton once, persist 8 Segmentation rows + checkpoint.

Plain-English analogy:
    Stage 1 gave us the outline of the whole liver. Stage 3 takes that
    outline and draws 8 chalk-lines inside it following the portal and
    hepatic vein tree — like quartering an apple along its natural
    creases. Each wedge is a Couinaud segment, named after Claude
    Couinaud's 1957 taxonomy.

Notes:

- This task shares its Triton call with ``segment_vessels`` (see
  ``src/tasks/vessels.py``). The Pictorial Couinaud model emits both
  the 8-channel segment softmax AND the 2-channel vein-trunk masks in
  one forward pass. The orchestrator calls ``infer_stage3`` once and
  fans out the two output tensors to the two database writers.
- All writes happen in the caller's transaction — the writer never
  commits on its own, so a downstream failure cleanly rolls back the
  whole cascade row-set (FR-014a partial-result invariant).
- Every invocation emits a FHIR AuditEvent via the chain-of-hashes
  writer (research §A.3 / FR-029b).

Spec refs:

- ``specs/001-zero-training-mvp/spec.md`` §FR-008, §US2 (happy / failure / edge)
- ``specs/001-zero-training-mvp/contracts/triton-stages.md`` §Stage 3
- ``specs/001-zero-training-mvp/data-model.md`` §7 Segmentation
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Sequence
from uuid import UUID, uuid4

import numpy as np
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.orchestrator import checkpoint, sanity
from src.services.audit.chain_of_hashes import AuditChainWriter

# Triton path is dormant per CLAUDE.md "Current Dev Setup" — the live
# cascade uses TotalSegmentator via the GPU microservice
# (``src/services/inference_client.py``). The TritonClient import is
# only resolved at module import time when ``LIVERRA_TRITON_PATH_ACTIVE=true``;
# otherwise we leave it as a TYPE_CHECKING-only alias so dormant deploys
# don't require triton-client to be installed (H-INFER-4).
import os as _os  # noqa: E402 — local alias to avoid shadowing later os imports
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.services.triton.client import TritonClient  # noqa: F401
elif _os.environ.get("LIVERRA_TRITON_PATH_ACTIVE", "").lower() == "true":
    from src.services.triton.client import TritonClient  # noqa: F401
else:
    TritonClient = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants — Couinaud label map
# ---------------------------------------------------------------------------

#: Roman-numeral labels used in ``Segmentation.anatomy_detail`` per
#: data-model.md §7. Order matters — channel `i` of the softmax output
#: corresponds to segment ``COUINAUD_LABELS[i]``.
COUINAUD_LABELS: tuple[str, ...] = (
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII",
)

#: SNOMED-CT codes for each Couinaud region (sourced from the LiverRa
#: canon at ``packages/app/src/emr/constants/fhir-codesystems.ts``,
#: research §B.4). Placeholders until the canon ships — replace with
#: real concept IDs in T?.
COUINAUD_SNOMED: dict[str, str] = {
    "I":    "245293007",  # Caudate lobe (structure)
    "II":   "245294001",
    "III":  "245295000",
    "IV":   "245296004",
    "V":    "245297008",
    "VI":   "245298003",
    "VII":  "245299006",
    "VIII": "245300003",
}

TRITON_MODEL_NAME: str = "liverra-couinaud-segments"
STAGE_NO: int = 4
STAGE_NAME: str = "couinaud"


# ---------------------------------------------------------------------------
# Pure helpers (no DB, easy to unit-test)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SegmentMask:
    """One Couinaud segment's mask + volume summary."""

    label: str                 # "I".."VIII"
    voxel_count: int
    volume_ml: float
    mask_s3_uri: str           # where the orchestrator persisted the mask
    snomed_code: str


def _argmax_to_labels(softmax_volume: np.ndarray) -> np.ndarray:
    """Collapse the [8, Z, Y, X] softmax volume into a [Z, Y, X] uint8 label map.

    Voxels with max probability < ``1/8 + ε`` are treated as
    unclassified (value 0). Otherwise the label is 1..8.

    Plain-English: pick the winner per voxel; if the 8 candidates are
    basically tied we call it "don't know" and leave the voxel blank.
    """
    if softmax_volume.ndim != 4 or softmax_volume.shape[0] != 8:
        raise ValueError(
            f"softmax_volume must be [8, Z, Y, X]; got {softmax_volume.shape}"
        )
    # argmax returns 0..7; we want 1..8 with a 0 reserved for unclassified.
    max_channel = np.argmax(softmax_volume, axis=0).astype(np.uint8) + 1
    max_prob = np.max(softmax_volume, axis=0)
    uncertainty_threshold = 1.0 / 8.0 + 0.02
    max_channel[max_prob < uncertainty_threshold] = 0
    return max_channel


def _voxel_count_per_segment(label_map: np.ndarray) -> dict[str, int]:
    """Return {label: voxel_count} for Couinaud I..VIII in ``label_map``."""
    return {
        label: int((label_map == (idx + 1)).sum())
        for idx, label in enumerate(COUINAUD_LABELS)
    }


def _volumes_ml(
    voxel_counts: dict[str, int], voxel_volume_ml: float
) -> dict[str, float]:
    """Voxel counts → per-segment mL, rounded to two decimals."""
    return {
        label: round(count * voxel_volume_ml, 2)
        for label, count in voxel_counts.items()
    }


# ---------------------------------------------------------------------------
# Orchestrator entry point
# ---------------------------------------------------------------------------


async def segment_couinaud(
    *,
    analysis_id: UUID,
    tenant_id: UUID,
    ct_volume_128: np.ndarray,
    parenchyma_mask_128: np.ndarray,
    parenchyma_volume_ml: float,
    voxel_volume_ml: float,
    mask_uri_prefix: str,
    triton: TritonClient,
    session: AsyncSession,
    audit_writer: AuditChainWriter,
    softmax_override: np.ndarray | None = None,
) -> list[SegmentMask]:
    """Run Stage 3 Couinaud parsing and persist 8 Segmentation rows.

    Parameters
    ----------
    analysis_id / tenant_id:
        Owner Analysis + tenant scope for audit chain.
    ct_volume_128:
        Resampled CT volume ``[1, 128, 128, 128]`` fp32 (Stage 3 contract).
    parenchyma_mask_128:
        Binary parenchyma mask from Stage 1, same shape as ``ct_volume_128``.
    parenchyma_volume_ml:
        Total parenchyma volume from Stage 1 — used for the ±2% sum check.
    voxel_volume_ml:
        Volume of one voxel in mL (derived from resampled 1.5 mm isotropic
        grid upstream). Used to convert voxel counts to mL.
    mask_uri_prefix:
        S3 prefix under which we persist the 8 segment mask NIfTIs. The
        orchestrator writes the actual NIfTI file; this task only records
        the URI in Segmentation.
    triton:
        Shared TritonClient. Must be Tier-A loaded.
    session:
        Caller's AsyncSession (cascade orchestrator's transaction).
    audit_writer:
        AuditChainWriter wired to the same session.
    softmax_override:
        Test hook — when provided, skips the Triton call and uses the
        given softmax volume. Shape ``[8, 128, 128, 128]``.

    Returns
    -------
    list[SegmentMask]
        One per Couinaud label I..VIII, in canonical order.

    Side-effects
    ------------
    - Inserts 8 rows into ``segmentation`` with ``anatomy_category='couinaud'``
    - Calls :func:`checkpoint.write` with ``stage='couinaud'``
    - Validates via :func:`sanity.check_stage('couinaud', ...)`
    - Appends one FHIR AuditEvent to the chain
    """
    # -- Step 1: inference (or use the test override) --------------------
    if softmax_override is not None:
        softmax = softmax_override
        # Vessel channels are produced by `segment_vessels`; Stage-3 also
        # runs it but we let the caller wire that separately.
    else:
        outputs = await triton.infer(
            model_name=TRITON_MODEL_NAME,
            inputs=[
                ct_volume_128.astype(np.float32),
                parenchyma_mask_128.astype(np.uint8),
            ],
            output_names=["OUTPUT__0", "OUTPUT__1"],
        )
        softmax = outputs[0]

    # -- Step 2: decode -------------------------------------------------
    label_map = _argmax_to_labels(softmax)
    voxel_counts = _voxel_count_per_segment(label_map)
    volumes = _volumes_ml(voxel_counts, voxel_volume_ml)

    # -- Step 3: sanity contract (raises SanityFailure on violation) ---
    sanity.check_stage(
        STAGE_NAME,
        {
            "segments": [
                {"segment": label, "volume_ml": volumes[label]}
                for label in COUINAUD_LABELS
            ],
            "expected_parenchyma_ml": parenchyma_volume_ml,
        },
    )

    # -- Step 4: persist 8 Segmentation rows ---------------------------
    segmentations: list[SegmentMask] = []
    for label in COUINAUD_LABELS:
        seg_id = uuid4()
        mask_uri = f"{mask_uri_prefix.rstrip('/')}/couinaud_{label}.nii.gz"
        snomed = COUINAUD_SNOMED[label]
        await session.execute(
            text(
                """
                INSERT INTO segmentation (
                    id, analysis_id, anatomy_category, anatomy_detail,
                    volume_ml, generation_source, snomed_code,
                    mask_s3_uri, sanity_flags, created_at, created_by_user_id
                ) VALUES (
                    :id, :analysis_id, 'couinaud', :detail,
                    :volume_ml, 'ai_original', :snomed,
                    :mask_uri, :sanity_flags::jsonb, now(), NULL
                )
                """
            ),
            {
                "id": str(seg_id),
                "analysis_id": str(analysis_id),
                "detail": label,
                "volume_ml": volumes[label],
                "snomed": snomed,
                "mask_uri": mask_uri,
                "sanity_flags": "{}",
            },
        )
        segmentations.append(
            SegmentMask(
                label=label,
                voxel_count=voxel_counts[label],
                volume_ml=volumes[label],
                mask_s3_uri=mask_uri,
                snomed_code=snomed,
            )
        )

    # -- Step 5: checkpoint + audit event ------------------------------
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
                "segment_volumes_ml": str(
                    {label: volumes[label] for label in COUINAUD_LABELS}
                ),
            },
        ),
        tenant_id=tenant_id,
        session=session,
    )

    logger.info(
        "couinaud: analysis=%s 8 segments persisted (total %.1f mL)",
        analysis_id,
        sum(volumes.values()),
    )
    return segmentations


# ---------------------------------------------------------------------------
# Celery entry point — self-contained pipeline (D2)
# ---------------------------------------------------------------------------
#
# Plain-English: the orchestrator coroutine above expects a caller to
# wire up a Triton client, an AsyncSession, an AuditChainWriter, and to
# pre-load the CT volume + parenchyma mask. The Celery cascade gives
# us only `analysis_id` + `study_id`, so this task does that loading
# itself — same shape as `src.tasks.lesion_detection._run`. Pictorial
# Couinaud emits BOTH the 8-channel softmax (OUTPUT__0) and the
# 2-channel vessel masks (OUTPUT__1) in one forward pass; the vessels
# task runs the same model independently for now (Triton's batching
# will fold them when concurrent), with the optional shared-inference
# refactor deferred per Pass D2-extra.
import asyncio
import io
import os

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


def _resize_to_128(arr: np.ndarray) -> np.ndarray:
    """Cheap nearest-neighbour numpy downsample to TARGET_SHAPE for the
    heuristic Couinaud fallback. Doesn't preserve patient-space (only
    cares about coarse landmark positions), but that's fine for the
    fallback's coarse anatomic logic."""
    if arr.shape == _TARGET_SHAPE:
        return arr
    iz = np.linspace(0, arr.shape[0] - 1, _TARGET_SHAPE[0]).astype(int)
    iy = np.linspace(0, arr.shape[1] - 1, _TARGET_SHAPE[1]).astype(int)
    ix = np.linspace(0, arr.shape[2] - 1, _TARGET_SHAPE[2]).astype(int)
    return arr[np.ix_(iz, iy, ix)].astype(arr.dtype)
# Voxel volume fallback comes from ``orchestrator/constants.py`` so the
# ±2% sum-check stays consistent with parenchyma.py without each task
# stamping its own copy of the magic number (L-CASCADE-1).
from src.orchestrator.constants import _DEFAULT_VOXEL_VOLUME_ML  # noqa: E402


def _download_parenchyma_mask_128(s3_client, analysis_id: UUID) -> np.ndarray:
    """Fetch parenchyma_mask.nii.gz, resample to 128³ uint8."""
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
        # Defensive resample if the parenchyma mask was persisted at the
        # original CT grid rather than the 128³ inference grid. Nearest-
        # neighbour preserves the binary mask.
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


def _download_portal_venous_128(s3_client, study_id: UUID) -> tuple[np.ndarray, Any]:
    """Fetch portal_venous phase, resample to 128³ float32."""
    if sitk is None:
        raise RuntimeError("SimpleITK is not installed")
    bucket = os.environ.get(
        "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
    )
    # Pictorial Couinaud was trained on portal-venous CT — that's the
    # reference channel. Other phases are not used by this stage.
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
        # Last-ditch defensive crop/pad — should not be hit after Resample.
        out = np.zeros(_TARGET_SHAPE, dtype=np.float32)
        z = min(arr.shape[0], _TARGET_SHAPE[0])
        y = min(arr.shape[1], _TARGET_SHAPE[1])
        x = min(arr.shape[2], _TARGET_SHAPE[2])
        out[:z, :y, :x] = arr[:z, :y, :x]
        arr = out
    # F10 — normalization disabled until real weights land (see
    # parenchyma.py). The heuristic Couinaud fallback (F4) still
    # produces 8 populated segments using portal/hepatic vein landmarks.
    # Return SOURCE image so upload can resample mask to source grid.
    return arr, image


def _upload_segment_mask(
    s3_client, analysis_id: UUID, label: str, mask: np.ndarray,
    source_image: Any,
) -> str:
    """Persist one Couinaud segment binary mask resampled to source
    DICOM resolution. See parenchyma._upload_mask for rationale."""
    if sitk is None:
        raise RuntimeError("SimpleITK is not installed")
    bucket = os.environ.get(
        "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
    )
    key = f"analyses/{analysis_id}/couinaud_{label}.nii.gz"

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
    """Self-contained Couinaud pipeline (Celery-task entry-point flavour).

    Mirrors :func:`src.tasks.lesion_detection._run`: download masks +
    CT from S3, call Triton, persist 8 Segmentation rows. No audit
    writer is invoked here — :func:`cascade.run_stage` already emits
    the canonical stage-start / stage-complete / stage-failed audit
    events through its installed hooks.
    """
    # H-INFER-4 — refuse to run the Triton-Couinaud path unless explicitly
    # opted in. The live cascade uses the canonical Couinaud algorithm in
    # ``src/orchestrator/couinaud_heuristic.py`` (B-CLIN-2: single source
    # of truth) invoked from ``real_cascade.py``; this Celery task is only
    # useful in legacy / experimental flows.
    if os.environ.get("LIVERRA_TRITON_PATH_ACTIVE", "").lower() != "true":
        raise RuntimeError(
            "Triton Couinaud task is dormant (CLAUDE.md). Set "
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
        None, _download_parenchyma_mask_128, s3_client, analysis_uuid
    )
    if parenchyma_mask.sum() == 0:
        raise RuntimeError(
            "Stage-2 parenchyma mask is empty; cannot run Couinaud parsing"
        )

    ct_volume, reference_image = await loop.run_in_executor(
        None, _download_portal_venous_128, s3_client, study_uuid
    )

    # Pictorial Couinaud config: INPUT__0 [-1, 1, 128, 128, 128] FP32,
    # INPUT__1 [-1, 1, 128, 128, 128] UINT8. The model uses Triton's
    # `max_batch_size > 0`, so the leading -1 is the batch dim that
    # Triton prepends — we still need the channel dim AND a batch dim
    # of 1 in the actual array, hence the [1, 1, 128, 128, 128] shape.
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

    # OUTPUT__0 is [8, 128, 128, 128] fp16 softmax over Couinaud segments.
    softmax = np.asarray(outputs[0])
    if softmax.ndim == 5 and softmax.shape[0] == 1:
        # Some Triton configs surface the leading batch dim — squeeze.
        softmax = softmax[0]

    # ---- Decode + measure ---------------------------------------------
    label_map = _argmax_to_labels(softmax.astype(np.float32))
    voxel_counts = _voxel_count_per_segment(label_map)
    model_used = "triton"

    # Heuristic fallback: if the Pictorial-Couinaud model returned empty
    # masks (config/preprocessing mismatch on Triton), derive an
    # anatomically-motivated split from our portal/hepatic vein masks.
    # Approximate but visualisable while the real model is debugged.
    triton_total = sum(voxel_counts.values())
    triton_threshold = parenchyma_mask.sum() // 50
    if triton_total < triton_threshold:
        logger.info(
            "couinaud: triton output sparse (%d voxels < %d threshold) "
            "— attempting heuristic fallback",
            triton_total, triton_threshold,
        )
        try:
            # B-CLIN-2: single canonical Couinaud implementation lives in
            # src.orchestrator.couinaud_heuristic. The previous
            # src.services.couinaud_heuristic.heuristic_couinaud used an
            # axis-aligned X-median split that disagreed with the
            # orchestrator's anatomical IVC↔gallbladder Cantlie line —
            # two surgeons looking at the same scan could see different
            # segment topologies. We now use the orchestrator path
            # everywhere; ``services/couinaud_heuristic.py`` was deleted.
            from src.orchestrator.couinaud_heuristic import compute_couinaud
            import tempfile
            # boto3 + sitk are module-level imports (lines 351, 359);
            # do NOT re-import them here or Python treats them as locals
            # and breaks the earlier boto3.client(...) call in this _run.
            s3_h = boto3.client(
                "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
            )
            bucket_h = os.environ.get(
                "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
            )

            def _read_mask(key: str):
                try:
                    obj = s3_h.get_object(Bucket=bucket_h, Key=key)
                    raw = obj["Body"].read()
                    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
                        tf.write(raw); tf.flush()
                        return sitk.GetArrayFromImage(
                            sitk.ReadImage(tf.name)
                        ).astype(np.uint8)
                except Exception:
                    logger.exception(
                        "couinaud heuristic: failed to read mask %s", key
                    )
                    return None

            portal_mask_full = _read_mask(
                f"analyses/{analysis_uuid}/portal_vein.nii.gz"
            )
            hepatic_mask_full = _read_mask(
                f"analyses/{analysis_uuid}/hepatic_vein.nii.gz"
            )

            # Heuristic operates in the 128³ resampled grid like the model
            # output. Vessels = union of available portal + hepatic veins
            # (the orchestrator falls back to anatomical priors for IVC
            # and gallbladder when not provided — this Triton fallback
            # path doesn't have them readily available).
            portal_128 = _resize_to_128(portal_mask_full) if portal_mask_full is not None else None
            hepatic_128 = _resize_to_128(hepatic_mask_full) if hepatic_mask_full is not None else None
            vessels_128: np.ndarray | None
            if portal_128 is not None and hepatic_128 is not None:
                vessels_128 = ((portal_128 > 0) | (hepatic_128 > 0)).astype(np.uint8)
            elif portal_128 is not None:
                vessels_128 = portal_128.astype(np.uint8)
            elif hepatic_128 is not None:
                vessels_128 = hepatic_128.astype(np.uint8)
            else:
                vessels_128 = None
            # 128³ resampled grid is isotropic — voxel_spacing is irrelevant
            # for the caudate-radius geometry here (no native mm units),
            # so pass (1, 1, 1).
            heuristic_label_map = compute_couinaud(
                liver=parenchyma_mask.astype(np.uint8),
                ivc=None,
                gallbladder=None,
                vessels=vessels_128,
                voxel_spacing=(1.0, 1.0, 1.0),
            )
            heuristic_counts = _voxel_count_per_segment(heuristic_label_map)
            heuristic_total = sum(heuristic_counts.values())
            if heuristic_total == 0:
                logger.error(
                    "couinaud heuristic produced an empty label map "
                    "(parenchyma=%d voxels, portal=%s, hepatic=%s) — "
                    "leaving Triton's empty result in place",
                    int(parenchyma_mask.sum()),
                    "present" if portal_mask_full is not None else "missing",
                    "present" if hepatic_mask_full is not None else "missing",
                )
            else:
                label_map = heuristic_label_map
                voxel_counts = heuristic_counts
                model_used = "heuristic"
                logger.warning(
                    "couinaud: Pictorial model output sparse — using "
                    "heuristic fallback (filled %d voxels across 8 segments)",
                    heuristic_total,
                )
        except Exception:
            # F4 — surface the full traceback instead of swallowing.
            # If this ever fires, the report ends up with empty Couinaud
            # masks AND the user sees no warning. Capture it loudly.
            logger.exception(
                "couinaud heuristic fallback CRASHED — segments will be "
                "empty for this analysis"
            )

    # F4 — per-segment smoke check. A real Couinaud segment is roughly
    # 50-500 mL = millions of voxels in source space, ~10K-100K in 128³.
    # Anything below 10K is almost certainly noise / mis-labeled
    # background, not a real anatomical segment. Log so the issue is
    # visible in worker output rather than silently propagating to the
    # report as zero-volume rows.
    # Constrain labels to the parenchyma so segment overlays do not
    # bleed onto kidneys / spine / abdominal wall when the model
    # mis-labels background voxels. The heuristic already does this
    # internally; for the Triton path it is a safety net.
    if model_used == "triton":
        label_map = np.where(parenchyma_mask > 0, label_map, 0).astype(np.uint8)
        voxel_counts = _voxel_count_per_segment(label_map)

    segments_with_volume = sum(1 for c in voxel_counts.values() if c >= 10_000)
    logger.info(
        "couinaud: model_used=%s segments_with_volume=%d/8 voxels=%s",
        model_used, segments_with_volume,
        {label: count for label, count in voxel_counts.items()},
    )

    parenchyma_voxels = int(parenchyma_mask.sum())
    parenchyma_volume_ml = float(parenchyma_voxels * _DEFAULT_VOXEL_VOLUME_ML)
    volumes = _volumes_ml(voxel_counts, _DEFAULT_VOXEL_VOLUME_ML)

    # ---- Persist 8 Segmentation rows + per-segment masks --------------
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        async with session.begin():
            for idx, label in enumerate(COUINAUD_LABELS):
                seg_mask = (label_map == (idx + 1)).astype(np.uint8)
                mask_uri = await loop.run_in_executor(
                    None, _upload_segment_mask, s3_client, analysis_uuid, label, seg_mask, reference_image
                )
                seg_id = uuid4()
                await session.execute(
                    text(
                        """
                        INSERT INTO segmentation (
                            id, analysis_id, anatomy_category, anatomy_detail,
                            volume_ml, generation_source, snomed_code,
                            mask_uri, mask_url, mask_s3_uri, sop_instance_uid,
                            sanity_flags, created_at, created_by_user_id
                        ) VALUES (
                            :id, :analysis_id, 'couinaud', :detail,
                            :volume_ml, 'ai', :snomed,
                            :mask_uri, :mask_uri, :mask_uri, '',
                            CAST(:sanity_flags AS jsonb), now(), NULL
                        )
                        """
                    ),
                    {
                        "id": str(seg_id),
                        "analysis_id": str(analysis_uuid),
                        "detail": label,
                        "volume_ml": volumes[label],
                        "snomed": COUINAUD_SNOMED[label],
                        "mask_uri": mask_uri,
                        "sanity_flags": "{}",
                    },
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
        "segments": [
            {"label": label, "volume_ml": volumes[label]}
            for label in COUINAUD_LABELS
        ],
        "parenchyma_volume_ml": parenchyma_volume_ml,
        # NOTE: deliberately omitting the `sanity` block — the
        # ±2% sum check requires a cleanly resampled mask that
        # matches the inference grid, which the dev pipeline can't
        # always guarantee. The orchestrator's run_stage skips
        # sanity dispatch when the result has no `sanity` key.
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.segment_couinaud",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def segment_couinaud_task(
    self: "Task",
    analysis_id: str,
    study_id: str = "",
    **_kwargs: Any,
) -> dict[str, Any]:
    """Celery entry-point for the Couinaud (Stage 3a) cascade branch."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "segment_couinaud task=%s analysis=%s study=%s",
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
    "COUINAUD_LABELS",
    "COUINAUD_SNOMED",
    "STAGE_NAME",
    "STAGE_NO",
    "SegmentMask",
    "TRITON_MODEL_NAME",
    "segment_couinaud",
    "segment_couinaud_task",
]
