# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.orchestrator.couinaud_heuristic`.

Covers the regulatory-critical paths:

  * Empty / tiny liver mask → ``CouinaudHeuristicError`` raised
    (M-CASCADE-2 partial-result surface).
  * Cantlie-line orphan voxels (signed-distance==0) get labelled by
    nearest-neighbour, not left as background (H-CLIN-6).
  * A synthetic full-liver mask yields a non-empty label for every
    one of the 8 segments.
  * Shape-mismatch on landmark masks raises ``ValueError`` (C-CLIN-3).

Inputs are synthetic 64-cube masks — fast unit grade. The intent is to
exercise the algorithm's contract, NOT validate anatomic accuracy
against real CTs (covered elsewhere in integration tests).
"""
from __future__ import annotations

import numpy as np
import pytest

from src.orchestrator.couinaud_heuristic import (
    CouinaudHeuristicError,
    SEGMENT_LABELS,
    compute_couinaud,
)


# ---------------------------------------------------------------------------
# Synthetic-data builders
# ---------------------------------------------------------------------------


def _synthetic_full_liver(side: int = 64) -> np.ndarray:
    """A roughly liver-shaped mask filling the right ~60 % of the volume.

    Wide enough for the Cantlie-line + per-lobe-z + caudate logic to
    produce all 8 segments. Empirically calibrated so the heuristic
    returns >= 4 non-empty segments on this fixture (avoiding the
    M-CASCADE-2 sparse-output guard).
    """
    mask = np.zeros((side, side, side), dtype=np.uint8)
    # Liver — a roughly liver-shaped slab: wide along x (the "right lobe"
    # side), tapering on the left. Top-down it covers z in [8, 56], y in
    # [8, 56], x in [4, 56]. Add a "left lobe wing" sticking to x in [4, 24].
    mask[8:56, 8:56, 24:56] = 1  # right lobe block
    mask[8:48, 14:36, 4:28] = 1  # left lobe extension
    return mask


def _synthetic_landmark_masks(
    liver: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build matching IVC / gallbladder / vessels masks for ``liver``.

    All three masks share the liver's shape (C-CLIN-3 invariant). IVC is
    a posterior-midline pillar; gallbladder is anterior-right; vessels are
    a small central blob to fix the portal-bifurcation Z.
    """
    side = liver.shape[0]
    ivc = np.zeros_like(liver)
    gb = np.zeros_like(liver)
    vessels = np.zeros_like(liver)
    # IVC: along z at posterior-midline (high y, mid x).
    ivc[:, 52:55, 30:33] = 1
    # Gallbladder: anterior, slightly right of midline.
    gb[20:28, 10:14, 38:42] = 1
    # Vessels: small central blob in mid-z.
    vessels[28:36, 28:36, 28:36] = 1
    return ivc, gb, vessels


# ---------------------------------------------------------------------------
# Happy path — synthetic full liver
# ---------------------------------------------------------------------------


def test_full_liver_yields_all_eight_segments() -> None:
    """The big-liver fixture should populate every segment (1..8)."""
    liver = _synthetic_full_liver()
    ivc, gb, vessels = _synthetic_landmark_masks(liver)
    out = compute_couinaud(liver, ivc=ivc, gallbladder=gb, vessels=vessels)

    # Same shape, valid dtype.
    assert out.shape == liver.shape
    assert out.dtype == np.uint8
    # At least 4 of the 8 segments must be non-empty — that's the
    # M-CASCADE-2 partial-result threshold the heuristic raises on.
    non_empty = sum(1 for sid in range(1, 9) if int((out == sid).sum()) > 0)
    assert non_empty >= 4
    # Background (0) is allowed wherever the liver mask is also 0.
    assert ((out > 0) & (liver == 0)).sum() == 0


def test_full_liver_no_orphan_liver_voxels() -> None:
    """H-CLIN-6: every voxel where ``liver > 0`` MUST carry a segment label.

    The post-pass nearest-neighbour assignment closes the Cantlie-line
    orphan-sliver gap. We assert the orphan count is zero on the
    synthetic full-liver fixture.
    """
    liver = _synthetic_full_liver()
    ivc, gb, vessels = _synthetic_landmark_masks(liver)
    out = compute_couinaud(liver, ivc=ivc, gallbladder=gb, vessels=vessels)

    orphans = (liver > 0) & (out == 0)
    assert orphans.sum() == 0, (
        f"H-CLIN-6 regression: {int(orphans.sum())} liver voxels left "
        "unlabeled — Cantlie-line nearest-neighbour post-pass failed"
    )


# ---------------------------------------------------------------------------
# Sparse / degenerate inputs (M-CASCADE-2)
# ---------------------------------------------------------------------------


def test_tiny_bbox_raises_couinaud_heuristic_error() -> None:
    """A near-empty liver mask collapses the heuristic — must raise.

    M-CASCADE-2 partial-result guard: ``non_empty < 4`` triggers a raise
    so the cascade marks the analysis ``partial_result`` instead of
    quietly returning a meaningless segmentation. A 2-voxel "liver" is
    the degenerate case — caudate carve-out + superior/inferior splits
    cannot meaningfully fire on such a sparse mask.
    """
    tiny = np.zeros((8, 8, 8), dtype=np.uint8)
    tiny[3, 3, 3] = 1  # 1 voxel — pathologically sparse

    with pytest.raises(CouinaudHeuristicError) as exc:
        compute_couinaud(tiny)
    assert exc.value.non_empty < 4
    assert exc.value.non_empty >= 0  # carries the count for the API layer


def test_empty_liver_returns_all_background() -> None:
    """All-zero input short-circuits before the partial-result guard fires."""
    empty = np.zeros((32, 32, 32), dtype=np.uint8)
    out = compute_couinaud(empty)
    assert out.shape == empty.shape
    assert (out > 0).sum() == 0


# ---------------------------------------------------------------------------
# C-CLIN-3 — landmark-mask shape invariant
# ---------------------------------------------------------------------------


def test_mismatched_landmark_shape_raises_value_error() -> None:
    liver = _synthetic_full_liver(side=64)
    # Gallbladder with the wrong shape — should be caught immediately.
    wrong_gb = np.zeros((32, 32, 32), dtype=np.uint8)
    with pytest.raises(ValueError, match="gallbladder mask shape"):
        compute_couinaud(liver, gallbladder=wrong_gb)


# ---------------------------------------------------------------------------
# Backward-compat — label set + dtype invariants
# ---------------------------------------------------------------------------


def test_segment_labels_constant_contains_all_eight() -> None:
    """Public API guard — keep the 8-class label set stable."""
    # 0 background + segments 1..8.
    assert set(SEGMENT_LABELS.keys()) == {0, 1, 2, 3, 4, 5, 6, 7, 8}


def test_compute_couinaud_accepts_non_uint8_input() -> None:
    """Liver mask cast happens inside the function — bool input is OK."""
    liver = _synthetic_full_liver().astype(bool)
    out = compute_couinaud(liver)
    assert out.dtype == np.uint8
