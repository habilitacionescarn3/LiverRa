# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for :mod:`src.services.calibration.temperature_scaling` (T228).

Covers:

1. Softmax-sum invariance (``sum(softmax(apply(logits))) ≈ 1.0``).
2. Argmax preservation (temperature is monotonic, never changes the
   winning class).
3. Abstention behaviour: when the calibrated max-prob falls below the
   tenant threshold, the classification task must mark the lesion
   ``suggested_class='abstained'``.
4. Degenerate temperatures rejected at construction time.
5. High-temperature limit: T -> ∞ flattens the distribution toward
   uniform, which always triggers abstention.
6. ``load_for_tenant`` falls back to T=1.5 when no calibration row
   exists.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import numpy as np
import pytest

from src.services.calibration import (
    DEFAULT_ABSTENTION_THRESHOLD,
    DEFAULT_TEMPERATURE,
    TemperatureScaler,
)


# ---------------------------------------------------------------------------
# Construction + validation
# ---------------------------------------------------------------------------


def test_default_temperature_is_one_point_five() -> None:
    scaler = TemperatureScaler(tenant_id=uuid4())
    assert scaler.temperature == pytest.approx(DEFAULT_TEMPERATURE)


def test_rejects_zero_temperature() -> None:
    with pytest.raises(ValueError):
        TemperatureScaler(tenant_id=uuid4(), temperature=0.0)


def test_rejects_negative_temperature() -> None:
    with pytest.raises(ValueError):
        TemperatureScaler(tenant_id=uuid4(), temperature=-1.0)


def test_rejects_nan_temperature() -> None:
    with pytest.raises(ValueError):
        TemperatureScaler(tenant_id=uuid4(), temperature=float("nan"))


# ---------------------------------------------------------------------------
# Core scaling + softmax invariants
# ---------------------------------------------------------------------------


def test_apply_divides_by_temperature() -> None:
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=2.0)
    logits = np.array([2.0, 4.0, -6.0])
    np.testing.assert_allclose(scaler.apply(logits), logits / 2.0)


def test_softmax_sums_to_one() -> None:
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.7)
    logits = np.array([3.2, -1.1, 0.7, 4.4, 2.2, -0.3])
    probs = scaler.softmax(logits)
    assert probs.sum() == pytest.approx(1.0, abs=1e-9)


def test_softmax_sums_to_one_for_extreme_logits() -> None:
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    # Magnitudes large enough that a naive exp would overflow.
    logits = np.array([1000.0, 999.5, 998.7, 1001.2, 997.0, 990.0])
    probs = scaler.softmax(logits)
    assert probs.sum() == pytest.approx(1.0, abs=1e-9)
    assert np.all(probs >= 0)
    assert np.all(probs <= 1)


def test_softmax_preserves_argmax() -> None:
    """Temperature is monotonic: top-1 never changes."""
    rng = np.random.default_rng(42)
    logits = rng.normal(size=6)
    hot = TemperatureScaler(tenant_id=uuid4(), temperature=0.5)
    cold = TemperatureScaler(tenant_id=uuid4(), temperature=5.0)
    assert int(np.argmax(hot.softmax(logits))) == int(np.argmax(logits))
    assert int(np.argmax(cold.softmax(logits))) == int(np.argmax(logits))


def test_higher_temperature_flattens_distribution() -> None:
    """Calibration in action: bigger T ⇒ smaller max-prob."""
    logits = np.array([8.0, 1.0, 0.5, -1.0, -0.3, 2.0])
    max_sharp = TemperatureScaler(tenant_id=uuid4(), temperature=1.0).softmax(
        logits
    ).max()
    max_cool = TemperatureScaler(tenant_id=uuid4(), temperature=5.0).softmax(
        logits
    ).max()
    assert max_sharp > max_cool


def test_extreme_temperature_yields_uniform_distribution() -> None:
    """T -> ∞ must drive the softmax toward a uniform 6-way split."""
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1e6)
    logits = np.array([10.0, -3.0, 1.0, 7.0, 0.0, 2.0])
    probs = scaler.softmax(logits)
    uniform = np.full_like(probs, 1.0 / probs.size)
    np.testing.assert_allclose(probs, uniform, atol=1e-5)
    # Abstention threshold 0.65 is always tripped for uniform 6-way.
    assert probs.max() < DEFAULT_ABSTENTION_THRESHOLD


# ---------------------------------------------------------------------------
# Abstention semantics (matches src/tasks/classification.py behaviour)
# ---------------------------------------------------------------------------


def _suggested_class(
    probs: np.ndarray,
    class_order: tuple[str, ...],
    threshold: float,
) -> str:
    """Mirror the abstention decision made in the classification task."""
    max_prob = float(probs.max())
    if max_prob < threshold:
        return "abstained"
    return class_order[int(np.argmax(probs))]


def test_abstains_when_max_prob_below_threshold() -> None:
    class_order = ("hcc", "icc", "metastasis", "fnh", "hemangioma", "cyst")
    # Flat-ish logits mean every class probability ~0.16-ish.
    logits = np.array([0.1, 0.12, 0.09, 0.11, 0.08, 0.1])
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    probs = scaler.softmax(logits)
    assert _suggested_class(probs, class_order, 0.65) == "abstained"


def test_does_not_abstain_when_max_prob_clears_threshold() -> None:
    class_order = ("hcc", "icc", "metastasis", "fnh", "hemangioma", "cyst")
    # Very peaky logits → max-prob approaches 1 after softmax.
    logits = np.array([20.0, -5.0, -5.0, -5.0, -5.0, -5.0])
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    probs = scaler.softmax(logits)
    assert _suggested_class(probs, class_order, 0.65) == "hcc"


def test_threshold_boundary_is_inclusive_of_refusal() -> None:
    """When max-prob equals the threshold, we still accept — abstention
    fires strictly below."""
    class_order = ("hcc", "icc", "metastasis", "fnh", "hemangioma", "cyst")
    # Hand-crafted probability distribution: max = 0.65 exactly.
    probs = np.array([0.65, 0.07, 0.07, 0.07, 0.07, 0.07])
    assert _suggested_class(probs, class_order, 0.65) == "hcc"
    # Barely below threshold → abstain.
    probs_low = np.array([0.6499, 0.0701, 0.07, 0.07, 0.07, 0.07])
    assert _suggested_class(probs_low, class_order, 0.65) == "abstained"


# ---------------------------------------------------------------------------
# load_for_tenant fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_load_for_tenant_defaults_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    tenant_id = uuid4()

    execute_mock = AsyncMock(return_value=SimpleNamespace(first=lambda: None))
    session = SimpleNamespace(execute=execute_mock)

    scaler = await TemperatureScaler.load_for_tenant(tenant_id, session)
    assert scaler.tenant_id == tenant_id
    assert scaler.temperature == pytest.approx(DEFAULT_TEMPERATURE)
    execute_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_load_for_tenant_reads_row_when_present() -> None:
    tenant_id = uuid4()
    execute_mock = AsyncMock(
        return_value=SimpleNamespace(first=lambda: (2.75,))
    )
    session = SimpleNamespace(execute=execute_mock)

    scaler = await TemperatureScaler.load_for_tenant(tenant_id, session)
    assert scaler.temperature == pytest.approx(2.75)


@pytest.mark.asyncio
async def test_load_for_tenant_falls_back_on_db_error(caplog: pytest.LogCaptureFixture) -> None:
    tenant_id = uuid4()
    execute_mock = AsyncMock(side_effect=RuntimeError("simulated DB outage"))
    session = SimpleNamespace(execute=execute_mock)

    scaler = await TemperatureScaler.load_for_tenant(tenant_id, session)
    assert scaler.temperature == pytest.approx(DEFAULT_TEMPERATURE)


# ---------------------------------------------------------------------------
# DB CHECK-compatible probability vector (round-trip invariant)
# ---------------------------------------------------------------------------


def test_probs_satisfy_db_check_constraint() -> None:
    """The classification table has a CHECK that Σprobs ∈ [0.99, 1.01]."""
    logits = np.array([2.0, -1.5, 3.3, 0.2, -0.1, 1.8])
    scaler = TemperatureScaler(tenant_id=uuid4(), temperature=1.5)
    probs = scaler.softmax(logits)
    # Emulate the rounding the task performs before INSERT.
    rounded = {str(i): round(float(p), 6) for i, p in enumerate(probs)}
    total = sum(rounded.values())
    assert 0.99 <= total <= 1.01
