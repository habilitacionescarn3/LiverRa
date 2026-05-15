# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Unit tests for the rule-based tumor-type lesion classifier.

Covers the safety-critical paths in
:mod:`src.orchestrator.tumor_type_classifier`:

  * LR-M derivation — malignant top-1 with low confidence flips
    ``lirads_category`` to ``"LR-M"`` (B-CLIN-1).
  * High-confidence malignant predictions never get the LR-M flag.
  * The "indeterminate" path when no rule scores above 1.0 (M-CLIN-4).
  * Each clinical rule shape produces a sensible top-1 prediction.

These are pure rule-based unit tests — no model weights, no ML calls.
"""
from __future__ import annotations

from src.orchestrator.tumor_type_classifier import (
    CLASS_ORDER,
    classify_lesion,
)


def _features(
    *,
    pattern: dict,
    phases: dict | None = None,
    deltas: dict | None = None,
) -> dict:
    """Compose a minimal ``features`` dict matching the classifier contract."""
    return {
        "enhancement_pattern": pattern,
        "phases": phases or {},
        "deltas": deltas or {},
    }


# ---------------------------------------------------------------------------
# Shape + invariants
# ---------------------------------------------------------------------------


def test_returns_canonical_shape() -> None:
    out = classify_lesion(_features(pattern={}))
    assert set(out.keys()) == {
        "logits",
        "probabilities",
        "top1",
        "top1_confidence",
        "lirads_category",
        "reasoning",
        "input_summary",
    }
    # Probabilities sum to ~1.0 across the 6 fixed classes.
    assert set(out["probabilities"].keys()) == set(CLASS_ORDER)
    assert abs(sum(out["probabilities"].values()) - 1.0) < 1e-3


# ---------------------------------------------------------------------------
# Indeterminate (M-CLIN-4)
# ---------------------------------------------------------------------------


def test_indeterminate_path_when_no_rule_scores_above_one() -> None:
    """No discriminant pattern fires → top1='indeterminate' with 1/6 conf."""
    out = classify_lesion(_features(pattern={}))
    assert out["top1"] == "indeterminate"
    # Equiprobable across 6 classes.
    assert abs(out["top1_confidence"] - (1.0 / 6.0)) < 1e-3
    assert any("indeterminate" in r.lower() for r in out["reasoning"])
    # An indeterminate result should never carry an LR-M flag — LR-M
    # explicitly requires a malignant top-1.
    assert out["lirads_category"] is None


# ---------------------------------------------------------------------------
# Cyst rule (highest weight)
# ---------------------------------------------------------------------------


def test_cyst_rule_water_density_plus_no_enhancement() -> None:
    out = classify_lesion(
        _features(
            pattern={"is_water_density": True, "no_enhancement": True},
            phases={"non_contrast": {"missing": False, "lesion_mean_hu": 5.0}},
        )
    )
    assert out["top1"] == "cyst"
    assert out["lirads_category"] is None  # cyst is benign


# ---------------------------------------------------------------------------
# HCC rule — APHE + washout
# ---------------------------------------------------------------------------


def test_hcc_rule_aphe_and_washout_pv() -> None:
    out = classify_lesion(
        _features(
            pattern={"aphe": True, "washout_pv": True},
            phases={
                "arterial": {"missing": False, "relative_enhancement": 45.0},
                "portal_venous": {"missing": False, "relative_enhancement": -20.0},
            },
        )
    )
    assert out["top1"] == "hcc"


def test_hcc_high_confidence_does_not_emit_lr_m() -> None:
    """High-confidence HCC → ``lirads_category=None`` (LR-5, not LR-M)."""
    out = classify_lesion(
        _features(
            pattern={"aphe": True, "washout_pv": True, "washout_delayed": True},
            phases={
                "arterial": {"missing": False, "relative_enhancement": 60.0},
                "portal_venous": {"missing": False, "relative_enhancement": -25.0},
                "delayed": {"missing": False, "relative_enhancement": -30.0},
            },
        )
    )
    assert out["top1"] == "hcc"
    assert out["top1_confidence"] >= 0.6
    assert out["lirads_category"] is None


def test_fnh_rule_aphe_without_washout() -> None:
    out = classify_lesion(
        _features(
            pattern={"aphe": True, "washout_pv": False, "washout_delayed": False},
            phases={
                "arterial": {"missing": False, "relative_enhancement": 40.0},
            },
        )
    )
    assert out["top1"] == "fnh"


# ---------------------------------------------------------------------------
# Hemangioma rule — progressive enhancement
# ---------------------------------------------------------------------------


def test_hemangioma_rule_progressive_fill_in() -> None:
    out = classify_lesion(
        _features(
            pattern={"progressive": True},
            phases={
                "arterial": {"missing": False, "relative_enhancement": 5.0},
                "portal_venous": {"missing": False, "relative_enhancement": 15.0},
                "delayed": {"missing": False, "relative_enhancement": 30.0},
            },
        )
    )
    assert out["top1"] == "hemangioma"


# ---------------------------------------------------------------------------
# ICC rule — delayed-dominant without APHE
# ---------------------------------------------------------------------------


def test_icc_rule_delayed_dominant_no_aphe() -> None:
    out = classify_lesion(
        _features(
            pattern={"aphe": False, "progressive": False},
            phases={
                "arterial": {"missing": False, "relative_enhancement": 5.0},
                "delayed": {"missing": False, "relative_enhancement": 25.0},
            },
        )
    )
    assert out["top1"] == "icc"


# ---------------------------------------------------------------------------
# Metastasis rule — hypovascular
# ---------------------------------------------------------------------------


def test_metastasis_rule_hypovascular_not_water() -> None:
    out = classify_lesion(
        _features(
            pattern={"hypovascular": True, "is_water_density": False},
            phases={
                "arterial": {"missing": False, "relative_enhancement": -15.0},
                "portal_venous": {"missing": False, "relative_enhancement": -10.0},
            },
        )
    )
    assert out["top1"] == "metastasis"


# ---------------------------------------------------------------------------
# LR-M derivation (B-CLIN-1) — the regulatory headline test
# ---------------------------------------------------------------------------


def test_lr_m_derivation_low_confidence_malignant() -> None:
    """Low-confidence malignant prediction → ``lirads_category='LR-M'``.

    We rig the inputs so the metastasis score barely exceeds the no-rule
    threshold (>1.0 to escape "indeterminate") but stays low after
    softmax: a faint hypovascular signature with no other rule firing.
    Hypovascular scores 3.0 → at temperature 0.7 the softmax stays under
    the 0.6 LR-M cutoff because the other classes still carry mass.
    """
    out = classify_lesion(
        _features(
            pattern={"hypovascular": True},
            phases={
                "arterial": {"missing": False, "relative_enhancement": -6.0},
                "portal_venous": {"missing": False, "relative_enhancement": -6.0},
            },
        ),
        temperature=2.0,  # flatten softmax to keep top-1 < 0.6
    )
    assert out["top1"] in ("hcc", "icc", "metastasis")
    assert out["top1_confidence"] < 0.6
    assert out["lirads_category"] == "LR-M"


def test_lr_m_not_set_for_benign_top1() -> None:
    """A benign top-1 (cyst / FNH / hemangioma) never gets the LR-M flag."""
    out = classify_lesion(
        _features(
            pattern={"is_water_density": True, "no_enhancement": True},
            phases={"non_contrast": {"missing": False, "lesion_mean_hu": 2.0}},
        )
    )
    assert out["top1"] == "cyst"
    assert out["lirads_category"] is None
