# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LI-RADS-style 6-class lesion classifier.

Rule-based discriminant scorer for the six classes our Triton config
declares (matching `triton-models/liverra-lilnet-classify/config.pbtxt`):

    [hcc, icc, metastasis, fnh, hemangioma, cyst]

Output is a softmax over hand-coded discriminant scores, plus a list of
human-readable reasoning strings that explain why each class was scored.
This is NOT the upstream LiLNet model — it's a clinically-grounded
interim classifier that produces the same `[6]` logit signature LiLNet
would, with the advantage that every prediction is explainable.

Each lesion type has a textbook 4-phase enhancement signature in
contrast-enhanced CT:

    HCC          arterial hyperenhancement (APHE) + PV/delayed washout
    ICC          progressive enhancement (delayed > arterial), peripheral
    Metastasis   hypovascular across phases; rim enhancement
    FNH          APHE + iso/hyper in PV/delayed (no washout)
    Hemangioma   peripheral nodular fill-in, progressive (D > PV > A)
    Cyst         water density (~0 HU) all phases, no enhancement

The rules below are intentionally simple — we trade specificity for
interpretability and auditability. Real clinical use should compare
predictions against radiologist labels on a held-out set before any
clinical claim.
"""
from __future__ import annotations

import math
from typing import Any

CLASS_ORDER: tuple[str, ...] = (
    "hcc", "icc", "metastasis", "fnh", "hemangioma", "cyst"
)


def _softmax(scores: dict[str, float], temperature: float = 1.0) -> dict[str, float]:
    """Numerically-stable softmax over the 6 classes."""
    if not scores:
        return {c: 1.0 / len(CLASS_ORDER) for c in CLASS_ORDER}
    max_s = max(scores.values())
    exp_scores = {c: math.exp((s - max_s) / max(temperature, 1e-6)) for c, s in scores.items()}
    total = sum(exp_scores.values())
    return {c: exp_scores[c] / total for c in CLASS_ORDER}


def classify_lesion(features: dict, *, temperature: float = 0.7) -> dict[str, Any]:
    """Classify one lesion from its 4-phase enhancement features.

    Parameters
    ----------
    features
        Output of
        :func:`src.orchestrator.lesion_enhancement_features.extract_lesion_features`.
    temperature
        Softmax temperature. Lower values give more confident top-1.

    Returns
    -------
    dict with::

        {
            "logits": {class: score, ...},
            "probabilities": {class: prob, ...},  # sums to 1.0
            "top1": str,
            "top1_confidence": float,
            "reasoning": [str, ...],              # human-readable rules that fired
            "input_summary": {                    # echo of key features for audit
                "rel_arterial": float,
                "rel_portal_venous": float,
                "rel_delayed": float,
                "abs_non_contrast": float,
                ...
            }
        }
    """
    pat = features.get("enhancement_pattern", {})
    phases = features.get("phases", {})
    deltas = features.get("deltas", {})

    def _rel(phase: str) -> float:
        f = phases.get(phase, {})
        return 0.0 if f.get("missing") else float(f.get("relative_enhancement", 0.0))

    def _abs(phase: str) -> float:
        f = phases.get(phase, {})
        return 0.0 if f.get("missing") else float(f.get("lesion_mean_hu", 0.0))

    rel_a, rel_pv, rel_d = _rel("arterial"), _rel("portal_venous"), _rel("delayed")
    hu_nc = _abs("non_contrast")

    aphe = bool(pat.get("aphe"))
    washout_pv = bool(pat.get("washout_pv"))
    washout_d = bool(pat.get("washout_delayed"))
    progressive = bool(pat.get("progressive"))
    hypovascular = bool(pat.get("hypovascular"))
    is_water = bool(pat.get("is_water_density"))
    no_enh = bool(pat.get("no_enhancement"))

    scores: dict[str, float] = {c: 0.0 for c in CLASS_ORDER}
    reasoning: list[str] = []

    # Rule 1: Cyst — water density across all phases AND no enhancement.
    # Strong rule (highest weight) because cyst signature is very specific.
    if is_water and no_enh:
        scores["cyst"] += 5.0
        reasoning.append(
            f"Water-density (NC HU={hu_nc:.0f}) and no enhancement across phases → cyst"
        )
    elif is_water:
        # Water density but some enhancement — likely complicated cyst or biliary cystadenoma.
        scores["cyst"] += 2.0
        reasoning.append(
            f"Water-density baseline (NC HU={hu_nc:.0f}) but mild enhancement seen — possible cyst"
        )

    # Rule 2: HCC — APHE + washout (LI-RADS LR-5 hallmark).
    if aphe and (washout_pv or washout_d):
        scores["hcc"] += 4.5
        reasoning.append(
            f"Arterial hyperenhancement (Δ={rel_a:+.0f}) + washout "
            f"(PV={rel_pv:+.0f}, D={rel_d:+.0f}) → HCC pattern (LI-RADS hallmark)"
        )
    elif aphe and not washout_pv and not washout_d:
        # APHE without washout: more FNH-like.
        scores["fnh"] += 3.5
        reasoning.append(
            f"Arterial hyperenhancement (Δ={rel_a:+.0f}) WITHOUT washout "
            f"(PV={rel_pv:+.0f}, D={rel_d:+.0f}) → FNH pattern"
        )
        # Small partial credit to HCC since some HCCs lack classic washout
        scores["hcc"] += 0.8

    # Rule 3: Hemangioma — progressive peripheral fill-in over delayed.
    # We don't have peripheral-vs-central spatial info from the bbox-mean
    # features, so we rely on the temporal progression alone.
    if progressive and rel_d > 5:
        scores["hemangioma"] += 3.5
        reasoning.append(
            f"Progressive enhancement (A={rel_a:+.0f} → PV={rel_pv:+.0f} → D={rel_d:+.0f}) → "
            f"hemangioma pattern (centripetal fill-in)"
        )

    # Rule 4: ICC — late/delayed enhancement without classic APHE.
    if rel_d > rel_a and rel_d > 0 and not aphe and not progressive:
        scores["icc"] += 2.5
        reasoning.append(
            f"Delayed enhancement (Δ={rel_d:+.0f} > Δ_arterial={rel_a:+.0f}) without APHE → "
            f"cholangiocarcinoma (ICC) pattern"
        )

    # Rule 5: Metastasis — hypovascular across all phases (and not cyst).
    if hypovascular and not is_water:
        scores["metastasis"] += 3.0
        reasoning.append(
            f"Hypovascular pattern (rel_A={rel_a:+.0f}, rel_PV={rel_pv:+.0f}) → metastasis"
        )

    # Rule 6: Mild positive enhancement throughout but no specific pattern
    # → ambiguous, put weak prior on metastasis (most common in oncology
    # context; conservative default).
    if max(scores.values()) < 1.0:
        scores["metastasis"] += 0.5
        scores["fnh"] += 0.3
        scores["hemangioma"] += 0.2
        reasoning.append(
            "No discriminant pattern matched — defaulting to weak metastasis prior"
        )

    # Convert to probabilities + top-1
    probabilities = _softmax(scores, temperature=temperature)
    top1 = max(probabilities, key=probabilities.get)
    top1_conf = probabilities[top1]

    input_summary = {
        "non_contrast_hu": _abs("non_contrast"),
        "arterial_hu": _abs("arterial"),
        "portal_venous_hu": _abs("portal_venous"),
        "delayed_hu": _abs("delayed"),
        "rel_arterial": rel_a,
        "rel_portal_venous": rel_pv,
        "rel_delayed": rel_d,
        "deltas": deltas,
        "pattern": pat,
    }

    return {
        "logits": {c: round(scores[c], 3) for c in CLASS_ORDER},
        "probabilities": {c: round(probabilities[c], 4) for c in CLASS_ORDER},
        "top1": top1,
        "top1_confidence": round(top1_conf, 4),
        "reasoning": reasoning,
        "input_summary": input_summary,
    }


__all__ = ["classify_lesion", "CLASS_ORDER"]
