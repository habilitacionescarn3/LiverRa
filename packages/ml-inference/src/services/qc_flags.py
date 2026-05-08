# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Quality-control flags for an analysis (Phase B2).

Lightweight inspections of the parenchyma mask that catch common
clinically-relevant gotchas without running another model:
    * dome cut-off (liver touches Z=top of CT field-of-view)
    * left lobe missing or under-segmented (left/right ratio out of range)
    * mask too small (likely failed segmentation)

Returns a list of `{level, code, message}` dicts the frontend can
render as a "QC notes" card on the report page.
"""
from __future__ import annotations

import logging
import os
import tempfile
from typing import Any
from uuid import UUID

import numpy as np

logger = logging.getLogger(__name__)


def compute_qc_flags(s3, analysis_id: UUID, study_id: UUID) -> list[dict]:
    """Return a list of QC flags for the analysis. Empty list = all OK."""
    try:
        import SimpleITK as sitk
    except ImportError:
        return []

    bucket = os.environ.get("LIVERRA_ANALYSES_BUCKET", "liverra-analyses-eu-central-1")
    key = f"analyses/{analysis_id}/parenchyma_mask.nii.gz"
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001
        logger.info("qc_flags: parenchyma_mask not yet written: %s", exc)
        return []

    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=True) as tf:
        tf.write(raw)
        tf.flush()
        img = sitk.ReadImage(tf.name)
        mask = sitk.GetArrayFromImage(img).astype(np.uint8)

    flags: list[dict] = []

    voxels = int((mask > 0).sum())
    spacing = img.GetSpacing()  # (X, Y, Z)
    voxel_ml = float(np.prod(spacing) / 1000.0)
    volume_ml = voxels * voxel_ml

    # Mask presence
    if voxels < 1000:
        flags.append({
            "level": "warn",
            "code": "mask_too_small",
            "message": (
                f"Parenchyma mask is very small ({voxels} voxels, ~{volume_ml:.1f} mL). "
                "Segmentation likely failed."
            ),
        })
        return flags  # downstream checks meaningless

    if volume_ml < 800:
        flags.append({
            "level": "warn",
            "code": "low_volume",
            "message": (
                f"Liver volume {volume_ml:.0f} mL is below adult normal "
                f"(typical 1,200-1,800 mL). May indicate under-segmentation."
            ),
        })
    elif volume_ml > 2500:
        flags.append({
            "level": "info",
            "code": "high_volume",
            "message": (
                f"Liver volume {volume_ml:.0f} mL is above adult normal range. "
                f"May reflect hepatomegaly OR over-segmentation of adjacent organs."
            ),
        })

    # Dome cut-off — does the mask touch z=max?
    nz = np.argwhere(mask > 0)
    z_max = int(nz[:, 0].max())
    z_extent = mask.shape[0]
    if z_max >= z_extent - 2:
        flags.append({
            "level": "warn",
            "code": "dome_cutoff",
            "message": (
                "Liver touches the superior edge of the CT field of view "
                "(z=top). Hepatic dome may be cut off — re-acquire with "
                "more superior coverage for surgical planning."
            ),
        })

    # Left vs right lobe (X-centroid as Cantlie line approximation)
    cx = int(round(nz[:, 2].mean()))
    left_voxels = int((mask[:, :, cx:] > 0).sum())  # +x = patient's left side
    right_voxels = int((mask[:, :, :cx] > 0).sum())
    total = left_voxels + right_voxels
    if total > 0:
        left_pct = 100.0 * left_voxels / total
        if left_pct < 20:
            flags.append({
                "level": "warn",
                "code": "left_lobe_small",
                "message": (
                    f"Left lobe is {left_pct:.1f}% of total liver volume "
                    "(typical adult: 30-40%). May indicate left-lobe atrophy "
                    "or under-segmentation."
                ),
            })
        elif left_pct > 50:
            flags.append({
                "level": "info",
                "code": "left_lobe_dominant",
                "message": (
                    f"Left lobe is {left_pct:.1f}% of total liver "
                    "(unusual; check for right-lobe atrophy or hypertrophy "
                    "from prior intervention)."
                ),
            })

    return flags
