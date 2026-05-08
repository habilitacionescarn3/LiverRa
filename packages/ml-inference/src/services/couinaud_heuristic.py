# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Heuristic Couinaud segmentation fallback (Phase B3).

Triggers when the Pictorial-Couinaud Triton model returns empty masks
(model config / preprocessing mismatch on Irakli's Triton). Produces
8 binary masks using anatomical landmarks derived from the cascade's
own portal_vein + hepatic_vein outputs (NOT TotalSegmentator).

Approach (coarse but anatomically motivated):
    * Cantlie line (left/right lobe boundary): vertical plane at the
      X-centroid of the parenchyma mask (gallbladder fossa ↔ IVC line).
    * Portal-bifurcation plane (upper/lower split for segments V/VI vs
      VII/VIII and II/III vs IV-superior): horizontal plane at the
      Z-centroid of the portal-vein mask voxels.
    * Right hepatic vein plane (anterior/posterior split for V/VIII vs
      VI/VII): vertical plane at the Y-centroid of hepatic-vein voxels
      that fall in the right lobe.

This is NOT a clinically-validated segmentation. The point is to give
the report SOMETHING viewable in 8 slots so the per-segment volume
column isn't all zeros while the proper Pictorial-Couinaud model is
debugged on Triton.
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

# Couinaud labels in canonical order — matches couinaud.py's COUINAUD_LABELS.
LABELS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]


def heuristic_couinaud(
    parenchyma: np.ndarray,
    portal: np.ndarray | None,
    hepatic: np.ndarray | None,
) -> np.ndarray:
    """Return a label_map with values 0..8 (0 = background, 1..8 = segments)."""
    if parenchyma.sum() == 0:
        return np.zeros_like(parenchyma, dtype=np.uint8)

    nz = np.argwhere(parenchyma > 0)
    cantlie_x = int(np.median(nz[:, 2]))  # split L (low x) / R (high x)

    # Upper/lower split by portal vein z-extent if available; else use parenchyma midline z.
    if portal is not None and portal.sum() > 0:
        portal_nz = np.argwhere(portal > 0)
        upper_lower_z = int(np.median(portal_nz[:, 0]))
    else:
        upper_lower_z = int(np.median(nz[:, 0]))

    # Anterior/posterior split (right lobe) by hepatic vein Y-position; else parenchyma midline Y.
    if hepatic is not None and hepatic.sum() > 0:
        hep_nz = np.argwhere(hepatic > 0)
        ant_post_y = int(np.median(hep_nz[:, 1]))
    else:
        ant_post_y = int(np.median(nz[:, 1]))

    # Caudate (segment I) approximation: posterior + central. Use a small
    # box near IVC (highest hepatic-vein concentration) at posterior edge.
    if hepatic is not None and hepatic.sum() > 0:
        hep_z_min = int(np.argwhere(hepatic > 0)[:, 0].min())
        caudate_z_max = hep_z_min + max(2, (nz[:, 0].max() - nz[:, 0].min()) // 8)
    else:
        caudate_z_max = upper_lower_z - 5

    Z, Y, X = parenchyma.shape
    zz, yy, xx = np.meshgrid(
        np.arange(Z), np.arange(Y), np.arange(X), indexing="ij"
    )
    is_liver = parenchyma > 0
    is_left = xx < cantlie_x
    is_upper = zz >= upper_lower_z
    is_anterior = yy < ant_post_y  # smaller Y = more anterior in axial conv

    # Caudate (segment I): a thin slab at the posterior central area, all liver
    is_caudate = (
        is_liver
        & (zz < caudate_z_max)
        & (np.abs(xx - cantlie_x) < (X // 16))
    )

    label_map = np.zeros_like(parenchyma, dtype=np.uint8)

    # Left lobe (segments II, III, IV)
    label_map[is_liver & is_left & is_upper & ~is_anterior] = 2  # II
    label_map[is_liver & is_left & ~is_upper & ~is_anterior] = 3  # III
    label_map[is_liver & is_left & is_anterior] = 4  # IV

    # Right lobe (segments V, VI, VII, VIII)
    label_map[is_liver & ~is_left & ~is_upper & is_anterior] = 5  # V (ant inf)
    label_map[is_liver & ~is_left & ~is_upper & ~is_anterior] = 6  # VI (post inf)
    label_map[is_liver & ~is_left & is_upper & ~is_anterior] = 7  # VII (post sup)
    label_map[is_liver & ~is_left & is_upper & is_anterior] = 8  # VIII (ant sup)

    # Caudate overrides
    label_map[is_caudate] = 1

    n_filled = int((label_map > 0).sum())
    n_total = int(is_liver.sum())
    logger.info(
        "heuristic_couinaud: filled %d/%d liver voxels (%d unique segments)",
        n_filled, n_total, len(np.unique(label_map)) - 1,
    )
    return label_map
