# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Cascade-wide numeric defaults — single source of truth (L-CASCADE-1).

Before this module existed, ``_DEFAULT_VOXEL_VOLUME_ML`` was duplicated in
four task modules (``parenchyma``, ``couinaud``, ``vessels``,
``flr_default``). Each copy drifted independently — a bug fix or a
spacing tweak had to be hand-applied four times, and one site still
disagreed when the audit found it.

Plain-English analogy:
    Think of this as the cascade's tape measure. Every stage that
    converts "how many voxels?" into "how many mL?" reaches for the
    same physical tape, instead of stamping a new ruler in each office.

Used by:
    - ``src/tasks/parenchyma.py``
    - ``src/tasks/couinaud.py``
    - ``src/tasks/vessels.py``
    - (formerly ``src/tasks/flr_default.py`` — being removed by Agent 3.1)
"""
from __future__ import annotations


# Default per-voxel volume for the resampled 128³ working grid assuming a
# ~300 mm abdominal FOV (2.3 mm isotropic spacing). Stages that have the
# *native* SimpleITK image use ``np.prod(image.GetSpacing()) / 1000`` and
# bypass this fallback — this constant is only for paths that don't carry
# the native spacing through.
_DEFAULT_VOXEL_VOLUME_ML: float = (2.3 ** 3) / 1000.0  # ~0.012 mL / voxel

# Public alias — prefer this in new code; the underscore-prefixed name is
# kept for the legacy task modules until they migrate.
DEFAULT_VOXEL_VOLUME_ML: float = _DEFAULT_VOXEL_VOLUME_ML


__all__ = ["DEFAULT_VOXEL_VOLUME_ML", "_DEFAULT_VOXEL_VOLUME_ML"]
