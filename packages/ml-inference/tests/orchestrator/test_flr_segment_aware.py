# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for the segment-aware Future Liver Remnant computation.

Covers :mod:`src.orchestrator.flr_segment_aware`:

  * Boundary: no vessels → FLR computed without subtraction.
  * H-CLIN-7: vessels_mask provided → vessel voxels removed from BOTH
    per-segment counts AND the total. ``vessels_subtracted`` reflects this.
  * The ``flr_pct = 100 * flr_ml / total_ml`` invariant holds within rounding.
  * Unknown resection pattern raises KeyError.
  * Single non-empty segment (degenerate case) — math doesn't blow up.

Inputs are synthetic 32-cube Couinaud label maps — fast unit grade.
"""
from __future__ import annotations

import numpy as np
import pytest

from src.orchestrator.flr_segment_aware import (
    RESECTION_PATTERNS,
    compute_flr,
    per_segment_volumes,
)


# ---------------------------------------------------------------------------
# Synthetic-data builders
# ---------------------------------------------------------------------------


def _eight_slab_couinaud(side: int = 32) -> np.ndarray:
    """Slice the cube into 8 z-bands labelled 1..8. Each band carries exactly
    one segment so per-segment volume math is trivially verifiable.

    Shape: ``(side, side, side)`` UINT8.
    """
    cube = np.zeros((side, side, side), dtype=np.uint8)
    band = side // 8
    for seg_id in range(1, 9):
        z0 = (seg_id - 1) * band
        z1 = seg_id * band
        cube[z0:z1, :, :] = seg_id
    return cube


# ---------------------------------------------------------------------------
# per_segment_volumes
# ---------------------------------------------------------------------------


def test_per_segment_volumes_no_vessels() -> None:
    couinaud = _eight_slab_couinaud()
    voxel_ml = 0.001  # mock 1 mm³ voxel
    vols = per_segment_volumes(couinaud, voxel_ml=voxel_ml)
    # Each segment carries 4 × 32 × 32 = 4096 voxels → 4.1 mL after .round(2).
    expected = round(4096 * voxel_ml, 2)  # 4.1
    for seg_id in range(1, 9):
        assert vols[seg_id] == pytest.approx(expected, abs=0.01)


def test_per_segment_volumes_with_vessels_subtracts() -> None:
    """H-CLIN-7: voxels inside ``vessels_mask`` are excluded from every
    segment's count."""
    couinaud = _eight_slab_couinaud()
    voxel_ml = 0.001
    # Vessels: a central pillar through every z-slice. Removes exactly
    # 4 × 4 × 32 = 512 voxels TOTAL across 8 segments (so 64 per segment).
    vessels = np.zeros_like(couinaud)
    vessels[:, 14:18, 14:18] = 1

    vols_with = per_segment_volumes(couinaud, voxel_ml=voxel_ml, vessels_mask=vessels)
    vols_without = per_segment_volumes(couinaud, voxel_ml=voxel_ml)

    for seg_id in range(1, 9):
        # With vessels every segment loses 4 (z-band) × 4 × 4 = 64 voxels.
        delta = vols_without[seg_id] - vols_with[seg_id]
        assert delta == pytest.approx(64 * voxel_ml, abs=0.01)


# ---------------------------------------------------------------------------
# compute_flr
# ---------------------------------------------------------------------------


def test_compute_flr_right_hepatectomy_no_vessels() -> None:
    couinaud = _eight_slab_couinaud()
    plane_pose, flr_ml, total_ml = compute_flr(
        couinaud, voxel_ml=0.001, pattern="right_hepatectomy"
    )
    # right_hepatectomy removes V/VI/VII/VIII (4 segments) → FLR = 4/8.
    # Per-segment 4096 vox × 0.001 mL → 4.1 mL after round; ×8 = 32.8 mL.
    assert total_ml == pytest.approx(8 * 4.1, abs=0.05)
    assert flr_ml == pytest.approx(4 * 4.1, abs=0.05)
    assert plane_pose["pattern"] == "right_hepatectomy"
    assert plane_pose["vessels_subtracted"] is False
    assert plane_pose["removed_segments"] == ["V", "VI", "VII", "VIII"]
    assert plane_pose["remnant_segments"] == ["I", "II", "III", "IV"]
    # FLR percentage is exactly 50% for the symmetric 4-vs-4 split.
    assert plane_pose["flr_pct"] == pytest.approx(50.0, abs=0.5)


def test_compute_flr_pct_invariant_holds() -> None:
    """``flr_pct = 100 * flr_ml / total_ml`` within rounding error.

    C-CLIN-1: per_segment + total derive from the same voxel_ml so a
    downstream consumer can rely on the relationship.
    """
    couinaud = _eight_slab_couinaud()
    plane_pose, flr_ml, total_ml = compute_flr(
        couinaud, voxel_ml=0.001, pattern="extended_right"
    )
    expected_pct = round(100.0 * flr_ml / total_ml, 2)
    assert plane_pose["flr_pct"] == pytest.approx(expected_pct, abs=0.01)


def test_compute_flr_with_vessels_subtracts_from_both_sides() -> None:
    """H-CLIN-7 fix: vessels_mask subtracts from BOTH per-segment volumes
    AND the total — so the ratio (and absolute) shifts compared to the
    no-vessels call."""
    couinaud = _eight_slab_couinaud()
    vessels = np.zeros_like(couinaud)
    vessels[:, 14:18, 14:18] = 1  # 512 voxel pillar — 64 per segment

    plane_with, flr_with, total_with = compute_flr(
        couinaud, voxel_ml=0.001, pattern="right_hepatectomy", vessels_mask=vessels,
    )
    _, flr_no, total_no = compute_flr(
        couinaud, voxel_ml=0.001, pattern="right_hepatectomy"
    )

    # ``vessels_subtracted`` flag flips True so downstream consumers know.
    assert plane_with["vessels_subtracted"] is True
    # Vessels removed from total (8 × 64 = 512 voxels = ~0.51 mL). Use a
    # tolerant band because compute_flr sums per-segment .round(2) values
    # so cumulative rounding error stacks.
    assert total_no - total_with == pytest.approx(0.512, abs=0.1)
    # Vessels removed from FLR (4 remnant × 64 = 256 voxels = ~0.26 mL).
    assert flr_no - flr_with == pytest.approx(0.256, abs=0.1)


def test_unknown_resection_pattern_raises() -> None:
    couinaud = _eight_slab_couinaud()
    with pytest.raises(KeyError, match="unknown resection pattern"):
        compute_flr(couinaud, voxel_ml=0.001, pattern="left_trisectionectomy_v999")


def test_single_segment_couinaud_does_not_blow_up() -> None:
    """Degenerate case: only segment II has voxels (e.g. pathological seg
    output). The math must still return a finite FLR without DivByZero."""
    cube = np.zeros((16, 16, 16), dtype=np.uint8)
    cube[:8, :, :] = 2  # only segment II
    plane_pose, flr_ml, total_ml = compute_flr(
        cube, voxel_ml=0.001, pattern="right_hepatectomy"
    )
    assert total_ml > 0
    # right hepatectomy removes V/VI/VII/VIII → segment II is in remnant.
    assert flr_ml > 0
    assert plane_pose["flr_pct"] == pytest.approx(100.0, abs=0.5)


def test_empty_couinaud_returns_zero_pct_without_div_by_zero() -> None:
    """All zeros couinaud → ``flr_pct == 0.0`` (the zero-protected branch)."""
    cube = np.zeros((8, 8, 8), dtype=np.uint8)
    plane_pose, flr_ml, total_ml = compute_flr(
        cube, voxel_ml=0.001, pattern="left_hepatectomy"
    )
    assert total_ml == 0.0
    assert flr_ml == 0.0
    assert plane_pose["flr_pct"] == 0.0


def test_per_segment_payload_contains_roman_keys() -> None:
    couinaud = _eight_slab_couinaud()
    plane_pose, _, _ = compute_flr(
        couinaud, voxel_ml=0.001, pattern="right_hepatectomy"
    )
    assert set(plane_pose["per_segment_ml"].keys()) == set(
        ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]
    )


def test_resection_patterns_constant_is_stable() -> None:
    """Guard the public API: the 6 advertised patterns are present."""
    assert set(RESECTION_PATTERNS.keys()) == {
        "right_hepatectomy",
        "left_hepatectomy",
        "extended_right",
        "extended_left",
        "right_anterior_sectionectomy",
        "left_lateral_sectionectomy",
    }
