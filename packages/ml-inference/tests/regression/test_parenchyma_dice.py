# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Parenchyma-segmentation Dice regression (T191 / SC-003).

Plain-English:
    Before every release we replay five golden CT cases through the
    parenchyma stage and measure how close the model's mask is to the
    hand-curated ground truth (the "Dice coefficient" — 1.0 means
    perfect overlap, 0.0 means no overlap). The spec requires the mean
    Dice across the five cases to be **≥ 0.92**. If it drops, we block
    the release.

We keep this test hermetic: the "Triton response" is just a numpy
file on disk (``fixtures/golden-responses/parenchyma/*.npy``). The
fixture dataset itself is large (~hundreds of MB of CT volumes) and
lives outside the repo — set ``LIVERRA_GOLDEN_FIXTURES_DIR`` to point
at a local mount. On CI the path is set via a runner-level secret.

Spec: spec.md §SC-003 ("mean Dice ≥ 0.92 across five representative
cases per pipeline revision").
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

try:
    import numpy as np  # type: ignore[import-untyped]
    import nibabel as nib  # type: ignore[import-untyped]

    _NUMPY_AVAILABLE = True
except ImportError:  # pragma: no cover
    _NUMPY_AVAILABLE = False


# SC-003 threshold — keep in sync with spec.md.
DICE_THRESHOLD = 0.92
GOLDEN_CASES = ["ct-001", "ct-002", "ct-003", "ct-004", "ct-005"]


def _fixtures_dir() -> Path | None:
    raw = os.environ.get("LIVERRA_GOLDEN_FIXTURES_DIR")
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_dir() else None


SKIP = _fixtures_dir() is None or not _NUMPY_AVAILABLE


def _dice(a, b) -> float:
    """Standard Dice-Sørensen coefficient for binary masks."""
    a_bool = a.astype(bool)
    b_bool = b.astype(bool)
    inter = (a_bool & b_bool).sum()
    denom = a_bool.sum() + b_bool.sum()
    return float((2.0 * inter) / denom) if denom > 0 else 1.0


def _load_mask(path: Path):
    """Load a NIfTI mask (int mask) as a boolean numpy array."""
    img = nib.load(str(path))
    return np.asarray(img.dataobj).astype(bool)


def _load_golden_response(fixtures: Path, case: str):
    """Load the mocked Triton response (pre-computed mask) for ``case``."""
    return np.load(fixtures / "golden-responses" / "parenchyma" / f"{case}.npy")


@pytest.mark.skipif(
    SKIP,
    reason=(
        "Set LIVERRA_GOLDEN_FIXTURES_DIR to a directory containing the golden "
        "parenchyma dataset. See tests/fixtures/README.md."
    ),
)
def test_parenchyma_dice_at_least_0_92():
    """Mean Dice across five golden cases MUST be ≥ 0.92 (SC-003)."""
    fixtures = _fixtures_dir()
    assert fixtures is not None  # narrow for mypy after SKIP

    per_case_dice: list[tuple[str, float]] = []
    for case in GOLDEN_CASES:
        gt = _load_mask(fixtures / f"{case}-parenchyma-gt.nii.gz")
        pred = _load_golden_response(fixtures, case)
        score = _dice(pred, gt)
        per_case_dice.append((case, score))

    mean_dice = sum(d for _, d in per_case_dice) / len(per_case_dice)

    # Pretty-print for CI logs.
    print("\nParenchyma Dice regression — SC-003 threshold ≥ {:.2f}".format(DICE_THRESHOLD))
    print("-" * 50)
    for case, d in per_case_dice:
        flag = "OK" if d >= DICE_THRESHOLD else "LOW"
        print(f"  {case:<10} {d:.4f}  [{flag}]")
    print(f"  {'mean':<10} {mean_dice:.4f}")
    print("-" * 50)

    assert mean_dice >= DICE_THRESHOLD, (
        f"Mean Dice {mean_dice:.4f} < {DICE_THRESHOLD} threshold (SC-003 violation)"
    )
