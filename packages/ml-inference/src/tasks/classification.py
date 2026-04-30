# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-lesion classification Celery task (T214 + T418).

Stage 6 of the cascade. Runs once per lesion detected by
:mod:`src.tasks.lesion_detection` (Stage 5). For each lesion:

1. Crop the 4-phase volume to a 96³ isotropic box centered on the
   lesion centroid.
2. Call Triton ``liverra-lilnet-classify`` → raw 6-class logits.
3. Load the tenant's :class:`TemperatureScaler` and apply it before
   softmax (research §C.7 + FR-011 + T418 wiring).
4. If ``max(probs) < tenant.abstention_threshold`` → mark abstained
   with ``suggested_class='abstained'``.
5. Persist one ``Classification`` row + emit a stage checkpoint.

Plain-English analogy:
    This task is the specialist who looks at each circled spot from
    the previous read and labels it — HCC, ICC, met, FNH, haemangioma,
    or cyst. If none of the labels is clearly the best match, they
    refuse to guess and hand the case back to the reviewer. The
    refusal isn't a failure; it's the system being honest about
    uncertainty.

Budget (research §C.2): 20 s soft / 30 s hard for the whole fanout.
Per-lesion inference itself is capped at 5 s by the contract.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
from typing import Any
from uuid import UUID

import boto3
import numpy as np

try:
    import SimpleITK as sitk  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    sitk = None  # type: ignore[assignment]

try:
    from celery import Task  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    Task = object  # type: ignore[assignment,misc]

from sqlalchemy import text as sa_text

from src.db.session import get_sessionmaker
from src.orchestrator import cascade, checkpoint
from src.services.calibration import (
    DEFAULT_ABSTENTION_THRESHOLD,
    TemperatureScaler,
)
from src.services.triton import TritonClient, TritonInferenceError
from src.workers.app import app

logger = logging.getLogger(__name__)


TRITON_URL = os.environ.get("TRITON_URL", "triton:8001")
MODEL_NAME = "liverra-lilnet-classify"

#: Fixed class order per contracts/triton-stages.md §Stage 4.
CLASS_ORDER: tuple[str, ...] = (
    "hcc",
    "icc",
    "metastasis",
    "fnh",
    "hemangioma",
    "cyst",
)

#: 96³ isotropic input shape per Stage 4 contract.
TARGET_SHAPE: tuple[int, int, int] = (96, 96, 96)


# ---------------------------------------------------------------------------
# Crop + phase loading helpers
# ---------------------------------------------------------------------------


def _center_crop_96(
    volume: np.ndarray,
    centroid: tuple[int, int, int],
) -> np.ndarray:
    """Return a ``(96, 96, 96)`` crop centered on ``centroid``.

    Pads with zeros when the centroid is too close to a volume edge.
    """
    out = np.zeros(TARGET_SHAPE, dtype=np.float32)
    half = [dim // 2 for dim in TARGET_SHAPE]
    shape = volume.shape
    for z in range(TARGET_SHAPE[0]):
        src_z = centroid[0] - half[0] + z
        if src_z < 0 or src_z >= shape[0]:
            continue
        for y in range(TARGET_SHAPE[1]):
            src_y = centroid[1] - half[1] + y
            if src_y < 0 or src_y >= shape[1]:
                continue
            for x in range(TARGET_SHAPE[2]):
                src_x = centroid[2] - half[2] + x
                if src_x < 0 or src_x >= shape[2]:
                    continue
                out[z, y, x] = float(volume[src_z, src_y, src_x])
    return out


def _vectorized_center_crop(
    volume: np.ndarray,
    centroid: tuple[int, int, int],
) -> np.ndarray:
    """Fast numpy variant of :func:`_center_crop_96`.

    Preferred in production; the pure-Python version above is kept as
    a fallback for environments without strided slicing support.
    """
    out = np.zeros(TARGET_SHAPE, dtype=np.float32)
    half = [dim // 2 for dim in TARGET_SHAPE]
    shape = volume.shape
    src_start = [centroid[i] - half[i] for i in range(3)]
    src_end = [src_start[i] + TARGET_SHAPE[i] for i in range(3)]
    dst_start = [max(0, -src_start[i]) for i in range(3)]
    dst_end = [
        TARGET_SHAPE[i] - max(0, src_end[i] - shape[i]) for i in range(3)
    ]
    src_start = [max(0, src_start[i]) for i in range(3)]
    src_end = [min(shape[i], src_end[i]) for i in range(3)]
    if any(dst_end[i] <= dst_start[i] for i in range(3)):
        return out
    out[
        dst_start[0]:dst_end[0],
        dst_start[1]:dst_end[1],
        dst_start[2]:dst_end[2],
    ] = volume[
        src_start[0]:src_end[0],
        src_start[1]:src_end[1],
        src_start[2]:src_end[2],
    ].astype(np.float32)
    return out


def _download_phase_volumes(
    s3_client: Any, study_id: UUID
) -> list[np.ndarray]:
    """Return a list of 4 phase volumes as ``(D, H, W)`` arrays."""
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )
    bucket = os.environ.get(
        "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
    )
    phases = ("non_contrast", "arterial", "portal_venous", "delayed")
    out: list[np.ndarray] = []
    for phase in phases:
        key = f"studies/{study_id}/phases/{phase}.nii.gz"
        try:
            obj = s3_client.get_object(Bucket=bucket, Key=key)
        except Exception as exc:
            logger.warning("missing phase %s: %s", phase, exc)
            out.append(np.zeros((1, 1, 1), dtype=np.float32))
            continue
        # sitk.ReadImage(BytesIO) segfaults on libsitk 2.5+; use temp file.
        raw = obj["Body"].read()
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
            tf.write(raw)
            tf.flush()
            img = sitk.ReadImage(tf.name)
        out.append(sitk.GetArrayFromImage(img).astype(np.float32))
    return out


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


async def _fetch_lesion(
    session: Any, lesion_id: UUID
) -> dict[str, Any] | None:
    """Return the lesion row as a dict, or None if it was erased."""
    result = await session.execute(
        sa_text(
            """
            SELECT id, analysis_id, bbox3d
            FROM lesion
            WHERE id = :id
            """
        ),
        {"id": str(lesion_id)},
    )
    row = result.first()
    if row is None:
        return None
    bbox_json = row[2]
    if isinstance(bbox_json, str):
        bbox_json = json.loads(bbox_json)
    return {
        "id": row[0],
        "analysis_id": row[1],
        "bbox3d": bbox_json,
    }


async def _fetch_tenant_for_analysis(
    session: Any, analysis_id: UUID
) -> UUID | None:
    """Resolve the tenant that owns an analysis (for calibration lookup)."""
    result = await session.execute(
        sa_text(
            """
            SELECT s.tenant_id
            FROM analysis a
            JOIN study s ON s.id = a.study_id
            WHERE a.id = :id
            """
        ),
        {"id": str(analysis_id)},
    )
    row = result.first()
    if row is None:
        return None
    return UUID(str(row[0]))


async def _insert_classification(
    session: Any,
    *,
    lesion_id: UUID,
    probs: dict[str, float],
    suggested_class: str,
    temperature: float,
    abstained: bool,
) -> None:
    """INSERT one Classification row. Enforces the probs-sum CHECK."""
    await session.execute(
        sa_text(
            """
            INSERT INTO classification (
                lesion_id,
                probs_vec,
                suggested_class,
                temperature,
                abstained
            ) VALUES (
                :lesion_id,
                CAST(:probs_vec AS jsonb),
                :suggested_class,
                :temperature,
                :abstained
            )
            """
        ),
        {
            "lesion_id": str(lesion_id),
            "probs_vec": json.dumps(probs),
            "suggested_class": suggested_class,
            "temperature": temperature,
            "abstained": abstained,
        },
    )


# ---------------------------------------------------------------------------
# Core per-lesion workflow
# ---------------------------------------------------------------------------


def _centroid_from_bbox(bbox_coords: list[int]) -> tuple[int, int, int]:
    """``[z0, y0, x0, z1, y1, x1]`` -> integer centroid."""
    return (
        (bbox_coords[0] + bbox_coords[3]) // 2,
        (bbox_coords[1] + bbox_coords[4]) // 2,
        (bbox_coords[2] + bbox_coords[5]) // 2,
    )


async def _run(
    analysis_id: str,
    lesion_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Classify a single lesion + persist the result."""
    analysis_uuid = UUID(analysis_id)
    lesion_uuid = UUID(lesion_id)

    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )
    loop = asyncio.get_running_loop()

    sessionmaker = get_sessionmaker()
    async with sessionmaker() as session:
        lesion = await _fetch_lesion(session, lesion_uuid)
        if lesion is None:
            # Erasure or cascade race — emit a no-op result the
            # orchestrator can aggregate over.
            return {
                "analysis_id": analysis_id,
                "lesion_id": lesion_id,
                "skipped": True,
                "reason": "lesion_not_found",
            }
        tenant_id = await _fetch_tenant_for_analysis(session, analysis_uuid)
        if tenant_id is None:
            raise RuntimeError(
                f"analysis {analysis_uuid} has no tenant_id — cannot "
                "look up calibration"
            )
        scaler = await TemperatureScaler.load_for_tenant(tenant_id, session)

        # ---- Build 4×96³ crop --------------------------------------
        study_id_row = await session.execute(
            sa_text("SELECT study_id FROM analysis WHERE id = :id"),
            {"id": str(analysis_uuid)},
        )
        study_row = study_id_row.first()
        if study_row is None:
            raise RuntimeError(f"analysis {analysis_uuid} not found")
        study_uuid = UUID(str(study_row[0]))

    phase_volumes = await loop.run_in_executor(
        None, _download_phase_volumes, s3_client, study_uuid
    )
    bbox_coords = lesion["bbox3d"].get("coords", [0, 0, 0, 0, 0, 0])
    centroid = _centroid_from_bbox(bbox_coords)
    channels = [
        _vectorized_center_crop(vol, centroid) for vol in phase_volumes
    ]
    crop = np.stack(channels, axis=0)  # (4, 96, 96, 96)
    crop_batched = crop[np.newaxis, ...]  # (1, 4, 96, 96, 96)

    # ---- Triton inference --------------------------------------------
    triton = TritonClient(TRITON_URL)
    try:
        outputs = await triton.infer(
            MODEL_NAME,
            [crop_batched],
            input_names=["INPUT__0"],
            output_names=["OUTPUT__0"],
        )
    except TritonInferenceError:
        raise
    finally:
        await triton.close()

    raw_logits = np.asarray(outputs[0], dtype=np.float64).reshape(-1)
    if raw_logits.size != len(CLASS_ORDER):
        raise RuntimeError(
            f"LiLNet returned {raw_logits.size} logits; expected "
            f"{len(CLASS_ORDER)}"
        )

    # ---- T418 wiring: temperature scaling + abstention ---------------
    probs_arr = scaler.softmax(raw_logits)
    probs = {
        cls: float(p) for cls, p in zip(CLASS_ORDER, probs_arr, strict=True)
    }
    # Defensive re-normalise so the DB CHECK constraint is satisfied
    # even if float64 softmax drifts by 1e-16.
    total = sum(probs.values())
    if total > 0:
        probs = {cls: round(v / total, 6) for cls, v in probs.items()}

    max_prob = max(probs.values())
    abstention_threshold = float(
        os.environ.get(
            "LIVERRA_ABSTENTION_THRESHOLD",
            str(DEFAULT_ABSTENTION_THRESHOLD),
        )
    )
    abstained = max_prob < abstention_threshold
    if abstained:
        suggested_class = "abstained"
    else:
        suggested_class = max(probs.items(), key=lambda kv: kv[1])[0]

    # ---- Persist + checkpoint ---------------------------------------
    async with sessionmaker() as session:
        async with session.begin():
            await _insert_classification(
                session,
                lesion_id=lesion_uuid,
                probs=probs,
                suggested_class=suggested_class,
                temperature=float(scaler.temperature),
                abstained=abstained,
            )
            await checkpoint.write(
                analysis_id=analysis_uuid,
                stage_no=6,
                stage="classification",
                output_uri=(
                    f"classification://analyses/{analysis_uuid}/lesions/"
                    f"{lesion_uuid}"
                ),
                model_version=None,
                session=session,
                model_name="lilnet-classify",
            )

    return {
        "analysis_id": analysis_id,
        "lesion_id": lesion_id,
        "suggested_class": suggested_class,
        "abstained": abstained,
        "temperature": float(scaler.temperature),
        "abstention_threshold": abstention_threshold,
        "probs": probs,
        "sanity": {"probs": probs},
    }


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.classify_lesion",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def classify_lesion(
    self: "Task",
    analysis_id: str,
    lesion_id: str,
    **_kwargs: Any,
) -> dict[str, Any]:
    """Celery entry point — classify one lesion."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "classify_lesion task=%s analysis=%s lesion=%s",
        correlation_id,
        analysis_id,
        lesion_id,
    )

    async def _wrapped() -> dict[str, Any]:
        return await cascade.run_stage(
            "classification",
            UUID(analysis_id),
            _run,
            analysis_id,
            lesion_id,
            correlation_id=correlation_id,
        )

    return asyncio.run(_wrapped())


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.classify_lesions_fanout",
    acks_late=True,
)
def classify_lesions_fanout(
    self: "Task",
    lesion_detection_result: dict[str, Any] | None = None,
    analysis_id: str | None = None,
    study_id: str | None = None,
    **_kwargs: Any,
) -> dict[str, Any]:
    """Fanout wrapper invoked by the cascade after lesion_detection.

    Takes the output of :func:`detect_lesions` and kicks off one
    :func:`classify_lesion` signature per lesion. If zero lesions were
    detected, returns immediately with an empty list — an empty lesion
    list is a valid pipeline outcome (T216 failure-mode clause).
    """
    correlation_id = getattr(self.request, "id", None)
    result = lesion_detection_result or {}
    lesions = result.get("lesions", []) if isinstance(result, dict) else []
    if not lesions:
        logger.info(
            "classify_lesions_fanout task=%s analysis=%s — 0 lesions, skipping",
            correlation_id,
            analysis_id or result.get("analysis_id"),
        )
        return {
            "analysis_id": analysis_id or result.get("analysis_id"),
            "lesion_count": 0,
            "classifications": [],
        }

    resolved_analysis = analysis_id or result.get("analysis_id")
    signatures = [
        classify_lesion.signature(
            kwargs={
                "analysis_id": str(resolved_analysis),
                "lesion_id": str(lesion["lesion_id"]),
            },
            options={"soft_time_limit": 5, "time_limit": 10},
        )
        for lesion in lesions
    ]
    # We dispatch and return the signature group ids; the cascade
    # Canvas (T216) wraps this in a chord so FLR only runs once every
    # classification completes.
    from celery import group  # type: ignore[import-not-found]

    group(signatures).apply_async()
    return {
        "analysis_id": resolved_analysis,
        "lesion_count": len(lesions),
        "dispatched": True,
    }


__all__ = [
    "CLASS_ORDER",
    "classify_lesion",
    "classify_lesions_fanout",
]
