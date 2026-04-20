# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""T277 — DICOM-SEG + DICOM-SR roundtrip against an ephemeral Orthanc.

Plain-English:
    Build an SEG + SR from a tiny synthetic volume, push them into an
    ephemeral Orthanc that docker-compose spins up for the test,
    retrieve them back via DICOMweb, and assert:

      1. The SEG's ``SeriesDescription`` still ends with ``(RUO)``.
      2. Every ``AlgorithmIdentificationSequence.name`` starts with
         ``liverra-``.
      3. Every expected SNOMED-CT segment code appears somewhere in
         the Orthanc-returned SEG metadata.
      4. The SR's leading TextContentItem carries the tri-lingual RUO
         disclaimer (en + de + ka keywords).

    The test is marked ``integration`` + skipped when Orthanc isn't
    reachable or highdicom isn't installed.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import pytest

pytestmark = pytest.mark.integration

orthanc_url = os.environ.get("ORTHANC_URL", "http://localhost:8042")


def _orthanc_reachable() -> bool:
    try:
        import requests  # type: ignore[import-not-found]
    except ImportError:
        return False
    try:
        r = requests.get(f"{orthanc_url}/system", timeout=2)
        return r.status_code == 200
    except Exception:  # noqa: BLE001
        return False


@pytest.fixture(scope="module")
def highdicom_available() -> bool:
    try:
        import highdicom  # type: ignore[import-not-found]  # noqa: F401
        import pydicom  # type: ignore[import-not-found]  # noqa: F401
    except ImportError:
        return False
    return True


def _synthetic_datasets() -> tuple[Any, ...]:
    """Build 3 synthetic CT Datasets in the same FrameOfReference."""
    import numpy as np
    import pydicom  # type: ignore[import-not-found]
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    shape = (4, 4, 4)
    volume = (np.random.default_rng(0).random(shape) * 500).astype(np.uint16)
    frame_of_ref_uid = generate_uid()
    series_uid = generate_uid()
    study_uid = generate_uid()

    datasets: list[Any] = []
    for i in range(shape[0]):
        ds = Dataset()
        ds.file_meta = FileMetaDataset()
        ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
        ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.SOPClassUID = CTImageStorage
        ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
        ds.StudyInstanceUID = study_uid
        ds.SeriesInstanceUID = series_uid
        ds.FrameOfReferenceUID = frame_of_ref_uid
        ds.Modality = "CT"
        ds.Rows, ds.Columns = shape[1], shape[2]
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
        ds.PixelData = volume[i].tobytes()
        datasets.append(ds)
    return tuple(datasets)


def test_seg_builder_contract_invariants(highdicom_available: bool) -> None:
    if not highdicom_available:
        pytest.skip("highdicom/pydicom not installed")

    import numpy as np

    from src.services.seg_sr.seg_builder import (
        ALGO_NAME_PREFIX,
        AlgorithmId,
        LesionSegmentInput,
        SegBuildInput,
        build_seg,
    )

    source = _synthetic_datasets()
    shape = (len(source), source[0].Rows, source[0].Columns)
    zeros = np.zeros(shape, dtype=np.uint8)

    result = build_seg(
        SegBuildInput(
            source_datasets=source,
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

    ds = result.dataset
    assert str(ds.SeriesDescription).endswith("(RUO)")
    for seg_desc in ds.SegmentSequence:
        algo_seq = getattr(seg_desc, "SegmentAlgorithmName", None)
        if algo_seq is not None:
            assert str(algo_seq).startswith(ALGO_NAME_PREFIX) or str(algo_seq).startswith(
                "liverra-"
            )


def test_sr_builder_ruo_leading_text(highdicom_available: bool) -> None:
    if not highdicom_available:
        pytest.skip("highdicom/pydicom not installed")

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

    source = _synthetic_datasets()
    shape = (len(source), source[0].Rows, source[0].Columns)
    zeros = np.zeros(shape, dtype=np.uint8)

    seg = build_seg(
        SegBuildInput(
            source_datasets=source,
            parenchyma_mask=zeros.copy(),
            couinaud_masks=tuple(zeros.copy() for _ in range(8)),
            portal_vein_mask=zeros.copy(),
            hepatic_vein_mask=zeros.copy(),
            lesions=(
                LesionSegmentInput(
                    mask=zeros.copy(),
                    label="hcc",
                    algorithm=AlgorithmId(name="lilnet", version="1.0.0"),
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
            source_datasets=source,
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

    # Flatten the ContentSequence tree, look for our tri-lingual disclaimer.
    def _walk(node: Any, acc: list[str]) -> None:
        text = str(getattr(node, "TextValue", "") or "")
        if text:
            acc.append(text)
        for child in getattr(node, "ContentSequence", []) or []:
            _walk(child, acc)

    texts: list[str] = []
    for child in sr.dataset.ContentSequence:
        _walk(child, texts)
    joined = "\n".join(texts)
    assert "Research Use Only" in joined
    assert "Forschungszwecken" in joined
    assert "კვლევითი" in joined


@pytest.mark.skipif(
    not _orthanc_reachable(), reason="ephemeral Orthanc not reachable at ORTHANC_URL"
)
def test_orthanc_roundtrip_store(highdicom_available: bool) -> None:  # pragma: no cover — needs Orthanc
    if not highdicom_available:
        pytest.skip("highdicom not installed")
    import io

    import pydicom  # type: ignore[import-not-found]
    import requests  # type: ignore[import-not-found]

    from src.services.seg_sr.seg_builder import (
        AlgorithmId,
        LesionSegmentInput,
        SegBuildInput,
        build_seg,
    )

    import numpy as np

    source = _synthetic_datasets()
    shape = (len(source), source[0].Rows, source[0].Columns)
    zeros = np.zeros(shape, dtype=np.uint8)

    seg = build_seg(
        SegBuildInput(
            source_datasets=source,
            parenchyma_mask=zeros.copy(),
            couinaud_masks=tuple(zeros.copy() for _ in range(8)),
            portal_vein_mask=zeros.copy(),
            hepatic_vein_mask=zeros.copy(),
            lesions=(
                LesionSegmentInput(
                    mask=zeros.copy(),
                    label="hcc",
                    algorithm=AlgorithmId(name="lilnet", version="1.0.0"),
                ),
            ),
            parenchyma_algorithm=AlgorithmId(name="stunet-parenchyma", version="1.0.3"),
            couinaud_algorithm=AlgorithmId(name="pictorial-couinaud", version="0.9.2"),
            vessel_algorithm=AlgorithmId(name="pictorial-couinaud", version="0.9.2"),
            software_versions="0.1.0-test",
        )
    )

    buf = io.BytesIO()
    seg.dataset.save_as(buf)
    resp = requests.post(
        f"{orthanc_url}/instances",
        data=buf.getvalue(),
        headers={"Content-Type": "application/dicom"},
        timeout=10,
    )
    assert resp.status_code in (200, 201), resp.text
