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
    couinaud: np.ndarray, voxel_ml: float
) -> dict[int, float]:
    """Return {segment_id: volume_ml} for segments 1..8."""
    out: dict[int, float] = {}
    for seg_id in range(1, 9):
        voxels = int((couinaud == seg_id).sum())
        out[seg_id] = round(voxels * voxel_ml, 2)
    return out


def compute_flr(
    couinaud: np.ndarray,
    voxel_ml: float,
    pattern: str = "right_hepatectomy",
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

    per_seg = per_segment_volumes(couinaud, voxel_ml)
    total_ml = round(sum(per_seg.values()), 2)
    removed = RESECTION_PATTERNS[pattern]
    remnant = frozenset(range(1, 9)) - removed

    flr_ml = round(sum(per_seg[s] for s in remnant), 2)
    flr_pct = round(100.0 * flr_ml / total_ml, 2) if total_ml > 0 else 0.0

    plane_pose: dict[str, Any] = {
        "heuristic": "couinaud_segment_aware",
        "pattern": pattern,
        "removed_segments": sorted(SEGMENT_NAMES[s] for s in removed),
        "remnant_segments": sorted(SEGMENT_NAMES[s] for s in remnant),
        "per_segment_ml": {SEGMENT_NAMES[k]: v for k, v in per_seg.items()},
        "flr_pct": flr_pct,
    }
    return plane_pose, flr_ml, total_ml


__all__ = [
    "RESECTION_PATTERNS",
    "SEGMENT_NAMES",
    "compute_flr",
    "per_segment_volumes",
]
