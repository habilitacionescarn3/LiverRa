# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-tenant temperature recalibration Celery task (T467).

Triggered on every MBoM version bump for each active tenant. Re-fits
the per-tenant ``temperature`` parameter on the held-out validation
subset (``classification_validation_sample`` — migration 0009), writes
the new value to the ``tenant_calibration`` table, and emits a
``model_recalibrated`` FHIR AuditEvent.

Plain-English analogy:
    When we ship a new LiLNet weight, every hospital's "confidence
    dial" (temperature) needs to be re-tuned because the new model's
    raw softmax will have a different personality. This task takes
    each hospital's reference cases (path-confirmed diagnoses stored
    during routine review) and re-fits the dial so the abstention
    threshold continues to mean what it meant before.

Research: §C.7 — Two-layer output sanity; temperature scaling must be
re-fit when the underlying model changes or raw softmax drifts.

Invocation flow:
    `claim_registry.py` emits a `mbom_version_bumped` event when the
    MBoM's `lilnet-classify` version changes. This task is chained off
    that event (see `claim_registry.on_mbom_bump_lilnet`) and fanned
    out per active tenant by `recalibrate_all_tenants`.

The task is safe to invoke ad-hoc — e.g. after a bulk back-fill of
validation samples — via `celery call liverra.tasks.recalibrate_temperature
--args='["<tenant_uuid>"]'`.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

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
from src.services.audit.chain_of_hashes import AuditChainWriter
from src.services.calibration import DEFAULT_TEMPERATURE
from src.services.mbom.reader import get_default_reader
from src.services.triton import TritonClient, TritonInferenceError
from src.tasks.classification import CLASS_ORDER, TARGET_SHAPE
from src.workers.app import app

logger = logging.getLogger(__name__)


TRITON_URL = os.environ.get("TRITON_URL", "triton:8001")
MODEL_NAME = "liverra-lilnet-classify"
PHASES_BUCKET = os.environ.get(
    "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
)

#: Minimum samples required before we trust a tenant-specific fit.
#: Below this, we keep the model-family default + log a warning.
MIN_SAMPLES_FOR_FIT: int = 40

#: Search window for LBFGS-on-NLL (research §C.7 recommends 0.5..3.0).
TEMPERATURE_SEARCH_MIN: float = 0.5
TEMPERATURE_SEARCH_MAX: float = 5.0

#: Grid-search granularity. ~90 points across the window is plenty;
#: LiLNet's NLL curve is smooth.
TEMPERATURE_GRID_SIZE: int = 90


# ---------------------------------------------------------------------------
# Validation sample loading
# ---------------------------------------------------------------------------


async def _fetch_samples(
    session: Any, tenant_id: UUID
) -> list[dict[str, Any]]:
    """Return all validation samples for the tenant."""
    result = await session.execute(
        sa_text(
            """
            SELECT id, lesion_crop_s3_uri, ground_truth_class
            FROM classification_validation_sample
            WHERE tenant_id = :tenant_id
            ORDER BY added_at DESC
            """
        ),
        {"tenant_id": str(tenant_id)},
    )
    return [
        {
            "id": row[0],
            "uri": row[1],
            "ground_truth": row[2],
        }
        for row in result.fetchall()
    ]


def _parse_s3_uri(uri: str) -> tuple[str, str]:
    """`s3://bucket/key` → `(bucket, key)`."""
    if not uri.startswith("s3://"):
        raise ValueError(f"not an s3 uri: {uri}")
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def _load_crop(
    s3_client: Any, uri: str
) -> np.ndarray:
    """Download a NIfTI crop from S3 + return a (4, 96, 96, 96) array."""
    if sitk is None:
        raise RuntimeError(
            "SimpleITK is not installed; add `SimpleITK` to requirements.txt"
        )
    bucket, key = _parse_s3_uri(uri)
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    img = sitk.ReadImage(io.BytesIO(obj["Body"].read()))  # type: ignore[arg-type]
    arr = sitk.GetArrayFromImage(img).astype(np.float32)
    # Crops are stored as 4-channel volumes per the Stage 4 contract.
    if arr.shape != (4, *TARGET_SHAPE):
        raise ValueError(
            f"unexpected crop shape {arr.shape}; expected (4, {TARGET_SHAPE})"
        )
    return arr


# ---------------------------------------------------------------------------
# Temperature fitting (grid search on NLL)
# ---------------------------------------------------------------------------


def _fit_temperature(
    logits: np.ndarray, labels: np.ndarray
) -> float:
    """Return the temperature T that minimises NLL on (logits, labels).

    Parameters
    ----------
    logits:
        ``(N, C)`` raw logits — one row per sample, columns in
        ``CLASS_ORDER``.
    labels:
        ``(N,)`` integer labels in ``[0, C)``.

    We grid-search over a log-spaced window for numerical stability.
    LBFGS would be slightly faster but grid-search is trivially
    reproducible and the cost (N × grid_size softmax evals) is
    negligible at our sample counts.
    """
    grid = np.logspace(
        np.log10(TEMPERATURE_SEARCH_MIN),
        np.log10(TEMPERATURE_SEARCH_MAX),
        TEMPERATURE_GRID_SIZE,
    )
    best_t = float(DEFAULT_TEMPERATURE)
    best_nll = float("inf")
    n = labels.shape[0]
    rows = np.arange(n)
    for t in grid:
        scaled = logits / t
        shifted = scaled - np.max(scaled, axis=-1, keepdims=True)
        exp = np.exp(shifted)
        denom = np.sum(exp, axis=-1, keepdims=True)
        probs = exp / denom
        # Clip for log stability — true zero after float rounding
        # would send NLL to infinity.
        p_true = np.clip(probs[rows, labels], 1e-12, 1.0)
        nll = -float(np.mean(np.log(p_true)))
        if nll < best_nll:
            best_nll = nll
            best_t = float(t)
    return best_t


# ---------------------------------------------------------------------------
# Core recalibration workflow
# ---------------------------------------------------------------------------


async def _run(tenant_id: str) -> dict[str, Any]:
    tenant_uuid = UUID(tenant_id)
    sessionmaker = get_sessionmaker()
    s3_client = boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )

    async with sessionmaker() as session:
        samples = await _fetch_samples(session, tenant_uuid)

    if len(samples) < MIN_SAMPLES_FOR_FIT:
        logger.warning(
            "recalibrate_temperature: tenant %s has only %d samples "
            "(< %d); keeping existing temperature",
            tenant_uuid,
            len(samples),
            MIN_SAMPLES_FOR_FIT,
        )
        return {
            "tenant_id": str(tenant_uuid),
            "skipped": True,
            "reason": "insufficient_samples",
            "sample_count": len(samples),
        }

    # ---- Run inference over the validation set ----------------------
    triton = TritonClient(TRITON_URL)
    logits_rows: list[np.ndarray] = []
    labels: list[int] = []
    try:
        for sample in samples:
            try:
                crop = _load_crop(s3_client, sample["uri"])
            except Exception as exc:
                logger.warning(
                    "skipping unreadable crop %s: %s", sample["uri"], exc
                )
                continue
            batched = crop[np.newaxis, ...]  # (1, 4, 96, 96, 96)
            outputs = await triton.infer(
                MODEL_NAME,
                [batched],
                input_names=["INPUT__0"],
                output_names=["OUTPUT__0"],
            )
            logits = np.asarray(outputs[0], dtype=np.float64).reshape(-1)
            if logits.size != len(CLASS_ORDER):
                raise RuntimeError(
                    f"LiLNet returned {logits.size} logits; expected "
                    f"{len(CLASS_ORDER)}"
                )
            logits_rows.append(logits)
            labels.append(CLASS_ORDER.index(sample["ground_truth"]))
    finally:
        await triton.close()

    if len(logits_rows) < MIN_SAMPLES_FOR_FIT:
        return {
            "tenant_id": str(tenant_uuid),
            "skipped": True,
            "reason": "inference_failures_below_threshold",
            "sample_count": len(logits_rows),
        }

    logits_arr = np.stack(logits_rows, axis=0)
    labels_arr = np.asarray(labels, dtype=np.int64)
    new_temperature = _fit_temperature(logits_arr, labels_arr)

    # ---- Persist + audit --------------------------------------------
    mbom_reader = get_default_reader()
    mbom_info = mbom_reader.get("lilnet-classify")
    model_version = mbom_info.version if mbom_info else "unknown"

    async with sessionmaker() as session:
        async with session.begin():
            await session.execute(
                sa_text(
                    """
                    INSERT INTO tenant_calibration (
                        tenant_id, temperature, fitted_at, sample_count
                    ) VALUES (
                        :tenant_id, :temperature, :fitted_at, :sample_count
                    )
                    ON CONFLICT (tenant_id) DO UPDATE
                    SET temperature = EXCLUDED.temperature,
                        fitted_at = EXCLUDED.fitted_at,
                        sample_count = EXCLUDED.sample_count
                    """
                ),
                {
                    "tenant_id": str(tenant_uuid),
                    "temperature": float(new_temperature),
                    "fitted_at": datetime.now(timezone.utc),
                    "sample_count": len(logits_rows),
                },
            )
            await AuditChainWriter().write(
                {
                    "resourceType": "AuditEvent",
                    "id": str(uuid4()),
                    "category": "model_recalibrated",
                    "action": "U",
                    "recorded": datetime.now(timezone.utc).isoformat(),
                    "entity": [
                        {"what": {"reference": f"Tenant/{tenant_uuid}"}},
                    ],
                    "extension": [
                        {"url": "liverra:model_name", "valueString": MODEL_NAME},
                        {"url": "liverra:model_version", "valueString": model_version},
                        {"url": "liverra:new_temperature", "valueDecimal": float(new_temperature)},
                        {"url": "liverra:sample_count", "valueInteger": len(logits_rows)},
                        {"url": "liverra:fit_window_min", "valueDecimal": TEMPERATURE_SEARCH_MIN},
                        {"url": "liverra:fit_window_max", "valueDecimal": TEMPERATURE_SEARCH_MAX},
                    ],
                },
                tenant_uuid,
                session,
            )

    logger.info(
        "recalibrate_temperature: tenant=%s T=%.3f (was default=%.3f); "
        "samples=%d; model_version=%s",
        tenant_uuid,
        new_temperature,
        DEFAULT_TEMPERATURE,
        len(logits_rows),
        model_version,
    )
    return {
        "tenant_id": str(tenant_uuid),
        "skipped": False,
        "new_temperature": float(new_temperature),
        "sample_count": len(logits_rows),
        "model_version": model_version,
    }


# ---------------------------------------------------------------------------
# Celery entry points
# ---------------------------------------------------------------------------


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.recalibrate_temperature",
    autoretry_for=(TritonInferenceError,),
    retry_backoff=True,
    retry_backoff_max=900,
    retry_jitter=True,
    max_retries=3,
    acks_late=True,
)
def recalibrate_temperature(
    self: "Task", tenant_id: str, **_kwargs: Any
) -> dict[str, Any]:
    """Re-fit one tenant's LiLNet temperature."""
    correlation_id = getattr(self.request, "id", None)
    logger.info(
        "recalibrate_temperature task=%s tenant=%s",
        correlation_id,
        tenant_id,
    )
    return asyncio.run(_run(tenant_id))


@app.task(  # type: ignore[misc]
    bind=True,
    name="liverra.tasks.recalibrate_all_tenants",
    acks_late=True,
)
def recalibrate_all_tenants(
    self: "Task", **_kwargs: Any
) -> dict[str, Any]:
    """Fanout wrapper — invoked by claim_registry on MBoM bump.

    Looks up every active tenant and dispatches one
    `recalibrate_temperature` per tenant. Returns the list of dispatched
    task IDs so the caller can correlate.
    """

    async def _fanout() -> list[str]:
        sessionmaker = get_sessionmaker()
        async with sessionmaker() as session:
            result = await session.execute(
                sa_text(
                    "SELECT id FROM tenant WHERE active = true "
                    "ORDER BY id"
                )
            )
            tenant_ids = [str(row[0]) for row in result.fetchall()]
        return tenant_ids

    tenant_ids = asyncio.run(_fanout())
    dispatched: list[str] = []
    for tid in tenant_ids:
        sig = recalibrate_temperature.signature(
            kwargs={"tenant_id": tid},
            options={"soft_time_limit": 600, "time_limit": 900},
        )
        async_result = sig.apply_async()
        dispatched.append(str(async_result.id))

    return {
        "dispatched_count": len(dispatched),
        "task_ids": dispatched,
    }


__all__ = [
    "MIN_SAMPLES_FOR_FIT",
    "recalibrate_all_tenants",
    "recalibrate_temperature",
]
