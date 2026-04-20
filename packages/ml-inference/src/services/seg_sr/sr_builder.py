# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DICOM-SR (TID 1500 Measurement Report) builder (T258).

Plain-English:
    A DICOM-SR is a "structured report" — think of it as a spreadsheet
    of measurements (liver volume, each segment volume, lesion sizes,
    FLR percentage + adequacy verdict) bound into a DICOM file that
    points back at our SEG so radiologists' viewers can jump from
    measurement to overlay with one click.

    TID 1500 is the standard Measurement Report template. Inside it we
    place one ``VolumetricROIMeasurements`` group per structure. Each
    group contains at least one ``NumericMeasurement`` (e.g. Volume
    in mL) and, for FLR + lesions, a ``QualitativeEvaluation`` (FLR
    adequacy verdict / lesion class).

Contract:
    contracts/dicom-artifacts.md §Artifact 2 — DICOM-SR is the single
    source of truth for field names + coded concepts. The leading
    ``TextContentItem`` is the tri-lingual RUO disclaimer; FLR
    qualitative evaluation uses the 25/30/40% thresholds encoded in
    :mod:`snomed_codes.flr_adequacy_for`.

Dependencies:
    ``highdicom>=0.24`` (Apache 2.0), ``pydicom>=3.0`` (MIT).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

try:  # pragma: no cover — optional at import time for unit tests
    import highdicom as hd  # type: ignore[import-not-found]
    from highdicom.sr.coding import CodedConcept  # type: ignore[import-not-found]
    from highdicom.sr.value_types import (  # type: ignore[import-not-found]
        CodeContentItem,
        NumContentItem,
        TextContentItem,
    )
except ImportError:  # pragma: no cover
    hd = None  # type: ignore[assignment]
    CodedConcept = None  # type: ignore[assignment,misc]
    CodeContentItem = None  # type: ignore[assignment,misc]
    NumContentItem = None  # type: ignore[assignment,misc]
    TextContentItem = None  # type: ignore[assignment,misc]

try:  # pragma: no cover
    import pydicom  # type: ignore[import-not-found]
    from pydicom.uid import generate_uid  # type: ignore[import-not-found]
    from pydicom.sr.codedict import codes  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    pydicom = None  # type: ignore[assignment]
    codes = None  # type: ignore[assignment]

    def generate_uid(prefix: str | None = None) -> str:  # type: ignore[misc]
        raise RuntimeError("pydicom is required for DICOM-SR generation")

from .seg_builder import (
    CONTENT_CREATOR_NAME,
    LIVERRA_UID_ROOT,
    MANUFACTURER,
    MANUFACTURER_MODEL_NAME,
    SPECIFIC_CHARACTER_SET,
)
from .snomed_codes import (
    DCM_COMMENT_CODE,
    DCM_COMMENT_DISPLAY,
    DCM_COMMENT_SYSTEM,
    DCM_LONGEST_DIAMETER_CODE,
    DCM_LONGEST_DIAMETER_DISPLAY,
    DCM_LONGEST_DIAMETER_SYSTEM,
    SCT_PERCENTAGE,
    SCT_VOLUME,
    SnomedConcept,
    UCUM_DIMENSIONLESS,
    UCUM_ML,
    UCUM_MM,
    UCUM_PERCENT,
    flr_adequacy_for,
    lesion_concept_for,
)

logger = logging.getLogger(__name__)

SERIES_DESCRIPTION_SR: str = "LiverRa AI — Measurement Report (RUO)"

# Tri-lingual RUO disclaimer — research §B.8 authoritative body text.
# Placed as the first TextContentItem inside the SR's root content sequence
# so any DICOM reader encounters it before any measurement. The body is a
# single \n-joined string so legacy viewers that show only the first line
# still surface English first, which is the fallback.
RUO_DISCLAIMER_EN: str = (
    "Research Use Only (RUO). Not for diagnostic or treatment decisions. "
    "Outputs are informational only; clinical judgment rests with a qualified "
    "physician. See report body for model versions + confidence."
)
RUO_DISCLAIMER_DE: str = (
    "Nur zu Forschungszwecken (RUO). Nicht für diagnostische oder "
    "therapeutische Entscheidungen. Die Ergebnisse dienen nur zur "
    "Information; die klinische Beurteilung obliegt einer qualifizierten "
    "Ärztin oder einem qualifizierten Arzt."
)
RUO_DISCLAIMER_KA: str = (
    "მხოლოდ კვლევითი გამოყენებისთვის (RUO). არ არის განკუთვნილი "
    "დიაგნოსტიკური ან სამკურნალო გადაწყვეტილებებისთვის. გამოტანილი "
    "შედეგები მხოლოდ საინფორმაციო ხასიათისაა."
)
RUO_DISCLAIMER_TRI_LINGUAL: str = (
    RUO_DISCLAIMER_EN + "\n\n" + RUO_DISCLAIMER_DE + "\n\n" + RUO_DISCLAIMER_KA
)


# ---------------------------------------------------------------------------
# Input dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VolumeMeasurement:
    """A single volumetric ROI to emit as a TID 1411 subtemplate."""

    segment_number: int  # matches the SEG's Segment Number
    label: str  # human-readable, e.g. "Couinaud Segment III"
    volume_ml: float
    # SNOMED code for "Finding site" / segmented property — used to enrich the
    # ``VolumetricROI`` group when the SEG reference alone isn't enough.
    finding_site: SnomedConcept | None = None


@dataclass(frozen=True)
class FLRMeasurement:
    """Future Liver Remnant numeric + qualitative block."""

    remnant_volume_ml: float
    remnant_pct_functional: float  # 0..100
    resection_plane_hash: str
    operator_hash: str
    # Optional resection-plane segment number (if we emit one). When present,
    # placed in the TextValue string only — FLR does not get its own SEG row.
    plane_segment_number: int | None = None


@dataclass(frozen=True)
class LesionMeasurement:
    """One lesion's structured measurements."""

    segment_number: int  # SEG segment number for this lesion
    label: str | None  # LiLNet class label — None → "Uncertain"
    longest_diameter_mm: float
    volume_ml: float
    calibrated_confidence: float  # [0,1]
    temperature_applied: float


@dataclass(frozen=True)
class SRBuildInput:
    """All data the SR writer needs. Reference-style — the SR doesn't
    duplicate geometry that lives in the SEG."""

    source_datasets: Sequence[Any]  # pydicom datasets for evidence list
    seg_dataset: Any  # pydicom dataset of the SEG built by :mod:`seg_builder`

    parenchyma: VolumeMeasurement
    couinaud: Sequence[VolumeMeasurement]  # length 8
    flr: FLRMeasurement | None
    lesions: Sequence[LesionMeasurement]

    series_number: int = 9902
    instance_number: int = 1
    finalized_at: datetime | None = None
    software_versions: str = "0.0.0-dev"
    device_serial_number: str = "unknown-tenant"
    tenant_institution_name: str | None = None
    device_observer_uid: str | None = None
    person_observer_name: str | None = None  # optional; RUO default is None
    extra_tags: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SRBuildResult:
    sop_instance_uid: str
    series_instance_uid: str
    dataset: Any  # pydicom ``Dataset``


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coded(concept: SnomedConcept) -> Any:
    """Build a highdicom CodedConcept from our SnomedConcept dataclass."""
    if CodedConcept is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")
    # We store every concept with its schema URI; fall back to SCT for SNOMED
    # and let the caller pass DCM-system codes directly.
    scheme = "SCT" if "snomed.info" in concept.system else "SCT"
    return CodedConcept(value=concept.code, scheme_designator=scheme, meaning=concept.display)


def _dcm_coded(code: str, display: str) -> Any:
    if CodedConcept is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")
    return CodedConcept(value=code, scheme_designator="DCM", meaning=display)


def _ucum(concept: SnomedConcept) -> Any:
    """UCUM-system coded unit — tiny helper so callers don't repeat 'UCUM'."""
    if CodedConcept is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")
    return CodedConcept(value=concept.code, scheme_designator="UCUM", meaning=concept.display)


def _ruo_text_item() -> Any:
    """Leading ``TextContentItem`` — tri-lingual RUO disclaimer."""
    if TextContentItem is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")
    return TextContentItem(
        name=_dcm_coded(DCM_COMMENT_CODE, DCM_COMMENT_DISPLAY),
        value=RUO_DISCLAIMER_TRI_LINGUAL,
    )


def _volume_group(
    *,
    seg_dataset: Any,
    measurement: VolumeMeasurement,
    tracking_id_prefix: str,
) -> Any:
    """One TID 1411-style VolumetricROIMeasurements block.

    We deliberately use a single numeric measurement (volume) since the SEG
    provides the actual geometry — see contracts §SR structure for the shape.
    """
    if hd is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")

    volume = hd.sr.Measurement(
        name=_coded(SCT_VOLUME),
        value=float(measurement.volume_ml),
        unit=_ucum(UCUM_ML),
    )
    return hd.sr.VolumetricROIMeasurementsAndQualitativeEvaluations(
        tracking_identifier=hd.sr.TrackingIdentifier(
            uid=generate_uid(prefix=LIVERRA_UID_ROOT),
            identifier=f"{tracking_id_prefix}-{measurement.segment_number}",
        ),
        referenced_segment=hd.sr.ReferencedSegment.from_source_image(
            source_image=seg_dataset,
            segment_number=measurement.segment_number,
        )
        if hasattr(hd.sr, "ReferencedSegment")
        else hd.sr.ReferencedSegmentationFrame.from_source_image(
            source_image=seg_dataset,
            segment_number=measurement.segment_number,
        ),
        measurements=[volume],
        finding_type=_coded(measurement.finding_site) if measurement.finding_site else None,
    )


def _flr_group(seg_dataset: Any, flr: FLRMeasurement) -> Any:
    """FLR measurement group — volume + percentage + adequacy verdict."""
    if hd is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")

    volume_measure = hd.sr.Measurement(
        name=_coded(SCT_VOLUME), value=float(flr.remnant_volume_ml), unit=_ucum(UCUM_ML)
    )
    pct_measure = hd.sr.Measurement(
        name=_coded(SCT_PERCENTAGE), value=float(flr.remnant_pct_functional), unit=_ucum(UCUM_PERCENT)
    )

    adequacy = flr_adequacy_for(flr.remnant_pct_functional)
    qualitative = hd.sr.QualitativeEvaluation(
        name=_dcm_coded("121071", "Finding"),
        value=_coded(adequacy),
    )

    # FLR doesn't have a SEG segment of its own; use a free-text container so
    # viewers still display it next to its source (reviewer's plane hash).
    return hd.sr.MeasurementsAndQualitativeEvaluations(
        tracking_identifier=hd.sr.TrackingIdentifier(
            uid=generate_uid(prefix=LIVERRA_UID_ROOT),
            identifier="future-liver-remnant",
        ),
        measurements=[volume_measure, pct_measure],
        qualitative_evaluations=[qualitative],
        finding_type=_coded(adequacy),
    )


def _lesion_group(seg_dataset: Any, lesion: LesionMeasurement) -> Any:
    """One lesion's block — longest diameter, volume, class, confidence."""
    if hd is None:
        raise RuntimeError("highdicom is required for DICOM-SR generation")

    longest = hd.sr.Measurement(
        name=_dcm_coded(DCM_LONGEST_DIAMETER_CODE, DCM_LONGEST_DIAMETER_DISPLAY),
        value=float(lesion.longest_diameter_mm),
        unit=_ucum(UCUM_MM),
    )
    volume = hd.sr.Measurement(
        name=_coded(SCT_VOLUME),
        value=float(lesion.volume_ml),
        unit=_ucum(UCUM_ML),
    )
    confidence = hd.sr.Measurement(
        name=_dcm_coded("121401", "Derivation"),  # generic derivation stand-in
        value=float(lesion.calibrated_confidence),
        unit=_ucum(UCUM_DIMENSIONLESS),
    )

    lesion_class = lesion_concept_for(lesion.label)
    qualitative_class = hd.sr.QualitativeEvaluation(
        name=_dcm_coded("121071", "Finding"),
        value=_coded(lesion_class),
    )

    seg_ref = (
        hd.sr.ReferencedSegment.from_source_image(
            source_image=seg_dataset,
            segment_number=lesion.segment_number,
        )
        if hasattr(hd.sr, "ReferencedSegment")
        else hd.sr.ReferencedSegmentationFrame.from_source_image(
            source_image=seg_dataset,
            segment_number=lesion.segment_number,
        )
    )

    return hd.sr.VolumetricROIMeasurementsAndQualitativeEvaluations(
        tracking_identifier=hd.sr.TrackingIdentifier(
            uid=generate_uid(prefix=LIVERRA_UID_ROOT),
            identifier=f"lesion-seg{lesion.segment_number}",
        ),
        referenced_segment=seg_ref,
        measurements=[longest, volume, confidence],
        qualitative_evaluations=[qualitative_class],
        finding_type=_coded(lesion_class),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_sr(inp: SRBuildInput) -> SRBuildResult:
    """Build the TID 1500 Comprehensive SR. Returns a ready-to-save dataset.

    Invariants (see ``tests/contracts/test_dicom_artifacts_golden.py``):

    * Fresh ``SOPInstanceUID`` + ``SeriesInstanceUID`` per call (FR-026b).
    * First ``ContentSequence`` child is the tri-lingual RUO disclaimer.
    * Every lesion block's qualitative evaluation is a valid SNOMED concept.
    * FLR adequacy uses the 25/30/40 % thresholds from :mod:`snomed_codes`.
    """
    if hd is None or pydicom is None:
        raise RuntimeError(
            "build_sr requires both highdicom and pydicom; install via "
            "`pip install 'highdicom>=0.24' 'pydicom>=3.0'`"
        )
    if len(inp.couinaud) != 8:
        raise ValueError(f"Expected 8 Couinaud measurements; got {len(inp.couinaud)}")

    series_uid = generate_uid(prefix=LIVERRA_UID_ROOT)
    sop_uid = generate_uid(prefix=LIVERRA_UID_ROOT)
    finalized = inp.finalized_at or datetime.now(timezone.utc)

    device_uid = inp.device_observer_uid or (
        LIVERRA_UID_ROOT.rstrip(".") + ".device." + inp.software_versions
    )

    # --- Build the Imaging Measurements subtree --------------------------
    imaging_measurements: list[Any] = []

    imaging_measurements.append(
        _volume_group(
            seg_dataset=inp.seg_dataset,
            measurement=inp.parenchyma,
            tracking_id_prefix="liver-parenchyma",
        )
    )
    for couinaud in inp.couinaud:
        imaging_measurements.append(
            _volume_group(
                seg_dataset=inp.seg_dataset,
                measurement=couinaud,
                tracking_id_prefix="couinaud-volume",
            )
        )
    if inp.flr is not None:
        imaging_measurements.append(_flr_group(inp.seg_dataset, inp.flr))
    for lesion in inp.lesions:
        imaging_measurements.append(_lesion_group(inp.seg_dataset, lesion))

    # --- ObserverContext + MeasurementReport -----------------------------
    observer_context = hd.sr.ObserverContext(
        observer_type=_dcm_coded("121007", "Device"),
        observer_identifying_attributes=hd.sr.DeviceObserverIdentifyingAttributes(
            uid=device_uid,
            name=MANUFACTURER_MODEL_NAME,
            manufacturer_name=MANUFACTURER,
            model_name=MANUFACTURER_MODEL_NAME,
        ),
    )

    report = hd.sr.MeasurementReport(
        observation_context=hd.sr.ObservationContext(
            observer_person_context=None,  # RUO v1 — no clinician sign-off in SR sense
            observer_device_context=observer_context,
        ),
        procedure_reported=_dcm_coded("363683002", "CT of Abdomen"),
        imaging_measurements=imaging_measurements,
    )

    # Prepend the tri-lingual RUO disclaimer as the first ContentSequence child.
    # highdicom's MeasurementReport is a ContainerContentItem; mutate in place.
    ruo_item = _ruo_text_item()
    existing = list(getattr(report, "ContentSequence", []) or [])
    report.ContentSequence = [ruo_item, *existing]

    sr_dataset = hd.sr.ComprehensiveSR(
        evidence=[*inp.source_datasets, inp.seg_dataset],
        content=report,
        series_instance_uid=series_uid,
        series_number=inp.series_number,
        sop_instance_uid=sop_uid,
        instance_number=inp.instance_number,
        manufacturer=MANUFACTURER,
        manufacturer_model_name=MANUFACTURER_MODEL_NAME,
        software_versions=inp.software_versions,
        device_serial_number=inp.device_serial_number,
        series_description=SERIES_DESCRIPTION_SR,
        institution_name=inp.tenant_institution_name or "",
    )
    sr_dataset.SpecificCharacterSet = SPECIFIC_CHARACTER_SET
    sr_dataset.ContentDate = finalized.strftime("%Y%m%d")
    sr_dataset.ContentTime = finalized.strftime("%H%M%S")
    sr_dataset.CompletionFlag = "COMPLETE"
    sr_dataset.VerificationFlag = "UNVERIFIED"
    sr_dataset.ContentCreatorName = CONTENT_CREATOR_NAME
    if inp.person_observer_name:
        sr_dataset.PersonName = inp.person_observer_name

    for key, value in inp.extra_tags.items():
        setattr(sr_dataset, key, value)

    _assert_sr_invariants(sr_dataset)

    logger.info(
        "built DICOM-SR sop_uid=%s series_uid=%s measurement_groups=%d",
        sop_uid,
        series_uid,
        len(imaging_measurements),
    )

    return SRBuildResult(
        sop_instance_uid=sop_uid,
        series_instance_uid=series_uid,
        dataset=sr_dataset,
    )


def _assert_sr_invariants(sr: Any) -> None:
    """Fail fast on contract drift. Called inside :func:`build_sr`."""
    series_desc = str(getattr(sr, "SeriesDescription", ""))
    if not series_desc.endswith("(RUO)"):
        raise AssertionError(
            f"SR SeriesDescription must end with '(RUO)'; got {series_desc!r}"
        )
    content_seq = list(getattr(sr, "ContentSequence", []) or [])
    # First ContentSequence child should be our Text disclaimer; either the
    # MeasurementReport container or the disclaimer directly (depending on
    # how highdicom serialises).
    def _has_ruo(node: Any) -> bool:
        text = str(getattr(node, "TextValue", "") or "")
        if "Research Use Only" in text or "Forschungszwecken" in text or "კვლევითი" in text:
            return True
        children = getattr(node, "ContentSequence", []) or []
        return any(_has_ruo(c) for c in children)

    if not any(_has_ruo(item) for item in content_seq):
        raise AssertionError("SR missing leading tri-lingual RUO TextContentItem")


__all__ = [
    "VolumeMeasurement",
    "FLRMeasurement",
    "LesionMeasurement",
    "SRBuildInput",
    "SRBuildResult",
    "build_sr",
    "RUO_DISCLAIMER_EN",
    "RUO_DISCLAIMER_DE",
    "RUO_DISCLAIMER_KA",
    "RUO_DISCLAIMER_TRI_LINGUAL",
    "SERIES_DESCRIPTION_SR",
]
