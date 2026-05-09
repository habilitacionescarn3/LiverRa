# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 1 heuristic findings — pure-function compute layer.

Each ``compute_*`` function consumes numpy masks + the original CT in
Hounsfield units and returns a JSON-serialisable dict (or ``None`` /
empty list when the input is missing or too small to trust). No S3, no
DB, no model calls — just arithmetic.

The orchestration helper :func:`compute_all_phase1` runs all 7 in one
pass and returns ``{finding_type: payload}`` so the cascade can upsert
one row per finding into ``analysis_finding``.

Clinical thresholds are documented inline with their primary source.
See ``docs/research/13-additional-pathologies-model-research.md`` for
the full coverage rationale and sensitivity/specificity literature.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable

import numpy as np

logger = logging.getLogger(__name__)


# Stable string keys persisted in ``analysis_finding.finding_type``.
# Code is the single source of truth; the DB column is free-text on
# purpose so we can extend without migrations.
FINDING_TYPES = (
    "hu_stats",
    "spleen",
    "steatosis",
    "calcified_lesions",
    "simple_biliary_cysts",
    "indeterminate_malignant",
    "gallbladder",
)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _voxel_volume_ml(spacing_mm: tuple[float, float, float]) -> float:
    return float(spacing_mm[0] * spacing_mm[1] * spacing_mm[2]) / 1000.0


def _surface_area_mm2(mask: np.ndarray, spacing_mm: tuple[float, float, float]) -> float:
    """Approximate surface area by counting boundary faces of foreground voxels.

    Each axis contributes the rectangle area perpendicular to that axis;
    summed they yield a stair-stepped over-estimate of the true area
    (good enough for sphericity ranking, which is all we use it for).
    """
    if mask.sum() == 0:
        return 0.0
    sx, sy, sz = spacing_mm
    # Faces exposed = neighbours that are background. axis 0 = z, 1 = y, 2 = x.
    pad = np.pad(mask > 0, 1, mode="constant", constant_values=False)
    z_faces = (pad[:-1, 1:-1, 1:-1] != pad[1:, 1:-1, 1:-1]).sum()
    y_faces = (pad[1:-1, :-1, 1:-1] != pad[1:-1, 1:, 1:-1]).sum()
    x_faces = (pad[1:-1, 1:-1, :-1] != pad[1:-1, 1:-1, 1:]).sum()
    return float(z_faces * sx * sy + y_faces * sx * sz + x_faces * sy * sz)


def _wall_thickness_mm(
    mask: np.ndarray,
    spacing_mm: tuple[float, float, float],
    ct_hu: np.ndarray,
    *,
    inner_hu_max: float = 30.0,
    outer_hu_min: float = 30.0,
) -> float:
    """Estimate wall thickness via repeated 1-voxel erosion until interior HU
    drops below ``inner_hu_max`` (or mask exhausted).

    Returns thickness in millimetres along the smallest in-plane spacing.
    For thin-walled fluid-filled structures (cysts) the boundary HU drops
    to fluid HU within 1-2 erosions; for thick-walled structures (acute
    cholecystitis) it persists.

    This is a coarse approximation — surgical-grade wall measurement
    needs explicit segmentation of inner/outer surfaces. Treat as
    "screening grade" only.
    """
    try:
        from scipy.ndimage import binary_erosion
    except ImportError:
        logger.warning("scipy not available — wall_thickness defaulting to 0")
        return 0.0

    if mask.sum() < 50:
        return 0.0

    in_plane = float(min(spacing_mm))
    current = (mask > 0).copy()
    for step in range(1, 6):
        eroded = binary_erosion(current, iterations=1)
        if eroded.sum() < 10:
            return step * in_plane
        ring = current & ~eroded
        ring_hu = ct_hu[ring]
        if ring_hu.size == 0:
            return step * in_plane
        if float(ring_hu.mean()) < outer_hu_min and float(ring_hu.mean()) > inner_hu_max:
            # Ring is in the wall band — keep eroding.
            current = eroded
            continue
        # Reached fluid interior or fully outside — wall is "step" voxels.
        if float(ring_hu.mean()) <= inner_hu_max:
            return step * in_plane
        current = eroded
    return 5 * in_plane


def _validate_hu_array(arr: np.ndarray | None, *, name: str) -> bool:
    if arr is None:
        return False
    if not isinstance(arr, np.ndarray):
        logger.warning("%s expected ndarray, got %s", name, type(arr).__name__)
        return False
    if arr.size == 0:
        return False
    return True


# ---------------------------------------------------------------------------
# 1. HU statistics
# ---------------------------------------------------------------------------


def compute_hu_stats(
    parenchyma_mask: np.ndarray | None,
    ct_hu: np.ndarray | None,
) -> dict[str, Any] | None:
    """Hounsfield statistics inside the liver parenchyma mask.

    Foundation for steatosis (#3) and future iron / Wilson screens.
    Returns ``None`` if mask is missing or too small.
    """
    if not _validate_hu_array(parenchyma_mask, name="parenchyma_mask"):
        return None
    if not _validate_hu_array(ct_hu, name="ct_hu"):
        return None
    if parenchyma_mask.shape != ct_hu.shape:
        logger.warning(
            "hu_stats: shape mismatch parenchyma=%s ct=%s",
            parenchyma_mask.shape, ct_hu.shape,
        )
        return None

    liver_hu = ct_hu[parenchyma_mask > 0]
    if liver_hu.size < 1000:
        logger.info("hu_stats: parenchyma too small (%d voxels)", liver_hu.size)
        return None

    return {
        "mean":        float(liver_hu.mean()),
        "median":      float(np.median(liver_hu)),
        "p10":         float(np.percentile(liver_hu, 10)),
        "p90":         float(np.percentile(liver_hu, 90)),
        "std":         float(liver_hu.std()),
        "voxel_count": int(liver_hu.size),
    }


# ---------------------------------------------------------------------------
# 2. Spleen volumetry + splenomegaly flag
# ---------------------------------------------------------------------------


# Bezerra et al. 2017 — adult-population reference upper limit.
SPLENOMEGALY_THRESHOLD_ML = 314.0


def compute_spleen_volumetry(
    spleen_mask: np.ndarray | None,
    spacing_mm: tuple[float, float, float] | None,
) -> dict[str, Any] | None:
    if not _validate_hu_array(spleen_mask, name="spleen_mask"):
        return None
    if spacing_mm is None:
        logger.warning("spleen: spacing_mm missing")
        return None

    voxels = int((spleen_mask > 0).sum())
    if voxels < 500:
        logger.info("spleen: mask too small (%d voxels)", voxels)
        return None

    volume_ml = float(voxels * _voxel_volume_ml(spacing_mm))
    return {
        "volume_ml":    volume_ml,
        "splenomegaly": volume_ml > SPLENOMEGALY_THRESHOLD_ML,
        "threshold_ml": SPLENOMEGALY_THRESHOLD_ML,
        "reference":    "Bezerra et al. 2017",
    }


# ---------------------------------------------------------------------------
# 3. Steatosis severity (HU-based)
# ---------------------------------------------------------------------------


def compute_steatosis(
    hu_stats: dict[str, Any] | None,
    spleen_mask: np.ndarray | None,
    ct_hu: np.ndarray | None,
) -> dict[str, Any] | None:
    """Liver-attenuation-based steatosis grade.

    Per RSNA 2024 meta-analysis (sens 82%, spec 94%):
      - liver mean HU < 30                     → severe
      - liver mean HU < 40                     → moderate
      - liver-spleen Δ < -10 HU                → mild (or any of the above)

    Reports both metrics so a future iron-overload-conflict warning
    (iron raises HU; combined with fat that lowers HU, the two can
    cancel and produce a falsely "normal" reading) can layer on top.
    """
    if hu_stats is None:
        return None
    liver_mean = float(hu_stats.get("mean", 0))

    spleen_mean: float | None = None
    delta: float | None = None
    if (
        _validate_hu_array(spleen_mask, name="spleen_mask")
        and _validate_hu_array(ct_hu, name="ct_hu")
        and spleen_mask.shape == ct_hu.shape
    ):
        spleen_hu = ct_hu[spleen_mask > 0]
        if spleen_hu.size >= 100:
            spleen_mean = float(spleen_hu.mean())
            delta = liver_mean - spleen_mean

    if liver_mean < 30:
        grade = "severe"
    elif liver_mean < 40:
        grade = "moderate"
    elif delta is not None and delta < -10:
        grade = "mild"
    else:
        grade = "none"

    warnings: list[str] = []
    if spleen_mean is None:
        warnings.append("liver_spleen_delta missing — spleen mask absent")

    return {
        "grade":               grade,
        "liver_mean_hu":       liver_mean,
        "spleen_mean_hu":      spleen_mean,
        "liver_spleen_delta":  delta,
        "warnings":            warnings,
        "reference":           "RSNA 2024 meta-analysis (sens 82%, spec 94%)",
    }


# ---------------------------------------------------------------------------
# 4. Calcified lesion flag
# ---------------------------------------------------------------------------


def compute_calcified_lesions(
    per_lesion_masks: Iterable[tuple[str, np.ndarray]] | None,
    ct_hu: np.ndarray | None,
) -> list[dict[str, Any]]:
    """Per-lesion calcium screen.

    A lesion qualifies as calcified when both:
      - max HU > 150 (calcium signature)
      - >5% of voxels exceed HU 150 (rules out a single high-HU outlier)

    Differential: treated metastasis, granuloma, calcified HCC.
    """
    if per_lesion_masks is None:
        return []
    if not _validate_hu_array(ct_hu, name="ct_hu"):
        return []

    results: list[dict[str, Any]] = []
    for lesion_id, mask in per_lesion_masks:
        if not _validate_hu_array(mask, name=f"lesion_{lesion_id}"):
            continue
        if mask.shape != ct_hu.shape:
            logger.warning("calcified: shape mismatch lesion=%s ct=%s", mask.shape, ct_hu.shape)
            continue
        inside = ct_hu[mask > 0]
        if inside.size < 20:
            continue
        hu_max = float(inside.max())
        pct_calcified = float((inside > 150).mean())
        if hu_max > 150 and pct_calcified > 0.05:
            results.append({
                "lesion_id":      str(lesion_id),
                "hu_max":         hu_max,
                "pct_calcified":  pct_calcified,
                "interpretation": (
                    "calcified — consider treated metastasis, granuloma, "
                    "or calcified HCC"
                ),
            })
    return results


# ---------------------------------------------------------------------------
# 5. Simple biliary cyst characterization
# ---------------------------------------------------------------------------


def compute_simple_biliary_cysts(
    per_lesion_masks: Iterable[tuple[str, np.ndarray]] | None,
    ct_hu: np.ndarray | None,
    spacing_mm: tuple[float, float, float] | None,
) -> list[dict[str, Any]]:
    """Per-lesion 4-criteria simple-cyst rule.

    A lesion is reported as a simple biliary cyst when ALL hold:
      - mean HU in [0, 20] (water-density)
      - HU stdev < 15 (homogeneous fluid)
      - sphericity > 0.8 (round, not infiltrative)
      - wall thickness < 2 mm

    Clinical impact: simple cysts are benign and need no follow-up;
    flagging them prevents unnecessary MRI workups.
    """
    if per_lesion_masks is None or spacing_mm is None:
        return []
    if not _validate_hu_array(ct_hu, name="ct_hu"):
        return []

    results: list[dict[str, Any]] = []
    for lesion_id, mask in per_lesion_masks:
        if not _validate_hu_array(mask, name=f"lesion_{lesion_id}"):
            continue
        if mask.shape != ct_hu.shape:
            continue
        inside_idx = mask > 0
        inside_hu = ct_hu[inside_idx]
        if inside_hu.size < 50:
            continue
        hu_mean = float(inside_hu.mean())
        hu_std = float(inside_hu.std())

        voxel_count = int(inside_idx.sum())
        volume_mm3 = voxel_count * float(np.prod(spacing_mm))
        sa_mm2 = _surface_area_mm2(mask, spacing_mm)
        if sa_mm2 <= 0:
            continue
        sphericity = float(
            (np.pi ** (1.0 / 3.0)) * ((6.0 * volume_mm3) ** (2.0 / 3.0)) / sa_mm2
        )

        wall_mm = _wall_thickness_mm(mask, spacing_mm, ct_hu)

        if 0 <= hu_mean <= 20 and hu_std < 15 and sphericity > 0.8 and wall_mm < 2.0:
            results.append({
                "lesion_id":         str(lesion_id),
                "hu_mean":           hu_mean,
                "hu_std":            hu_std,
                "sphericity":        sphericity,
                "wall_thickness_mm": wall_mm,
                "interpretation":    "simple biliary cyst (benign — no follow-up needed)",
            })
    return results


# ---------------------------------------------------------------------------
# 6. Indeterminate-malignant (LR-M) exposure
# ---------------------------------------------------------------------------


def compute_indeterminate_malignant_flag(
    lesion_classifications: Iterable[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Surface LR-M lesions already produced by the LI-RADS classifier.

    Pure exposure — no new computation. The cascade's
    ``lirads-rule-classifier-v1`` already labels lesions; this helper
    just filters and shapes the result for the report card.
    """
    if lesion_classifications is None:
        return {"lr_m_count": 0, "lesions": [], "interpretation": "No LR-M lesions detected"}

    lr_m: list[dict[str, Any]] = []
    for c in lesion_classifications:
        label = c.get("label") or c.get("classification")
        if label != "LR-M":
            continue
        lr_m.append({
            "lesion_id":  str(c.get("lesion_id", "")),
            "confidence": c.get("confidence"),
        })

    return {
        "lr_m_count":     len(lr_m),
        "lesions":        lr_m,
        "interpretation": (
            "Indeterminate but probably malignant lesion(s) flagged — "
            "consider biopsy or contrast MRI"
            if lr_m else
            "No LR-M lesions detected"
        ),
    }


# ---------------------------------------------------------------------------
# 7. Gallbladder anatomy + stones
# ---------------------------------------------------------------------------


def compute_gallbladder(
    gallbladder_mask: np.ndarray | None,
    ct_hu: np.ndarray | None,
    spacing_mm: tuple[float, float, float] | None,
) -> dict[str, Any] | None:
    """Volume + stone screening + wall thickness.

    Stones: any cluster of voxels with HU > 100 inside the GB lumen
    (>50 voxels ≈ >0.05 mL of high-attenuation material rules out
    partial volume artefact at the wall).
    """
    if not _validate_hu_array(gallbladder_mask, name="gallbladder_mask"):
        return None
    if not _validate_hu_array(ct_hu, name="ct_hu"):
        return None
    if spacing_mm is None:
        return None
    if gallbladder_mask.shape != ct_hu.shape:
        logger.warning("gallbladder: shape mismatch gb=%s ct=%s",
                       gallbladder_mask.shape, ct_hu.shape)
        return None

    voxels = int((gallbladder_mask > 0).sum())
    if voxels < 500:
        logger.info("gallbladder: mask too small (%d voxels)", voxels)
        return None

    volume_ml = float(voxels * _voxel_volume_ml(spacing_mm))
    inside_hu = ct_hu[gallbladder_mask > 0]
    stone_voxels = int((inside_hu > 100).sum())
    has_stones = stone_voxels > 50

    wall_mm = _wall_thickness_mm(gallbladder_mask, spacing_mm, ct_hu)

    return {
        "volume_ml":         volume_ml,
        "wall_thickness_mm": wall_mm,
        "wall_thickened":    wall_mm > 3.0,
        "stones_detected":   has_stones,
        "stone_voxel_count": stone_voxels,
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def compute_all_phase1(
    *,
    parenchyma_mask: np.ndarray | None = None,
    spleen_mask: np.ndarray | None = None,
    gallbladder_mask: np.ndarray | None = None,
    ct_hu: np.ndarray | None = None,
    per_lesion_masks: Iterable[tuple[str, np.ndarray]] | None = None,
    spacing_mm: tuple[float, float, float] | None = None,
    lesion_classifications: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run all 7 Phase 1 heuristics and return ``{finding_type: payload}``.

    Each finding is wrapped in its own try/except — one failure can't
    abort the others. Missing optional masks (e.g. spleen, gallbladder)
    yield ``None`` payloads for the dependent findings; callers should
    skip ``None`` when persisting.
    """
    findings: dict[str, Any] = {}

    def _run(key: str, fn, *args, **kwargs) -> None:
        try:
            findings[key] = fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 — non-fatal by design
            logger.warning("phase1: %s failed: %s", key, exc)
            findings[key] = None

    # Materialize per-lesion masks once so they can be iterated by both
    # calcified-lesions and simple-biliary-cysts.
    lesion_list = list(per_lesion_masks) if per_lesion_masks is not None else None
    classifications_list = (
        list(lesion_classifications) if lesion_classifications is not None else None
    )

    _run("hu_stats", compute_hu_stats, parenchyma_mask, ct_hu)
    _run("spleen", compute_spleen_volumetry, spleen_mask, spacing_mm)
    _run(
        "steatosis", compute_steatosis,
        findings.get("hu_stats"), spleen_mask, ct_hu,
    )
    _run("calcified_lesions", compute_calcified_lesions, lesion_list, ct_hu)
    _run(
        "simple_biliary_cysts", compute_simple_biliary_cysts,
        lesion_list, ct_hu, spacing_mm,
    )
    _run("indeterminate_malignant", compute_indeterminate_malignant_flag, classifications_list)
    _run("gallbladder", compute_gallbladder, gallbladder_mask, ct_hu, spacing_mm)

    populated = [k for k, v in findings.items() if v not in (None, [], {})]
    logger.info("phase1: computed %d/7 findings (%s)", len(populated), ", ".join(populated))
    return findings
