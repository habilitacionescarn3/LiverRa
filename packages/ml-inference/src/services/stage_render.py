# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-stage matplotlib renderers for the production cascade.

Adapted from `packages/ml-inference/scripts/stage_report.py` (which
reads from local filesystem) to load NIfTI volumes from S3/MinIO so
it can run inside the FastAPI process. Returns matplotlib Figures
that the caller serializes to PNG bytes.

Each render function takes an `analysis_id` + an S3 client and
produces ONE figure summarising one cascade stage. The frontend's
ReportInlineView fetches each as a PNG via `/api/v1/analyses/{id}/
report/render/{stage}`.
"""
from __future__ import annotations

import io
import logging
import os
import tempfile
from typing import Any
from uuid import UUID

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

logger = logging.getLogger(__name__)

ANALYSES_BUCKET = os.environ.get(
    "LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1"
)
PHASES_BUCKET = os.environ.get(
    "LIVERRA_PHASES_BUCKET", "liverra-phases-eu-central-1"
)
RENDER_CACHE_PREFIX = "report-renders"


# ---------------------------------------------------------------------------
# S3 helpers
# ---------------------------------------------------------------------------


def _read_nii_from_s3(s3, bucket: str, key: str) -> Any | None:
    """Fetch a NIfTI from S3, return SimpleITK image or None on miss."""
    try:
        import SimpleITK as sitk
    except ImportError:
        raise RuntimeError("SimpleITK is required for stage rendering")
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
    except Exception as exc:  # noqa: BLE001
        logger.info("missing key %s: %s", key, exc)
        return None
    raw = obj["Body"].read()
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        return sitk.ReadImage(tf.name)


def _largest_connected_component(mask: np.ndarray, *, label: str = "mask") -> np.ndarray:
    """Return ``mask`` with only its largest connected blob retained.

    Defends the renderer against fragmented cascade outputs — a stub /
    dev-mode liver mask often has stray voxels far from the actual organ,
    which makes ``_bbox`` span the whole volume and the renderer sample
    slices in the chest + pelvis instead of through the liver. Picking
    the largest connected component is the simplest correct cleanup
    when the model is *mostly* right but speckled.

    Returns the original mask unchanged when (a) it's already a single
    blob (no work to do), (b) it's empty, or (c) scipy is missing.
    """
    nz = int(mask.sum())
    if nz == 0:
        return mask
    try:
        from scipy import ndimage  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover
        return mask
    labels, n_components = ndimage.label(mask > 0)
    if n_components <= 1:
        return mask
    sizes = ndimage.sum(mask > 0, labels, index=np.arange(1, n_components + 1))
    biggest = int(np.argmax(sizes)) + 1
    cleaned = (labels == biggest).astype(mask.dtype)
    kept = int(cleaned.sum())
    logger.warning(
        "stage_render: %s had %d components; kept the largest "
        "(%d/%d voxels = %.1f%%) — upstream cascade likely produced a "
        "fragmented mask, consider re-running with proper weights",
        label, n_components, kept, nz, (kept / nz) * 100.0,
    )
    return cleaned


def _resample_to(mask_img: Any, ref_img: Any) -> np.ndarray:
    """Resample a SimpleITK mask image into the reference image's grid
    using patient-space affine (NOT index-stretch). Returns uint8 array.

    The previous ``_resize_mask_to_ct`` did ``np.linspace`` index
    stretching which is geometry-blind: when mask + CT come from
    different phases (different origin / spacing / size), the contour
    drifts axially. ``sitk.Resample`` with the CT image as the
    reference computes the right physical-space mapping.
    """
    import SimpleITK as sitk
    if mask_img.GetSize() == ref_img.GetSize() and \
       mask_img.GetOrigin() == ref_img.GetOrigin() and \
       mask_img.GetSpacing() == ref_img.GetSpacing():
        # Already on the same grid — skip the resample.
        return sitk.GetArrayFromImage(mask_img).astype(np.uint8)
    resampled = sitk.Resample(
        mask_img,
        ref_img,
        sitk.Transform(),
        sitk.sitkNearestNeighbor,
        0,
        mask_img.GetPixelID(),
    )
    return sitk.GetArrayFromImage(resampled).astype(np.uint8)


def _load_volumes(s3, analysis_id: UUID, study_id: UUID) -> dict[str, Any] | None:
    """Load CT + parenchyma + vessel + lesion masks from S3.

    Returns dict with numpy arrays + voxel_ml stats or None if the core
    parenchyma_mask isn't yet written. All masks are resampled into the
    CT's patient-space grid via ``sitk.Resample`` so contours align
    correctly even if the cascade wrote masks at a different phase's
    grid (defensive — F1 should already align them upstream).
    """
    import SimpleITK as sitk
    aid = str(analysis_id)
    sid = str(study_id)

    # Pick the CT background phase. Prefer the cascade's
    # LIVERRA_REFERENCE_PHASE (the phase masks were written at) so the
    # resample below is a no-op in the happy path.
    preferred = os.environ.get("LIVERRA_REFERENCE_PHASE", "portal_venous")
    phase_order = (preferred, "portal_venous", "arterial", "non_contrast", "delayed")
    seen: set[str] = set()
    ct_img = None
    for phase in phase_order:
        if phase in seen:
            continue
        seen.add(phase)
        ct_img = _read_nii_from_s3(s3, PHASES_BUCKET, f"studies/{sid}/phases/{phase}.nii.gz")
        if ct_img is not None:
            logger.info("stage_render: using CT background phase=%s size=%s", phase, ct_img.GetSize())
            break
    if ct_img is None:
        return None

    liver_img = _read_nii_from_s3(s3, ANALYSES_BUCKET, f"analyses/{aid}/parenchyma_mask.nii.gz")
    if liver_img is None:
        return None

    ct = sitk.GetArrayFromImage(ct_img).astype(np.float32)
    liver = _resample_to(liver_img, ct_img)
    # Drop stray voxels from fragmented dev/stub masks so downstream
    # bbox + slice selection lands on the actual liver.
    liver = _largest_connected_component(liver, label="liver mask")

    # Vessel masks: prefer split portal/hepatic files (Triton cascade
    # convention). Newer TS-based cascade writes ONE merged ``vessels.nii.gz``;
    # use it as a fallback so the vessel panel still renders.
    portal = _read_nii_from_s3(s3, ANALYSES_BUCKET, f"analyses/{aid}/portal_vein.nii.gz")
    hepatic = _read_nii_from_s3(s3, ANALYSES_BUCKET, f"analyses/{aid}/hepatic_vein.nii.gz")
    portal_arr = _resample_to(portal, ct_img) if portal is not None else None
    hepatic_arr = _resample_to(hepatic, ct_img) if hepatic is not None else None
    if portal_arr is not None:
        portal_arr = _largest_connected_component(portal_arr, label="portal vein")
    if hepatic_arr is not None:
        hepatic_arr = _largest_connected_component(hepatic_arr, label="hepatic vein")
    if portal_arr is None and hepatic_arr is None:
        merged = _read_nii_from_s3(
            s3, ANALYSES_BUCKET, f"analyses/{aid}/vessels.nii.gz"
        )
        if merged is not None:
            # Merged file = combined vessel tree. Surface as "portal" so
            # the existing renderer code paths (cyan overlay) keep working.
            portal_arr = _resample_to(merged, ct_img)
            logger.info(
                "stage_render: using merged vessels.nii.gz fallback "
                "(no split portal/hepatic files for analysis %s)", aid,
            )

    spacing = ct_img.GetSpacing()  # (X, Y, Z)
    voxel_ml = float(np.prod(spacing) / 1000.0)

    # Mask-file volume at the actual CT spacing — surfaced to the report
    # builder so it can compare against the cascade's DB-reported volume
    # (which is computed at parenchyma.py:341 using a hardcoded voxel-size
    # constant and tends to under-report by ~3× for full-abdomen FOV scans).
    liver_volume_ml = int(liver.sum()) * voxel_ml
    if liver_volume_ml > 5000.0 or liver_volume_ml < 100.0:
        logger.warning(
            "stage_render: liver mask volume = %.0f mL is outside the "
            "physiologically plausible 100-5000 mL range — verify cascade "
            "output for analysis",
            liver_volume_ml,
        )

    return {
        "ct": ct,
        "ct_img": ct_img,
        "liver": liver,
        "portal": portal_arr,
        "hepatic": hepatic_arr,
        "spacing": spacing,
        "voxel_ml": voxel_ml,
        "liver_volume_ml_mask": liver_volume_ml,
    }


def _liver_slice_positions(
    liver: np.ndarray,
    *,
    n_axial: int = 6,
    n_coronal: int = 2,
    n_sagittal: int = 2,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pick slice indices weighted by where the liver mass actually is.

    Instead of evenly spacing samples across the full bbox (which lands
    extremes on slices where the liver is thin or fragmented), we use
    the per-axis cumulative voxel distribution and pick equal-mass
    quantiles. The result is N slices that each see roughly the same
    amount of liver — diagnostic-grade picks even for oddly shaped
    livers.
    """
    if int(liver.sum()) == 0:
        # Defensive: if mask is empty, fall back to volume center.
        s = liver.shape
        return (
            np.linspace(s[0] // 4, 3 * s[0] // 4, n_axial, dtype=int),
            np.linspace(s[1] // 3, 2 * s[1] // 3, n_coronal, dtype=int),
            np.linspace(s[2] // 3, 2 * s[2] // 3, n_sagittal, dtype=int),
        )

    def _quantile_picks(axis: int, n: int) -> np.ndarray:
        # Sum the mask across the other two axes → per-slice voxel count.
        per_slice = liver.sum(axis=tuple(a for a in range(3) if a != axis)).astype(np.float64)
        total = per_slice.sum()
        if total == 0:
            s = liver.shape[axis]
            return np.linspace(s // 4, 3 * s // 4, n, dtype=int)
        cum = np.cumsum(per_slice) / total
        # Pick quantiles at (i+0.5)/n so we stay clear of the very edges.
        targets = (np.arange(n) + 0.5) / n
        idx = np.searchsorted(cum, targets)
        idx = np.clip(idx, 0, liver.shape[axis] - 1)
        return idx.astype(int)

    return _quantile_picks(0, n_axial), _quantile_picks(1, n_coronal), _quantile_picks(2, n_sagittal)


def _hu_window(slc: np.ndarray, lo: float = -150, hi: float = 250) -> np.ndarray:
    return np.clip((slc - lo) / (hi - lo), 0, 1)


def _bbox(
    mask: np.ndarray,
    *,
    pad: int = 0,
    percentiles: tuple[float, float] | None = (1.0, 99.0),
) -> tuple[tuple[int, int], ...]:
    """Bounding box of nonzero voxels — robust to outliers.

    By default uses the [1, 99] percentile of the nonzero voxel positions
    along each axis instead of the strict min/max. This trims thin
    "tendrils" or stray edge voxels that survive the largest-CC pass,
    so renderer slice positions land tight on the anatomy.

    Pass ``percentiles=None`` for the strict min/max (legacy behaviour).
    """
    nz = np.argwhere(mask > 0)
    if nz.size == 0:
        s = mask.shape
        return tuple((0, s[i] - 1) for i in range(3))
    if percentiles is None:
        bounds = ((int(nz[:, i].min()), int(nz[:, i].max())) for i in range(3))
    else:
        lo_p, hi_p = percentiles
        bounds = (
            (int(np.percentile(nz[:, i], lo_p)), int(np.percentile(nz[:, i], hi_p)))
            for i in range(3)
        )
    out: list[tuple[int, int]] = []
    for axis_i, (lo, hi) in enumerate(bounds):
        if pad:
            lo = max(0, lo - pad)
            hi = min(mask.shape[axis_i] - 1, hi + pad)
        out.append((lo, hi))
    return tuple(out)


def _resize_mask_to_ct(mask: np.ndarray, ct_shape: tuple[int, ...]) -> np.ndarray:
    """Defensive numpy-only fallback when a mask reaches a renderer
    NOT through ``_load_volumes`` (which already does affine-aware
    resampling via ``_resample_to``). When shapes match this is a
    no-op — the happy path post-F2.

    DO NOT call this on masks loaded outside ``_load_volumes`` if you
    have the SimpleITK image — use ``_resample_to(mask_img, ct_img)``
    instead so the resample respects patient-space alignment.
    """
    if mask.shape == ct_shape:
        return mask
    logger.warning(
        "_resize_mask_to_ct: index-stretch fallback (mask=%s, ct=%s) — "
        "callers should use _resample_to with sitk images instead",
        mask.shape, ct_shape,
    )
    out = np.zeros(ct_shape, dtype=mask.dtype)
    iz = np.linspace(0, mask.shape[0] - 1, ct_shape[0]).astype(int)
    iy = np.linspace(0, mask.shape[1] - 1, ct_shape[1]).astype(int)
    ix = np.linspace(0, mask.shape[2] - 1, ct_shape[2]).astype(int)
    out[:] = mask[np.ix_(iz, iy, ix)]
    return out


def _figure_to_png_bytes(fig: matplotlib.figure.Figure) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Stage renderers
# ---------------------------------------------------------------------------


def render_parenchyma(s3, analysis_id: UUID, study_id: UUID) -> bytes | None:
    """6 axial + 2 coronal + 2 sagittal slices through the liver bbox,
    red contour overlay. Same recipe as scripts/stage_report.py:124-153.
    """
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct, liver = vols["ct"], _resize_mask_to_ct(vols["liver"], vols["ct"].shape)
    if int(liver.sum()) == 0:
        return None
    # Slice positions are weighted by the per-axis mask mass distribution
    # rather than the bbox extremes — this lands cuts where the liver is
    # actually thick, not where stray voxels make the bbox look bigger.
    z_slices, y_slices, x_slices = _liver_slice_positions(
        liver, n_axial=6, n_coronal=2, n_sagittal=2,
    )

    fig = plt.figure(figsize=(14, 7))
    gs = fig.add_gridspec(3, 6, height_ratios=[1, 1, 1], hspace=0.18, wspace=0.05)
    for i, z in enumerate(z_slices):
        ax = fig.add_subplot(gs[0, i])
        ax.imshow(_hu_window(ct[z]), cmap="gray", origin="lower")
        ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=1.2)
        ax.set_title(f"axial z={z}", fontsize=8)
        ax.axis("off")
    for i, y in enumerate(y_slices):
        ax = fig.add_subplot(gs[1, i * 3 : (i + 1) * 3])
        ax.imshow(_hu_window(ct[:, y, :]), cmap="gray", origin="lower")
        ax.contour(liver[:, y, :], levels=[0.5], colors=["red"], linewidths=1.0)
        ax.set_title(f"coronal y={y}", fontsize=8)
        ax.axis("off")
    for i, x in enumerate(x_slices):
        ax = fig.add_subplot(gs[2, i * 3 : (i + 1) * 3])
        ax.imshow(_hu_window(ct[:, :, x]), cmap="gray", origin="lower")
        ax.contour(liver[:, :, x], levels=[0.5], colors=["red"], linewidths=1.0)
        ax.set_title(f"sagittal x={x}", fontsize=8)
        ax.axis("off")
    return _figure_to_png_bytes(fig)


#: Defensive cap (F3 layer 3): if the loaded vessel mask occupies
#: more than this fraction of the liver mask voxels, we skip the
#: cyan overlay. Prevents the report from rendering body-wide
#: contour noise when the vessel model misfires (the upstream
#: F3 layer 2 in vessels.py should already drop such masks to
#: empty before they reach S3, but this is a belt-and-braces
#: check against legacy data + manual uploads).
_VESSEL_RENDER_MAX_FRACTION_OF_LIVER: float = 0.30


def _vessel_overlay_safe(
    vessel_mask: np.ndarray | None, liver_mask: np.ndarray, label: str,
) -> np.ndarray | None:
    """Return ``vessel_mask`` if it looks plausible relative to liver,
    or None if it appears oversegmented OR is empty (so the renderer
    skips the overlay rather than drawing chaotic body-wide contours
    or a useless empty cyan layer)."""
    if vessel_mask is None:
        return None
    vessel_voxels = int(vessel_mask.sum())
    if vessel_voxels == 0:
        logger.warning(
            "stage_render: skipping %s overlay — mask is empty "
            "(0 voxels); cascade Stage 3a likely produced no output",
            label,
        )
        return None
    liver_voxels = int(liver_mask.sum())
    if liver_voxels == 0:
        return vessel_mask
    fraction = vessel_voxels / liver_voxels
    if fraction > _VESSEL_RENDER_MAX_FRACTION_OF_LIVER:
        logger.warning(
            "stage_render: skipping %s overlay — %d voxels = %.1f%% of "
            "liver (%d) exceeds %.0f%% cap",
            label, vessel_voxels, fraction * 100, liver_voxels,
            _VESSEL_RENDER_MAX_FRACTION_OF_LIVER * 100,
        )
        return None
    return vessel_mask


def render_vessels(s3, analysis_id: UUID, study_id: UUID) -> bytes | None:
    """Coronal MIP + 3 axial detail slices showing vessel tree within liver."""
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct = vols["ct"]
    liver = _resize_mask_to_ct(vols["liver"], ct.shape)
    portal = _vessel_overlay_safe(vols["portal"], liver, "portal_vein")
    hepatic = _vessel_overlay_safe(vols["hepatic"], liver, "hepatic_vein")
    if portal is None and hepatic is None:
        return None
    vessels = np.zeros_like(liver)
    if portal is not None:
        vessels |= _resize_mask_to_ct(portal, ct.shape)
    if hepatic is not None:
        vessels |= _resize_mask_to_ct(hepatic, ct.shape)

    # Weight slice picks by the liver-mass distribution so the axial
    # detail panes land on slices where the liver (and therefore its
    # vessel tree) is actually thick.
    z_slices, _, _ = _liver_slice_positions(liver, n_axial=4, n_coronal=2, n_sagittal=2)

    fig = plt.figure(figsize=(14, 5))
    gs = fig.add_gridspec(1, 5, wspace=0.05)

    ax = fig.add_subplot(gs[0, 0:2])
    ct_mip = ct.max(axis=1)
    vessels_mip = vessels.max(axis=1)
    liver_mip = liver.max(axis=1)
    ax.imshow(_hu_window(ct_mip), cmap="gray", origin="lower", aspect="auto")
    ax.contour(liver_mip, levels=[0.5], colors=["red"], linewidths=0.8, alpha=0.6)
    overlay = np.zeros((*vessels_mip.shape, 4))
    overlay[vessels_mip > 0] = [0.0, 0.7, 1.0, 0.85]  # cyan
    ax.imshow(overlay, origin="lower", aspect="auto")
    ax.set_title("coronal MIP — vessels (cyan) within liver (red outline)", fontsize=9)
    ax.axis("off")

    for i, z in enumerate(z_slices[:3]):
        ax = fig.add_subplot(gs[0, 2 + i])
        ax.imshow(_hu_window(ct[z]), cmap="gray", origin="lower")
        ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=0.8)
        ax.contour(vessels[z], levels=[0.5], colors=["deepskyblue"], linewidths=1.0)
        ax.set_title(f"axial z={z}", fontsize=8)
        ax.axis("off")
    return _figure_to_png_bytes(fig)


def render_flr(s3, analysis_id: UUID, study_id: UUID, plane_z: int | None) -> bytes | None:
    """Coronal slice with resection plane drawn; FLR portion green, remnant red."""
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct = vols["ct"]
    liver = _resize_mask_to_ct(vols["liver"], ct.shape)
    (zmin, zmax), (ymin, ymax), _ = _bbox(liver)
    if zmax <= zmin:
        return None
    if plane_z is None:
        plane_z = (zmin + zmax) // 2

    y_mid = (ymin + ymax) // 2
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))

    # Coronal at y_mid with FLR/remnant tint
    coronal_ct = ct[:, y_mid, :]
    coronal_liver = liver[:, y_mid, :]
    axes[0].imshow(_hu_window(coronal_ct), cmap="gray", origin="lower")
    flr_overlay = np.zeros((*coronal_liver.shape, 4))
    flr_overlay[(coronal_liver > 0)] = [1.0, 0.3, 0.3, 0.35]
    above = np.zeros_like(flr_overlay)
    above[: int(plane_z) + 1] = flr_overlay[: int(plane_z) + 1]
    above[(coronal_liver > 0) & (np.arange(coronal_liver.shape[0])[:, None] >= plane_z)] = [
        0.3, 0.95, 0.4, 0.4,
    ]
    axes[0].imshow(above, origin="lower")
    axes[0].axhline(plane_z, color="yellow", linestyle="--", linewidth=1.5)
    axes[0].set_title(f"coronal y={y_mid} • plane at z={plane_z}", fontsize=9)
    axes[0].axis("off")

    # Sagittal at x_mid with same overlay
    x_mid = ct.shape[2] // 2
    sag_ct = ct[:, :, x_mid]
    sag_liver = liver[:, :, x_mid]
    axes[1].imshow(_hu_window(sag_ct), cmap="gray", origin="lower")
    sag_overlay = np.zeros((*sag_liver.shape, 4))
    sag_overlay[(sag_liver > 0) & (np.arange(sag_liver.shape[0])[:, None] >= plane_z)] = [
        0.3, 0.95, 0.4, 0.45,
    ]
    sag_overlay[(sag_liver > 0) & (np.arange(sag_liver.shape[0])[:, None] < plane_z)] = [
        1.0, 0.3, 0.3, 0.35,
    ]
    axes[1].imshow(sag_overlay, origin="lower")
    axes[1].axhline(plane_z, color="yellow", linestyle="--", linewidth=1.5)
    axes[1].set_title(f"sagittal x={x_mid}", fontsize=9)
    axes[1].axis("off")

    fig.suptitle(
        "FLR (green) above the resection plane • remnant (red) below "
        "— heuristic axial midpoint, NOT validated",
        fontsize=10,
    )
    return _figure_to_png_bytes(fig)


def _load_4_phases(s3, study_id: UUID) -> dict[str, np.ndarray]:
    """Load all 4 phase CT volumes (for enhancement-curve sampling).
    Phases that aren't present return None for that key."""
    import SimpleITK as sitk
    out: dict[str, np.ndarray] = {}
    for phase in ("non_contrast", "arterial", "portal_venous", "delayed"):
        img = _read_nii_from_s3(
            s3, PHASES_BUCKET, f"studies/{study_id}/phases/{phase}.nii.gz"
        )
        if img is not None:
            out[phase] = sitk.GetArrayFromImage(img).astype(np.float32)
    return out


def render_lesion_thumbnail(
    s3, analysis_id: UUID, study_id: UUID, lesion_id: UUID,
    bbox_3d: list[int] | None = None,
) -> bytes | None:
    """One lesion's 3-axis thumbnails + enhancement-curve plot.

    Top row: axial / coronal / sagittal slices centred on the lesion
    centroid, with red liver outline + yellow lesion contour.
    Bottom row: 4-point enhancement curve (mean HU within the lesion
    across non_contrast / arterial / portal_venous / delayed phases) —
    the radiology gold standard for hypervascular vs hypovascular
    lesion characterisation.
    """
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct = vols["ct"]
    ct_img = vols["ct_img"]
    liver = vols["liver"]  # already aligned to CT grid by _load_volumes

    try:
        import SimpleITK as sitk
        lesion_img = _read_nii_from_s3(
            s3, ANALYSES_BUCKET, f"analyses/{analysis_id}/lesions/{lesion_id}.nii.gz"
        )
    except Exception:  # noqa: BLE001
        lesion_img = None

    lesion = None
    if lesion_img is not None:
        # F2 — affine-aware resample so the yellow lesion contour aligns
        # to the CT background even if lesion was uploaded at a different
        # grid (e.g. 128³ bbox-cropped — see F5).
        lesion = _resample_to(lesion_img, ct_img)
    else:
        # Fallback: TS-based cascade writes one merged ``tumor_mask.nii.gz``
        # instead of per-lesion files. Crop it by the bbox passed from
        # the API endpoint (which read it from the lesion DB row).
        merged = _read_nii_from_s3(
            s3, ANALYSES_BUCKET, f"analyses/{analysis_id}/tumor_mask.nii.gz"
        )
        if merged is None or bbox_3d is None or len(bbox_3d) != 6:
            return None
        merged_arr = _resample_to(merged, ct_img)
        # Build a per-lesion mask = merged tumor AND inside the bbox.
        # bbox_3d format: [zmin, ymin, xmin, zmax, ymax, xmax].
        zmin, ymin, xmin, zmax, ymax, xmax = bbox_3d
        zmin = max(0, min(zmin, merged_arr.shape[0] - 1))
        zmax = max(zmin + 1, min(zmax, merged_arr.shape[0]))
        ymin = max(0, min(ymin, merged_arr.shape[1] - 1))
        ymax = max(ymin + 1, min(ymax, merged_arr.shape[1]))
        xmin = max(0, min(xmin, merged_arr.shape[2] - 1))
        xmax = max(xmin + 1, min(xmax, merged_arr.shape[2]))
        lesion = np.zeros_like(merged_arr)
        lesion[zmin:zmax, ymin:ymax, xmin:xmax] = merged_arr[zmin:zmax, ymin:ymax, xmin:xmax]
        if lesion.sum() == 0:
            # Bbox region is empty in the merged mask — fall back to
            # rendering the bbox itself as a hollow box outline.
            lesion[zmin:zmax, ymin:ymax, xmin] = 1
            lesion[zmin:zmax, ymin:ymax, xmax - 1] = 1
            lesion[zmin:zmax, ymin, xmin:xmax] = 1
            lesion[zmin:zmax, ymax - 1, xmin:xmax] = 1
        logger.info(
            "stage_render: lesion %s — using merged tumor_mask + bbox crop",
            str(lesion_id),
        )

    if lesion is None:
        return None
    nz = np.argwhere(lesion > 0)
    if nz.size == 0:
        return None
    cz, cy, cx = (int(nz[:, i].mean()) for i in range(3))

    # Phase C — enhancement curve sampling. Load each phase, resize to
    # the displayed CT's grid, sample mean HU within the lesion mask.
    phase_volumes = _load_4_phases(s3, study_id)
    enhancement: list[tuple[str, float | None]] = []
    for phase in ("non_contrast", "arterial", "portal_venous", "delayed"):
        pv = phase_volumes.get(phase)
        if pv is None:
            enhancement.append((phase, None))
            continue
        # Resize phase to displayed CT grid for indexing parity
        if pv.shape != ct.shape:
            try:
                iz = np.linspace(0, pv.shape[0] - 1, ct.shape[0]).astype(int)
                iy = np.linspace(0, pv.shape[1] - 1, ct.shape[1]).astype(int)
                ix = np.linspace(0, pv.shape[2] - 1, ct.shape[2]).astype(int)
                pv = pv[np.ix_(iz, iy, ix)]
            except Exception:  # noqa: BLE001
                enhancement.append((phase, None))
                continue
        sample = pv[lesion > 0]
        enhancement.append((phase, float(sample.mean()) if sample.size > 0 else None))

    fig = plt.figure(figsize=(11, 5.2))
    gs = fig.add_gridspec(2, 3, height_ratios=[3, 1], hspace=0.35, wspace=0.05)

    # Top row — 3-axis thumbnails
    for col, slc, title in (
        (0, (ct[cz], liver[cz], lesion[cz]), f"axial z={cz}"),
        (1, (ct[:, cy, :], liver[:, cy, :], lesion[:, cy, :]), f"coronal y={cy}"),
        (2, (ct[:, :, cx], liver[:, :, cx], lesion[:, :, cx]), f"sagittal x={cx}"),
    ):
        ax = fig.add_subplot(gs[0, col])
        ct_s, liv_s, les_s = slc
        ax.imshow(_hu_window(ct_s), cmap="gray", origin="lower")
        ax.contour(liv_s, levels=[0.5], colors=["red"], linewidths=0.6, alpha=0.6)
        ax.contour(les_s, levels=[0.5], colors=["yellow"], linewidths=1.4)
        ax.set_title(title, fontsize=9)
        ax.axis("off")

    # Bottom row — enhancement curve (spans all 3 columns)
    ax = fig.add_subplot(gs[1, :])
    phase_labels = ["non_contrast", "arterial", "portal_venous", "delayed"]
    xs = list(range(len(phase_labels)))
    ys = [v for _, v in enhancement]
    has_data = [y is not None for y in ys]
    if any(has_data):
        plot_xs = [x for x, h in zip(xs, has_data) if h]
        plot_ys = [y for y, h in zip(ys, has_data) if h]
        ax.plot(plot_xs, plot_ys, marker="o", color="#d97706", linewidth=2)
        for x, y in zip(plot_xs, plot_ys):
            ax.annotate(f"{y:.0f} HU", (x, y), textcoords="offset points",
                        xytext=(0, 8), ha="center", fontsize=8, color="#92400e")
    ax.set_xticks(xs)
    ax.set_xticklabels(phase_labels, fontsize=8)
    ax.set_ylabel("Mean HU within lesion", fontsize=8)
    ax.set_title("4-phase enhancement curve", fontsize=9)
    ax.grid(True, alpha=0.3)
    return _figure_to_png_bytes(fig)


# ---------------------------------------------------------------------------
# 3D mesh render (Phase D1)
# ---------------------------------------------------------------------------


def render_four_phase(s3, analysis_id: UUID, study_id: UUID) -> bytes | None:
    """Side-by-side 4-phase axial comparison at the liver-bbox midpoint.
    The radiology gold-standard for hypervascular/hypovascular pattern
    review (lesion light-up arterial → wash-out portal → late wash-in).
    """
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct_ref = vols["ct"]
    liver = _resize_mask_to_ct(vols["liver"], ct_ref.shape)
    (zmin, zmax), _, _ = _bbox(liver)
    if zmax <= zmin:
        return None
    z_mid = (zmin + zmax) // 2

    phase_vols = _load_4_phases(s3, study_id)
    phases = ("non_contrast", "arterial", "portal_venous", "delayed")
    fig, axes = plt.subplots(1, 4, figsize=(15, 4.2))
    for ax, phase in zip(axes, phases):
        pv = phase_vols.get(phase)
        if pv is None:
            ax.text(0.5, 0.5, f"{phase}\nnot available", ha="center", va="center", fontsize=10)
            ax.set_xticks([]); ax.set_yticks([])
            continue
        # Each phase has its own grid; compute the corresponding Z index
        # by mapping z_mid (in liver-mask grid) to this phase's Z range.
        z_phase = int(round(z_mid * pv.shape[0] / max(1, ct_ref.shape[0])))
        z_phase = max(0, min(pv.shape[0] - 1, z_phase))
        ax.imshow(_hu_window(pv[z_phase]), cmap="gray", origin="lower", aspect="equal")
        # Overlay liver contour by remapping liver mask to this phase's Z
        if liver.shape[0] > 0:
            liver_z = int(round(z_phase * liver.shape[0] / max(1, pv.shape[0])))
            liver_z = max(0, min(liver.shape[0] - 1, liver_z))
            ax.contour(liver[liver_z], levels=[0.5], colors=["red"], linewidths=0.6, alpha=0.7)
        ax.set_title(phase.replace("_", " "), fontsize=10)
        ax.axis("off")
    fig.suptitle(
        f"4-phase comparison @ liver-bbox midpoint (z≈{z_mid})",
        fontsize=11,
    )
    return _figure_to_png_bytes(fig)


def render_per_slice_pdf(s3, analysis_id: UUID, study_id: UUID) -> bytes | None:
    """Multi-page PDF, one page per axial slice within the liver bbox,
    each page showing CT + red liver contour + cyan vessel contours.
    The radiologist's slice-by-slice review document. ~50-200 pages."""
    from matplotlib.backends.backend_pdf import PdfPages

    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    ct = vols["ct"]
    liver = _resize_mask_to_ct(vols["liver"], ct.shape)
    # Apply F3 layer-3 guard so per-slice PDF doesn't render body-wide
    # cyan if the vessel mask is grossly oversegmented.
    portal = _vessel_overlay_safe(vols["portal"], liver, "portal_vein")
    hepatic = _vessel_overlay_safe(vols["hepatic"], liver, "hepatic_vein")
    portal_arr = _resize_mask_to_ct(portal, ct.shape) if portal is not None else None
    hepatic_arr = _resize_mask_to_ct(hepatic, ct.shape) if hepatic is not None else None

    (zmin, zmax), _, _ = _bbox(liver)
    if zmax <= zmin:
        return None
    # Cap pages so we don't generate 600-page PDFs for very-thin-slice CTs.
    z_indices = list(range(zmin, zmax + 1))
    if len(z_indices) > 80:
        step = max(1, len(z_indices) // 80)
        z_indices = z_indices[::step]

    buf = io.BytesIO()
    with PdfPages(buf) as pdf:
        for z in z_indices:
            fig, ax = plt.subplots(figsize=(8, 8))
            ax.imshow(_hu_window(ct[z]), cmap="gray", origin="lower")
            ax.contour(liver[z], levels=[0.5], colors=["red"], linewidths=1.0)
            if portal_arr is not None and (portal_arr[z] > 0).any():
                ax.contour(portal_arr[z], levels=[0.5], colors=["#0070ff"], linewidths=1.2)
            if hepatic_arr is not None and (hepatic_arr[z] > 0).any():
                ax.contour(hepatic_arr[z], levels=[0.5], colors=["#00d4ff"], linewidths=1.2)
            ax.set_title(
                f"axial slice z={z}  •  liver=red  portal=blue  hepatic=cyan",
                fontsize=10,
            )
            ax.axis("off")
            fig.tight_layout()
            pdf.savefig(fig, dpi=110, bbox_inches="tight")
            plt.close(fig)
    return buf.getvalue()


def render_mesh3d(s3, analysis_id: UUID, study_id: UUID) -> bytes | None:
    """Marching-cubes mesh of the parenchyma + vessel highlights."""
    try:
        from skimage import measure
    except ImportError:
        return None
    vols = _load_volumes(s3, analysis_id, study_id)
    if vols is None:
        return None
    liver = vols["liver"]
    if liver.sum() == 0:
        return None

    # Downsample liver to ~64³ for meshing speed (full 512³ marching-cubes
    # is slow + produces huge meshes)
    target = 96
    factors = [max(1, s // target) for s in liver.shape]
    small = liver[::factors[0], ::factors[1], ::factors[2]]
    if small.sum() == 0:
        return None
    try:
        verts, faces, _, _ = measure.marching_cubes(small.astype(np.float32), level=0.5)
    except Exception as exc:  # noqa: BLE001
        logger.info("marching_cubes failed: %s", exc)
        return None

    fig = plt.figure(figsize=(7, 7))
    ax = fig.add_subplot(111, projection="3d")
    ax.plot_trisurf(
        verts[:, 2], verts[:, 1], faces, verts[:, 0],
        cmap="Reds", lw=0, alpha=0.85,
    )
    ax.set_box_aspect((1, 1, 1))
    ax.set_title("Liver parenchyma — 3D mesh (downsampled)", fontsize=10)
    ax.axis("off")
    return _figure_to_png_bytes(fig)
