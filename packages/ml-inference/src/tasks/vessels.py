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
from src.services.triton.client import TritonClient

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
    trunks. We threshold at 0.5 — a common conservative default that
    keeps false positives low. Callers running a calibration study may
    patch this.
    """
    if channel.ndim != 3:
        raise ValueError(f"channel must be [Z, Y, X]; got {channel.shape}")
    return (np.asarray(channel) > 0.5).astype(np.uint8)


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

    await audit_writer.write(
        event_dict={
            "resourceType": "AuditEvent",
            "type": {"code": "ml_inference"},
            "action": "E",
            "outcome": "0",
            "agent": [{"who": {"display": "ml-worker"}}],
            "entity": [
                {
                    "what": {"reference": f"Analysis/{analysis_id}"},
                    "role": {"code": "4", "display": "Domain"},
                }
            ],
            "detail": {
                "stage": STAGE_NAME,
                "stage_no": STAGE_NO,
                "model": {
                    "name": "pictorial-couinaud",
                    "triton": TRITON_MODEL_NAME,
                },
                "portal_containment": round(portal_ratio, 4),
                "hepatic_containment": round(hepatic_ratio, 4),
            },
        },
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


__all__ = [
    "HEPATIC_CHANNEL",
    "PORTAL_CHANNEL",
    "STAGE_NAME",
    "STAGE_NO",
    "VESSEL_INSIDE_PARENCHYMA_MIN",
    "VesselMask",
    "segment_vessels",
]
