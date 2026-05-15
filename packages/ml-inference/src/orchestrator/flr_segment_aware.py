# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Segment-aware Future Liver Remnant (FLR) computation.

Given a Couinaud-style label map (1..8 for segments I..VIII; 0 for
non-liver — see :mod:`src.orchestrator.couinaud_heuristic`) and a
resection pattern, returns the FLR volume.

A surgeon's pre-operative question is:

    "If I do <right hepatectomy / extended right / left lateral
    sectionectomy / …>, what FLR is left? Is it above the safety
    threshold (~25–30%) for this patient?"

This module answers that. The 6 standard hepatectomy patterns covered
here cover ≥95% of clinical liver resections.
"""
from __future__ import annotations

from typing import Any

import numpy as np


SEGMENT_NAMES: dict[int, str] = {
    1: "I",
    2: "II",
    3: "III",
    4: "IV",
    5: "V",
    6: "VI",
    7: "VII",
    8: "VIII",
}


# Each pattern lists the segments REMOVED by the resection.
# FLR = total - sum(volume of removed segments).
RESECTION_PATTERNS: dict[str, frozenset[int]] = {
    "right_hepatectomy": frozenset({5, 6, 7, 8}),
    "left_hepatectomy": frozenset({2, 3, 4}),
    "extended_right": frozenset({4, 5, 6, 7, 8}),
    "extended_left": frozenset({2, 3, 4, 5, 8}),
    "right_anterior_sectionectomy": frozenset({5, 8}),
    "left_lateral_sectionectomy": frozenset({2, 3}),
}


def per_segment_volumes(
    couinaud: np.ndarray,
    voxel_ml: float,
    vessels_mask: np.ndarray | None = None,
) -> dict[int, float]:
    """Return ``{segment_id: volume_ml}`` for segments 1..8.

    H-CLIN-7: when ``vessels_mask`` is provided, voxels that fall inside
    the vascular tree are subtracted from the per-segment count. ESSO /
    ALPPS conventions: the major intrahepatic vessels (portal, hepatic
    vein trunks, IVC) are NOT functional parenchyma and should not
    contribute to remnant-volume math. Including them inflates the
    remnant by 5–10 %, which can push a borderline patient from yellow
    into green.
    """
    out: dict[int, float] = {}
    if vessels_mask is not None:
        # Boolean precomputation — keeps the per-segment loop cheap.
        vessels_bool = vessels_mask > 0
    for seg_id in range(1, 9):
        seg_bool = (couinaud == seg_id)
        if vessels_mask is not None:
            seg_bool = seg_bool & ~vessels_bool
        voxels = int(seg_bool.sum())
        out[seg_id] = round(voxels * voxel_ml, 2)
    return out


def compute_flr(
    couinaud: np.ndarray,
    voxel_ml: float,
    pattern: str = "right_hepatectomy",
    vessels_mask: np.ndarray | None = None,
) -> tuple[dict[str, Any], float, float]:
    """Compute Future Liver Remnant (FLR) for a resection pattern.

    Parameters
    ----------
    couinaud
        ``(Z, Y, X)`` UINT8 label map (0 background, 1..8 segments).
    voxel_ml
        Volume of one voxel in mL. Caller computes from CT spacing.
    pattern
        Key from :data:`RESECTION_PATTERNS`. Default is the most common
        clinical resection (right hepatectomy = remove V/VI/VII/VIII).
    vessels_mask
        H-CLIN-7: optional ``(Z, Y, X)`` mask of the intrahepatic
        vascular tree (portal + hepatic veins + IVC, if available).
        When supplied, vessel voxels are excluded from BOTH the
        per-segment volumes and the total — this is the ESSO / ALPPS
        convention: vessels do not contribute to functional parenchyma
        on either side of the resection plane, so FLR % is the ratio of
        functional remnant parenchyma to functional total parenchyma.
        When ``None``, falls back to the previous behaviour (vessels
        counted as parenchyma) — still correct for relative comparisons
        but inflates absolute volumes ~5–10 %.

    Returns
    -------
    plane_pose : dict
        Stored as JSONB in ``flr_calculation.plane_pose``. Carries the
        resection pattern + per-segment volumes + remnant/removed
        segment lists so the UI can render which segments are remnant.
    flr_ml : float
        Remnant volume in mL.
    total_ml : float
        Total liver volume in mL.

    Raises
    ------
    KeyError if ``pattern`` is not in :data:`RESECTION_PATTERNS`.
    """
    if pattern not in RESECTION_PATTERNS:
        raise KeyError(
            f"unknown resection pattern {pattern!r}; "
            f"valid: {sorted(RESECTION_PATTERNS)}"
        )

    per_seg = per_segment_volumes(couinaud, voxel_ml, vessels_mask=vessels_mask)
    total_ml = round(sum(per_seg.values()), 2)
    removed = RESECTION_PATTERNS[pattern]
    remnant = frozenset(range(1, 9)) - removed

    flr_ml = round(sum(per_seg[s] for s in remnant), 2)
    # C-CLIN-1: flr_pct is derived from the SAME total_ml we return, so a
    # downstream "flr_pct ≈ 100 * flr_ml / total_ml" sanity check holds
    # exactly (modulo the .round(2) on each side). When the caller passes
    # `vessels_mask`, total_ml here is the vessel-subtracted total —
    # callers that ALSO store a parenchyma-only "TS native total" should
    # surface flr_pct against THIS total, not the parenchyma one, to
    # avoid drift.
    flr_pct = round(100.0 * flr_ml / total_ml, 2) if total_ml > 0 else 0.0

    plane_pose: dict[str, Any] = {
        "heuristic": "couinaud_segment_aware",
        "pattern": pattern,
        "removed_segments": sorted(SEGMENT_NAMES[s] for s in removed),
        "remnant_segments": sorted(SEGMENT_NAMES[s] for s in remnant),
        "per_segment_ml": {SEGMENT_NAMES[k]: v for k, v in per_seg.items()},
        "flr_pct": flr_pct,
        "vessels_subtracted": vessels_mask is not None,
    }
    return plane_pose, flr_ml, total_ml


__all__ = [
    "RESECTION_PATTERNS",
    "SEGMENT_NAMES",
    "compute_flr",
    "per_segment_volumes",
]
