# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Couinaud 8-segment Celery task (T197).

Stage 3 of the cascade. Takes the parenchyma mask from Stage 1 and asks
the Pictorial Couinaud model (Triton `liverra-couinaud-segments`) to
parse the liver into its 8 Couinaud regions (I..VIII).

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
from src.services.triton.client import TritonClient

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
STAGE_NO: int = 3
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

    await audit_writer.write(
        event_dict={
            "resourceType": "AuditEvent",
            "type": {"code": "ml_inference"},
            "action": "E",  # Execute
            "outcome": "0",  # Success
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
                "segment_volumes_ml": {
                    label: volumes[label] for label in COUINAUD_LABELS
                },
            },
        },
        tenant_id=tenant_id,
        session=session,
    )

    logger.info(
        "couinaud: analysis=%s 8 segments persisted (total %.1f mL)",
        analysis_id,
        sum(volumes.values()),
    )
    return segmentations


__all__ = [
    "COUINAUD_LABELS",
    "COUINAUD_SNOMED",
    "STAGE_NAME",
    "STAGE_NO",
    "SegmentMask",
    "TRITON_MODEL_NAME",
    "segment_couinaud",
]
