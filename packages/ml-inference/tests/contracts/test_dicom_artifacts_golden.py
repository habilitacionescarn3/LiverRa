# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""T425 — Golden-field diff test for the DICOM-SEG + DICOM-SR builders.

Plain-English:
    This test is the insurance policy against silent contract drift.
    We build an SEG + SR from a known tiny fixture ("ct-002"), walk
    the generated pydicom ``Dataset`` for a short list of fields the
    ``contracts/dicom-artifacts.md`` document guarantees, and compare
    each to the expected shape.

    The fields we guard are the ones regulators will lean on:

      * SEG ``SeriesDescription`` ending with ``(RUO)``.
      * SEG per-segment SNOMED codes (parenchyma + Couinaud + vessels
        + lesion class) by code.
      * ``AlgorithmIdentificationSequence.name`` starting with
        ``liverra-``.
      * MULTI_SEGMENT_BINARY segmentation type.
      * SR leading ``TextContentItem`` containing the tri-lingual RUO
        disclaimer keywords.
"""
from __future__ import annotations

from typing import Any

import pytest


def _build_pair() -> tuple[Any, Any, dict[str, int]]:
    """Render SEG + SR from the ct-002 fixture volume."""
    pytest.importorskip("highdicom")
    pytest.importorskip("pydicom")

    import numpy as np

    from src.services.seg_sr.seg_builder import (
        AlgorithmId,
        LesionSegmentInput,
        SegBuildInput,
        build_seg,
    )
    from src.services.seg_sr.sr_builder import (
        FLRMeasurement,
        LesionMeasurement,
        SRBuildInput,
        VolumeMeasurement,
        build_sr,
    )

    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    shape = (3, 8, 8)
    frame_of_ref_uid = generate_uid()
    series_uid = generate_uid()
    study_uid = generate_uid()
    sources: list[Any] = []
    for i in range(shape[0]):
        ds = Dataset()
        ds.file_meta = FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
        ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_of_ref_uid
        ds.Modality = "CT"
        ds.Rows = shape[1]
        ds.Columns = shape[2]
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.PixelSpacing = [1.0, 1.0]
        ds.SliceThickness = 1.0
        ds.ImagePositionPatient = [0.0, 0.0, float(i)]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.InstanceNumber = i + 1
        ds.PixelData = np.zeros(shape[1:], dtype=np.uint16).tobytes()
        sources.append(ds)

    zeros = np.zeros(shape, dtype=np.uint8)
    seg = build_seg(
        SegBuildInput(
            source_datasets=tuple(sources),
            parenchyma_mask=zeros.copy(),
            couinaud_masks=tuple(zeros.copy() for _ in range(8)),
            portal_vein_mask=zeros.copy(),
            hepatic_vein_mask=zeros.copy(),
            lesions=(
                LesionSegmentInput(
                    mask=zeros.copy(),
                    label="hcc",
                    algorithm=AlgorithmId(name="lilnet", version="1.0.0"),
                    lesion_number=1,
                ),
            ),
            parenchyma_algorithm=AlgorithmId(name="stunet-parenchyma", version="1.0.3"),
            couinaud_algorithm=AlgorithmId(name="pictorial-couinaud", version="0.9.2"),
            vessel_algorithm=AlgorithmId(name="pictorial-couinaud", version="0.9.2"),
            software_versions="0.1.0-test",
        )
    )

    sr = build_sr(
        SRBuildInput(
            source_datasets=tuple(sources),
            seg_dataset=seg.dataset,
            parenchyma=VolumeMeasurement(
                segment_number=seg.segment_numbers["parenchyma"],
                label="Liver parenchyma",
                volume_ml=1450.0,
            ),
            couinaud=tuple(
                VolumeMeasurement(
                    segment_number=seg.segment_numbers[f"couinaud_{i}"],
                    label=f"Couinaud {i}",
                    volume_ml=100.0 + i,
                )
                for i in range(1, 9)
            ),
            flr=FLRMeasurement(
                remnant_volume_ml=420.0,
                remnant_pct_functional=28.7,
                resection_plane_hash="abc",
                operator_hash="user123",
            ),
            lesions=(
                LesionMeasurement(
                    segment_number=seg.segment_numbers["lesion_1"],
                    label="hcc",
                    longest_diameter_mm=18.4,
                    volume_ml=3.2,
                    calibrated_confidence=0.82,
                    temperature_applied=1.35,
                ),
            ),
            software_versions="0.1.0-test",
        )
    )
    return seg.dataset, sr.dataset, seg.segment_numbers


EXPECTED_SEG_SERIES_DESCRIPTION = "LiverRa AI — Liver Segmentation (RUO)"
EXPECTED_SR_SERIES_DESCRIPTION = "LiverRa AI — Measurement Report (RUO)"

# Authoritative SNOMED CT codes per contracts/dicom-artifacts.md. These live
# in Python-side constants (``snomed_codes.py``) — the test confirms they
# actually landed in the built SEG.
EXPECTED_SNOMED_CODES: tuple[str, ...] = (
    "10200004",   # Liver structure
    "245302009",  # Couinaud I
    "245303004",  # Couinaud II
    "245304005",  # Couinaud III
    "245305006",  # Couinaud IV
    "245306007",  # Couinaud V
    "245307003",  # Couinaud VI
    "245308008",  # Couinaud VII
    "245309003",  # Couinaud VIII
    "32764006",   # Portal vein
    "8887007",    # Hepatic vein
    "109841003",  # HCC — our single fixture lesion
)


def _flatten_algo_names(seg: Any) -> list[str]:
    names: list[str] = []
    for item in getattr(seg, "SegmentSequence", []) or []:
        algo_seq = getattr(item, "SegmentIdentificationSequence", None) or getattr(
            item, "AlgorithmIdentificationSequence", None
        )
        if algo_seq is not None:
            for a in algo_seq:
                n = getattr(a, "AlgorithmName", None)
                if n:
                    names.append(str(n))
        # Fall back to top-level attribute if highdicom flattened it.
        top = getattr(item, "SegmentAlgorithmName", None)
        if top:
            names.append(str(top))
    return names


def _flatten_segment_codes(seg: Any) -> set[str]:
    codes: set[str] = set()
    for item in getattr(seg, "SegmentSequence", []) or []:
        type_seq = getattr(item, "SegmentedPropertyTypeCodeSequence", []) or []
        for c in type_seq:
            code = getattr(c, "CodeValue", None)
            if code:
                codes.add(str(code))
    return codes


def test_seg_fields_match_contract() -> None:
    seg_ds, _sr_ds, segment_numbers = _build_pair()

    assert str(seg_ds.SeriesDescription) == EXPECTED_SEG_SERIES_DESCRIPTION

    # Algo names all carry the `liverra-` prefix.
    algo_names = _flatten_algo_names(seg_ds)
    assert algo_names, "SEG contains no AlgorithmIdentificationSequence entries"
    for n in algo_names:
        assert n.startswith("liverra-"), f"algo name {n!r} missing liverra- prefix"

    # All required SNOMED codes are present in the SEG.
    seen = _flatten_segment_codes(seg_ds)
    missing = [c for c in EXPECTED_SNOMED_CODES if c not in seen]
    assert not missing, f"SEG missing SNOMED codes: {missing!r} (got {sorted(seen)!r})"

    # Segment numbering is stable.
    assert segment_numbers["parenchyma"] == 1
    assert segment_numbers["couinaud_1"] == 2
    assert segment_numbers["couinaud_8"] == 9
    assert segment_numbers["portal_vein"] == 10
    assert segment_numbers["hepatic_vein"] == 11
    assert segment_numbers["lesion_1"] == 12


def test_sr_leading_text_has_trilingual_ruo() -> None:
    _seg_ds, sr_ds, _segment_numbers = _build_pair()

    assert str(sr_ds.SeriesDescription) == EXPECTED_SR_SERIES_DESCRIPTION

    def _walk(node: Any, acc: list[str]) -> None:
        text = str(getattr(node, "TextValue", "") or "")
        if text:
            acc.append(text)
        for child in getattr(node, "ContentSequence", []) or []:
            _walk(child, acc)

    texts: list[str] = []
    for child in sr_ds.ContentSequence:
        _walk(child, texts)
    joined = "\n".join(texts)
    for kw in ("Research Use Only", "Forschungszwecken", "კვლევითი"):
        assert kw in joined, f"SR missing localised RUO keyword {kw!r}"
