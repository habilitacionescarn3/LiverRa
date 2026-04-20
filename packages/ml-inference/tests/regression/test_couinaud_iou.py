# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Couinaud-segmentation IoU regression (T209 / SC-004).

Plain-English:
    For US2 we need to prove that the Pictorial Couinaud model still
    parses the liver into the right 8 pie-slices. Before each release
    we replay 20 golden cases, compare the model's label map to the
    hand-curated ground-truth label map, and compute the IoU
    (intersection-over-union — 1.0 = perfect, 0.0 = no overlap) per
    segment. Spec §SC-004 requires the overall mean IoU across all 8
    segments AND all 20 cases to be at least 0.70 — that's the
    surgeon-usability floor set by Prof. Schlitt's review panel.

    If the mean drops below 0.70 the release is blocked.

Test layout mirrors ``test_parenchyma_dice.py``:

    - Large fixture dataset lives outside the repo; set
      ``LIVERRA_GOLDEN_FIXTURES_DIR`` to enable.
    - "Triton response" is a numpy file: the 8-channel softmax volume
      already decoded into an integer label map (1..8).
    - We never call real Triton — this is a regression/contract test,
      not an integration test. Real inference is exercised by the
      staging-tier E2E.

Spec refs:

    - ``spec.md`` §SC-004 (≥0.70 mean IoU; ≥80% "surgically usable"
      surgeon rating)
    - ``contracts/triton-stages.md`` §Stage 3
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


# SC-004 threshold — keep in sync with spec.md.
IOU_THRESHOLD = 0.70

#: 20 golden cases — mirrors spec §Validation dataset (Geo Hospitals
#: 20-scan curated set). Names follow ``ct-NNN`` convention.
GOLDEN_CASES: tuple[str, ...] = tuple(f"ct-{i:03d}" for i in range(1, 21))

COUINAUD_LABELS: tuple[str, ...] = (
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII",
)


def _fixtures_dir() -> Path | None:
    raw = os.environ.get("LIVERRA_GOLDEN_FIXTURES_DIR")
    if not raw:
        return None
    path = Path(raw)
    return path if path.is_dir() else None


SKIP = _fixtures_dir() is None or not _NUMPY_AVAILABLE


def _iou(a, b) -> float:
    """Standard IoU (Jaccard index) for binary masks.

    Returns 1.0 when both masks are empty (vacuous case).
    """
    a_bool = a.astype(bool)
    b_bool = b.astype(bool)
    inter = (a_bool & b_bool).sum()
    union = (a_bool | b_bool).sum()
    if union == 0:
        return 1.0
    return float(inter / union)


def _load_label_map(path: Path):
    """Load a NIfTI label map (uint8, 0..8) as int numpy array."""
    img = nib.load(str(path))
    return np.asarray(img.dataobj).astype(np.int16)


def _load_golden_response(fixtures: Path, case: str):
    """Load the pre-argmaxed Couinaud label map for ``case``.

    Layout: ``golden-responses/couinaud/<case>.npy`` — a uint8 array
    shaped like the ground-truth label map, with values 0..8.
    """
    return np.load(fixtures / "golden-responses" / "couinaud" / f"{case}.npy")


def _per_segment_iou(pred_labels, gt_labels) -> dict[str, float]:
    """Return {segment_label: iou} over the 8 Couinaud regions."""
    out: dict[str, float] = {}
    for idx, label in enumerate(COUINAUD_LABELS, start=1):
        pred = pred_labels == idx
        gt = gt_labels == idx
        out[label] = _iou(pred, gt)
    return out


@pytest.mark.skipif(
    SKIP,
    reason=(
        "Set LIVERRA_GOLDEN_FIXTURES_DIR to a directory containing the golden "
        "Couinaud dataset. See tests/fixtures/README.md."
    ),
)
def test_couinaud_overall_mean_iou_at_least_0_70():
    """Overall mean IoU across 20 cases × 8 segments MUST be ≥ 0.70 (SC-004)."""
    fixtures = _fixtures_dir()
    assert fixtures is not None  # narrow for mypy after SKIP

    # ``rows`` accumulates (case, segment_label, iou). We compute the
    # overall mean as a flat average of the 160 data points so every
    # segment contributes equally — a single dominant segment cannot
    # mask a smaller one collapsing.
    rows: list[tuple[str, str, float]] = []

    for case in GOLDEN_CASES:
        gt = _load_label_map(fixtures / f"{case}-couinaud-gt.nii.gz")
        pred = _load_golden_response(fixtures, case)
        if pred.shape != gt.shape:
            pytest.fail(
                f"shape mismatch in {case}: pred {pred.shape} vs gt {gt.shape}"
            )
        per_seg = _per_segment_iou(pred, gt)
        for label, iou in per_seg.items():
            rows.append((case, label, iou))

    overall_mean = sum(iou for _, _, iou in rows) / len(rows)

    # Per-segment aggregates (useful for debugging when overall is below
    # threshold — often one segment drags the whole mean down).
    per_segment_mean: dict[str, float] = {
        label: sum(i for c, s, i in rows if s == label)
        / len([1 for c, s, i in rows if s == label])
        for label in COUINAUD_LABELS
    }

    # Pretty-print for CI logs. This is intentionally verbose so
    # diffs between releases are readable in the pytest summary.
    print(f"\nCouinaud IoU regression — SC-004 threshold ≥ {IOU_THRESHOLD:.2f}")
    print("-" * 50)
    print(f"  Overall mean IoU: {overall_mean:.4f} across "
          f"{len(GOLDEN_CASES)} cases × {len(COUINAUD_LABELS)} segments "
          f"= {len(rows)} data points")
    print("  Per-segment mean IoU:")
    for label in COUINAUD_LABELS:
        mean_iou = per_segment_mean[label]
        flag = "OK" if mean_iou >= IOU_THRESHOLD else "LOW"
        print(f"    segment {label:<5} {mean_iou:.4f}  [{flag}]")

    assert overall_mean >= IOU_THRESHOLD, (
        f"Overall mean IoU {overall_mean:.4f} below SC-004 threshold "
        f"{IOU_THRESHOLD:.2f}."
    )


@pytest.mark.skipif(
    SKIP,
    reason="Set LIVERRA_GOLDEN_FIXTURES_DIR to enable regression tests.",
)
def test_couinaud_no_segment_dropped():
    """Every ground-truth segment must have IoU > 0 — no segment is lost.

    A "segment lost" case means the model skipped a Couinaud region
    entirely on a scan where the ground truth has voxels for it. That
    indicates a topology failure, not just a low-quality mask, and
    should block the release regardless of the overall mean.
    """
    fixtures = _fixtures_dir()
    assert fixtures is not None

    offenders: list[tuple[str, str]] = []
    for case in GOLDEN_CASES:
        gt = _load_label_map(fixtures / f"{case}-couinaud-gt.nii.gz")
        pred = _load_golden_response(fixtures, case)
        for idx, label in enumerate(COUINAUD_LABELS, start=1):
            gt_has = (gt == idx).any()
            pred_has = (pred == idx).any()
            if gt_has and not pred_has:
                offenders.append((case, label))

    assert not offenders, (
        "Model dropped at least one ground-truth Couinaud segment on "
        f"{len(offenders)} (case, segment) pair(s): {offenders[:5]} ..."
    )
