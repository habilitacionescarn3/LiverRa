"""Real-quality cascade — runs TotalSegmentator on the Todua CT.

Bypasses the stub Triton models with a pretrained, anatomically-correct
liver/vessels/tumor segmentation. Outputs land in the same MinIO paths and
Postgres rows as the regular Triton cascade, so show_results.py renders
correctly with no changes.

Usage:
    AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password \\
      AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1 \\
      python packages/ml-inference/scripts/real_cascade.py

License: TotalSegmentator code is Apache-2.0; weights are CC-BY-NC-SA-4.0.
**Internal demo only — not for clinical/commercial use.**
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

import boto3
import numpy as np
import psycopg
import SimpleITK as sitk
from totalsegmentator.python_api import totalsegmentator

# Heuristic Couinaud + segment-aware FLR
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # …/ml-inference/
from src.orchestrator.couinaud_heuristic import compute_couinaud
from src.orchestrator.flr_segment_aware import (
    RESECTION_PATTERNS,
    compute_flr as compute_segment_aware_flr,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
PHASES_BUCKET = "liverra-phases-eu-central-1"
ANALYSES_BUCKET = "liverra-analyses-eu-central-1"
STUDY_ID = "00000000-0000-0000-0000-0000000000bb"
TENANT_ID = "00000000-0000-0000-0000-000000000001"
TARGET_SHAPE = (128, 128, 128)  # match Triton parenchyma contract (Z, Y, X)

LICENSE_BANNER = (
    "[license] TotalSegmentator weights: CC-BY-NC-SA-4.0 — "
    "internal demo only, NOT for clinical or commercial use."
)


# ---------------------------------------------------------------------------
# IO helpers
# ---------------------------------------------------------------------------


def s3_client():
    return boto3.client(
        "s3", region_name=os.environ.get("AWS_REGION", "eu-central-1")
    )


def download_phase(study_id: str, phase: str, dest: Path) -> Path:
    """Download a phase NIfTI from MinIO to local disk. Idempotent."""
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return dest
    obj = s3_client().get_object(
        Bucket=PHASES_BUCKET,
        Key=f"studies/{study_id}/phases/{phase}.nii.gz",
    )
    dest.write_bytes(obj["Body"].read())
    return dest


def upload_nii(image: sitk.Image, key: str, bucket: str = ANALYSES_BUCKET) -> str:
    """Save a SimpleITK image and upload to MinIO. Returns s3:// URI."""
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
        path = tf.name
    try:
        sitk.WriteImage(image, path)
        with open(path, "rb") as fh:
            s3_client().put_object(Bucket=bucket, Key=key, Body=fh.read())
    finally:
        os.unlink(path)
    return f"s3://{bucket}/{key}"


def resample_mask_to(
    mask_image: sitk.Image, target_shape_zyx: tuple[int, int, int]
) -> sitk.Image:
    """Resample a binary mask to target_shape_zyx using nearest-neighbor."""
    # SimpleITK SetSize takes (X, Y, Z); our target is (Z, Y, X).
    z, y, x = target_shape_zyx
    out_size = [x, y, z]
    in_size = list(mask_image.GetSize())
    in_spacing = list(mask_image.GetSpacing())
    out_spacing = [
        in_size[i] * in_spacing[i] / out_size[i] for i in range(3)
    ]
    res = sitk.ResampleImageFilter()
    res.SetSize(out_size)
    res.SetOutputSpacing(out_spacing)
    res.SetOutputOrigin(mask_image.GetOrigin())
    res.SetOutputDirection(mask_image.GetDirection())
    res.SetInterpolator(sitk.sitkNearestNeighbor)
    res.SetDefaultPixelValue(0)
    return res.Execute(mask_image)


def voxel_volume_ml(image: sitk.Image) -> float:
    sx, sy, sz = image.GetSpacing()
    return (sx * sy * sz) / 1000.0  # mm³ → ml


def native_volume_ml(mask_image: sitk.Image) -> float:
    arr = sitk.GetArrayFromImage(mask_image)  # (Z, Y, X)
    return float((arr > 0).sum() * voxel_volume_ml(mask_image))


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------


def insert_checkpoint(
    conn,
    analysis_id: str,
    stage_no: int,
    stage: str,
    output_uri: str,
    model_version: str,
    license_hash: str = "n/a",
) -> None:
    conn.execute(
        """
        INSERT INTO pipeline_checkpoint
          (analysis_id, stage_no, stage, output_uri, model_version, model_license_hash)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (analysis_id, stage_no, stage, output_uri, model_version, license_hash),
    )


# ---------------------------------------------------------------------------
# FLR heuristic — replicates src/tasks/flr_default.py:_compute_default_plane
# ---------------------------------------------------------------------------


def axial_midpoint_flr(mask_zyx: np.ndarray) -> tuple[dict, int, int]:
    """Return (plane_pose, flr_voxels, total_voxels)."""
    coords = np.argwhere(mask_zyx > 0)
    if coords.size == 0:
        return ({"axis": "axial", "z_index": 0, "heuristic": "parenchyma_empty"}, 0, 0)
    z_min = int(coords[:, 0].min())
    z_max = int(coords[:, 0].max())
    z_plane = (z_min + z_max) // 2
    flr_mask = mask_zyx.copy()
    flr_mask[z_plane:, :, :] = 0
    return (
        {
            "axis": "axial",
            "z_index": z_plane,
            "bbox_z": [z_min, z_max],
            "heuristic": "axial_midpoint",
        },
        int(flr_mask.sum()),
        int(mask_zyx.sum()),
    )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--resection-pattern",
        choices=sorted(RESECTION_PATTERNS),
        default="right_hepatectomy",
        help="Hepatectomy pattern for the segment-aware FLR (default: right_hepatectomy).",
    )
    args = parser.parse_args()
    resection_pattern = args.resection_pattern

    print(LICENSE_BANNER)
    print(f"[config] resection_pattern={resection_pattern}")
    t0 = time.perf_counter()

    analysis_id = str(uuid.uuid4())
    print(f"\n[1/7] Create Analysis row")
    print(f"      analysis_id = {analysis_id}")
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO analysis (id, tenant_id, study_id, status, pipeline_version, started_at)
            VALUES (%s, %s, %s, 'running', %s, now())
            """,
            (analysis_id, TENANT_ID, STUDY_ID, "totalsegmentator-v2"),
        )
        # Stage 1 — anonymization passthrough (CT is already de-identified).
        insert_checkpoint(
            conn,
            analysis_id,
            1,
            "anonymization",
            f"s3://liverra-dev/anonymized/{STUDY_ID}.zip",
            "ctp+presidio@v1-passthrough",
        )
    print(f"      ✓ +{time.perf_counter()-t0:.2f}s")

    workdir = Path("/tmp/real_cascade") / analysis_id[:8]
    workdir.mkdir(parents=True, exist_ok=True)

    # ----------------------------------------------------------------------
    # Stage 2 — parenchyma (TotalSegmentator task=total, roi=liver)
    # ----------------------------------------------------------------------
    print(f"\n[2/7] Download portal_venous CT")
    ct_path = workdir / "portal_venous.nii.gz"
    download_phase(STUDY_ID, "portal_venous", ct_path)
    print(f"      {ct_path.name}  ({ct_path.stat().st_size/1e6:.1f} MB)  +{time.perf_counter()-t0:.2f}s")

    print(f"\n[3/7] TotalSegmentator (task=total, roi=liver,IVC,gallbladder)")
    seg_dir = workdir / "ts_total"
    seg_dir.mkdir(exist_ok=True)
    t_seg = time.perf_counter()
    totalsegmentator(
        input=str(ct_path),
        output=str(seg_dir),
        task="total",
        roi_subset=["liver", "inferior_vena_cava", "gallbladder"],
        device="gpu",
        ml=False,
        quiet=True,
    )
    liver_path = seg_dir / "liver.nii.gz"
    if not liver_path.exists():
        print(f"      !! expected {liver_path} not found", file=sys.stderr)
        return 1
    liver_native = sitk.ReadImage(str(liver_path))
    total_ml = native_volume_ml(liver_native)
    voxels = int((sitk.GetArrayFromImage(liver_native) > 0).sum())
    print(f"      ✓ {liver_path.name}  +{time.perf_counter()-t_seg:.1f}s")
    print(f"      total liver volume: {total_ml:,.1f} ml  ({voxels:,} voxels)")

    # Capture the new landmarks if TS produced them; fall back to None.
    ivc_path = seg_dir / "inferior_vena_cava.nii.gz"
    gb_path = seg_dir / "gallbladder.nii.gz"
    ivc_native = sitk.ReadImage(str(ivc_path)) if ivc_path.exists() else None
    gb_native = sitk.ReadImage(str(gb_path)) if gb_path.exists() else None
    if ivc_native is not None:
        print(f"      ✓ {ivc_path.name}  ({int((sitk.GetArrayFromImage(ivc_native)>0).sum()):,} voxels)")
    else:
        print(f"      ! {ivc_path.name} missing — caudate (segment I) will fall back to anatomical prior")
    if gb_native is not None:
        print(f"      ✓ {gb_path.name}  ({int((sitk.GetArrayFromImage(gb_native)>0).sum()):,} voxels)")
    else:
        print(f"      ! {gb_path.name} missing — Cantlie line will fall back to anatomical prior")

    print(f"\n[4/7] Resample liver mask → 128³ + upload")
    liver_128 = resample_mask_to(liver_native, TARGET_SHAPE)
    # Cast to UINT8 to match Triton's parenchyma OUTPUT__0 dtype contract.
    cast = sitk.CastImageFilter()
    cast.SetOutputPixelType(sitk.sitkUInt8)
    liver_128 = cast.Execute(liver_128)
    parenchyma_uri = upload_nii(
        liver_128, f"analyses/{analysis_id}/parenchyma_mask.nii.gz"
    )
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        insert_checkpoint(
            conn,
            analysis_id,
            2,
            "parenchyma",
            parenchyma_uri,
            "totalsegmentator-v2",
            license_hash="cc-by-nc-sa-4.0",
        )
    print(f"      ✓ {parenchyma_uri.split('/')[-1]}  +{time.perf_counter()-t0:.2f}s")

    # ----------------------------------------------------------------------
    # Stage 3 + 5 — vessels + lesion detection (TotalSegmentator task=liver_vessels)
    # ----------------------------------------------------------------------
    print(f"\n[5/7] TotalSegmentator (task=liver_vessels)")
    vessels_dir = workdir / "ts_vessels"
    vessels_dir.mkdir(exist_ok=True)
    t_lv = time.perf_counter()
    vessels_done = False
    portal_native = hepatic_native = tumor_native = None
    try:
        totalsegmentator(
            input=str(ct_path),
            output=str(vessels_dir),
            task="liver_vessels",
            device="gpu",
            ml=False,
            quiet=True,
        )
        # task=liver_vessels emits per-label NIfTIs:
        #   liver_vessels.nii.gz   (combined hepatic + portal vessel tree)
        #   liver_tumor.nii.gz     (tumor candidates)
        # Older TS versions used split files (portal_vein.nii.gz, hepatic_vein.nii.gz).
        # Probe for whichever is present.
        produced = sorted(p.name for p in vessels_dir.glob("*.nii.gz"))
        print(f"      produced: {', '.join(produced)}")
        if (vessels_dir / "liver_vessels.nii.gz").exists():
            portal_native = sitk.ReadImage(str(vessels_dir / "liver_vessels.nii.gz"))
        elif (vessels_dir / "portal_vein.nii.gz").exists():
            portal_native = sitk.ReadImage(str(vessels_dir / "portal_vein.nii.gz"))
        if (vessels_dir / "hepatic_vein.nii.gz").exists():
            hepatic_native = sitk.ReadImage(str(vessels_dir / "hepatic_vein.nii.gz"))
        if (vessels_dir / "liver_tumor.nii.gz").exists():
            tumor_native = sitk.ReadImage(str(vessels_dir / "liver_tumor.nii.gz"))
        vessels_done = portal_native is not None or hepatic_native is not None
        print(f"      ✓ +{time.perf_counter()-t_lv:.1f}s")
    except Exception as exc:
        print(f"      ! liver_vessels task failed: {exc}")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        if vessels_done:
            # Upload the (possibly combined) vessel mask.
            vessel_uri = upload_nii(
                portal_native if portal_native is not None else hepatic_native,
                f"analyses/{analysis_id}/vessels.nii.gz",
            )
            insert_checkpoint(
                conn,
                analysis_id,
                3,
                "vessels",
                vessel_uri,
                "totalsegmentator-v2-liver_vessels",
                license_hash="cc-by-nc-sa-4.0",
            )
            v_arr = sitk.GetArrayFromImage(portal_native if portal_native is not None else hepatic_native)
            v_voxels = int((v_arr > 0).sum())
            v_ml = v_voxels * voxel_volume_ml(portal_native if portal_native is not None else hepatic_native)
            print(f"      vessel tree volume: {v_ml:,.1f} ml  ({v_voxels:,} voxels)")
        else:
            insert_checkpoint(
                conn,
                analysis_id,
                3,
                "vessels",
                f"s3://liverra-dev/stub/{analysis_id}/vessels.nii.gz",
                "stub-vessels@v1",
                license_hash="n/a-dev-stub",
            )

        # Stage 4 — Couinaud (anatomical heuristic via Cantlie + portal
        # bifurcation; replaces the stub used in earlier sessions).
        print(f"\n[5b/7] Couinaud heuristic (Cantlie + portal bifurcation)")
        t_cou = time.perf_counter()
        liver_arr_native = sitk.GetArrayFromImage(liver_native).astype(np.uint8)
        ivc_arr = sitk.GetArrayFromImage(ivc_native).astype(np.uint8) if ivc_native is not None else None
        gb_arr = sitk.GetArrayFromImage(gb_native).astype(np.uint8) if gb_native is not None else None
        vessels_arr = None
        if vessels_done and (portal_native is not None or hepatic_native is not None):
            v_src = portal_native if portal_native is not None else hepatic_native
            vessels_arr = sitk.GetArrayFromImage(v_src).astype(np.uint8)
        sx, sy, sz = liver_native.GetSpacing()  # (X, Y, Z) in mm
        couinaud_native_arr = compute_couinaud(
            liver=liver_arr_native,
            ivc=ivc_arr,
            gallbladder=gb_arr,
            vessels=vessels_arr,
            voxel_spacing=(sx, sy, sz),
        )
        # Wrap as a SimpleITK image at native CT geometry so the resample
        # below + the show_results.py renderer can handle it.
        couinaud_native = sitk.GetImageFromArray(couinaud_native_arr)
        couinaud_native.CopyInformation(liver_native)
        # Resample to 128³ NEAREST_NEIGHBOR for the downstream contract.
        couinaud_128 = resample_mask_to(couinaud_native, TARGET_SHAPE)
        cast_u8 = sitk.CastImageFilter()
        cast_u8.SetOutputPixelType(sitk.sitkUInt8)
        couinaud_128 = cast_u8.Execute(couinaud_128)
        couinaud_uri = upload_nii(
            couinaud_128, f"analyses/{analysis_id}/couinaud.nii.gz"
        )
        insert_checkpoint(
            conn,
            analysis_id,
            4,
            "couinaud",
            couinaud_uri,
            "couinaud-heuristic-v1",
            license_hash="n/a-heuristic",
        )
        # Print per-segment voxel counts (sanity)
        per_seg_v = {sid: int((couinaud_native_arr == sid).sum()) for sid in range(1, 9)}
        voxel_ml_native = float(np.prod(liver_native.GetSpacing())) / 1000.0
        per_seg_ml = {sid: round(per_seg_v[sid] * voxel_ml_native, 1) for sid in per_seg_v}
        print(f"      ✓ {couinaud_uri.split('/')[-1]}  +{time.perf_counter()-t_cou:.2f}s")
        seg_str = "  ".join(
            f"{name}={per_seg_ml[i]}ml"
            for i, name in zip(range(1, 9), ["I","II","III","IV","V","VI","VII","VIII"])
        )
        print(f"      per-segment: {seg_str}")

    # Stage 5 — lesion detection from liver_tumor mask.
    lesion_count = 0
    lesion_volumes_ml: list[float] = []
    if tumor_native is not None:
        t_arr = sitk.GetArrayFromImage(tumor_native)
        if t_arr.sum() > 0:
            from scipy.ndimage import label as cc_label
            labeled, lesion_count = cc_label(t_arr > 0)
            voxel_ml = voxel_volume_ml(tumor_native)
            for lid in range(1, lesion_count + 1):
                lesion_volumes_ml.append(float((labeled == lid).sum() * voxel_ml))
    print(f"\n[6/7] Lesion detection: {lesion_count} candidate(s)")
    for i, v in enumerate(lesion_volumes_ml, 1):
        print(f"      lesion {i}: {v:.2f} ml")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        insert_checkpoint(
            conn,
            analysis_id,
            5,
            "lesion_detection",
            f"s3://liverra-analyses-eu-central-1/analyses/{analysis_id}/lesions/",
            "totalsegmentator-v2-liver_vessels"
            if tumor_native is not None
            else "stub-no-tumor",
            license_hash="cc-by-nc-sa-4.0" if tumor_native is not None else "n/a-dev-stub",
        )

    # ----------------------------------------------------------------------
    # Stage 7 — FLR (segment-aware: total minus segments removed by the
    # selected resection pattern, computed on the native-res Couinaud mask)
    # ----------------------------------------------------------------------
    print(f"\n[7/7] FLR (segment-aware: pattern={resection_pattern})")
    plane, flr_ml, total_ml_seg = compute_segment_aware_flr(
        couinaud_native_arr, voxel_ml_native, pattern=resection_pattern
    )
    flr_pct = (flr_ml / total_ml_seg * 100.0) if total_ml_seg > 0 else 0.0
    # Use TS's native-res total volume for display (more accurate than the
    # sum-of-segments which can be slightly different due to rounding +
    # caudate carve-out)
    print(f"      total: {total_ml:,.1f} ml  |  FLR: {flr_ml:,.1f} ml  ({flr_pct:.1f} %)")
    print(f"      pattern: {resection_pattern}")
    print(f"      removed segments: {plane['removed_segments']}")
    print(f"      remnant segments: {plane['remnant_segments']}")

    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO flr_calculation
              (analysis_id, plane_pose, total_ml, flr_ml, flr_pct, computed_at)
            VALUES (%s, %s::jsonb, %s, %s, %s, now())
            """,
            (
                analysis_id,
                json.dumps(plane),
                round(total_ml, 2),
                round(flr_ml, 2),
                round(flr_pct, 2),
            ),
        )
        insert_checkpoint(
            conn,
            analysis_id,
            7,
            "flr_init",
            f"flr://analyses/{analysis_id}",
            f"flr-segment-aware-{resection_pattern}@v1",
            license_hash="n/a-heuristic",
        )
        # Mark Analysis completed.
        conn.execute(
            "UPDATE analysis SET status='completed', completed_at=now() WHERE id=%s",
            (analysis_id,),
        )

    print(f"\n=== DONE in {time.perf_counter()-t0:.1f}s ===")
    print(f"  analysis_id: {analysis_id}")
    print(f"  Inspect: python packages/ml-inference/scripts/show_results.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
