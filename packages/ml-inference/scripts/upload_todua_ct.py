"""Convert the 4-phase todua-ct DICOM into NIfTI and upload to MinIO.

Maps the 4 clinical phases (non_contrast, arterial, portal_venous, delayed)
to the bucket layout the orchestrator expects:

    s3://liverra-phases-eu-central-1/studies/<study_id>/phases/<phase>.nii.gz

Phase selection heuristic — we pick the SeriesDescription that contains
each phase's keyword. The series with the most slices (ie thinnest cuts)
wins ties.
"""
from __future__ import annotations

import os
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import boto3
import numpy as np
import pydicom
import SimpleITK as sitk

ROOT = Path("/home/irakli/LiverRA/LiverRa/fixtures/dicom/todua-ct")
STUDY_ID = "00000000-0000-0000-0000-0000000000bb"
BUCKET = "liverra-phases-eu-central-1"

# Substring → phase. First match wins, scanned in this order.
PHASE_KEYWORDS: List[Tuple[str, str]] = [
    ("non contrast", "non_contrast"),
    ("non-contrast", "non_contrast"),
    ("arterial", "arterial"),
    ("venous", "portal_venous"),
    ("portal", "portal_venous"),
    ("late phase", "delayed"),
    ("delayed", "delayed"),
]


def classify_phase(description: str) -> str | None:
    desc = description.lower()
    for kw, phase in PHASE_KEYWORDS:
        if kw in desc:
            return phase
    return None


def main() -> int:
    print(f"Scanning {ROOT}…")
    files = sorted(ROOT.rglob("*.dcm"))
    print(f"  {len(files)} DICOM files total")

    # 1. Group files by SeriesInstanceUID and capture first SeriesDescription
    by_series: Dict[str, List[Path]] = defaultdict(list)
    descriptions: Dict[str, str] = {}
    for f in files:
        try:
            ds = pydicom.dcmread(str(f), stop_before_pixels=True)
        except Exception:
            continue
        suid = str(ds.get("SeriesInstanceUID", ""))
        if not suid:
            continue
        by_series[suid].append(f)
        descriptions.setdefault(suid, str(ds.get("SeriesDescription", "")))
    print(f"  {len(by_series)} unique series")

    # 2. Pick best series per target phase. Score = (matches phase keyword,
    #    largest slice count). Skip thoracic/monitoring/dose-report etc.
    phase_pick: Dict[str, Tuple[str, str, int]] = {}  # phase → (suid, desc, count)
    for suid, slices in by_series.items():
        desc = descriptions[suid]
        phase = classify_phase(desc)
        if phase is None:
            continue
        # Prefer series with more slices (= thinner cuts = better resolution)
        prior = phase_pick.get(phase)
        if prior is None or len(slices) > prior[2]:
            phase_pick[phase] = (suid, desc, len(slices))

    print("\nPhase selection:")
    for phase in ("non_contrast", "arterial", "portal_venous", "delayed"):
        if phase in phase_pick:
            suid, desc, n = phase_pick[phase]
            print(f"  {phase:14s} ← '{desc}'  ({n} slices)  [series ...{suid[-8:]}]")
        else:
            print(f"  {phase:14s} ← MISSING (will use zero-volume placeholder)")

    # 3. For each picked series, build a 3D volume via SimpleITK and upload
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "eu-central-1"))

    for phase in ("non_contrast", "arterial", "portal_venous", "delayed"):
        if phase not in phase_pick:
            print(f"\n[{phase}] uploading zero-volume placeholder")
            zero = np.zeros((64, 64, 32), dtype=np.float32)
            img = sitk.GetImageFromArray(zero)
            with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
                sitk.WriteImage(img, tf.name)
                key = f"studies/{STUDY_ID}/phases/{phase}.nii.gz"
                with open(tf.name, "rb") as fh:
                    s3.put_object(Bucket=BUCKET, Key=key, Body=fh.read())
            os.unlink(tf.name)
            continue

        suid, desc, count = phase_pick[phase]
        slice_paths = sorted(str(p) for p in by_series[suid])
        print(f"\n[{phase}] reading {count} slices from '{desc}'…")

        reader = sitk.ImageSeriesReader()
        # Use Sitk's GDCM-based UID-aware ordering when possible
        ordered = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(
            str(slice_paths[0].rsplit("/", 1)[0]), suid
        )
        if not ordered:
            ordered = slice_paths
        reader.SetFileNames(ordered)
        try:
            volume = reader.Execute()
        except Exception as exc:
            print(f"  !! SimpleITK read failed: {exc}")
            print(f"  fallback: stacking via pydicom pixel arrays")
            arrays = []
            for p in slice_paths:
                ds = pydicom.dcmread(p)
                arrays.append(ds.pixel_array)
            arr3d = np.stack(arrays, axis=0).astype(np.float32)
            volume = sitk.GetImageFromArray(arr3d)

        size = volume.GetSize()  # (X, Y, Z)
        spacing = volume.GetSpacing()
        print(f"  shape (X,Y,Z): {size}   spacing (mm): {tuple(round(s,2) for s in spacing)}")

        # Write to a temp file then upload (boto3 needs bytes)
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
            sitk.WriteImage(volume, tf.name)
            size_bytes = os.path.getsize(tf.name)
            print(f"  serialized: {size_bytes/1e6:.1f} MB")
            with open(tf.name, "rb") as fh:
                key = f"studies/{STUDY_ID}/phases/{phase}.nii.gz"
                s3.put_object(Bucket=BUCKET, Key=key, Body=fh.read())
        os.unlink(tf.name)
        print(f"  → uploaded s3://{BUCKET}/{key}")

    print("\n✓ ALL 4 PHASES UPLOADED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
