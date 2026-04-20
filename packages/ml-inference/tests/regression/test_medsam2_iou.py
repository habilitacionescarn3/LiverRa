# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""MedSAM-2 slice-to-slice IoU regression (T253).

Plain-English:
    MedSAM-2 tracks a prompted lesion across adjacent CT slices — the
    neighbouring masks should overlap by at least **0.85 IoU** (80%+
    shared pixels). If the tracker drifts so far that consecutive
    masks barely overlap, the radiologist's single click is not
    reliably producing a 3D lesion.

Plan ref: plan.md §ML regression; spec.md §FR-016.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

try:
    import numpy as np  # type: ignore[import-untyped]

    _NUMPY_AVAILABLE = True
except ImportError:  # pragma: no cover
    _NUMPY_AVAILABLE = False


IOU_THRESHOLD = 0.85
GOLDEN_CASES = ["medsam2-case-01", "medsam2-case-02", "medsam2-case-03"]


def _fixtures_dir() -> Path | None:
    raw = os.environ.get("LIVERRA_GOLDEN_FIXTURES_DIR")
    if not raw:
        return None
    p = Path(raw) / "medsam2-track"
    return p if p.is_dir() else None


SKIP = _fixtures_dir() is None or not _NUMPY_AVAILABLE


def _iou(a, b) -> float:
    a_bool = a.astype(bool)
    b_bool = b.astype(bool)
    inter = (a_bool & b_bool).sum()
    union = (a_bool | b_bool).sum()
    return float(inter / union) if union > 0 else 1.0


@pytest.mark.regression
@pytest.mark.skipif(SKIP, reason="Golden fixtures / numpy missing")
def test_medsam2_slice_iou_stays_above_threshold() -> None:
    """Assert min adjacent-slice IoU ≥ 0.85 across every golden case."""
    fx = _fixtures_dir()
    assert fx is not None

    all_ious: list[float] = []
    for case in GOLDEN_CASES:
        case_dir = fx / case
        if not case_dir.is_dir():
            pytest.skip(f"Missing golden case {case}")
        volume = np.load(case_dir / "tracked-mask.npy")  # (Z, H, W) uint8
        assert volume.ndim == 3, "tracked-mask.npy must be 3D"
        # Walk adjacent slices, skipping empty ones (above/below lesion
        # ends) because those IoUs are trivially 1.0 or undefined.
        for z in range(volume.shape[0] - 1):
            a, b = volume[z], volume[z + 1]
            if a.sum() == 0 and b.sum() == 0:
                continue
            iou = _iou(a, b)
            all_ious.append(iou)

    assert all_ious, "No non-empty adjacent slices across golden cases"
    min_iou = float(np.min(all_ious))
    assert min_iou >= IOU_THRESHOLD, (
        f"MedSAM-2 min slice IoU {min_iou:.4f} below {IOU_THRESHOLD}"
    )
