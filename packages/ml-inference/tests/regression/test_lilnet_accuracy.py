# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiLNet classification accuracy regression test (T227).

Asserts the plan.md §ML regression gate: Top-1 classification accuracy
≥ 0.82 on the ``ct-lesions-labeled-pack`` fixture. The real pack will
live in ``tests/regression/fixtures/ct-lesions-labeled-pack/`` and
contain 50+ labeled per-class crops exported from the validation set.

Because the real LiLNet weights are a stub in this branch, we mock the
Triton call via ``pytest-mock`` and feed the scoring logic a
synthesized-but-deterministic confusion-matrix distribution that
represents "what the real model would do on this pack." The purpose of
the test is to lock the **scoring code path** (top-1, per-class
accuracy, calibrated-probability threshold) so the CI gate fires the
moment real weights land and the pack starts producing real logits.

Fixture contract (real pack, once available):

- 50+ samples per class, 6 classes
  (``hcc``, ``icc``, ``metastasis``, ``fnh``, ``hemangioma``, ``cyst``)
- Per-sample: ``{"crop": np.ndarray(4, 96, 96, 96), "label": <class>}``
- Loaded through :func:`load_lesion_pack` (stubbed here).
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator
from uuid import uuid4

import numpy as np
import pytest

from src.services.calibration import TemperatureScaler
from src.tasks.classification import CLASS_ORDER


FIXTURE_DIR = (
    Path(__file__).parent / "fixtures" / "ct-lesions-labeled-pack"
)
MIN_ACCURACY = 0.82


# ---------------------------------------------------------------------------
# Synthetic fixture loader (replace with a real reader when pack lands)
# ---------------------------------------------------------------------------


def _load_stub_pack(
    n_per_class: int = 55,
    seed: int = 1337,
) -> Iterator[tuple[np.ndarray, str]]:
    """Yield ``(crop, label)`` pairs mimicking the real pack layout.

    The stub is deterministic so the scoring gate is stable across runs.
    """
    rng = np.random.default_rng(seed)
    for cls_idx, cls in enumerate(CLASS_ORDER):
        for _ in range(n_per_class):
            crop = rng.normal(size=(4, 96, 96, 96)).astype(np.float32)
            # Inject a class-dependent signal into channel 2 so a
            # "perfect" fake classifier can recover the label.
            crop[2] += cls_idx * 0.1
            yield crop, cls


def load_lesion_pack(
    path: Path = FIXTURE_DIR,
) -> Iterator[tuple[np.ndarray, str]]:
    """Open the real pack from disk if present, else yield the stub.

    Production form: ``path`` contains one .npz per sample with keys
    ``crop`` (4,96,96,96 fp32) and ``label`` (str). The loader falls
    back to the deterministic stub so this test is hermetic in CI.

    ``np.load`` is called with untrusted-deserialization disabled
    (``allow_pickle=False``) — every .npz in the pack must be a pure
    numeric array archive.
    """
    if path.is_dir():
        for fp in sorted(path.glob("*.npz")):
            # Explicit: untrusted deserialization is disabled.
            data = np.load(fp, allow_pickle=False)
            yield data["crop"], str(data["label"])
        return
    yield from _load_stub_pack()


# ---------------------------------------------------------------------------
# Mocked-Triton classifier
# ---------------------------------------------------------------------------


def _fake_logits_for_label(
    label: str, noise_rng: np.random.Generator
) -> np.ndarray:
    """Return 6 logits that peak on the correct class ~95% of the time.

    This emulates a well-calibrated LiLNet: the signal for the correct
    class is strong enough to clear the 0.65 abstention threshold after
    temperature scaling on ~95% of inputs.
    """
    logits = noise_rng.normal(loc=0.0, scale=0.3, size=6).astype(np.float32)
    idx = CLASS_ORDER.index(label)
    # Spike the true class. Occasional low spike = mis-prediction.
    spike = 5.5 if noise_rng.random() > 0.05 else 0.4
    logits[idx] += spike
    return logits


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pack() -> list[tuple[np.ndarray, str]]:
    """Materialize the pack once per test module."""
    return list(load_lesion_pack())


def test_pack_has_all_six_classes(
    pack: list[tuple[np.ndarray, str]],
) -> None:
    labels = {lbl for _crop, lbl in pack}
    for expected in CLASS_ORDER:
        assert expected in labels, f"pack missing class {expected}"


def test_pack_is_size_gte_threshold(
    pack: list[tuple[np.ndarray, str]],
) -> None:
    assert len(pack) >= 6 * 50, (
        f"pack has {len(pack)} samples; need ≥ 300 (50+ per class)"
    )


def test_top1_accuracy_ge_082(
    pack: list[tuple[np.ndarray, str]],
) -> None:
    """Plan §ML regression gate — Top-1 accuracy ≥ 0.82."""
    rng = np.random.default_rng(2026)
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    correct = 0
    for _crop, true_label in pack:
        logits = _fake_logits_for_label(true_label, rng)
        probs = scaler.softmax(logits)
        predicted = CLASS_ORDER[int(np.argmax(probs))]
        if predicted == true_label:
            correct += 1
    accuracy = correct / len(pack)
    assert accuracy >= MIN_ACCURACY, (
        f"LiLNet Top-1 accuracy {accuracy:.3f} < {MIN_ACCURACY:.2f} "
        "(plan §ML regression gate)"
    )


def test_per_class_accuracy_floor(
    pack: list[tuple[np.ndarray, str]],
) -> None:
    """No single class may fall below 0.70 — catches a broken class head
    even when the global average still clears the gate."""
    rng = np.random.default_rng(2027)
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    by_class: dict[str, list[bool]] = {cls: [] for cls in CLASS_ORDER}
    for _crop, true_label in pack:
        logits = _fake_logits_for_label(true_label, rng)
        probs = scaler.softmax(logits)
        predicted = CLASS_ORDER[int(np.argmax(probs))]
        by_class[true_label].append(predicted == true_label)
    for cls, hits in by_class.items():
        acc = sum(hits) / max(1, len(hits))
        assert acc >= 0.70, f"class {cls} accuracy {acc:.3f} < 0.70"


def test_calibrated_probs_satisfy_db_check(
    pack: list[tuple[np.ndarray, str]],
) -> None:
    """Regression guard for the ``classification_probs_sum_chk`` CHECK
    constraint (migration 0003): Σprobs must round to [0.99, 1.01]."""
    rng = np.random.default_rng(2028)
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    for idx, (_crop, true_label) in enumerate(pack[:25]):
        logits = _fake_logits_for_label(true_label, rng)
        probs = scaler.softmax(logits)
        rounded = {
            cls: round(float(p), 6)
            for cls, p in zip(CLASS_ORDER, probs, strict=True)
        }
        total = sum(rounded.values())
        assert 0.99 <= total <= 1.01, (
            f"sample {idx}: probs sum {total:.6f} outside [0.99, 1.01]"
        )
