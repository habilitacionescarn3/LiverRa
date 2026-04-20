# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""VISTA3D Δ-Dice regression (T252 / SC-006).

Plain-English:
    When a surgeon clicks once to fix an under-segmented mask, we
    expect the AI's overlap with the ground truth (Dice) to jump by
    at least **+0.05** after three clicks. Anything smaller means the
    interactive refinement is not buying us enough accuracy to be
    worth the surgeon's time.

We replay three golden cases, apply the exact same three hand-labelled
clicks each time through ``LocalRecompute.composite``, measure the
Dice before vs after, and assert the improvement clears the +0.05 bar.

Spec refs: spec.md §SC-006, FR-015.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

try:
    import numpy as np  # type: ignore[import-untyped]

    _NUMPY_AVAILABLE = True
except ImportError:  # pragma: no cover
    _NUMPY_AVAILABLE = False


DELTA_DICE_THRESHOLD = 0.05
CLICKS_PER_CASE = 3
GOLDEN_CASES = ["vista3d-case-01", "vista3d-case-02", "vista3d-case-03"]


def _fixtures_dir() -> Path | None:
    raw = os.environ.get("LIVERRA_GOLDEN_FIXTURES_DIR")
    if not raw:
        return None
    p = Path(raw) / "vista3d-refine"
    return p if p.is_dir() else None


SKIP = _fixtures_dir() is None or not _NUMPY_AVAILABLE


def _dice(a, b) -> float:
    a_bool = a.astype(bool)
    b_bool = b.astype(bool)
    inter = (a_bool & b_bool).sum()
    denom = a_bool.sum() + b_bool.sum()
    return float((2.0 * inter) / denom) if denom > 0 else 1.0


@pytest.mark.regression
@pytest.mark.skipif(SKIP, reason="Golden fixtures / numpy missing")
def test_vista3d_three_click_delta_dice_meets_threshold() -> None:
    """Assert mean Δ-Dice ≥ +0.05 after 3 clicks across golden cases."""
    from src.services.review.refinement_local_recompute import LocalRecompute

    fx = _fixtures_dir()
    assert fx is not None

    class _Store:
        def __init__(self) -> None:
            self._blobs: dict[str, bytes] = {}

        async def get(self, key: str) -> bytes:
            return self._blobs.get(key, b"")

        async def put(self, key: str, data: bytes) -> str:
            self._blobs[key] = data
            return key

    class _TritonStub:
        """Replay recorded 128³ VISTA3D outputs from disk."""

        def __init__(self, case_dir: Path) -> None:
            self._case = case_dir
            self._call = 0

        async def infer(self, model_name: str, inputs):  # noqa: ANN001
            self._call += 1
            path = self._case / f"click-{self._call}.npy"
            mask = np.load(path)
            return {"mask": mask.astype(np.uint8)}

    deltas: list[float] = []
    for case in GOLDEN_CASES:
        case_dir = fx / case
        if not case_dir.is_dir():
            pytest.skip(f"Missing golden case {case}")
        pred = np.load(case_dir / "ai-mask.npy").astype(np.uint8)
        gt = np.load(case_dir / "gt-mask.npy").astype(np.uint8)
        clicks = np.load(case_dir / "clicks.npy")  # shape (N, 4) [x,y,z,type]
        dice_before = _dice(pred, gt)

        triton = _TritonStub(case_dir)
        store = _Store()
        rec = LocalRecompute(triton=triton, mask_store=store)

        # Simulate in-memory edit loop — no DB round-trips.
        current = pred.copy()
        for i in range(min(CLICKS_PER_CASE, len(clicks))):
            voxel = tuple(int(v) for v in clicks[i][:3])
            click_type = "add" if int(clicks[i][3]) == 1 else "subtract"
            new_bytes, _ = asyncio.run(
                rec._apply_crop_edit(  # type: ignore[attr-defined]
                    mask_bytes=current.tobytes(),
                    shape=current.shape,
                    voxel=voxel,
                    click_type=click_type,
                )
            )
            current = np.frombuffer(new_bytes, dtype=np.uint8).reshape(
                current.shape
            ).copy()

        dice_after = _dice(current, gt)
        deltas.append(dice_after - dice_before)

    mean_delta = float(np.mean(deltas))
    assert mean_delta >= DELTA_DICE_THRESHOLD, (
        f"VISTA3D mean Δ-Dice {mean_delta:.4f} below +{DELTA_DICE_THRESHOLD} "
        f"after {CLICKS_PER_CASE} clicks; deltas={deltas}"
    )
