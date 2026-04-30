"""Pull cascade results from Postgres + MinIO and render a quick visual review.

For the most-recent Analysis row:
  1. Print all DB rows (analysis, pipeline_checkpoint, flr_calculation).
  2. Download the parenchyma mask + a CT phase from MinIO.
  3. Render axial/coronal/sagittal middle-slice overlays as a PNG.
  4. Print where to open everything in 3D Slicer for interactive review.

Usage:
    python packages/ml-inference/scripts/show_results.py [output.png]
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path

import boto3
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np
import psycopg
import SimpleITK as sitk

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
PHASES_BUCKET = "liverra-phases-eu-central-1"
ANALYSES_BUCKET = "liverra-analyses-eu-central-1"
STUDY_ID = "00000000-0000-0000-0000-0000000000bb"
OUT_PNG = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tmp/cascade_review.png")


def download_nii(bucket: str, key: str) -> np.ndarray:
    s3 = boto3.client("s3", region_name="eu-central-1")
    obj = s3.get_object(Bucket=bucket, Key=key)
    raw = obj["Body"].read()
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tf:
        tf.write(raw)
        path = tf.name
    img = sitk.ReadImage(path)
    os.unlink(path)
    return sitk.GetArrayFromImage(img)


def main() -> int:
    # 1. DB rows
    with psycopg.connect(DB_URL) as conn:
        conn.autocommit = True
        analysis = conn.execute(
            """
            SELECT id, status, started_at, queued_at
            FROM analysis
            ORDER BY queued_at DESC
            LIMIT 1
            """
        ).fetchone()
        if not analysis:
            print("No Analysis row found. Trigger the cascade first.")
            return 1
        aid, status, started, queued = analysis
        print("=== Analysis ===")
        print(f"  id:        {aid}")
        print(f"  status:    {status}")
        print(f"  queued:    {queued}")
        print(f"  started:   {started}")

        ckpts = conn.execute(
            """
            SELECT stage_no, stage, model_version, written_at, output_uri
            FROM pipeline_checkpoint
            WHERE analysis_id = %s
            ORDER BY stage_no
            """,
            (aid,),
        ).fetchall()
        print("\n=== Pipeline checkpoints ===")
        for sn, st, mv, wt, uri in ckpts:
            dt = (wt - started).total_seconds()
            print(f"  {sn}. {st:<18} +{dt:>5.2f}s  {mv:<32} {uri}")

        flr = conn.execute(
            """
            SELECT total_ml, flr_ml, flr_pct, plane_pose, computed_at
            FROM flr_calculation
            WHERE analysis_id = %s
            """,
            (aid,),
        ).fetchone()
        if flr:
            total, flr_ml, pct, pose, when = flr
            print("\n=== FLR result ===")
            print(f"  total liver volume:    {total} ml")
            print(f"  future liver remnant:  {flr_ml} ml ({pct} %)")
            print(f"  plane pose:            {pose}")

    # 2. Download parenchyma mask + portal_venous CT for overlay
    print("\n=== Downloading masks for visualization ===")
    print("  parenchyma mask…")
    mask = download_nii(
        ANALYSES_BUCKET, f"analyses/{aid}/parenchyma_mask.nii.gz"
    )
    print(f"  mask shape (Z,Y,X): {mask.shape}, nonzero: {(mask>0).sum():,}")

    print("  portal_venous CT…")
    ct = download_nii(PHASES_BUCKET, f"studies/{STUDY_ID}/phases/portal_venous.nii.gz")
    print(f"  CT shape (Z,Y,X): {ct.shape}")

    # The mask is 128³ (Triton's contract); the CT is 512×512×~600. Resample
    # the CT to the mask's shape so they overlay 1:1 in the figure.
    print("  resampling CT to mask grid…")
    from scipy.ndimage import zoom
    z = tuple(m / c for m, c in zip(mask.shape, ct.shape))
    ct_small = zoom(ct.astype(np.float32), z, order=1)
    print(f"  CT resampled: {ct_small.shape}")

    # Window the CT to soft-tissue range for display
    ct_disp = np.clip(ct_small, -150, 250)
    ct_disp = (ct_disp + 150) / 400.0  # → [0,1]

    # 3. Three-pane PNG: axial / coronal / sagittal middle slices
    print(f"\n=== Rendering {OUT_PNG} ===")
    # Read parenchyma model_version so we can label the figure as "real" vs "stub".
    parenchyma_mv = ""
    for sn, st, mv, _wt, _uri in ckpts:
        if st == "parenchyma":
            parenchyma_mv = mv or ""
            break
    if parenchyma_mv.startswith("totalsegmentator"):
        quality_label = f"✓ Real liver segmentation ({parenchyma_mv})"
        title_color = "darkgreen"
    elif parenchyma_mv.startswith("stub"):
        quality_label = f"⚠ Stub model output ({parenchyma_mv}) — not anatomical"
        title_color = "darkred"
    else:
        quality_label = parenchyma_mv or "unknown model"
        title_color = "black"

    fig, axes = plt.subplots(2, 3, figsize=(13, 8))
    fig.suptitle(
        f"LiverRa cascade — {aid}\n"
        f"{quality_label}  |  total {flr[0] if flr else '?'} ml  "
        f"|  FLR {flr[1] if flr else '?'} ml ({flr[2] if flr else '?'} %)",
        fontsize=11,
        color=title_color,
    )

    # Choose middle slice from the MASK BOUNDING BOX, not the volume midpoint
    # — otherwise the axial slice lands wherever Z=64 of 128 happens to fall
    # (typically lower abdomen / pelvis), not in the liver.
    nz = np.argwhere(mask > 0)
    if nz.size:
        z_mid = int((nz[:, 0].min() + nz[:, 0].max()) // 2)
        y_mid = int((nz[:, 1].min() + nz[:, 1].max()) // 2)
        x_mid = int((nz[:, 2].min() + nz[:, 2].max()) // 2)
    else:
        z_mid = mask.shape[0] // 2
        y_mid = mask.shape[1] // 2
        x_mid = mask.shape[2] // 2
    views = [
        ("axial", ct_disp[z_mid, :, :], mask[z_mid, :, :]),
        ("coronal", ct_disp[:, y_mid, :], mask[:, y_mid, :]),
        ("sagittal", ct_disp[:, :, x_mid], mask[:, :, x_mid]),
    ]
    for col, (title, ct_slice, mask_slice) in enumerate(views):
        # CT alone
        axes[0, col].imshow(ct_slice, cmap="gray", origin="lower")
        axes[0, col].set_title(f"{title} CT (portal_venous)")
        axes[0, col].axis("off")
        # CT + mask overlay
        axes[1, col].imshow(ct_slice, cmap="gray", origin="lower")
        axes[1, col].imshow(
            np.ma.masked_where(mask_slice == 0, mask_slice),
            cmap="autumn",
            alpha=0.45,
            origin="lower",
        )
        axes[1, col].set_title(f"{title} + parenchyma mask")
        axes[1, col].axis("off")

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    plt.tight_layout()
    plt.savefig(OUT_PNG, dpi=120)
    plt.close()
    print(f"  ✓ wrote {OUT_PNG} ({OUT_PNG.stat().st_size:,} B)")

    print("\n=== How to interactively review ===")
    print("  Open in 3D Slicer (https://www.slicer.org):")
    print(f"    1. Download CT phase: ")
    print(f"       AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password \\")
    print(f"         AWS_ENDPOINT_URL=http://localhost:9000 aws s3 cp \\")
    print(f"         s3://{PHASES_BUCKET}/studies/{STUDY_ID}/phases/portal_venous.nii.gz \\")
    print(f"         /tmp/ct.nii.gz --endpoint-url http://localhost:9000")
    print(f"    2. Download mask:")
    print(f"       (same command for s3://{ANALYSES_BUCKET}/analyses/{aid}/parenchyma_mask.nii.gz)")
    print(f"    3. Open both in Slicer; the mask overlays the CT.")
    print()
    print(f"  Or just open: {OUT_PNG.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
