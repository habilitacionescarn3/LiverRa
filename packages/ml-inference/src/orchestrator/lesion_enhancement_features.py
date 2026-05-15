# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-lesion 4-phase enhancement feature extraction.

Given a lesion mask + 4 contrast-phase CT volumes (non_contrast, arterial,
portal_venous, delayed) + the parenchyma mask, computes:

  - Mean / median / std HU of the lesion in each phase
  - Mean HU of the surrounding liver background (parenchyma minus the
    lesion + a small dilation margin) in each phase
  - Relative enhancement (lesion HU − background HU) per phase
  - Enhancement deltas (e.g., A − NC) per phase pair

These features are the input signature LiLNet would have consumed and are
also clinically-readable on their own — radiologists call them the
"enhancement curve" or "wash-in / wash-out pattern".
"""
from __future__ import annotations

from typing import Mapping

import numpy as np

PHASES = ("non_contrast", "arterial", "portal_venous", "delayed")


def _safe_mean(arr: np.ndarray) -> float:
    return float(arr.mean()) if arr.size else 0.0


def _safe_median(arr: np.ndarray) -> float:
    return float(np.median(arr)) if arr.size else 0.0


def _safe_std(arr: np.ndarray) -> float:
    return float(arr.std()) if arr.size else 0.0


def extract_lesion_features(
    lesion_mask: np.ndarray,
    phase_volumes: Mapping[str, np.ndarray],
    liver_mask: np.ndarray,
    voxel_ml: float,
    background_dilation_voxels: int = 2,
    all_lesions_mask: np.ndarray | None = None,
) -> dict:
    """Compute the 4-phase enhancement signature for one lesion.

    Parameters
    ----------
    lesion_mask
        ``(Z, Y, X)`` bool/uint8 — the single connected component for one
        lesion, in the native CT voxel grid.
    phase_volumes
        Dict mapping phase name (one of :data:`PHASES`) to the
        ``(Z, Y, X)`` HU CT volume in the same voxel grid.
    liver_mask
        ``(Z, Y, X)`` parenchyma mask (uint8/bool) for background HU.
    voxel_ml
        Volume of one voxel in mL — used to compute the lesion volume.
    background_dilation_voxels
        Voxels of margin to exclude around the lesion when computing
        background liver HU. Avoids contamination from peritumoral edema.
    all_lesions_mask
        C-CLIN-2: ``(Z, Y, X)`` union of EVERY lesion mask in this scan
        (including ``lesion_mask`` itself). When supplied, the
        background HU pool excludes voxels belonging to ANY lesion, not
        just the current one. On multi-lesion scans the previous
        implementation included neighbouring lesions in the background,
        biasing the relative-enhancement curve toward APHE-positive
        classifications. When ``None``, falls back to the
        single-lesion behaviour (still correct on solitary-lesion
        scans).

    Returns
    -------
    dict with shape::

        {
            "volume_ml": float,
            "voxels": int,
            "phases": {
                "non_contrast": {
                    "lesion_mean_hu": float,
                    "lesion_median_hu": float,
                    "lesion_std_hu": float,
                    "background_liver_hu": float,
                    "relative_enhancement": float,  # lesion - background
                },
                "arterial": {...}, "portal_venous": {...}, "delayed": {...}
            },
            "enhancement_pattern": {
                "aphe": bool,                   # arterial hyperenhancement
                "washout_pv": bool,             # PV phase darker than liver
                "washout_delayed": bool,        # delayed phase darker
                "progressive": bool,            # PV>A and D>PV
                "hypovascular": bool,           # rel_a<0 and rel_pv<0
                "is_water_density": bool,       # all phases ≈ 0 HU
                "no_enhancement": bool,         # no phase >10 HU above NC
            },
            "deltas": {
                "a_minus_nc": float, "pv_minus_nc": float,
                "d_minus_nc": float, "pv_minus_a": float, "d_minus_pv": float,
            }
        }
    """
    lesion_bool = lesion_mask > 0
    if not lesion_bool.any():
        return {"volume_ml": 0.0, "voxels": 0, "phases": {}, "enhancement_pattern": {}, "deltas": {}}

    # Build background liver mask: parenchyma minus lesion minus a small
    # dilation buffer around the lesion.
    # C-CLIN-2: when ``all_lesions_mask`` is supplied, also strip every
    # other lesion's voxels (with the same dilation buffer) so the
    # background HU pool is pure parenchyma. Otherwise, on a scan with
    # an HCC + a coincident hemangioma, the hemangioma's wash-in
    # artefactually elevates the "background" HU and the HCC's relative
    # enhancement scores too low.
    if all_lesions_mask is not None:
        exclude = (lesion_bool | (all_lesions_mask > 0))
    else:
        exclude = lesion_bool
    if background_dilation_voxels > 0:
        from scipy.ndimage import binary_dilation
        struct = np.ones((3, 3, 3), dtype=bool)
        exclude_dilated = binary_dilation(
            exclude, structure=struct, iterations=background_dilation_voxels
        )
    else:
        exclude_dilated = exclude
    background_bool = (liver_mask > 0) & ~exclude_dilated

    voxels = int(lesion_bool.sum())

    phases_features: dict[str, dict] = {}
    for phase_name in PHASES:
        if phase_name not in phase_volumes:
            phases_features[phase_name] = {
                "lesion_mean_hu": float("nan"),
                "lesion_median_hu": float("nan"),
                "lesion_std_hu": float("nan"),
                "background_liver_hu": float("nan"),
                "relative_enhancement": float("nan"),
                "missing": True,
            }
            continue
        vol = phase_volumes[phase_name]
        lesion_vox = vol[lesion_bool]
        bg_vox = vol[background_bool]
        lesion_mean = _safe_mean(lesion_vox)
        # H-CLIN-3: when the background pool is empty (liver mask
        # didn't intersect with this phase volume, or every parenchymal
        # voxel was excluded by the all-lesions mask), the previous
        # behaviour set ``bg_mean = 0`` silently, so the downstream
        # classifier confidently labeled the lesion against AIR (-1000
        # HU) as APHE-positive HCC. Flag the phase as missing instead;
        # callers (e.g., classifier) check ``.get("missing")`` and skip.
        if bg_vox.size == 0:
            phases_features[phase_name] = {
                "lesion_mean_hu":       round(lesion_mean, 2),
                "lesion_median_hu":     round(_safe_median(lesion_vox), 2),
                "lesion_std_hu":        round(_safe_std(lesion_vox), 2),
                "background_liver_hu":  float("nan"),
                "relative_enhancement": float("nan"),
                "missing":              True,
                "reason":               "empty_background",
            }
            continue
        bg_mean = _safe_mean(bg_vox)
        phases_features[phase_name] = {
            "lesion_mean_hu":       round(lesion_mean, 2),
            "lesion_median_hu":     round(_safe_median(lesion_vox), 2),
            "lesion_std_hu":        round(_safe_std(lesion_vox), 2),
            "background_liver_hu":  round(bg_mean, 2),
            "relative_enhancement": round(lesion_mean - bg_mean, 2),
            "missing":              False,
        }

    # Pattern flags — robust to any missing phase via .get with defaults
    def _hu(phase: str) -> float:
        f = phases_features.get(phase, {})
        return float(f.get("lesion_mean_hu", 0.0)) if not f.get("missing") else 0.0

    def _rel(phase: str) -> float:
        f = phases_features.get(phase, {})
        return float(f.get("relative_enhancement", 0.0)) if not f.get("missing") else 0.0

    rel_a, rel_pv, rel_d = _rel("arterial"), _rel("portal_venous"), _rel("delayed")
    hu_nc, hu_a, hu_pv, hu_d = _hu("non_contrast"), _hu("arterial"), _hu("portal_venous"), _hu("delayed")

    enhancement_pattern = {
        "aphe": rel_a > 20,
        "washout_pv": rel_pv < -10,
        "washout_delayed": rel_d < -10,
        "progressive": (rel_pv > rel_a) and (rel_d > rel_pv),
        "hypovascular": (rel_a < -5) and (rel_pv < -5),
        "is_water_density": all(abs(x) < 20 for x in (hu_nc, hu_a, hu_pv, hu_d)),
        "no_enhancement": (max(hu_a, hu_pv, hu_d) - hu_nc) < 10,
    }

    deltas = {
        "a_minus_nc": round(hu_a - hu_nc, 2),
        "pv_minus_nc": round(hu_pv - hu_nc, 2),
        "d_minus_nc": round(hu_d - hu_nc, 2),
        "pv_minus_a": round(hu_pv - hu_a, 2),
        "d_minus_pv": round(hu_d - hu_pv, 2),
    }

    return {
        "volume_ml": round(voxels * voxel_ml, 2),
        "voxels": voxels,
        "phases": phases_features,
        "enhancement_pattern": enhancement_pattern,
        "deltas": deltas,
    }


__all__ = ["extract_lesion_features", "PHASES"]
