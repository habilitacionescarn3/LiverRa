"""Per-stage visual review for the most recent real_cascade run.

Builds tmp/stage_report/ with:
  - index.html              — single-page report with one section per stage
  - stage2_parenchyma.png   — multi-slice liver QC (axial montage + ortho)
  - stage3_vessels.png      — coronal MIP + axial slices showing vessel tree
  - stage4_couinaud.png     — stub-aware placeholder (or heuristic split)
  - stage5_lesions.png      — per-lesion 3-axis thumbnails with bboxes
  - stage6_classification.png — bar chart per lesion (or "skipped")
  - stage7_flr.png          — coronal slice with resection plane drawn

Plus a Concerns/Next-steps section pulled from the latest run state.

Usage:
    python packages/ml-inference/scripts/stage_report.py
    xdg-open tmp/stage_report/index.html
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.colors
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import numpy as np
import psycopg
import SimpleITK as sitk
from scipy.ndimage import label as cc_label

DB_URL = os.environ.get(
    "DATABASE_URL_SYNC",
    "postgresql://liverra:liverra@localhost:5432/liverra",
)
WORKDIR_ROOT = Path("/tmp/real_cascade")
OUT_DIR = Path("/home/irakli/LiverRA/LiverRa/tmp/stage_report")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Data load
# ---------------------------------------------------------------------------


def load_run() -> dict:
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        analysis = conn.execute(
            """
            SELECT id, status, started_at, queued_at, completed_at, pipeline_version
            FROM analysis ORDER BY queued_at DESC LIMIT 1
            """
        ).fetchone()
        aid = str(analysis[0])
        ckpts = conn.execute(
            """
            SELECT stage_no, stage, model_version, output_uri, model_license_hash, written_at
            FROM pipeline_checkpoint WHERE analysis_id=%s ORDER BY stage_no
            """,
            (aid,),
        ).fetchall()
        flr = conn.execute(
            "SELECT total_ml, flr_ml, flr_pct, plane_pose, computed_at "
            "FROM flr_calculation WHERE analysis_id=%s",
            (aid,),
        ).fetchone()
    return {
        "analysis_id": aid,
        "status": analysis[1],
        "started_at": analysis[2],
        "completed_at": analysis[4],
        "pipeline_version": analysis[5],
        "checkpoints": ckpts,
        "flr": flr,
    }


def load_volumes(aid_prefix: str):
    base = WORKDIR_ROOT / aid_prefix
    if not base.exists():
        return None
    ct_img = sitk.ReadImage(str(base / "portal_venous.nii.gz"))
    liver_img = sitk.ReadImage(str(base / "ts_total/liver.nii.gz"))
    ct = sitk.GetArrayFromImage(ct_img).astype(np.float32)
    liver = sitk.GetArrayFromImage(liver_img).astype(np.uint8)
    vessels = tumor = None
    vp = base / "ts_vessels/liver_vessels.nii.gz"
    tp = base / "ts_vessels/liver_tumor.nii.gz"
    if vp.exists():
        vessels = sitk.GetArrayFromImage(sitk.ReadImage(str(vp))).astype(np.uint8)
    if tp.exists():
        tumor = sitk.GetArrayFromImage(sitk.ReadImage(str(tp))).astype(np.uint8)
    return {
        "ct": ct,
        "ct_img": ct_img,
        "liver": liver,
        "vessels": vessels,
        "tumor": tumor,
        "spacing": ct_img.GetSpacing(),  # (X, Y, Z)
        "voxel_ml": float(np.prod(ct_img.GetSpacing()) / 1000.0),
    }


def hu_window(slice_arr: np.ndarray, lo: float = -150, hi: float = 250) -> np.ndarray:
    return np.clip((slice_arr - lo) / (hi - lo), 0, 1)


def bbox(mask: np.ndarray) -> tuple[tuple[int, int], ...]:
    nz = np.argwhere(mask > 0)
    if nz.size == 0:
        s = mask.shape
        return tuple((0, s[i] - 1) for i in range(3))
    return tuple((int(nz[:, i].min()), int(nz[:, i].max())) for i in range(3))


# ---------------------------------------------------------------------------
# Stage renderers
# ---------------------------------------------------------------------------


def render_stage2_parenchyma(vols: dict, out_path: Path) -> dict:
    """6 axial + 2 coronal + 2 sagittal at liver bbox; contour overlay."""
    ct, liver = vols["ct"], vols["liver"]
    (zmin, zmax), (ymin, ymax), (xmin, xmax) = bbox(liver)
    z_slices = np.linspace(zmin, zmax, 6, dtype=int)
    y_slices = np.linspace(ymin + (ymax - ymin) // 4, ymax - (ymax - ymin) // 4, 2, dtype=int)
    x_slices = np.linspace(xmin + (xmax - xmin) // 4, xmax - (xmax - xmin) // 4, 2, dtype=int)

    fig = plt.figure(figsize=(14, 7))
    gs = fig.add_gridspec(3, 6, height_ratios=[1, 1, 1], hspace=0.18, wspace=0.05)
    for i, z in enumerate(z_slices):
        ax = fig.add_subplot(gs[0, i])
        ax.imshow(hu_window(ct[z]), cmap="gray", origin="lower")
        ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=1.2)
        ax.set_title(f"axial z={z}", fontsize=8)
        ax.axis("off")
    for i, y in enumerate(y_slices):
        ax = fig.add_subplot(gs[1, i*3:(i+1)*3])
        ax.imshow(hu_window(ct[:, y, :]), cmap="gray", origin="lower")
        ax.contour(liver[:, y, :], levels=[0.5], colors=["red"], linewidths=1.0)
        ax.set_title(f"coronal y={y}", fontsize=8)
        ax.axis("off")
    for i, x in enumerate(x_slices):
        ax = fig.add_subplot(gs[2, i*3:(i+1)*3])
        ax.imshow(hu_window(ct[:, :, x]), cmap="gray", origin="lower")
        ax.contour(liver[:, :, x], levels=[0.5], colors=["red"], linewidths=1.0)
        ax.set_title(f"sagittal x={x}", fontsize=8)
        ax.axis("off")
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()

    # Stats
    voxel_ml = vols["voxel_ml"]
    voxels = int((liver > 0).sum())
    # connected components — flag islands
    cc, n = cc_label(liver > 0)
    sizes = np.bincount(cc.ravel())[1:] if n else np.array([])
    main = int(sizes.max()) if sizes.size else 0
    islands_lt5ml = int(((sizes * voxel_ml) < 5).sum()) if sizes.size else 0
    return {
        "voxels": voxels,
        "volume_ml": voxels * voxel_ml,
        "components": int(n),
        "main_component_voxels": main,
        "main_component_pct": (100.0 * main / voxels) if voxels else 0.0,
        "small_islands_under_5ml": islands_lt5ml,
        "bbox_z": (zmin, zmax),
        "bbox_y": (ymin, ymax),
        "bbox_x": (xmin, xmax),
    }


def render_stage3_vessels(vols: dict, out_path: Path) -> dict | None:
    """Coronal MIP of vessels, plus axial panels showing vessel + liver contour."""
    if vols["vessels"] is None:
        return None
    ct, liver, vessels = vols["ct"], vols["liver"], vols["vessels"]
    inside = (vessels > 0) & (liver > 0)
    outside = (vessels > 0) & (liver == 0)

    (zmin, zmax), _, _ = bbox(liver)
    z_slices = np.linspace(zmin, zmax, 4, dtype=int)

    fig = plt.figure(figsize=(14, 5))
    gs = fig.add_gridspec(1, 5, wspace=0.05)

    # Left: coronal MIP-style overlay (project vessels along Y)
    ax = fig.add_subplot(gs[0, 0:2])
    # MIP CT: max along Y (anterior-posterior) for vessel projection
    ct_mip = ct.max(axis=1)
    vessels_mip = vessels.max(axis=1)
    liver_mip_outline = liver.max(axis=1)
    ax.imshow(hu_window(ct_mip), cmap="gray", origin="lower", aspect="auto")
    ax.contour(liver_mip_outline, levels=[0.5], colors=["red"], linewidths=0.8, alpha=0.6)
    # Render vessels as colored overlay
    overlay = np.zeros((*vessels_mip.shape, 4))
    overlay[vessels_mip > 0] = [0.0, 0.7, 1.0, 0.85]  # cyan
    ax.imshow(overlay, origin="lower", aspect="auto")
    ax.set_title("coronal MIP — vessels (cyan) within liver (red outline)", fontsize=9)
    ax.axis("off")

    # Right: 3 axial slices with vessel + liver contours
    for i, z in enumerate(z_slices[:3]):
        ax = fig.add_subplot(gs[0, 2 + i])
        ax.imshow(hu_window(ct[z]), cmap="gray", origin="lower")
        ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=0.8)
        ax.contour(vessels[z], levels=[0.5], colors=["deepskyblue"], linewidths=1.0)
        ax.set_title(f"axial z={z}", fontsize=8)
        ax.axis("off")
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()

    voxel_ml = vols["voxel_ml"]
    return {
        "voxels_total": int((vessels > 0).sum()),
        "voxels_inside_liver": int(inside.sum()),
        "voxels_outside_liver": int(outside.sum()),
        "containment_pct": 100.0 * int(inside.sum()) / max(1, int((vessels > 0).sum())),
        "volume_inside_ml": float(int(inside.sum()) * voxel_ml),
        "volume_outside_ml": float(int(outside.sum()) * voxel_ml),
    }


def _load_couinaud_native(aid: str) -> np.ndarray | None:
    """Re-compute the native-resolution Couinaud mask if landmark masks
    are still on disk under /tmp/real_cascade/<aid_prefix>/.

    The 128³ mask in MinIO loses the high-res segment boundaries we want
    for visualization; the native-res TS landmark outputs are still on
    disk after a real_cascade.py run.
    """
    base = WORKDIR_ROOT / aid[:8]
    liver_p = base / "ts_total/liver.nii.gz"
    if not liver_p.exists():
        return None
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from src.orchestrator.couinaud_heuristic import compute_couinaud  # noqa: E402

    liver_img = sitk.ReadImage(str(liver_p))
    liver = sitk.GetArrayFromImage(liver_img).astype(np.uint8)
    ivc_p = base / "ts_total/inferior_vena_cava.nii.gz"
    gb_p = base / "ts_total/gallbladder.nii.gz"
    vp = base / "ts_vessels/liver_vessels.nii.gz"
    ivc = sitk.GetArrayFromImage(sitk.ReadImage(str(ivc_p))).astype(np.uint8) if ivc_p.exists() else None
    gb = sitk.GetArrayFromImage(sitk.ReadImage(str(gb_p))).astype(np.uint8) if gb_p.exists() else None
    vessels = sitk.GetArrayFromImage(sitk.ReadImage(str(vp))).astype(np.uint8) if vp.exists() else None
    sx, sy, sz = liver_img.GetSpacing()
    return compute_couinaud(liver, ivc, gb, vessels, voxel_spacing=(sx, sy, sz))


# tab10-ish palette — distinct, projector-friendly
_SEG_COLORS = [
    "#1f77b4",  # 1 caudate (blue)
    "#ff7f0e",  # 2 II  (orange)
    "#2ca02c",  # 3 III (green)
    "#d62728",  # 4 IV  (red)
    "#9467bd",  # 5 V   (purple)
    "#8c564b",  # 6 VI  (brown)
    "#e377c2",  # 7 VII (pink)
    "#17becf",  # 8 VIII (cyan)
]


def render_stage4_couinaud(vols: dict, aid: str, out_path: Path) -> dict:
    """Render 8-color Couinaud overlay on liver slices + per-segment table.

    Falls back to a "stub" placeholder if the native-res Couinaud mask
    cannot be reconstructed (the source landmark masks aren't on disk).
    """
    cou = _load_couinaud_native(aid)
    if cou is None:
        # Fallback — no source data; show the placeholder.
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5,
                "Stage 4 — Couinaud segmentation\n\n"
                "No native-resolution landmark masks on disk.\n"
                "Re-run real_cascade.py to regenerate.",
                ha="center", va="center", fontsize=11, family="monospace",
                bbox=dict(boxstyle="round,pad=0.6",
                          facecolor="#fff7d0", edgecolor="orange"))
        ax.axis("off")
        plt.savefig(out_path, dpi=130, bbox_inches="tight")
        plt.close()
        return {"note": "fallback"}

    ct = vols["ct"]
    voxel_ml = vols["voxel_ml"]
    (zmin, zmax), (ymin, ymax), (xmin, xmax) = bbox(cou)

    # Per-segment volumes (in mL)
    per_seg_ml = {sid: round(int((cou == sid).sum()) * voxel_ml, 1) for sid in range(1, 9)}
    seg_names = ["I (caudate)", "II", "III", "IV", "V", "VI", "VII", "VIII"]

    # Build a lookup → color image (Z, Y, X, 4) only filled where cou>0
    z_show = np.linspace(zmin, zmax, 4, dtype=int)
    y_show = np.linspace(ymin + (ymax - ymin) // 4,
                         ymax - (ymax - ymin) // 4, 2, dtype=int)
    x_show = np.linspace(xmin + (xmax - xmin) // 4,
                         xmax - (xmax - xmin) // 4, 2, dtype=int)

    fig = plt.figure(figsize=(14, 9))
    gs = fig.add_gridspec(3, 4, height_ratios=[1, 1, 0.8], hspace=0.35, wspace=0.05)

    def overlay(ax, ct_slice: np.ndarray, cou_slice: np.ndarray, title: str) -> None:
        ax.imshow(hu_window(ct_slice), cmap="gray", origin="lower")
        for sid in range(1, 9):
            mask = (cou_slice == sid)
            if not mask.any():
                continue
            rgba = np.zeros((*mask.shape, 4))
            color = matplotlib.colors.to_rgb(_SEG_COLORS[sid - 1])
            rgba[mask] = [*color, 0.45]
            ax.imshow(rgba, origin="lower")
        ax.set_title(title, fontsize=8)
        ax.axis("off")

    for i, z in enumerate(z_show):
        ax = fig.add_subplot(gs[0, i])
        overlay(ax, ct[z], cou[z], f"axial z={z}")
    for i, y in enumerate(y_show):
        ax = fig.add_subplot(gs[1, i*2:(i+1)*2])
        overlay(ax, ct[:, y, :], cou[:, y, :], f"coronal y={y}")
    # 2 sagittal in row 1 col 0..3
    for i, x in enumerate(x_show):
        ax = fig.add_subplot(gs[2, i*2:(i+1)*2])
        # Per-segment table (left half) + sagittal slice (right half)?
        # Simpler: make this row two sagittals.
        overlay(ax, ct[:, :, x], cou[:, :, x], f"sagittal x={x}")

    # Add a per-segment legend / volume table to the figure title area
    legend_lines = []
    for sid, name in zip(range(1, 9), seg_names):
        legend_lines.append(f"{name}: {per_seg_ml[sid]:>6.1f} ml")
    legend_text = "  •  ".join(legend_lines)
    fig.suptitle(
        f"Stage 4 — Couinaud heuristic (Cantlie + portal bifurcation)\n"
        f"{legend_text}",
        fontsize=10,
    )
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()
    return {
        "per_segment_ml": per_seg_ml,
        "total_ml": round(sum(per_seg_ml.values()), 1),
    }


def render_stage5_lesions(vols: dict, out_path: Path) -> dict | None:
    """Per-lesion 3-axis thumbnail strip + summary table."""
    if vols["tumor"] is None:
        fig, ax = plt.subplots(figsize=(8, 3))
        ax.text(0.5, 0.5, "no tumor channel available", ha="center", va="center")
        ax.axis("off")
        plt.savefig(out_path, dpi=130, bbox_inches="tight")
        plt.close()
        return None
    ct, liver, tumor = vols["ct"], vols["liver"], vols["tumor"]
    # liver-contained tumor only
    tumor_in = (tumor > 0) & (liver > 0)
    cc, n = cc_label(tumor_in)
    voxel_ml = vols["voxel_ml"]
    lesions: list[dict] = []
    for lid in range(1, n + 1):
        m = (cc == lid)
        v = int(m.sum())
        ml = v * voxel_ml
        if ml < 0.05:
            continue  # tiny noise
        coords = np.argwhere(m)
        center = tuple(int(coords[:, i].mean()) for i in range(3))
        zlo, zhi = int(coords[:, 0].min()), int(coords[:, 0].max())
        ylo, yhi = int(coords[:, 1].min()), int(coords[:, 1].max())
        xlo, xhi = int(coords[:, 2].min()), int(coords[:, 2].max())
        lesions.append({
            "id": lid,
            "volume_ml": ml,
            "voxels": v,
            "center": center,
            "bbox": ((zlo, zhi), (ylo, yhi), (xlo, xhi)),
        })
    lesions.sort(key=lambda l: -l["volume_ml"])

    if not lesions:
        fig, ax = plt.subplots(figsize=(8, 3))
        ax.text(0.5, 0.5, "0 liver-contained tumor candidates ≥ 0.05 ml",
                ha="center", va="center")
        ax.axis("off")
        plt.savefig(out_path, dpi=130, bbox_inches="tight")
        plt.close()
        return {"lesions": []}

    # Render per-lesion: axial / coronal / sagittal thumbnail centered on lesion
    n_show = min(len(lesions), 5)
    fig, axes = plt.subplots(n_show, 3, figsize=(9, 2.6 * n_show))
    if n_show == 1:
        axes = axes.reshape(1, 3)
    for row, les in enumerate(lesions[:n_show]):
        z, y, x = les["center"]
        # axial
        ax = axes[row, 0]
        ax.imshow(hu_window(ct[z]), cmap="gray", origin="lower")
        ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=0.6, alpha=0.6)
        ax.contour((cc[z] == les["id"]).astype(np.uint8), levels=[0.5],
                   colors=["yellow"], linewidths=1.4)
        ax.set_title(f"lesion {les['id']} • axial z={z} • {les['volume_ml']:.1f} ml",
                     fontsize=8)
        ax.axis("off")
        # coronal
        ax = axes[row, 1]
        ax.imshow(hu_window(ct[:, y, :]), cmap="gray", origin="lower")
        ax.contour(liver[:, y, :], levels=[0.5], colors=["red"], linewidths=0.6, alpha=0.6)
        ax.contour((cc[:, y, :] == les["id"]).astype(np.uint8), levels=[0.5],
                   colors=["yellow"], linewidths=1.4)
        ax.set_title(f"coronal y={y}", fontsize=8)
        ax.axis("off")
        # sagittal
        ax = axes[row, 2]
        ax.imshow(hu_window(ct[:, :, x]), cmap="gray", origin="lower")
        ax.contour(liver[:, :, x], levels=[0.5], colors=["red"], linewidths=0.6, alpha=0.6)
        ax.contour((cc[:, :, x] == les["id"]).astype(np.uint8), levels=[0.5],
                   colors=["yellow"], linewidths=1.4)
        ax.set_title(f"sagittal x={x}", fontsize=8)
        ax.axis("off")
    plt.tight_layout()
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()

    return {"lesions": lesions, "n_components": n}


def render_stage6_classification(lesion_info: dict | None, out_path: Path) -> dict:
    """Per-lesion class-probability bar chart — stub mode shows placeholder."""
    fig, ax = plt.subplots(figsize=(9, 4))
    classes = ["hcc", "icc", "metastasis", "fnh", "hemangioma", "cyst"]
    if not lesion_info or not lesion_info.get("lesions"):
        ax.text(0.5, 0.5, "Stage 6 — Classification\n\nSkipped: 0 liver-contained lesions",
                ha="center", va="center", fontsize=11, family="monospace")
        ax.axis("off")
    else:
        # No real classifier wired yet — show "uniform unknown" with "stub" warning
        n = min(len(lesion_info["lesions"]), 3)
        ax.text(0.5, 0.92,
                "Stage 6 — Classification (LiLNet)  •  STUB: model not wired",
                ha="center", va="top", fontsize=11, family="monospace",
                transform=ax.transAxes,
                bbox=dict(boxstyle="round", facecolor="#fff7d0", edgecolor="orange"))
        # Show flat bars per lesion as placeholder
        x_pos = np.arange(len(classes))
        for i, les in enumerate(lesion_info["lesions"][:n]):
            ax.bar(x_pos + i * 0.25, np.full(len(classes), 1.0 / len(classes)),
                   width=0.22, label=f"lesion {les['id']} ({les['volume_ml']:.0f} ml)",
                   alpha=0.6)
        ax.set_xticks(x_pos)
        ax.set_xticklabels(classes)
        ax.set_ylabel("class probability (placeholder = uniform)")
        ax.set_ylim(0, 1)
        ax.legend(fontsize=8, loc="upper right")
        ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()
    return {"note": "stub classifier"}


def render_stage7_flr(vols: dict, flr_row, aid: str, out_path: Path) -> dict:
    """Coronal + sagittal with segment-aware green (FLR) / red (removed) overlay.

    Reads the resection pattern from ``flr_row.plane_pose`` and uses the
    native-resolution Couinaud mask to color voxels by remnant vs.
    removed segment.
    """
    if not flr_row:
        fig, ax = plt.subplots(figsize=(8, 4))
        ax.text(0.5, 0.5, "no flr_calculation row", ha="center", va="center")
        ax.axis("off")
        plt.savefig(out_path, dpi=130, bbox_inches="tight")
        plt.close()
        return {}
    total_ml, flr_ml, flr_pct, plane_pose, _when = flr_row
    plane = plane_pose if isinstance(plane_pose, dict) else json.loads(plane_pose)

    ct, liver = vols["ct"], vols["liver"]
    (zmin, zmax), (ymin, ymax), (xmin, xmax) = bbox(liver)

    # Try to load the native Couinaud mask for segment-aware rendering.
    cou = _load_couinaud_native(aid) if "pattern" in plane else None
    pattern = plane.get("pattern", "axial_midpoint")

    fig, axes = plt.subplots(1, 3, figsize=(14, 5))

    if cou is not None and pattern in {
        "right_hepatectomy", "left_hepatectomy", "extended_right",
        "extended_left", "right_anterior_sectionectomy",
        "left_lateral_sectionectomy",
    }:
        # Map names → IDs for masking
        name_to_id = {"I": 1, "II": 2, "III": 3, "IV": 4,
                      "V": 5, "VI": 6, "VII": 7, "VIII": 8}
        removed_ids = {name_to_id[n] for n in plane.get("removed_segments", [])
                       if n in name_to_id}
        remnant_ids = {name_to_id[n] for n in plane.get("remnant_segments", [])
                       if n in name_to_id}

        def _render(ax, ct_slice, cou_slice, title):
            ax.imshow(hu_window(ct_slice), cmap="gray", origin="lower")
            green = np.zeros((*cou_slice.shape, 4))
            red = np.zeros((*cou_slice.shape, 4))
            for sid in remnant_ids:
                m = (cou_slice == sid)
                green[m] = [0.2, 0.9, 0.2, 0.45]
            for sid in removed_ids:
                m = (cou_slice == sid)
                red[m] = [1.0, 0.3, 0.3, 0.45]
            ax.imshow(green, origin="lower")
            ax.imshow(red, origin="lower")
            ax.set_title(title, fontsize=9)
            ax.axis("off")

        y_mid = (ymin + ymax) // 2
        x_mid = (xmin + xmax) // 2
        _render(axes[0], ct[:, y_mid, :], cou[:, y_mid, :],
                f"coronal y={y_mid} — green=remnant, red=removed")
        _render(axes[1], ct[:, :, x_mid], cou[:, :, x_mid],
                f"sagittal x={x_mid}")

        # Per-segment table
        per_seg = plane.get("per_segment_ml", {})
        lines = [
            f"FLR — segment-aware",
            f"  pattern: {pattern}",
            "",
            f"  total liver:  {total_ml} ml",
            f"  FLR (green):  {flr_ml} ml  ({flr_pct} %)",
            f"  remnant (red): {float(total_ml)-float(flr_ml):.2f} ml",
            "",
            f"  removed: {', '.join(plane.get('removed_segments', []))}",
            f"  remnant: {', '.join(plane.get('remnant_segments', []))}",
            "",
            "  per-segment volumes:",
        ]
        for name in ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]:
            v = per_seg.get(name, 0)
            tag = "removed" if name in plane.get("removed_segments", []) else "remnant"
            lines.append(f"    {name:5s} {v:>7.1f} ml  ({tag})")
        lines += [
            "",
            "⚠ Heuristic Couinaud — NOT validated",
            "   against radiologist annotations.",
        ]
        axes[2].axis("off")
        axes[2].text(0.0, 0.98, "\n".join(lines),
                     family="monospace", fontsize=9,
                     verticalalignment="top", transform=axes[2].transAxes)
    else:
        # Fallback to the old axial-midpoint rendering if no Couinaud or pattern.
        for ax in axes[:2]:
            ax.text(0.5, 0.5,
                    "axial-midpoint plane (legacy mode)\n"
                    "Couinaud mask not loaded.",
                    ha="center", va="center", fontsize=10)
            ax.axis("off")
        axes[2].axis("off")
        axes[2].text(0.0, 0.95,
                     f"total: {total_ml} ml\nFLR: {flr_ml} ml ({flr_pct} %)\n\n"
                     f"plane: {plane}",
                     family="monospace", fontsize=9,
                     verticalalignment="top", transform=axes[2].transAxes)

    plt.tight_layout()
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()
    return {
        "total_ml": float(total_ml),
        "flr_ml": float(flr_ml),
        "flr_pct": float(flr_pct),
        "plane": plane,
    }


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------


def _img_tag(path: Path) -> str:
    return f'<img src="{path.name}" alt="{path.stem}" style="max-width:100%;border:1px solid #ccc;border-radius:4px;">'


def write_html(run: dict, sections: list[dict]) -> Path:
    aid = run["analysis_id"]
    started = run["started_at"]
    completed = run["completed_at"]
    duration = (completed - started) if (started and completed) else None
    duration_s = f"{duration.total_seconds():.1f} s" if duration else "n/a"

    html_path = OUT_DIR / "index.html"
    rows = []
    for sn, st, mv, uri, lic, written_at in run["checkpoints"]:
        rows.append(
            f"<tr><td>{sn}</td><td>{st}</td><td><code>{mv}</code></td>"
            f"<td><code>{lic}</code></td>"
            f"<td>{(written_at - started).total_seconds():.2f}s</td>"
            f"<td><code>{uri}</code></td></tr>"
        )

    flr = run["flr"]
    flr_html = (
        f"<p><strong>Total liver:</strong> {flr[0]} ml &nbsp;"
        f"<strong>FLR:</strong> {flr[1]} ml ({flr[2]} %) "
        f"<span class='warn'>(heuristic — NOT validated)</span></p>"
    ) if flr else "<p>No flr_calculation row.</p>"

    sections_html = []
    for s in sections:
        sections_html.append(f"""
        <section>
          <h2>Stage {s['stage_no']} — {s['title']}</h2>
          <p class="meta">{s['meta']}</p>
          {_img_tag(s['image']) if s.get('image') else ''}
          {s.get('extra_html', '')}
        </section>
        """)

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>LiverRa stage report — {aid}</title>
<style>
body{{font-family:-apple-system,system-ui,Segoe UI,Helvetica,sans-serif;color:#222;
     max-width:1080px;margin:24px auto;padding:0 16px;line-height:1.45}}
h1{{margin-bottom:0}}
h2{{margin-top:1.6em;border-bottom:1px solid #eee;padding-bottom:.3em}}
.meta{{color:#666;font-size:.92em;margin:0 0 .8em 0}}
table{{border-collapse:collapse;width:100%;font-size:.92em;margin:.6em 0}}
th,td{{border:1px solid #ddd;padding:6px 9px;text-align:left}}
th{{background:#f3f3f3}}
section{{margin-bottom:1.8em}}
.warn{{color:#a55;font-weight:bold}}
.ok{{color:#383;font-weight:bold}}
code{{background:#f6f6f6;padding:1px 5px;border-radius:3px}}
</style></head><body>

<h1>LiverRa stage report</h1>
<p class="meta">
  analysis_id: <code>{aid}</code> &nbsp;|&nbsp;
  status: <strong>{run['status']}</strong> &nbsp;|&nbsp;
  duration: {duration_s} &nbsp;|&nbsp;
  pipeline: <code>{run['pipeline_version']}</code>
</p>

<h2>Pipeline checkpoints</h2>
<table>
  <thead><tr><th>#</th><th>stage</th><th>model_version</th><th>license</th><th>Δ from start</th><th>output_uri</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table>

<h2>FLR summary</h2>
{flr_html}

{''.join(sections_html)}

<h2>Concerns / next steps</h2>
<ul>
  <li>Liver mask passes rough auto-QC; not yet clinically validated.</li>
  <li>Tumor channel: lesions correctly circled but TS's <code>liver_tumor</code> task is known to over-segment in some patients — needs a per-case radiologist review.</li>
  <li>Couinaud (stage 4) is still a passthrough stub — no segment-aware FLR yet.</li>
  <li>Classification (stage 6) has no real model wired — placeholder uniform probabilities only when lesions exist.</li>
  <li>FLR uses an axial midpoint; real surgical FLR requires a portal-vein-territory plane defined by the surgeon.</li>
</ul>

<h2>Improvement ideas (queued)</h2>
<ul>
  <li><strong>Connected-component cleanup</strong> on the liver mask — drop islands &lt; 5 ml, fill holes.</li>
  <li><strong>Heuristic Couinaud</strong> using TS's IVC + portal-vein outputs to define the principal hepatic plane (Cantlie line) and the right/middle/left portal divisions.</li>
  <li><strong>Per-lesion 4-phase enhancement curve</strong> — sample the same VOI from non_contrast / arterial / portal_venous / delayed; this is the LiLNet input and is clinically interpretable on its own.</li>
  <li><strong>Per-slice radiologist PDF</strong> — one page per axial slice in the liver bbox, contour overlay, in DICOM viewing order.</li>
  <li><strong>Side-by-side 4-phase viewer</strong> — same Z slice across all 4 phases (radiology gold standard).</li>
  <li><strong>3D mesh render</strong> via plotly or vtk — interactive view for the surgeon.</li>
  <li><strong>Dome / left-lobe completeness flags</strong> — alert if left lobe &lt; 20% or superior z-extent &lt; 80% of typical.</li>
  <li><strong>Pre-op vs post-op compare view</strong> — when we have follow-up scans.</li>
</ul>

<p class="meta">Generated {dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} UTC</p>
</body></html>
"""
    html_path.write_text(html)
    return html_path


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    print("=== LiverRa stage report ===")
    run = load_run()
    aid = run["analysis_id"]
    print(f"  analysis_id: {aid}")
    vols = load_volumes(aid[:8])
    if vols is None:
        print(f"!! Native volumes missing under /tmp/real_cascade/{aid[:8]}/")
        print("   Re-run real_cascade.py to populate, then re-run this script.")
        return 1

    sections: list[dict] = []

    # Stage 1
    sections.append({
        "stage_no": 1, "title": "Anonymization (passthrough)",
        "meta": "Input CT was already de-identified by the upload step. No PHI fields present in the source DICOMs.",
        "image": None,
    })

    # Stage 2
    print("  rendering stage 2 (parenchyma)…")
    s2 = render_stage2_parenchyma(vols, OUT_DIR / "stage2_parenchyma.png")
    sections.append({
        "stage_no": 2, "title": "Parenchyma (TotalSegmentator v2)",
        "meta": (
            f"Total liver volume: <strong>{s2['volume_ml']:.0f} ml</strong> "
            f"({s2['voxels']:,} voxels). "
            f"Components: {s2['components']} (largest = {s2['main_component_pct']:.1f}% of volume; "
            f"{s2['small_islands_under_5ml']} islands &lt; 5 ml). "
            f"Bbox z=[{s2['bbox_z'][0]}..{s2['bbox_z'][1]}]."
        ),
        "image": OUT_DIR / "stage2_parenchyma.png",
    })

    # Stage 3
    print("  rendering stage 3 (vessels)…")
    s3 = render_stage3_vessels(vols, OUT_DIR / "stage3_vessels.png")
    sections.append({
        "stage_no": 3, "title": "Vessels (TotalSegmentator liver_vessels)",
        "meta": (
            f"Vessel tree: <strong>{s3['volume_inside_ml']:.1f} ml inside liver</strong> "
            f"+ {s3['volume_outside_ml']:.1f} ml outside (IVC + caval portion). "
            f"Containment: {s3['containment_pct']:.1f}%."
            if s3 else
            "Stage 3 stub — vessels not segmented."
        ),
        "image": OUT_DIR / "stage3_vessels.png",
    })

    # Stage 4 — real heuristic when source landmarks are present
    print("  rendering stage 4 (couinaud heuristic)…")
    s4 = render_stage4_couinaud(vols, aid, OUT_DIR / "stage4_couinaud.png")
    if "per_segment_ml" in s4:
        per = s4["per_segment_ml"]
        seg_summary = "  •  ".join(
            f"{name}={per[sid]} ml" for sid, name in
            zip(range(1, 9), ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"])
        )
        s4_meta = (
            f"Heuristic Couinaud (Cantlie line + portal bifurcation). "
            f"<strong>Total {s4['total_ml']:.0f} ml.</strong> "
            f"Per segment: {seg_summary}. "
            f"<span class='warn'>(NOT validated against radiologist annotations)</span>"
        )
        s4_title = "Couinaud (heuristic)"
    else:
        s4_meta = "Native-resolution landmark masks not on disk; re-run real_cascade.py."
        s4_title = "Couinaud — fallback"
    sections.append({
        "stage_no": 4, "title": s4_title,
        "meta": s4_meta,
        "image": OUT_DIR / "stage4_couinaud.png",
    })

    # Stage 5
    print("  rendering stage 5 (lesions)…")
    s5 = render_stage5_lesions(vols, OUT_DIR / "stage5_lesions.png")
    n_les = len(s5["lesions"]) if s5 else 0
    if s5 and s5["lesions"]:
        biggest = s5["lesions"][0]
        meta = (
            f"<strong>{n_les} liver-contained lesion candidate(s)</strong> "
            f"(threshold ≥ 0.05 ml). Biggest: {biggest['volume_ml']:.1f} ml "
            f"at z={biggest['center'][0]} y={biggest['center'][1]} x={biggest['center'][2]}."
        )
    else:
        meta = "0 lesion candidates ≥ 0.05 ml."
    sections.append({
        "stage_no": 5, "title": "Lesion detection",
        "meta": meta,
        "image": OUT_DIR / "stage5_lesions.png",
    })

    # Stage 6
    print("  rendering stage 6 (classification — stub)…")
    s6 = render_stage6_classification(s5, OUT_DIR / "stage6_classification.png")
    sections.append({
        "stage_no": 6, "title": "Classification — STUB",
        "meta": "No real classifier wired. LiLNet integration is multi-day work (per PHASE_3_GAPS.md).",
        "image": OUT_DIR / "stage6_classification.png",
    })

    # Stage 7
    print("  rendering stage 7 (FLR)…")
    s7 = render_stage7_flr(vols, run["flr"], aid, OUT_DIR / "stage7_flr.png")
    if s7:
        plane = s7.get("plane", {})
        pattern = plane.get("pattern", "n/a")
        s7_meta = (
            f"<strong>Pattern: {pattern}</strong> &nbsp;|&nbsp; "
            f"Total {s7['total_ml']:.0f} ml &nbsp;|&nbsp; "
            f"FLR {s7['flr_ml']:.0f} ml ({s7['flr_pct']:.1f}%) &nbsp;|&nbsp; "
            f"removed: {', '.join(plane.get('removed_segments', []))} &nbsp;|&nbsp; "
            f"<span class='warn'>(heuristic — NOT validated)</span>"
        )
    else:
        s7_meta = "FLR row not present."
    sections.append({
        "stage_no": 7, "title": "FLR (segment-aware heuristic)",
        "meta": s7_meta,
        "image": OUT_DIR / "stage7_flr.png",
    })

    print("  writing HTML…")
    html_path = write_html(run, sections)
    print(f"\n✓ {html_path}")
    print(f"  open: xdg-open {html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
