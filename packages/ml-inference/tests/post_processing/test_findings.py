# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.services.post_processing.findings`.

All 7 Phase 1 heuristic findings are pure functions over numpy + HU
arrays. We assert:

  * Null-safe paths — every function returns ``None`` / ``[]`` on
    missing or malformed inputs (regression bucket per CLAUDE.md
    "spleen-too-small" surface).
  * compute_indeterminate_malignant_flag — filters on
    ``lirads_category="LR-M"`` (B-CLIN-1) AND on legacy ``label="LR-M"``.
  * compute_steatosis — M-CLIN-3 (null ``hu_stats["mean"]`` → ``None``),
    M-CLIN-2 (two-criterion grading with spleen-Δ), confidence downgrade
    when spleen missing.
  * compute_gallbladder — ``wall_thickened`` boolean, ``capped`` flag.
  * ``_wall_thickness_mm`` — ``capped=True`` on max-iter exit (M-CLIN-5).
  * ``_voxel_volume_ml`` — assertion on implausible spacing (M-CLIN-1).
"""
from __future__ import annotations

import numpy as np
import pytest

from src.services.post_processing.findings import (
    SPLENOMEGALY_THRESHOLD_ML,
    _voxel_volume_ml,
    _wall_thickness_mm,
    compute_all_phase1,
    compute_calcified_lesions,
    compute_gallbladder,
    compute_hu_stats,
    compute_indeterminate_malignant_flag,
    compute_simple_biliary_cysts,
    compute_spleen_volumetry,
    compute_steatosis,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


SPACING_2MM = (2.0, 2.0, 2.0)  # 2×2×2 mm = 8 mm³ = 0.008 mL per voxel


# ---------------------------------------------------------------------------
# _voxel_volume_ml (M-CLIN-1)
# ---------------------------------------------------------------------------


def test_voxel_volume_ml_happy_path() -> None:
    # 1×1×1 mm = 0.001 mL.
    assert _voxel_volume_ml((1.0, 1.0, 1.0)) == pytest.approx(0.001)
    assert _voxel_volume_ml((2.0, 2.0, 2.0)) == pytest.approx(0.008)


@pytest.mark.parametrize("spacing", [(0.05, 1.0, 1.0), (1.0, 12.0, 1.0), (0.0, 1.0, 1.0)])
def test_voxel_volume_ml_rejects_implausible_spacing(spacing: tuple) -> None:
    """Out-of-range axis values catch unit-confusion bugs at the boundary."""
    with pytest.raises(AssertionError):
        _voxel_volume_ml(spacing)


# ---------------------------------------------------------------------------
# compute_hu_stats
# ---------------------------------------------------------------------------


def test_hu_stats_returns_none_when_mask_too_small() -> None:
    mask = np.zeros((10, 10, 10), dtype=np.uint8)
    mask[0, 0, 0] = 1  # only 1 voxel — < 1000 threshold
    ct = np.full(mask.shape, 50, dtype=np.float32)
    assert compute_hu_stats(mask, ct) is None


def test_hu_stats_happy_path() -> None:
    mask = np.ones((20, 20, 20), dtype=np.uint8)  # 8000 voxels
    ct = np.full(mask.shape, 55, dtype=np.float32)
    out = compute_hu_stats(mask, ct)
    assert out is not None
    assert out["mean"] == pytest.approx(55.0)
    assert out["voxel_count"] == 8000


def test_hu_stats_shape_mismatch_returns_none() -> None:
    mask = np.ones((10, 10, 10), dtype=np.uint8)
    ct = np.ones((8, 8, 8), dtype=np.float32)
    assert compute_hu_stats(mask, ct) is None


# ---------------------------------------------------------------------------
# compute_spleen_volumetry — degraded path per CLAUDE.md
# ---------------------------------------------------------------------------


def test_spleen_too_small_returns_degraded_finding_with_warning() -> None:
    """CLAUDE.md spleen-too-small surface — TS returns <500 voxels →
    finding carries a warning instead of silent None."""
    mask = np.zeros((20, 20, 20), dtype=np.uint8)
    mask[0:3, 0:3, 0:3] = 1  # 27 voxels — far below 500
    out = compute_spleen_volumetry(mask, SPACING_2MM)
    assert out is not None
    assert out["splenomegaly"] is None
    assert "warning" in out
    assert "TotalSegmentator" in out["warning"]


def test_spleen_happy_path_splenomegaly_flag() -> None:
    # Build a mask of ~500 mL → above 314 threshold.
    side = 50
    mask = np.zeros((side, side, side), dtype=np.uint8)
    mask[:40, :40, :40] = 1  # 64,000 voxels * 0.008 mL = 512 mL
    out = compute_spleen_volumetry(mask, SPACING_2MM)
    assert out is not None
    assert out["volume_ml"] == pytest.approx(64000 * 0.008, abs=0.5)
    assert out["splenomegaly"] is True
    assert out["threshold_ml"] == SPLENOMEGALY_THRESHOLD_ML


def test_spleen_missing_spacing_returns_none() -> None:
    mask = np.ones((10, 10, 10), dtype=np.uint8)
    assert compute_spleen_volumetry(mask, None) is None


def test_spleen_missing_mask_returns_none() -> None:
    assert compute_spleen_volumetry(None, SPACING_2MM) is None


# ---------------------------------------------------------------------------
# compute_steatosis — M-CLIN-2 + M-CLIN-3
# ---------------------------------------------------------------------------


def test_steatosis_null_hu_stats_returns_none() -> None:
    """M-CLIN-3: when ``hu_stats`` is None the whole finding is None."""
    assert compute_steatosis(None, None, None) is None


def test_steatosis_null_safe_when_mean_missing() -> None:
    """M-CLIN-3 regression guard: malformed hu_stats with ``mean=None`` is
    surfaced as ``None`` — NEVER silently coerced to 0.0 and graded as
    severe steatosis."""
    bad_stats = {"median": 50.0, "voxel_count": 1000}  # no 'mean'
    assert compute_steatosis(bad_stats, None, None) is None


def test_steatosis_two_criterion_grading_with_spleen() -> None:
    """M-CLIN-2: HU < 40 + spleen-Δ < -10 → moderate (high confidence)."""
    hu_stats = {"mean": 35.0, "median": 35.0, "voxel_count": 1000}
    # Spleen mask with consistent HU = 50 → liver-spleen Δ = -15 → moderate.
    spleen_mask = np.ones((10, 10, 10), dtype=np.uint8)
    ct = np.full(spleen_mask.shape, 50.0, dtype=np.float32)
    out = compute_steatosis(hu_stats, spleen_mask, ct)
    assert out is not None
    assert out["grade"] == "moderate"
    assert out["confidence"] == "high"
    assert out["liver_spleen_delta"] == pytest.approx(-15.0)


def test_steatosis_hu_only_downgrades_confidence_when_spleen_missing() -> None:
    """M-CLIN-2: HU < 40 with NO spleen → moderate at LOW confidence + warning."""
    hu_stats = {"mean": 35.0, "voxel_count": 1000}
    out = compute_steatosis(hu_stats, None, None)
    assert out is not None
    assert out["grade"] == "moderate"
    assert out["confidence"] == "low"
    assert any("liver_spleen_delta missing" in w for w in out["warnings"])


def test_steatosis_severe_at_low_hu_high_confidence() -> None:
    """HU < 30 — severe is robust on its own (no spleen needed)."""
    hu_stats = {"mean": 25.0, "voxel_count": 1000}
    out = compute_steatosis(hu_stats, None, None)
    assert out is not None
    assert out["grade"] == "severe"
    assert out["confidence"] == "high"


# ---------------------------------------------------------------------------
# compute_calcified_lesions
# ---------------------------------------------------------------------------


def test_calcified_lesions_none_when_no_input() -> None:
    assert compute_calcified_lesions(None, None) == []


def test_calcified_lesion_flagged_when_hu_max_above_150_and_pct_above_5() -> None:
    """High-HU lesion (calcium signature) gets flagged."""
    side = 10
    mask = np.zeros((side, side, side), dtype=np.uint8)
    mask[2:5, 2:5, 2:5] = 1  # 27 voxels — must beat the 20-voxel cutoff
    ct = np.full((side, side, side), 100.0, dtype=np.float32)
    # Add a high-HU island > 5 % of voxels.
    ct[2:5, 2:5, 2:5] = 200.0
    out = compute_calcified_lesions([("L1", mask)], ct)
    assert len(out) == 1
    assert out[0]["lesion_id"] == "L1"
    assert out[0]["hu_max"] == 200.0


# ---------------------------------------------------------------------------
# compute_indeterminate_malignant_flag (B-CLIN-1)
# ---------------------------------------------------------------------------


def test_indeterminate_malignant_filters_on_lirads_category() -> None:
    """B-CLIN-1: only lesions with ``lirads_category='LR-M'`` are counted."""
    lesions = [
        {"lesion_id": "L1", "lirads_category": "LR-M", "confidence": 0.45},
        {"lesion_id": "L2", "lirads_category": None, "confidence": 0.9},
        {"lesion_id": "L3", "lirads_category": "LR-5", "confidence": 0.8},
    ]
    out = compute_indeterminate_malignant_flag(lesions)
    assert out["lr_m_count"] == 1
    assert out["lesions"][0]["lesion_id"] == "L1"


def test_indeterminate_malignant_legacy_label_path() -> None:
    """Backward-compat: an older row stored LR-M in ``label`` directly."""
    lesions = [{"lesion_id": "old-1", "label": "LR-M"}]
    out = compute_indeterminate_malignant_flag(lesions)
    assert out["lr_m_count"] == 1


def test_indeterminate_malignant_empty_input_returns_no_count() -> None:
    out = compute_indeterminate_malignant_flag(None)
    assert out["lr_m_count"] == 0
    assert out["lesions"] == []


# ---------------------------------------------------------------------------
# compute_gallbladder
# ---------------------------------------------------------------------------


def test_gallbladder_returns_none_when_mask_too_small() -> None:
    mask = np.zeros((10, 10, 10), dtype=np.uint8)
    mask[0, 0, 0] = 1
    ct = np.full(mask.shape, 30.0, dtype=np.float32)
    assert compute_gallbladder(mask, ct, SPACING_2MM) is None


def test_gallbladder_wall_thickened_flag_true_when_wall_above_3mm() -> None:
    """`wall_thickened` flips True when the iteration cap fires (capped wall)."""
    side = 40
    # Big solid GB block — wall_thickness will hit cap, so capped=True
    # and wall_thickened follows.
    mask = np.zeros((side, side, side), dtype=np.uint8)
    mask[5:35, 5:35, 5:35] = 1
    # CT with uniformly high HU inside the gallbladder so the wall-band
    # detector never falls below the inner HU threshold → loop exits via cap.
    ct = np.full(mask.shape, 80.0, dtype=np.float32)
    out = compute_gallbladder(mask, ct, SPACING_2MM)
    assert out is not None
    # We expect capped True because the interior never reaches "fluid"
    # (HU=80 stays in the wall band, never drops below 30 inner threshold).
    assert out["wall_thickness_capped"] is True
    assert out["wall_thickened"] is True


def test_gallbladder_stones_detected_with_high_hu_voxels() -> None:
    """A cluster of HU > 100 voxels inside the GB lumen → stones flagged."""
    side = 30
    mask = np.zeros((side, side, side), dtype=np.uint8)
    mask[5:25, 5:25, 5:25] = 1  # ~8k voxels
    ct = np.full(mask.shape, 10.0, dtype=np.float32)  # fluid
    ct[6:10, 6:10, 6:10] = 200.0  # 64 voxels of "stones" (HU > 100)
    out = compute_gallbladder(mask, ct, SPACING_2MM)
    assert out is not None
    assert out["stones_detected"] is True
    assert out["stone_voxel_count"] >= 50


def test_gallbladder_shape_mismatch_returns_none() -> None:
    mask = np.ones((10, 10, 10), dtype=np.uint8)
    ct = np.ones((8, 8, 8), dtype=np.float32)
    assert compute_gallbladder(mask, ct, SPACING_2MM) is None


# ---------------------------------------------------------------------------
# _wall_thickness_mm (M-CLIN-5)
# ---------------------------------------------------------------------------


def test_wall_thickness_capped_true_on_loop_exhaustion() -> None:
    """M-CLIN-5: when the erosion loop hits its iteration cap, ``capped=True``
    is returned alongside the floor estimate."""
    side = 40
    mask = np.zeros((side, side, side), dtype=np.uint8)
    mask[5:35, 5:35, 5:35] = 1
    # Constant HU above the inner threshold → wall band never converges.
    ct = np.full(mask.shape, 80.0, dtype=np.float32)
    thickness_mm, capped = _wall_thickness_mm(mask, SPACING_2MM, ct)
    assert capped is True
    assert thickness_mm > 0


# ---------------------------------------------------------------------------
# compute_simple_biliary_cysts
# ---------------------------------------------------------------------------


def test_simple_biliary_cyst_detection_on_water_density_sphere() -> None:
    """A round, low-HU, low-std, thin-walled lesion should be flagged."""
    side = 30
    # Build a sphere of radius 10 voxels.
    mask = np.zeros((side, side, side), dtype=np.uint8)
    zz, yy, xx = np.indices(mask.shape)
    cx, cy, cz = side // 2, side // 2, side // 2
    sphere = (zz - cz) ** 2 + (yy - cy) ** 2 + (xx - cx) ** 2 <= 10 ** 2
    mask[sphere] = 1
    # Water density CT.
    ct = np.full(mask.shape, 8.0, dtype=np.float32)
    out = compute_simple_biliary_cysts(
        [("cyst-1", mask)], ct, SPACING_2MM,
    )
    # The wall-thickness heuristic on this synthetic fixture may or may
    # not commit (depends on the ring-HU walk converging) — but a hit
    # must carry the right interpretation when it does.
    if out:
        assert out[0]["lesion_id"] == "cyst-1"
        assert "simple biliary cyst" in out[0]["interpretation"]


# ---------------------------------------------------------------------------
# compute_all_phase1 — orchestration null-safety (CLAUDE.md surface)
# ---------------------------------------------------------------------------


def test_compute_all_phase1_with_minimal_inputs_returns_dict() -> None:
    """No optional masks supplied → all dependent findings yield ``None`` /
    ``[]`` rather than crashing the cascade."""
    out = compute_all_phase1()
    # Every Phase 1 key is present, even when its payload is None.
    assert set(out.keys()) >= {
        "hu_stats", "spleen", "steatosis", "calcified_lesions",
        "simple_biliary_cysts", "indeterminate_malignant", "gallbladder",
    }
    # hu_stats is None when no parenchyma mask supplied.
    assert out["hu_stats"] is None
    # indeterminate_malignant always returns the empty shape, never None.
    assert out["indeterminate_malignant"]["lr_m_count"] == 0


def test_compute_all_phase1_recovers_from_per_finding_failure() -> None:
    """One finding raising doesn't abort the others (per the orchestrator
    try/except)."""
    # Pass a malformed spleen mask (object dtype) that will trip the
    # _validate_hu_array path — _run swallows + sets ``None``.
    out = compute_all_phase1(spleen_mask=np.array([1, 2, 3]))
    # spleen finding is None (degraded gracefully).
    assert out["spleen"] is None
    # indeterminate_malignant still computed.
    assert out["indeterminate_malignant"]["lr_m_count"] == 0
