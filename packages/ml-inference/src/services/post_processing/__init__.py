# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Phase 1 post-processing heuristics.

Pure-function consumers of TotalSegmentator masks + raw HU volume.
No new ML, no GPU. See ``findings.py`` for the 7 compute functions and
``compute_all_phase1`` for the orchestration helper used by
``scripts/real_cascade.py``.
"""
from __future__ import annotations

from .findings import (
    FINDING_TYPES,
    compute_all_phase1,
    compute_calcified_lesions,
    compute_gallbladder,
    compute_hu_stats,
    compute_indeterminate_malignant_flag,
    compute_simple_biliary_cysts,
    compute_spleen_volumetry,
    compute_steatosis,
)

__all__ = [
    "FINDING_TYPES",
    "compute_all_phase1",
    "compute_calcified_lesions",
    "compute_gallbladder",
    "compute_hu_stats",
    "compute_indeterminate_malignant_flag",
    "compute_simple_biliary_cysts",
    "compute_spleen_volumetry",
    "compute_steatosis",
]
