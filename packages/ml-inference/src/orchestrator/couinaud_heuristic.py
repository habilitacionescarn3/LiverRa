# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Anatomy-grounded Couinaud-segment heuristic.

Produces an 8-class label map (1=I, 2=II, …, 8=VIII; 0=non-liver) using
landmarks from TotalSegmentator's `total` task — IVC, gallbladder — plus
the `liver_vessels` mask if available. Splits the liver into:

    Cantlie plane (vertical, parallel to z-axis):
        right lobe (V/VI/VII/VIII) | left lobe (II/III/IV)

    Portal-bifurcation plane (horizontal, at median z of vessels):
        superior |  inferior

    Right-lobe anterior/posterior split (vertical, second plane in right lobe):
        anterior (V/VIII) | posterior (VI/VII)

    Left-lobe medial/lateral split (vertical, second plane in left lobe;
    proxy for falciform/umbilical fissure):
        medial (IV) | lateral (II/III)

    Caudate (I) carved out separately — voxels within ~1.5 cm of IVC,
    inferior to portal bifurcation.

NOT a clinically-validated Couinaud — a defensible anatomical heuristic
that produces sensible per-segment volumes and enables real
resection-pattern FLR. See docs/plans/PHASE_3_GAPS.md.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


# Couinaud label map produced by this module
SEGMENT_LABELS = {
    0: "background",
    1: "I (caudate)",
    2: "II",
    3: "III",
    4: "IV",
    5: "V",
    6: "VI",
    7: "VII",
    8: "VIII",
}


def _centroid_xy(mask: np.ndarray) -> tuple[float, float]:
    """Mean (y, x) over all nonzero voxels. Z is collapsed."""
    nz = np.argwhere(mask > 0)
    if nz.size == 0:
        return float("nan"), float("nan")
    return float(nz[:, 1].mean()), float(nz[:, 2].mean())


def _bbox(mask: np.ndarray) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    nz = np.argwhere(mask > 0)
    if nz.size == 0:
        s = mask.shape
        return (0, s[0] - 1), (0, s[1] - 1), (0, s[2] - 1)
    return (
        (int(nz[:, 0].min()), int(nz[:, 0].max())),
        (int(nz[:, 1].min()), int(nz[:, 1].max())),
        (int(nz[:, 2].min()), int(nz[:, 2].max())),
    )


def _signed_distance_to_line_xy(
    yy: np.ndarray, xx: np.ndarray, p1: tuple[float, float], p2: tuple[float, float]
) -> np.ndarray:
    """Signed perpendicular distance from each (yy, xx) point to the line
    p1→p2 in the xy-plane.

    Sign is consistent across the plane: positive on one side, negative on
    the other. Useful for Cantlie / falciform splits.
    """
    y1, x1 = p1
    y2, x2 = p2
    # 2D cross product magnitude / line length → signed distance
    dx, dy = x2 - x1, y2 - y1
    denom = float(np.hypot(dx, dy)) or 1.0
    return ((xx - x1) * dy - (yy - y1) * dx) / denom


def _portal_bifurcation_z(
    liver: np.ndarray,
    vessels: Optional[np.ndarray],
    lobe_mask_xy: Optional[np.ndarray] = None,
) -> int:
    """Estimate the portal-vein bifurcation Z.

    If ``lobe_mask_xy`` (Y, X bool) is given, restrict the median to that
    lobe's voxels — useful because the right and left lobes can have
    different superior/inferior split heights and a single global Z
    would skew toward the larger lobe (typically right).
    """
    if lobe_mask_xy is not None:
        # Geometric Z midpoint of the lobe, regardless of vessels.
        # The vessel-based estimate is global and biased to the larger lobe.
        zs = []
        for z in range(liver.shape[0]):
            sl = (liver[z] > 0) & lobe_mask_xy
            if sl.any():
                zs.append(z)
        if zs:
            return (min(zs) + max(zs)) // 2
    (zlo, zhi), _, _ = _bbox(liver)
    if vessels is not None and (vessels > 0).any():
        v_in = (vessels > 0) & (liver > 0)
        if v_in.any():
            return int(np.median(np.argwhere(v_in)[:, 0]))
    return int((zlo + zhi) / 2)


def _ivc_centroid_in_liver_z(
    liver: np.ndarray, ivc: Optional[np.ndarray]
) -> tuple[float, float]:
    """IVC (y, x) centroid restricted to z slices where the liver exists.
    Falls back to anatomical prior (posterior-midline of liver bbox)."""
    (zlo, zhi), (ylo, yhi), (xlo, xhi) = _bbox(liver)
    if ivc is not None and (ivc > 0).any():
        ivc_in_liver = ivc.copy()
        ivc_in_liver[:zlo, :, :] = 0
        ivc_in_liver[zhi + 1:, :, :] = 0
        if (ivc_in_liver > 0).any():
            nz = np.argwhere(ivc_in_liver > 0)
            return float(nz[:, 1].mean()), float(nz[:, 2].mean())
    # Fallback: posterior (high y) midline of liver bbox
    return float(ylo + 0.85 * (yhi - ylo)), float(0.5 * (xlo + xhi))


def _gallbladder_centroid(
    liver: np.ndarray, gallbladder: Optional[np.ndarray]
) -> tuple[float, float]:
    """Gallbladder (y, x) centroid; fallback = anterior right-of-midline."""
    if gallbladder is not None and (gallbladder > 0).any():
        return _centroid_xy(gallbladder)
    (_, _), (ylo, yhi), (xlo, xhi) = _bbox(liver)
    # Anterior (low y) right-of-midline (high x in our DICOM convention,
    # but TS NIfTI commonly has patient-right at low x — we approximate
    # below by using the lateral edge of the liver bbox closest to the
    # falciform direction, i.e., away from the IVC midline).
    return float(ylo + 0.25 * (yhi - ylo)), float(xlo + 0.55 * (xhi - xlo))


class CouinaudHeuristicError(RuntimeError):
    """Raised by :func:`compute_couinaud` when output is too sparse to use.

    Caught by the cascade orchestrator to mark ``Analysis.status =
    'partial_result'`` rather than ``'completed'`` (M-CASCADE-2). Carries
    ``non_empty`` so the audit / UI can show "x/8 segments produced".
    """

    def __init__(self, msg: str, *, non_empty: int) -> None:
        super().__init__(msg)
        self.non_empty = non_empty


def compute_couinaud(
    liver: np.ndarray,
    ivc: Optional[np.ndarray] = None,
    gallbladder: Optional[np.ndarray] = None,
    vessels: Optional[np.ndarray] = None,
    voxel_spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> np.ndarray:
    """Return an 8-class Couinaud-style label map for ``liver``.

    Parameters
    ----------
    liver
        ``(Z, Y, X)`` UINT8 binary parenchyma mask.
    ivc, gallbladder, vessels
        Optional landmark masks at the same voxel grid. Missing landmarks
        fall back to anatomical priors (warned about by the caller, not
        here — this module is silent).
    voxel_spacing
        ``(spacing_x, spacing_y, spacing_z)`` in mm — used only for the
        caudate radius (1.5 cm = 15 mm).

    Returns
    -------
    np.ndarray of UINT8 in {0, 1, …, 8} with the same shape as ``liver``.
    Labels are stable across runs given the same inputs.

    Orientation contract (C-CLIN-3)
    --------------------------------
    All mask arrays MUST share the same voxel grid AND be canonicalized
    to a consistent orientation before being passed in. nibabel callers
    should run ``nib.as_closest_canonical(img)`` first; SimpleITK callers
    should ensure all landmark masks were resampled against the same
    reference image (so direction-cosines match).

    The Cantlie line and "right-lobe-is-positive" sign are derived from
    the IVC + gallbladder centroids themselves, so the algorithm is
    robust to L/R swaps as long as the landmark masks live in the SAME
    coordinate frame as the liver mask. The remaining orientation
    assumption is the IVC / gallbladder anatomical-prior fallback in
    :func:`_ivc_centroid_in_liver_z` and :func:`_gallbladder_centroid`
    (only used when those masks are missing) — those default to the
    posterior-midline / anterior-right hint typical of canonical
    radiological axial slices.
    """
    if liver.dtype != np.uint8:
        liver = liver.astype(np.uint8)
    # C-CLIN-3: sanity-check that all landmark masks share the liver's
    # shape — a silent mismatch (e.g., the caller forgot to resample the
    # gallbladder mask to the liver reference) would have the algorithm
    # querying landmarks at the wrong voxel grid and producing a Cantlie
    # line in entirely the wrong place.
    for name, arr in (("ivc", ivc), ("gallbladder", gallbladder), ("vessels", vessels)):
        if arr is not None and arr.shape != liver.shape:
            raise ValueError(
                f"compute_couinaud: {name} mask shape {arr.shape} does not "
                f"match liver mask shape {liver.shape} — caller must "
                f"resample all landmark masks to the same voxel grid "
                f"(see docstring orientation contract)."
            )
    out = np.zeros_like(liver)

    if not (liver > 0).any():
        return out

    (zlo, zhi), (ylo, yhi), (xlo, xhi) = _bbox(liver)

    # ---- 1. Cantlie line in xy-plane: through IVC centroid → gallbladder
    p_ivc = _ivc_centroid_in_liver_z(liver, ivc)
    p_gb = _gallbladder_centroid(liver, gallbladder)

    # If the IVC and gallbladder collapse to nearly the same point (very
    # rare; happens if both fallbacks fired and the bbox is tiny), force
    # the Cantlie line through the bbox midline.
    if abs(p_ivc[0] - p_gb[0]) < 1e-3 and abs(p_ivc[1] - p_gb[1]) < 1e-3:
        p_ivc = (float(0.85 * (yhi - ylo) + ylo), float(0.5 * (xhi + xlo)))
        p_gb = (float(0.25 * (yhi - ylo) + ylo), float(0.5 * (xhi + xlo)))

    # ---- 3. Build per-voxel splits using broadcast index grids
    # We only need 2D (yy, xx) grids since the Cantlie / sub-plane splits
    # are constant across z; the z-plane handles superior/inferior.
    yy, xx = np.meshgrid(
        np.arange(liver.shape[1]),
        np.arange(liver.shape[2]),
        indexing="ij",
    )
    cantlie = _signed_distance_to_line_xy(yy, xx, p_ivc, p_gb)  # (Y, X)

    # Right lobe = positive side of Cantlie ; left lobe = negative side.
    # Determine which sign means "right" by checking which side the bbox
    # x-extent is wider on.
    liver_xy_proj = (liver > 0).any(axis=0)  # (Y, X)
    pos_mass = float((cantlie > 0)[liver_xy_proj].sum())
    neg_mass = float((cantlie < 0)[liver_xy_proj].sum())
    # Convention: the larger lobe in voxel count = right lobe (in adult
    # anatomy the right lobe is ~60% of total liver volume).
    right_is_positive = pos_mass >= neg_mass

    # ---- 2b. Per-lobe portal-bifurcation Z (computed AFTER Cantlie so
    # we can restrict each median to the right or left lobe's xy mask).
    if right_is_positive:
        right_xy = liver_xy_proj & (cantlie > 0)
        left_xy = liver_xy_proj & (cantlie < 0)
    else:
        right_xy = liver_xy_proj & (cantlie < 0)
        left_xy = liver_xy_proj & (cantlie > 0)
    z_pvb_right = _portal_bifurcation_z(liver, vessels, right_xy)
    z_pvb_left = _portal_bifurcation_z(liver, vessels, left_xy)
    # Caudate-related z still uses the global vessel-based estimate
    z_pvb = _portal_bifurcation_z(liver, vessels)

    # ---- 4. Secondary lateral splits within each lobe.
    # Right lobe: split anterior vs. posterior — median of |distance|
    # gives a 50/50 area split (acceptable for V/VIII vs VI/VII proxy).
    # Left lobe: falciform sits ~35% of the way from Cantlie toward the
    # lateral edge, NOT at the median. Using the 35th percentile of
    # |distance| keeps IV ≈ II+III in size (matching adult anatomy).
    cantlie_in_liver = cantlie[liver_xy_proj]
    if right_is_positive:
        right_vals = cantlie_in_liver[cantlie_in_liver > 0]
        left_vals = cantlie_in_liver[cantlie_in_liver < 0]
    else:
        right_vals = cantlie_in_liver[cantlie_in_liver < 0]
        left_vals = cantlie_in_liver[cantlie_in_liver > 0]

    if right_vals.size:
        right_split_dist = float(np.median(np.abs(right_vals)))
    else:
        right_split_dist = 0.0
    if left_vals.size:
        # 35th percentile (not median) — anatomically calibrated: in
        # normal adults segment IV ≈ 10–12 % of liver vs II+III ≈ 10–14 %,
        # so the falciform sits closer to the Cantlie line than the
        # mid-line of the left lobe.
        left_split_dist = float(np.percentile(np.abs(left_vals), 35.0))
    else:
        left_split_dist = 0.0

    # ---- 5. Caudate (segment I): voxels within radius_mm of the IVC,
    # inferior to the portal-bifurcation z. Computed over the liver volume.
    radius_mm = 15.0  # 1.5 cm — typical caudate envelope around IVC
    sx, sy, sz = voxel_spacing
    # Use dy + dx in mm; Z handled by inferiority constraint.
    dy_mm = (yy - p_ivc[0]) * sy
    dx_mm = (xx - p_ivc[1]) * sx
    near_ivc_xy = (dy_mm * dy_mm + dx_mm * dx_mm) <= (radius_mm * radius_mm)

    # ---- 6. Compose the 8-class map by combining splits.
    # Loop once per Z slice — keeps memory bounded for big volumes.
    for z in range(zlo, zhi + 1):
        sl = liver[z] > 0
        if not sl.any():
            continue
        is_superior_right = z >= z_pvb_right
        is_superior_left = z >= z_pvb_left
        # Caudate carve-out: near IVC AND inferior to global portal bifurcation
        caudate_here = sl & near_ivc_xy & (z < z_pvb)

        right_mask = sl & ((cantlie > 0) if right_is_positive else (cantlie < 0))
        left_mask = sl & ((cantlie < 0) if right_is_positive else (cantlie > 0))

        # Anterior in right lobe = closer-to-Cantlie side (small |dist|)
        # Posterior = far-from-Cantlie side (large |dist|)
        if right_is_positive:
            right_anterior = right_mask & (cantlie <= right_split_dist)
            right_posterior = right_mask & (cantlie > right_split_dist)
            # Left medial = closer-to-Cantlie (small |dist| in left lobe)
            left_medial = left_mask & (cantlie >= -left_split_dist)
            left_lateral = left_mask & (cantlie < -left_split_dist)
        else:
            right_anterior = right_mask & (cantlie >= -right_split_dist)
            right_posterior = right_mask & (cantlie < -right_split_dist)
            left_medial = left_mask & (cantlie <= left_split_dist)
            left_lateral = left_mask & (cantlie > left_split_dist)

        z_out = out[z]
        # Right lobe: VIII/VII superior, V/VI inferior (per-lobe Z)
        if is_superior_right:
            z_out[right_anterior] = 8  # VIII
            z_out[right_posterior] = 7  # VII
        else:
            z_out[right_anterior] = 5  # V
            z_out[right_posterior] = 6  # VI
        # Left lobe: II superior, III inferior on lateral; IV unified
        if is_superior_left:
            z_out[left_lateral] = 2  # II
        else:
            z_out[left_lateral] = 3  # III
        z_out[left_medial] = 4  # IV (unified — IVa/IVb subdivision not modeled)
        # Caudate overrides whichever label fell on near-IVC inferior voxels
        z_out[caudate_here] = 1
        out[z] = z_out

    # H-CLIN-6: voxels exactly on the Cantlie line (signed-distance == 0)
    # are neither > 0 nor < 0, so neither right_mask nor left_mask claimed
    # them. Likewise for floating-point boundary cases on the per-lobe
    # sub-splits. A 0.1–0.5 % sliver of liver voxels would otherwise stay
    # labeled as "background" (0), leaking into per-segment volumes and
    # therefore the segment-aware FLR. Post-pass: assign each orphan liver
    # voxel the label of its nearest labeled neighbour.
    liver_mask = liver > 0
    orphans = liver_mask & (out == 0)
    if orphans.any():
        try:
            from scipy.ndimage import distance_transform_edt
            labeled_mask = (out > 0)
            # ``return_indices=True`` returns, for every voxel in the
            # background (=== not labeled), the coordinates of the
            # nearest labeled voxel. We then look up that voxel's label
            # in ``out`` and assign it to the orphan.
            _, indices = distance_transform_edt(
                ~labeled_mask, return_indices=True
            )
            zz_i, yy_i, xx_i = indices
            nearest_labels = out[zz_i, yy_i, xx_i]
            out[orphans] = nearest_labels[orphans]
        except ImportError:
            # Fallback when scipy isn't installed: per-slice mode of the
            # labeled voxels. Coarser but never silently leaves liver
            # voxels with label 0.
            for z in range(zlo, zhi + 1):
                sl_orphans = orphans[z]
                if not sl_orphans.any():
                    continue
                z_out = out[z]
                slice_labels = z_out[z_out > 0]
                if slice_labels.size == 0:
                    continue
                mode_label = int(np.bincount(slice_labels.ravel()).argmax())
                z_out[sl_orphans] = mode_label
                out[z] = z_out

    # M-CASCADE-2: when fewer than 4 of the 8 segments have any voxels,
    # the heuristic has collapsed (typically because the liver bbox is
    # tiny or both IVC + gallbladder priors fired). Reporting `flr_pct=0`
    # downstream is anatomically meaningless — surface this as a partial
    # result so the cascade marks the analysis 'partial_result' and the
    # UI shows the warning instead of a misleading number.
    non_empty = sum(1 for sid in range(1, 9) if int((out == sid).sum()) > 0)
    if non_empty < 4:
        raise CouinaudHeuristicError(
            f"Couinaud heuristic produced only {non_empty}/8 non-empty "
            "segments; cannot trust segment-aware downstream stages",
            non_empty=non_empty,
        )

    return out


__all__ = ["compute_couinaud", "CouinaudHeuristicError", "SEGMENT_LABELS"]
