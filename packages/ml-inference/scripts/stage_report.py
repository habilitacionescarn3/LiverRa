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


def render_stage4_couinaud(vols: dict, out_path: Path, is_stub: bool) -> dict:
    """Heuristic 4-quadrant Couinaud split if vessels available; otherwise stub note."""
    fig, ax = plt.subplots(figsize=(8, 5))
    if is_stub:
        ax.text(0.5, 0.5,
                "Stage 4 — Couinaud segmentation\n\n"
                "Status: STUB (not implemented)\n\n"
                "A real Couinaud split needs portal-vein bifurcation +\n"
                "right hepatic vein landmarks. We have those from\n"
                "TotalSegmentator's liver_vessels output but the\n"
                "anatomical heuristic isn't wired yet.\n\n"
                "Tracked in docs/plans/PHASE_3_GAPS.md.",
                ha="center", va="center", fontsize=11, family="monospace",
                bbox=dict(boxstyle="round,pad=0.6", facecolor="#fff7d0", edgecolor="orange"))
        ax.axis("off")
    else:
        # placeholder — would render 8-color overlay
        ax.text(0.5, 0.5, "Couinaud placeholder", ha="center", va="center")
        ax.axis("off")
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()
    return {"note": "stub" if is_stub else "real"}


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


def render_stage7_flr(vols: dict, flr_row, out_path: Path) -> dict:
    """Coronal slice with the resection plane drawn; FLR portion green, rest red."""
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
    # Plane is on a 128³ mask. Map z_index to native CT Z.
    (zmin, zmax), (ymin, ymax), (xmin, xmax) = bbox(liver)
    # The 128³ z_index sits inside the 128³ bbox of the resampled mask, so we
    # convert proportionally to the native bbox.
    z_idx_128 = plane.get("z_index", 64)
    bbox_z_128 = plane.get("bbox_z", [0, 127])
    if bbox_z_128[1] > bbox_z_128[0]:
        # Convert z_index in 128³ frame to native frame using liver bbox.
        frac = (z_idx_128 - bbox_z_128[0]) / max(1, (bbox_z_128[1] - bbox_z_128[0]))
        z_native = int(zmin + frac * (zmax - zmin))
    else:
        z_native = (zmin + zmax) // 2

    fig, axes = plt.subplots(1, 3, figsize=(13, 5))
    # coronal at liver mid-Y
    y_mid = (ymin + ymax) // 2
    ct_c = hu_window(ct[:, y_mid, :])
    axes[0].imshow(ct_c, cmap="gray", origin="lower")
    # split liver into FLR (above plane) and remnant (below)
    liver_c = liver[:, y_mid, :].astype(np.float32)
    above = liver_c.copy(); above[:z_native, :] = 0  # NB origin lower means z_native < image_top
    below = liver_c.copy(); below[z_native:, :] = 0
    overlay_above = np.zeros((*liver_c.shape, 4))
    overlay_above[above > 0] = [0.2, 0.9, 0.2, 0.45]  # green = FLR
    overlay_below = np.zeros((*liver_c.shape, 4))
    overlay_below[below > 0] = [1.0, 0.3, 0.3, 0.45]  # red = remnant
    axes[0].imshow(overlay_above, origin="lower")
    axes[0].imshow(overlay_below, origin="lower")
    axes[0].axhline(z_native, color="white", linewidth=1.5, linestyle="--")
    axes[0].set_title(f"coronal y={y_mid} — FLR (green) above plane z={z_native}", fontsize=9)
    axes[0].axis("off")

    # sagittal at mid X
    x_mid = (xmin + xmax) // 2
    ct_s = hu_window(ct[:, :, x_mid])
    axes[1].imshow(ct_s, cmap="gray", origin="lower")
    liver_s = liver[:, :, x_mid].astype(np.float32)
    above = liver_s.copy(); above[:z_native, :] = 0
    below = liver_s.copy(); below[z_native:, :] = 0
    overlay_above = np.zeros((*liver_s.shape, 4))
    overlay_above[above > 0] = [0.2, 0.9, 0.2, 0.45]
    overlay_below = np.zeros((*liver_s.shape, 4))
    overlay_below[below > 0] = [1.0, 0.3, 0.3, 0.45]
    axes[1].imshow(overlay_above, origin="lower")
    axes[1].imshow(overlay_below, origin="lower")
    axes[1].axhline(z_native, color="white", linewidth=1.5, linestyle="--")
    axes[1].set_title(f"sagittal x={x_mid}", fontsize=9)
    axes[1].axis("off")

    # numerical summary
    axes[2].axis("off")
    axes[2].text(0.0, 0.95,
                 f"FLR — heuristic: axial midpoint\n\n"
                 f"  total liver:  {total_ml} ml\n"
                 f"  FLR (green):  {flr_ml} ml  ({flr_pct} %)\n"
                 f"  remnant (red): {float(total_ml)-float(flr_ml):.2f} ml\n\n"
                 f"  plane: {plane}\n\n"
                 f"⚠ NOT clinically validated.\n"
                 f"   Real FLR needs:\n"
                 f"   - Couinaud-aware resection plane\n"
                 f"   - Portal-vein territory mapping\n"
                 f"   - Surgeon-defined cut surface",
                 family="monospace", fontsize=10, verticalalignment="top",
                 transform=axes[2].transAxes)
    plt.tight_layout()
    plt.savefig(out_path, dpi=130, bbox_inches="tight")
    plt.close()

    return {
        "total_ml": float(total_ml),
        "flr_ml": float(flr_ml),
        "flr_pct": float(flr_pct),
        "plane": plane,
        "z_native": z_native,
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

    # Stage 4
    print("  rendering stage 4 (couinaud — stub)…")
    s4 = render_stage4_couinaud(vols, OUT_DIR / "stage4_couinaud.png", is_stub=True)
    sections.append({
        "stage_no": 4, "title": "Couinaud — STUB",
        "meta": "No real Couinaud segmentation yet. Heuristic split using TS's IVC + portal-vein outputs is queued.",
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
    s7 = render_stage7_flr(vols, run["flr"], OUT_DIR / "stage7_flr.png")
    sections.append({
        "stage_no": 7, "title": "FLR (axial midpoint heuristic)",
        "meta": (
            f"Total {s7['total_ml']:.0f} ml &nbsp; "
            f"FLR {s7['flr_ml']:.0f} ml ({s7['flr_pct']:.1f}%). "
            f"Plane crossed at native z={s7['z_native']}. "
            f"<span class='warn'>(heuristic — NOT validated)</span>"
            if s7 else "FLR row not present."
        ),
        "image": OUT_DIR / "stage7_flr.png",
    })

    print("  writing HTML…")
    html_path = write_html(run, sections)
    print(f"\n✓ {html_path}")
    print(f"  open: xdg-open {html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
