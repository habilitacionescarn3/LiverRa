# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DICOM-SEG builder (T257).

Plain-English:
    A DICOM-SEG is a special kind of DICOM file that carries a stack of
    binary masks (liver parenchyma, 8 Couinaud segments, 2 vessels, N
    lesions) instead of pixel brightness. Hospital PACS systems already
    know how to store and display these, so we use ``highdicom`` — the
    authoritative Python library for DICOM structured artifacts — to
    build one per finalize.

    Think of it as one spiral-bound folder where each page is a coloured
    transparent overlay of the liver, labelled with a SNOMED-CT code so
    any downstream reader (Orthanc, OHIF, a radiology workstation) can
    say "this purple blob is Couinaud II" without ever having to trust
    our JSON.

Contract:
    contracts/dicom-artifacts.md §Artifact 1 — DICOM-SEG is the single
    source of truth. MULTI_SEGMENT_BINARY layout, fresh SOP Instance UID
    per finalize (FR-026b), ``SeriesDescription`` suffix ``(RUO)`` and
    every ``AlgorithmIdentificationSequence.name`` prefixed ``liverra-``
    for audit.

Inputs:
    :class:`SegBuildInput` is the pure-Python bundle the finalize task
    hands us — a list of source CT datasets, the aligned volumes
    (parenchyma, 8 Couinaud, 2 vessels, N lesions), and the MBoM-backed
    algorithm names / versions. No database session here by design; this
    module is safe to unit-test without Postgres.

Dependencies:
    ``highdicom>=0.24`` (Apache 2.0), ``pydicom>=3.0`` (MIT),
    ``numpy>=2.0``.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Sequence

import numpy as np

try:  # pragma: no cover — optional at import time for unit tests
    import highdicom as hd  # type: ignore[import-not-found]
    from highdicom.seg import SegmentDescription  # type: ignore[import-not-found]
    from highdicom.sr.coding import CodedConcept  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    hd = None  # type: ignore[assignment]
    SegmentDescription = None  # type: ignore[assignment,misc]
    CodedConcept = None  # type: ignore[assignment,misc]

try:  # pragma: no cover — pydicom is an explicit dep in production
    import pydicom  # type: ignore[import-not-found]
    from pydicom.dataset import Dataset  # type: ignore[import-not-found]
    from pydicom.uid import generate_uid  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    pydicom = None  # type: ignore[assignment]
    Dataset = object  # type: ignore[assignment,misc]

    def generate_uid(prefix: str | None = None) -> str:  # type: ignore[misc]
        raise RuntimeError("pydicom is required for DICOM-SEG generation")

from .snomed_codes import (
    ALGORITHM_AUTOMATIC,
    ALGORITHM_SEMIAUTOMATIC,
    CATEGORY_LESION,
    CATEGORY_ORGAN,
    CATEGORY_VASCULAR,
    COUINAUD_SEGMENTS_ORDERED,
    HEPATIC_VEIN,
    LIVER,
    PORTAL_VEIN,
    SnomedConcept,
    lesion_concept_for,
)

logger = logging.getLogger(__name__)

# LiverRa's org-level DICOM UID root. Acquired once at org level; the
# real value lives in AWS Secrets Manager. The default is a safe
# research-only placeholder that is obviously fake so no rogue
# production build accidentally ships it (see contracts §Common).
LIVERRA_UID_ROOT: str = os.environ.get(
    "LIVERRA_DICOM_UID_ROOT", "1.2.826.0.1.3680043.10.9999."  # RUO placeholder
)

SERIES_DESCRIPTION_SEG: str = "LiverRa AI — Liver Segmentation (RUO)"
CONTENT_CREATOR_NAME: str = "LiverRa^AI^v1"
MANUFACTURER: str = "LiverRa"
MANUFACTURER_MODEL_NAME: str = "LiverRa v1 MVP"
SPECIFIC_CHARACTER_SET: str = "ISO_IR 192"

# Every ``AlgorithmIdentificationSequence.name`` the SEG writer emits
# MUST begin with this prefix per contracts §Common / §Acceptance tests.
ALGO_NAME_PREFIX: str = "liverra-"


@dataclass(frozen=True)
class AlgorithmId:
    """MBoM-anchored algorithm identifier for one segment."""

    name: str
    version: str

    def as_highdicom(self) -> Any:
        """Render as highdicom ``AlgorithmIdentificationSequence`` entry."""
        if hd is None:
            raise RuntimeError("highdicom is required for DICOM-SEG generation")
        return hd.AlgorithmIdentificationSequence(
            name=self.name,
            version=self.version,
            family=_coded_dcm("113015", "Deep Learning"),
            source="LiverRa",
        )


@dataclass(frozen=True)
class LesionSegmentInput:
    """One lesion → one SEG segment bundle."""

    mask: np.ndarray
    label: str | None  # "hcc" / "icc" / ... / None → "Uncertain"
    algorithm: AlgorithmId
    semiautomatic: bool = False  # True if MedSAM-2 reviewer-prompted
    lesion_number: int = 0  # 1-based; used for SEG label humans see


@dataclass(frozen=True)
class SegBuildInput:
    """Pure-data bundle the finalize Celery task hands to :func:`build_seg`.

    All masks MUST share the same shape + spatial frame of reference as
    ``source_datasets``. The builder raises on mismatch (no silent
    resampling — finalize is the wrong place to throw away fidelity).
    """

    source_datasets: Sequence[Any]  # pydicom ``Dataset`` instances, one per source slice
    parenchyma_mask: np.ndarray
    couinaud_masks: Sequence[np.ndarray]  # length 8, ordered I..VIII
    portal_vein_mask: np.ndarray
    hepatic_vein_mask: np.ndarray
    lesions: Sequence[LesionSegmentInput]
    parenchyma_algorithm: AlgorithmId
    couinaud_algorithm: AlgorithmId
    vessel_algorithm: AlgorithmId

    tenant_institution_name: str | None = None  # None → empty string per contract
    series_number: int = 9901
    instance_number: int = 1
    finalized_at: datetime | None = None
    software_versions: str = "0.0.0-dev"
    device_serial_number: str = "unknown-tenant"
    extra_tags: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SegBuildResult:
    """What the finalize task persists + hands to the SR builder."""

    sop_instance_uid: str
    series_instance_uid: str
    dataset: Any  # pydicom ``Dataset`` — serialised to bytes by caller
    segment_numbers: dict[str, int]  # stable map: "parenchyma", "couinaud_i", ..., "lesion_1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coded(concept: SnomedConcept) -> Any:
    """Render one :class:`SnomedConcept` as a highdicom ``CodedConcept``."""
    if CodedConcept is None:
        raise RuntimeError("highdicom is required")
    return CodedConcept(
        value=concept.code,
        scheme_designator="SCT" if concept.system.endswith("snomed.info/sct") else "SCT",
        meaning=concept.display,
    )


def _coded_dcm(code: str, display: str) -> Any:
    """Render a DCM-system CodedConcept (used for algorithm family, etc.)."""
    if CodedConcept is None:
        raise RuntimeError("highdicom is required")
    return CodedConcept(value=code, scheme_designator="DCM", meaning=display)


def _stamp_algo_name(raw_name: str) -> str:
    """Ensure the algorithm name begins with ``liverra-`` per contract."""
    name = raw_name.strip()
    if not name:
        name = "unknown"
    if not name.startswith(ALGO_NAME_PREFIX):
        name = f"{ALGO_NAME_PREFIX}{name}"
    return name


def _ensure_mask_shape(name: str, mask: np.ndarray, reference: np.ndarray) -> np.ndarray:
    """Reject shape mismatches loudly (finalize never silently resamples)."""
    if mask.shape != reference.shape:
        raise ValueError(
            f"SEG input '{name}' shape {mask.shape} does not match "
            f"parenchyma reference shape {reference.shape}"
        )
    return mask.astype(np.uint8, copy=False)


def _build_segment_description(
    *,
    segment_number: int,
    segmented_property_type: SnomedConcept,
    segmented_property_category: SnomedConcept,
    algorithm: AlgorithmId,
    tracking_id: str,
    label: str,
    semiautomatic: bool = False,
) -> Any:
    """One segment's metadata (highdicom ``SegmentDescription``)."""
    if SegmentDescription is None:
        raise RuntimeError("highdicom is required for DICOM-SEG generation")

    stamped = AlgorithmId(name=_stamp_algo_name(algorithm.name), version=algorithm.version)
    algo_type = ALGORITHM_SEMIAUTOMATIC if semiautomatic else ALGORITHM_AUTOMATIC

    return SegmentDescription(
        segment_number=segment_number,
        segment_label=label,
        segmented_property_category=_coded(segmented_property_category),
        segmented_property_type=_coded(segmented_property_type),
        algorithm_type=algo_type,
        algorithm_identification=stamped.as_highdicom(),
        tracking_id=tracking_id,
        tracking_uid=generate_uid(prefix=LIVERRA_UID_ROOT),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_seg(inp: SegBuildInput) -> SegBuildResult:
    """Assemble a MULTI_SEGMENT_BINARY DICOM-SEG for one finalize event.

    Returns a :class:`SegBuildResult` whose ``dataset`` is a pydicom
    :class:`Dataset` ready for ``.save_as(path)`` or byte-stream emit.
    The caller is responsible for persisting to S3 and the DB.

    Contract invariants (asserted on the way out — see
    ``tests/contracts/test_dicom_artifacts_golden.py``):

    * ``SeriesDescription`` ends with ``(RUO)``.
    * Every ``AlgorithmIdentificationSequence.name`` starts with
      ``liverra-``.
    * Fresh ``SOPInstanceUID`` + ``SeriesInstanceUID`` per call
      (FR-026b).
    * Segments are 1=parenchyma, 2-9=Couinaud I..VIII, 10=portal vein,
      11=hepatic vein, 12..=lesions in ``inp.lesions`` order.
    """
    if hd is None or pydicom is None:
        raise RuntimeError(
            "build_seg requires both highdicom and pydicom; install via "
            "`pip install 'highdicom>=0.24' 'pydicom>=3.0'`"
        )
    if not inp.source_datasets:
        raise ValueError("SegBuildInput.source_datasets must not be empty")

    reference = inp.parenchyma_mask
    if reference.ndim != 3:
        raise ValueError("parenchyma_mask must be a 3-D volume (D, H, W)")

    # --- Segment ordering is STABLE across finalizes of the same study ---
    segment_numbers: dict[str, int] = {"parenchyma": 1}
    descriptions: list[Any] = [
        _build_segment_description(
            segment_number=1,
            segmented_property_type=LIVER,
            segmented_property_category=CATEGORY_ORGAN,
            algorithm=inp.parenchyma_algorithm,
            tracking_id="liver-parenchyma",
            label="Liver parenchyma",
        )
    ]
    layers: list[np.ndarray] = [_ensure_mask_shape("parenchyma", reference, reference)]

    # Couinaud I..VIII — segments 2..9.
    if len(inp.couinaud_masks) != 8:
        raise ValueError(
            f"Expected 8 Couinaud masks (I..VIII); got {len(inp.couinaud_masks)}"
        )
    for i, mask in enumerate(inp.couinaud_masks):
        concept = COUINAUD_SEGMENTS_ORDERED[i]
        seg_no = 2 + i
        segment_numbers[f"couinaud_{i + 1}"] = seg_no
        descriptions.append(
            _build_segment_description(
                segment_number=seg_no,
                segmented_property_type=concept,
                segmented_property_category=CATEGORY_ORGAN,
                algorithm=inp.couinaud_algorithm,
                tracking_id=f"couinaud-{i + 1}",
                label=f"Couinaud Segment {concept.display.split(' ')[-1]}",
            )
        )
        layers.append(_ensure_mask_shape(f"couinaud_{i + 1}", mask, reference))

    # Vessels — segments 10, 11.
    segment_numbers["portal_vein"] = 10
    descriptions.append(
        _build_segment_description(
            segment_number=10,
            segmented_property_type=PORTAL_VEIN,
            segmented_property_category=CATEGORY_VASCULAR,
            algorithm=inp.vessel_algorithm,
            tracking_id="portal-vein",
            label="Portal vein (trunk + primary)",
        )
    )
    layers.append(_ensure_mask_shape("portal_vein", inp.portal_vein_mask, reference))

    segment_numbers["hepatic_vein"] = 11
    descriptions.append(
        _build_segment_description(
            segment_number=11,
            segmented_property_type=HEPATIC_VEIN,
            segmented_property_category=CATEGORY_VASCULAR,
            algorithm=inp.vessel_algorithm,
            tracking_id="hepatic-vein",
            label="Hepatic vein (trunks)",
        )
    )
    layers.append(_ensure_mask_shape("hepatic_vein", inp.hepatic_vein_mask, reference))

    # Lesions — segments 12..(11 + N).
    for n, lesion in enumerate(inp.lesions, start=1):
        seg_no = 11 + n
        concept = lesion_concept_for(lesion.label)
        segment_numbers[f"lesion_{n}"] = seg_no
        descriptions.append(
            _build_segment_description(
                segment_number=seg_no,
                segmented_property_type=concept,
                segmented_property_category=CATEGORY_LESION,
                algorithm=lesion.algorithm,
                tracking_id=f"lesion-{n}",
                label=f"Lesion {n} ({concept.display})",
                semiautomatic=lesion.semiautomatic,
            )
        )
        layers.append(_ensure_mask_shape(f"lesion_{n}", lesion.mask, reference))

    # Stack layers into a (D, H, W, num_segments) bool volume per highdicom
    # MULTI_SEGMENT_BINARY expectation.
    pixel_array = np.stack(layers, axis=-1).astype(np.uint8)

    series_uid = generate_uid(prefix=LIVERRA_UID_ROOT)
    sop_uid = generate_uid(prefix=LIVERRA_UID_ROOT)
    finalized = inp.finalized_at or datetime.now(timezone.utc)

    seg = hd.seg.Segmentation(
        source_images=list(inp.source_datasets),
        pixel_array=pixel_array,
        segmentation_type=hd.seg.SegmentationTypeValues.BINARY,
        segment_descriptions=descriptions,
        series_instance_uid=series_uid,
        series_number=inp.series_number,
        sop_instance_uid=sop_uid,
        instance_number=inp.instance_number,
        manufacturer=MANUFACTURER,
        manufacturer_model_name=MANUFACTURER_MODEL_NAME,
        software_versions=inp.software_versions,
        device_serial_number=inp.device_serial_number,
        series_description=SERIES_DESCRIPTION_SEG,
        content_creator_name=CONTENT_CREATOR_NAME,
        content_label="LIVERRA_LIVER_AI",
        content_description="LiverRa v1 liver + Couinaud + vessels + lesions (RUO)",
    )

    # Common fields the contract nails down but highdicom doesn't own directly.
    seg.SpecificCharacterSet = SPECIFIC_CHARACTER_SET
    seg.InstitutionName = inp.tenant_institution_name or ""
    seg.ContentDate = finalized.strftime("%Y%m%d")
    seg.ContentTime = finalized.strftime("%H%M%S")
    seg.ClinicalTrialSubjectID = ""
    seg.ClinicalTrialProtocolID = ""

    for key, value in inp.extra_tags.items():
        setattr(seg, key, value)

    _assert_seg_invariants(seg, descriptions)

    logger.info(
        "built DICOM-SEG sop_uid=%s series_uid=%s segments=%d",
        sop_uid,
        series_uid,
        len(descriptions),
    )

    return SegBuildResult(
        sop_instance_uid=sop_uid,
        series_instance_uid=series_uid,
        dataset=seg,
        segment_numbers=segment_numbers,
    )


def _assert_seg_invariants(seg: Any, descriptions: Sequence[Any]) -> None:
    """Fail fast if we ever emit a SEG that breaks contracts/dicom-artifacts.md."""
    series_desc = str(getattr(seg, "SeriesDescription", ""))
    if not series_desc.endswith("(RUO)"):
        raise AssertionError(
            f"SEG SeriesDescription must end with '(RUO)'; got {series_desc!r}"
        )
    for desc in descriptions:
        algo_seq = getattr(desc, "AlgorithmIdentificationSequence", None)
        if algo_seq is None:
            continue
        for item in algo_seq:
            name = str(getattr(item, "AlgorithmName", ""))
            if not name.startswith(ALGO_NAME_PREFIX):
                raise AssertionError(
                    f"AlgorithmIdentificationSequence.name must start "
                    f"with '{ALGO_NAME_PREFIX}'; got {name!r}"
                )


__all__ = [
    "AlgorithmId",
    "LesionSegmentInput",
    "SegBuildInput",
    "SegBuildResult",
    "build_seg",
    "LIVERRA_UID_ROOT",
    "SERIES_DESCRIPTION_SEG",
    "ALGO_NAME_PREFIX",
]
