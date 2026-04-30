"""Multi-slice QC review for the most recent real_cascade run.

Renders a montage at NATIVE CT resolution (not the 128³ Triton-contract
mask) so a radiologist can scroll-equivalent through the liver:

  - 9 axial slices evenly spaced through the liver mask's Z bounding box
  - 3 coronal slices (anterior / mid / posterior of the liver)
  - 3 sagittal slices (right / mid / left of the liver)
  - Mask rendered as a red CONTOUR (boundary outline), not a solid fill,
    so the underlying CT remains visible at the mask edge
  - Per-Z voxel-count sparkline at the bottom — flat, smooth curves
    indicate continuous segmentation; spikes/dropouts indicate slice
    misses or vessel-leak artifacts
  - Vessel and tumor contours optionally overlaid in distinct colors

Usage:
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_ENDPOINT_URL=... \\
      python packages/ml-inference/scripts/qc_review.py [out.png]

Reads files from /tmp/real_cascade/<aid_prefix>/ which the most recent
real_cascade.py run leaves intact. If those are missing, falls back to
downloading the 128³ resampled mask from MinIO (lower QC fidelity).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import psycopg
import SimpleITK as sitk

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
WORKDIR_ROOT = Path("/tmp/real_cascade")
OUT_PNG = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    "/home/irakli/LiverRA/LiverRa/tmp/qc_review.png"
)


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------


def _latest_analysis_id() -> str | None:
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        row = conn.execute(
            "SELECT id FROM analysis ORDER BY queued_at DESC LIMIT 1"
        ).fetchone()
    return str(row[0]) if row else None


def _latest_flr() -> tuple[float, float, float] | None:
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        row = conn.execute(
            """
            SELECT total_ml, flr_ml, flr_pct FROM flr_calculation
            WHERE analysis_id = (SELECT id FROM analysis ORDER BY queued_at DESC LIMIT 1)
            """
        ).fetchone()
    if not row:
        return None
    return float(row[0]), float(row[1]), float(row[2])


def _load_native(aid_prefix: str) -> tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None, sitk.Image]:
    """Return (ct, liver_mask, vessels_mask_or_None, tumor_mask_or_None, sitk_image_for_spacing)."""
    base = WORKDIR_ROOT / aid_prefix
    ct_img = sitk.ReadImage(str(base / "portal_venous.nii.gz"))
    liver_img = sitk.ReadImage(str(base / "ts_total/liver.nii.gz"))
    ct = sitk.GetArrayFromImage(ct_img)  # (Z, Y, X)
    liver = sitk.GetArrayFromImage(liver_img).astype(np.uint8)
    vessels = None
    tumor = None
    vp = base / "ts_vessels/liver_vessels.nii.gz"
    tp = base / "ts_vessels/liver_tumor.nii.gz"
    if vp.exists():
        vessels = sitk.GetArrayFromImage(sitk.ReadImage(str(vp))).astype(np.uint8)
    if tp.exists():
        tumor = sitk.GetArrayFromImage(sitk.ReadImage(str(tp))).astype(np.uint8)
    return ct, liver, vessels, tumor, ct_img


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _bbox(mask: np.ndarray) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    """Return ((z_min, z_max), (y_min, y_max), (x_min, x_max)) of nonzero voxels."""
    nz = np.argwhere(mask > 0)
    if nz.size == 0:
        s = mask.shape
        return (0, s[0] - 1), (0, s[1] - 1), (0, s[2] - 1)
    return (
        (int(nz[:, 0].min()), int(nz[:, 0].max())),
        (int(nz[:, 1].min()), int(nz[:, 1].max())),
        (int(nz[:, 2].min()), int(nz[:, 2].max())),
    )


def _window(slice_arr: np.ndarray, lo: float = -150, hi: float = 250) -> np.ndarray:
    """Soft-tissue HU window → [0, 1] grayscale."""
    return np.clip((slice_arr - lo) / (hi - lo), 0, 1)


def _draw_panel(ax, ct_slice: np.ndarray, masks: list[tuple[np.ndarray, str]], title: str) -> None:
    """One CT slice + contour overlays."""
    ax.imshow(_window(ct_slice), cmap="gray", origin="lower")
    for mask_slice, color in masks:
        if mask_slice is None or mask_slice.sum() == 0:
            continue
        ax.contour(mask_slice, levels=[0.5], colors=[color], linewidths=1.0)
    ax.set_title(title, fontsize=8)
    ax.axis("off")


def main() -> int:
    aid = _latest_analysis_id()
    if aid is None:
        print("No analysis row found.", file=sys.stderr)
        return 1
    aid_prefix = aid[:8]
    print(f"=== QC review for analysis {aid} ===")

    base = WORKDIR_ROOT / aid_prefix
    if not (base / "portal_venous.nii.gz").exists():
        print(
            f"!! native CT not found at {base/'portal_venous.nii.gz'}.\n"
            f"   Re-run real_cascade.py to populate this directory."
        )
        return 1

    ct, liver, vessels, tumor, ct_img = _load_native(aid_prefix)
    print(f"  CT shape:    {ct.shape}   spacing (X,Y,Z): {tuple(round(s,2) for s in ct_img.GetSpacing())}")
    print(f"  liver mask:  {liver.shape}   nonzero: {(liver>0).sum():,}")
    if vessels is not None:
        # Filter vessels to those inside the liver mask (TS's liver_vessels can leak)
        vessels_inside = (vessels > 0) & (liver > 0)
        v_inside = int(vessels_inside.sum())
        v_total = int((vessels > 0).sum())
        v_contain_pct = (100.0 * v_inside / v_total) if v_total else 0.0
        print(f"  vessels:     {v_total:,} total / {v_inside:,} inside liver ({v_contain_pct:.1f} %)")
        vessels = vessels_inside.astype(np.uint8)
    if tumor is not None:
        # Critical QC step — TS's liver_tumor task is known to fire on
        # non-liver structures (especially dense GI contents, spleen,
        # vessel artifacts). Split into "contained" (real candidates) and
        # "external" (false positives outside the liver bbox).
        tumor_inside = (tumor > 0) & (liver > 0)
        tumor_outside = (tumor > 0) & (liver == 0)
        t_inside = int(tumor_inside.sum())
        t_outside = int(tumor_outside.sum())
        t_total = t_inside + t_outside
        t_contain_pct = (100.0 * t_inside / t_total) if t_total else 0.0
        voxel_ml_pre = (np.prod(ct_img.GetSpacing())) / 1000.0
        print(f"  tumor cand:  {t_total:,} total = {t_inside:,} inside liver ({t_contain_pct:.1f} %) + {t_outside:,} outside (FALSE POSITIVES)")
        print(f"               inside-liver tumor volume: {t_inside * voxel_ml_pre:.1f} ml")
        print(f"               outside-liver volume:      {t_outside * voxel_ml_pre:.1f} ml")
        tumor = tumor_inside.astype(np.uint8)  # keep only contained for the panels
        tumor_fp = tumor_outside.astype(np.uint8)
    else:
        tumor_fp = None

    (zmin, zmax), (ymin, ymax), (xmin, xmax) = _bbox(liver)
    print(f"  liver bbox:  z=[{zmin}..{zmax}]  y=[{ymin}..{ymax}]  x=[{xmin}..{xmax}]")
    voxel_ml = (np.prod(ct_img.GetSpacing())) / 1000.0
    total_ml = float((liver > 0).sum() * voxel_ml)

    # 9 axial slices through the liver bbox, evenly spaced.
    n_axial = 9
    z_slices = np.linspace(zmin, zmax, n_axial, dtype=int)
    # 3 coronal slices (anterior / mid / posterior of liver bbox).
    y_slices = np.linspace(
        ymin + (ymax - ymin) // 4, ymax - (ymax - ymin) // 4, 3, dtype=int
    )
    # 3 sagittal slices (right / mid / left of liver bbox).
    x_slices = np.linspace(
        xmin + (xmax - xmin) // 4, xmax - (xmax - xmin) // 4, 3, dtype=int
    )

    flr = _latest_flr()
    flr_str = f"FLR {flr[1]:.0f} ml ({flr[2]:.1f} %)" if flr else "FLR n/a"

    fig = plt.figure(figsize=(15, 12))
    gs = fig.add_gridspec(5, n_axial, height_ratios=[3, 3, 3, 3, 1.6], hspace=0.25, wspace=0.05)

    fig.suptitle(
        f"LiverRa QC review — {aid}\n"
        f"liver {total_ml:.0f} ml  |  {flr_str} (heuristic — NOT validated)  |  bbox z={zmin}–{zmax} ({zmax-zmin+1} slices)\n"
        f"contour: red = liver, cyan = vessels (liver-contained), yellow = tumor (liver-contained), gray = external tumor (FP)",
        fontsize=9.5,
        color="black",
    )

    # Row 0: 9 axial slices at native resolution, evenly spaced through liver bbox
    for i, z in enumerate(z_slices):
        ax = fig.add_subplot(gs[0, i])
        masks = [(liver[z], "red")]
        if vessels is not None:
            masks.append((vessels[z], "deepskyblue"))
        if tumor is not None:
            masks.append((tumor[z], "yellow"))
        if tumor_fp is not None:
            masks.append((tumor_fp[z], "lightgray"))
        _draw_panel(ax, ct[z], masks, f"axial z={z}")

    # Row 1: 3 coronal — fill the row by spanning 3 columns each
    cols_per = max(n_axial // 3, 1)
    for i, y in enumerate(y_slices):
        col_start = i * cols_per
        col_end = col_start + cols_per
        ax = fig.add_subplot(gs[1, col_start:col_end])
        masks = [(liver[:, y, :], "red")]
        if vessels is not None:
            masks.append((vessels[:, y, :], "deepskyblue"))
        if tumor is not None:
            masks.append((tumor[:, y, :], "yellow"))
        if tumor_fp is not None:
            masks.append((tumor_fp[:, y, :], "lightgray"))
        _draw_panel(ax, ct[:, y, :], masks, f"coronal y={y}")

    # Row 2: 3 sagittal
    for i, x in enumerate(x_slices):
        col_start = i * cols_per
        col_end = col_start + cols_per
        ax = fig.add_subplot(gs[2, col_start:col_end])
        masks = [(liver[:, :, x], "red")]
        if vessels is not None:
            masks.append((vessels[:, :, x], "deepskyblue"))
        if tumor is not None:
            masks.append((tumor[:, :, x], "yellow"))
        if tumor_fp is not None:
            masks.append((tumor_fp[:, :, x], "lightgray"))
        _draw_panel(ax, ct[:, :, x], masks, f"sagittal x={x}")

    # Row 3: a wider axial montage using DIFFERENT slice indices to give the
    # surgeon more vertical coverage of the liver
    extra_z = np.linspace(zmin + 1, zmax - 1, n_axial, dtype=int)
    # Offset each slightly from row 0 so we don't duplicate
    extra_z = (extra_z + (zmax - zmin) // (n_axial * 2)).clip(zmin, zmax)
    for i, z in enumerate(extra_z):
        ax = fig.add_subplot(gs[3, i])
        masks = [(liver[z], "red")]
        if vessels is not None:
            masks.append((vessels[z], "deepskyblue"))
        if tumor is not None:
            masks.append((tumor[z], "yellow"))
        if tumor_fp is not None:
            masks.append((tumor_fp[z], "lightgray"))
        _draw_panel(ax, ct[z], masks, f"axial z={z}")

    # Row 4: per-Z voxel count curve (continuity / dropout check)
    ax = fig.add_subplot(gs[4, :])
    z_counts = (liver > 0).sum(axis=(1, 2))
    z_axis = np.arange(len(z_counts))
    ax.fill_between(z_axis, 0, z_counts, color="red", alpha=0.3)
    ax.plot(z_axis, z_counts, color="red", linewidth=1.0, label="liver voxels per Z")
    if vessels is not None:
        v_counts = (vessels > 0).sum(axis=(1, 2))
        ax.plot(z_axis, v_counts, color="deepskyblue", linewidth=0.8, label="vessels (liver-contained)")
    if tumor is not None:
        t_counts = (tumor > 0).sum(axis=(1, 2))
        if t_counts.max() > 0:
            ax.plot(z_axis, t_counts, color="orange", linewidth=1.0, label="tumor (liver-contained)")
    if tumor_fp is not None:
        fp_counts = (tumor_fp > 0).sum(axis=(1, 2))
        if fp_counts.max() > 0:
            ax.plot(z_axis, fp_counts, color="gray", linewidth=0.8, linestyle="--",
                    label="tumor FP (outside liver)")
    ax.axvspan(zmin, zmax, alpha=0.08, color="red", label=f"bbox z=[{zmin},{zmax}]")
    ax.set_xlabel("Z slice index (inferior → superior)", fontsize=8)
    ax.set_ylabel("nonzero voxels / slice", fontsize=8)
    ax.legend(fontsize=7, loc="upper right")
    ax.tick_params(labelsize=7)
    ax.grid(True, alpha=0.3)

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(OUT_PNG, dpi=130, bbox_inches="tight")
    plt.close()
    print(f"\n  ✓ wrote {OUT_PNG}  ({OUT_PNG.stat().st_size:,} B)")
    print(f"\nQC checklist:")
    print(f"  [ ] All 9 axial panels (rows 0 & 3) show red contour on the liver, not bone or vessels")
    print(f"  [ ] Coronal/sagittal contours follow the liver edge without leaking into stomach/heart/diaphragm")
    print(f"  [ ] Z-voxel curve is smooth (no dropouts) inside the bbox shaded region")
    print(f"  [ ] Mask covers superior dome + inferior tip (look at first and last z slices in row 3)")
    print(f"  [ ] Tumor contours (yellow) — flag any > 5 ml that don't look like a real lesion")
    return 0


if __name__ == "__main__":
    sys.exit(main())
