# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.orchestrator.lesion_enhancement_features`.

Covers the regulatory-critical paths:

  * C-CLIN-2: multi-lesion background exclusion — when ``all_lesions_mask``
    is supplied the background HU pool excludes EVERY lesion, not just the
    current one (prevents APHE-positive bias).
  * H-CLIN-3: empty-background fallback — when the parenchyma mask doesn't
    intersect the phase volume, the phase is flagged ``missing=True`` with
    ``reason="empty_background"`` instead of silently using ``bg=0`` (and
    classifying against air as APHE-positive HCC).
  * Per-phase HU stats correctness on a noiseless synthetic case.

All inputs are tiny synthetic numpy arrays — fast unit grade.
"""
from __future__ import annotations

import numpy as np

from src.orchestrator.lesion_enhancement_features import (
    PHASES,
    extract_lesion_features,
)


# ---------------------------------------------------------------------------
# Synthetic-data builders
# ---------------------------------------------------------------------------


def _build_scene(side: int = 16) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    """Return ``(liver, lesion, phases)``.

    Liver is a centered cube; lesion is a 3 × 3 × 3 sub-cube inside it.
    Phase volumes carry constant HU per phase — easy ground-truth
    arithmetic.
    """
    liver = np.zeros((side, side, side), dtype=np.uint8)
    liver[4:12, 4:12, 4:12] = 1
    lesion = np.zeros_like(liver)
    lesion[7:10, 7:10, 7:10] = 1
    # Phase HU: NC=50 (parenchyma), lesion overrides with HU=80 (NC).
    # Arterial: parenchyma=70, lesion=130 → +60 rel (APHE-positive).
    phases: dict[str, np.ndarray] = {}
    for name, par_hu, les_hu in (
        ("non_contrast", 50, 80),
        ("arterial", 70, 130),
        ("portal_venous", 90, 60),  # washout
        ("delayed", 95, 55),  # washout
    ):
        vol = np.full(liver.shape, par_hu, dtype=np.int16)
        vol[lesion > 0] = les_hu
        phases[name] = vol
    return liver, lesion, phases


# ---------------------------------------------------------------------------
# Shape + invariants
# ---------------------------------------------------------------------------


def test_returns_canonical_shape() -> None:
    liver, lesion, phases = _build_scene()
    out = extract_lesion_features(lesion, phases, liver, voxel_ml=0.001)
    assert set(out.keys()) == {
        "volume_ml", "voxels", "phases", "enhancement_pattern", "deltas"
    }
    assert set(out["phases"].keys()) == set(PHASES)
    assert out["voxels"] == 27  # 3 × 3 × 3
    assert out["volume_ml"] == round(27 * 0.001, 2)


def test_phase_hu_stats_correctness() -> None:
    """Constant-HU lesion + parenchyma → exact means / medians / stds."""
    liver, lesion, phases = _build_scene()
    out = extract_lesion_features(lesion, phases, liver, voxel_ml=0.001)
    arterial = out["phases"]["arterial"]
    # Lesion HU = 130 everywhere; bg HU = 70 (excluding lesion + dilation).
    assert arterial["lesion_mean_hu"] == 130.0
    assert arterial["lesion_std_hu"] == 0.0
    assert arterial["background_liver_hu"] == 70.0
    assert arterial["relative_enhancement"] == 60.0


def test_enhancement_pattern_flags_match_synthetic_curve() -> None:
    """The synthetic curve is APHE + washout — flags must match."""
    liver, lesion, phases = _build_scene()
    out = extract_lesion_features(lesion, phases, liver, voxel_ml=0.001)
    pat = out["enhancement_pattern"]
    assert pat["aphe"] is True  # rel_a = 60 > 20
    assert pat["washout_pv"] is True  # rel_pv = -30 < -10
    assert pat["washout_delayed"] is True
    assert pat["progressive"] is False
    assert pat["hypovascular"] is False
    assert pat["is_water_density"] is False
    assert pat["no_enhancement"] is False


# ---------------------------------------------------------------------------
# H-CLIN-3 — empty background
# ---------------------------------------------------------------------------


def test_empty_background_emits_missing_with_reason() -> None:
    """When parenchyma doesn't intersect the phase volume (or every voxel
    is excluded by the all-lesions mask), the phase is flagged
    ``missing=True, reason="empty_background"`` — never ``bg=0`` quietly.
    """
    side = 16
    liver = np.zeros((side, side, side), dtype=np.uint8)
    # Liver overlaps the lesion entirely → after exclusion, NO bg voxels.
    liver[7:10, 7:10, 7:10] = 1
    lesion = np.zeros_like(liver)
    lesion[7:10, 7:10, 7:10] = 1
    phases = {"arterial": np.full(liver.shape, 100, dtype=np.int16)}

    out = extract_lesion_features(
        lesion, phases, liver, voxel_ml=0.001, background_dilation_voxels=0
    )
    arterial = out["phases"]["arterial"]
    assert arterial["missing"] is True
    assert arterial["reason"] == "empty_background"
    # H-CLIN-3 regression guard: relative_enhancement MUST NOT be a
    # number — if it were 0.0 or a finite "lesion - 0" the downstream
    # classifier would confidently call APHE-positive against air.
    re = arterial["relative_enhancement"]
    assert re != re or re is None or isinstance(re, float) and np.isnan(re)


# ---------------------------------------------------------------------------
# C-CLIN-2 — multi-lesion background exclusion
# ---------------------------------------------------------------------------


def test_multi_lesion_background_excludes_other_lesions() -> None:
    """The background HU pool MUST exclude voxels belonging to OTHER lesions.

    Setup: one HCC-like lesion + one hemangioma-like lesion in the same
    liver. WITHOUT ``all_lesions_mask``, the HCC's background HU is
    contaminated by hemangioma HU and the HCC's relative enhancement
    scores lower. WITH ``all_lesions_mask``, the bg pool is pure
    parenchyma and the HCC reads its true APHE signal.
    """
    side = 32
    liver = np.zeros((side, side, side), dtype=np.uint8)
    liver[4:28, 4:28, 4:28] = 1  # big liver

    lesion_a = np.zeros_like(liver)  # HCC
    lesion_a[8:12, 8:12, 8:12] = 1
    lesion_b = np.zeros_like(liver)  # hemangioma (high HU on arterial)
    lesion_b[20:24, 20:24, 20:24] = 1

    # Arterial phase: parenchyma=70, lesion_a=130, lesion_b=150.
    arterial = np.full(liver.shape, 70, dtype=np.int16)
    arterial[lesion_a > 0] = 130
    arterial[lesion_b > 0] = 150

    # Run without all_lesions_mask — lesion_b contaminates bg pool.
    no_mask = extract_lesion_features(
        lesion_a, {"arterial": arterial}, liver, voxel_ml=0.001
    )
    bg_contaminated = no_mask["phases"]["arterial"]["background_liver_hu"]

    # Run with all_lesions_mask — pure parenchyma bg.
    all_les = (lesion_a > 0) | (lesion_b > 0)
    with_mask = extract_lesion_features(
        lesion_a, {"arterial": arterial}, liver, voxel_ml=0.001,
        all_lesions_mask=all_les.astype(np.uint8),
    )
    bg_clean = with_mask["phases"]["arterial"]["background_liver_hu"]

    # Clean bg (~70) MUST be lower than contaminated bg (which pulls
    # toward 150 from lesion_b voxels). The C-CLIN-2 fix flips this
    # ordering.
    assert bg_clean < bg_contaminated
    # And the clean bg should be very close to the true parenchyma HU
    # (some dilation buffer still removes a few voxels but doesn't drag
    # the mean significantly).
    assert abs(bg_clean - 70.0) < 1.0


# ---------------------------------------------------------------------------
# Boundary — empty lesion mask
# ---------------------------------------------------------------------------


def test_empty_lesion_mask_returns_zeros() -> None:
    """An all-zero lesion mask short-circuits to an empty result."""
    liver = np.ones((8, 8, 8), dtype=np.uint8)
    lesion = np.zeros_like(liver)
    out = extract_lesion_features(
        lesion, {"arterial": np.full(liver.shape, 100, dtype=np.int16)},
        liver, voxel_ml=0.001,
    )
    assert out["voxels"] == 0
    assert out["volume_ml"] == 0.0


def test_missing_phase_volume_is_marked_missing() -> None:
    """When a phase isn't in ``phase_volumes`` the per-phase dict is
    flagged ``missing=True`` (legacy NaN-tolerant path)."""
    liver, lesion, phases = _build_scene()
    # Drop the delayed phase entirely.
    phases_partial = {k: v for k, v in phases.items() if k != "delayed"}
    out = extract_lesion_features(lesion, phases_partial, liver, voxel_ml=0.001)
    assert out["phases"]["delayed"]["missing"] is True
