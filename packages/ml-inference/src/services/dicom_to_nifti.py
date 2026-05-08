# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""DICOM → NIfTI conversion + MinIO staging.

Plain-English: when a clinician clicks "Run AI" on a study sitting on
local Orthanc, the cascade pipeline expects 4-phase NIfTI volumes at
specific S3 keys (`studies/{study_id}/phases/{phase}.nii.gz`). This
service does the conversion:

  1. Fetch all DICOM instances for a study from Orthanc (DICOMweb WADO-RS)
  2. Group by SeriesInstanceUID
  3. Convert each series to a NIfTI volume via SimpleITK
  4. Detect contrast phase from SeriesDescription / AcquisitionTime
  5. Upload NIfTI to MinIO at the cascade's expected key
  6. Update study.phase_coverage so the orchestrator knows what's available

Phase detection is best-effort. When SeriesDescription contains
"arterial" / "art" → arterial phase, "portal" / "pv" / "venous" →
portal_venous, "delayed" / "5min" / "15min" → delayed, "non" / "plain"
/ "pre" → non_contrast. Unmatched series default to "arterial" so the
parenchyma stage always has at least one input.

Failure modes are non-fatal: if conversion fails, we log a warning
and let the cascade fail at parenchyma with a clear error_slug. We
never silently corrupt the cascade input.
"""
from __future__ import annotations

import io
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Optional
from uuid import UUID

import boto3
import httpx
import SimpleITK as sitk

logger = logging.getLogger(__name__)


ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://localhost:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASSWORD = os.environ.get("ORTHANC_PASSWORD", "orthanc")

PHASES_BUCKET = os.environ.get("S3_PHASES_BUCKET", "liverra-phases-eu-central-1")

# Match patterns for phase detection (case-insensitive).
PHASE_PATTERNS: dict[str, list[str]] = {
    "arterial": [r"\barter", r"\bart\b", r"\b25s\b", r"\b30s\b"],
    "portal_venous": [r"\bportal", r"\bpv\b", r"\bvenous", r"\b60s\b", r"\b70s\b"],
    "delayed": [r"\bdelay", r"\blate\b", r"\b3min\b", r"\b5min\b", r"\b15min\b"],
    "non_contrast": [r"\bnon[- ]?contrast", r"\bplain\b", r"\bpre[- ]?contrast"],
}


def _detect_phase(series_description: str) -> str | None:
    """Phase detection from SeriesDescription. Returns None if no
    phase keyword matches — caller should SKIP unrecognised series
    rather than dump them into the arterial slot, which used to claim
    the slot before the real arterial-phase series got processed
    (e.g. junk "Patient Protocol" 2-slice scout series displacing the
    actual 600-slice "Arterial Phase" series in iteration order).
    """
    if not series_description:
        return None
    desc = series_description.lower()
    for phase, patterns in PHASE_PATTERNS.items():
        for pat in patterns:
            if re.search(pat, desc):
                return phase
    return None


def _orthanc_get_json(path: str) -> dict | list:
    """GET against Orthanc REST API, returns parsed JSON."""
    auth = (ORTHANC_USER, ORTHANC_PASSWORD)
    with httpx.Client(timeout=30) as client:
        r = client.get(f"{ORTHANC_URL}{path}", auth=auth)
        r.raise_for_status()
        return r.json()


def _orthanc_get_bytes(path: str) -> bytes:
    auth = (ORTHANC_USER, ORTHANC_PASSWORD)
    with httpx.Client(timeout=60) as client:
        r = client.get(f"{ORTHANC_URL}{path}", auth=auth)
        r.raise_for_status()
        return r.content


def _find_orthanc_study_by_uid(study_instance_uid: str) -> Optional[str]:
    """Resolve a DICOM StudyInstanceUID → Orthanc internal study ID."""
    payload = {"Level": "Study", "Query": {"StudyInstanceUID": study_instance_uid}}
    auth = (ORTHANC_USER, ORTHANC_PASSWORD)
    with httpx.Client(timeout=30) as client:
        r = client.post(f"{ORTHANC_URL}/tools/find", json=payload, auth=auth)
        r.raise_for_status()
        ids = r.json()
        return ids[0] if ids else None


def _series_to_nifti(orthanc_series_id: str) -> Optional[bytes]:
    """Pull all DICOMs for a series, write NIfTI bytes via SimpleITK."""
    instance_ids = _orthanc_get_json(f"/series/{orthanc_series_id}/instances")
    if not isinstance(instance_ids, list) or not instance_ids:
        return None

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        for inst in instance_ids:
            inst_id = inst["ID"] if isinstance(inst, dict) else inst
            data = _orthanc_get_bytes(f"/instances/{inst_id}/file")
            (tmp_path / f"{inst_id}.dcm").write_bytes(data)

        # SimpleITK reads a DICOM series and emits a single 3D volume.
        reader = sitk.ImageSeriesReader()
        try:
            dicom_names = reader.GetGDCMSeriesFileNames(str(tmp_path))
        except RuntimeError as e:
            logger.warning("ImageSeriesReader failed: %s", e)
            return None
        if not dicom_names:
            return None
        reader.SetFileNames(dicom_names)
        try:
            volume = reader.Execute()
        except RuntimeError as e:
            logger.warning("SimpleITK execute failed: %s", e)
            return None

        # Write as compressed NIfTI to a temp file, then return bytes.
        out_path = tmp_path / "volume.nii.gz"
        sitk.WriteImage(volume, str(out_path), useCompression=True)
        return out_path.read_bytes()


def _s3_client():
    """Return a boto3 S3 client pointing at MinIO."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT_URL", "http://localhost:9000"),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "minioadmin"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "minioadmin"),
        region_name=os.environ.get("AWS_REGION", "eu-central-1"),
    )


def _ensure_bucket(s3, bucket: str) -> None:
    try:
        s3.head_bucket(Bucket=bucket)
    except Exception:  # noqa: BLE001
        try:
            s3.create_bucket(Bucket=bucket)
            logger.info("Created MinIO bucket %s", bucket)
        except Exception as e:  # noqa: BLE001
            logger.warning("Bucket create skipped: %s", e)


def stage_orthanc_study_to_minio(
    study_instance_uid: str, study_id: UUID,
) -> dict[str, str]:
    """Convert all series of an Orthanc study to NIfTI + upload to MinIO.

    Returns ``{phase: s3_key, ...}`` for every successfully converted series.
    The caller writes these into ``study.phase_coverage`` so the cascade
    knows what to read.
    """
    orthanc_study_id = _find_orthanc_study_by_uid(study_instance_uid)
    if not orthanc_study_id:
        logger.warning("Orthanc study not found for UID %s", study_instance_uid)
        return {}

    study_meta = _orthanc_get_json(f"/studies/{orthanc_study_id}")
    if not isinstance(study_meta, dict):
        return {}
    series_ids = study_meta.get("Series", [])

    s3 = _s3_client()
    _ensure_bucket(s3, PHASES_BUCKET)

    staged: dict[str, str] = {}
    for series_id in series_ids:
        try:
            series_meta = _orthanc_get_json(f"/series/{series_id}")
            if not isinstance(series_meta, dict):
                continue
            tags = series_meta.get("MainDicomTags", {})
            description = tags.get("SeriesDescription", "") or ""
            phase = _detect_phase(description)

            # Skip series that don't match a known phase keyword (e.g.
            # "Patient Protocol", "Dose Report", "Topogram") — they
            # used to claim the arterial slot via the old default and
            # block the real arterial series from being staged.
            if phase is None:
                logger.info(
                    "Skipping unrecognised series description=%s", description,
                )
                continue

            # Skip duplicate phases (only stage one series per phase).
            if phase in staged:
                continue

            nifti_bytes = _series_to_nifti(series_id)
            if not nifti_bytes:
                continue

            key = f"studies/{study_id}/phases/{phase}.nii.gz"
            s3.put_object(
                Bucket=PHASES_BUCKET,
                Key=key,
                Body=io.BytesIO(nifti_bytes),
                ContentType="application/octet-stream",
            )
            staged[phase] = f"s3://{PHASES_BUCKET}/{key}"
            logger.info(
                "Staged phase=%s description=%s → s3://%s/%s",
                phase, description, PHASES_BUCKET, key,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to stage series %s: %s", series_id, e)
            continue

    return staged


__all__ = ["stage_orthanc_study_to_minio", "_detect_phase"]
