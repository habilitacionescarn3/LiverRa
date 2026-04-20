# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Liver superior-inferior coverage check (FR-006 / FR-006a).

Plain-English:
    We only accept scans whose field of view covers the *entire* liver.
    "Entire" here means from the dome (top of the right hemidiaphragm)
    down past the inferior tip of the right lobe. A missing dome is the
    classic partial-coverage failure mode — the residual volume
    computation (FLR) depends on measuring both halves, so a truncated
    dome is unsafe for surgical planning.

    Heuristic: take the Z-coordinates of every slice in the portal-venous
    series (DICOM ImagePositionPatient[2]) and check:

      - the range ≥ 22 cm (adult liver superior-inferior extent upper
        bound per Healey's atlas + ESGAR consensus); and
      - the top slice is within 30 mm of the expected hemidiaphragm
        height (we approximate this as "within 30 mm of the patient's
        highest slice across all series in the study" — ensures the
        dome isn't truncated relative to what was scanned).

    Partial coverage → ``InsufficientCoverageError`` with
    ``admin_override_allowed=True`` so the admin path (FR-006a) can
    push through with a documented rationale.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable


MIN_LIVER_Z_EXTENT_MM = 220.0  # 22 cm — FR-006 threshold
DOME_TOLERANCE_MM = 30.0       # accepted gap between series top + dome


class InsufficientCoverageError(Exception):
    """Raised when coverage does not meet FR-006. Honours FR-006a override."""

    def __init__(
        self,
        detail: str,
        *,
        slug: str = "insufficient_coverage",
        admin_override_allowed: bool = True,
    ) -> None:
        super().__init__(detail)
        self.slug = slug
        self.detail = detail
        self.admin_override_allowed = admin_override_allowed


@dataclass(frozen=True)
class SliceGeometry:
    """Minimal slice geometry pulled from ImagePositionPatient."""

    series_instance_uid: str
    z_mm: float  # ImagePositionPatient[2]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _range(z_values: list[float]) -> float:
    return max(z_values) - min(z_values) if z_values else 0.0


def check_coverage(
    portal_venous_slices: Iterable[SliceGeometry],
    *,
    all_study_slices: Iterable[SliceGeometry] | None = None,
) -> None:
    """Validate FR-006 coverage against the portal-venous series.

    Parameters
    ----------
    portal_venous_slices:
        The Z-coordinates of every slice in the portal-venous series.
    all_study_slices:
        Optional: Z-coordinates for the whole study. If provided, we
        ensure the portal-venous top slice is within ``DOME_TOLERANCE_MM``
        of the study-wide top slice (catches "scan included upper lungs
        in arterial phase but portal-venous stopped below the diaphragm").

    Raises
    ------
    InsufficientCoverageError
        If either check fails. FR-006a admin override is allowed.
    """
    pv = sorted(s.z_mm for s in portal_venous_slices)
    if not pv:
        raise InsufficientCoverageError(
            "portal-venous series has no decodable slice geometry",
            slug="no_portal_venous_geometry",
            admin_override_allowed=False,
        )

    extent = _range(pv)
    if extent < MIN_LIVER_Z_EXTENT_MM:
        raise InsufficientCoverageError(
            f"Z extent {extent:.1f} mm < {MIN_LIVER_Z_EXTENT_MM:.0f} mm minimum",
            slug="insufficient_z_extent",
            admin_override_allowed=True,
        )

    if all_study_slices is not None:
        z_study = sorted(s.z_mm for s in all_study_slices)
        if z_study:
            study_top = max(z_study)
            pv_top = max(pv)
            if (study_top - pv_top) > DOME_TOLERANCE_MM:
                raise InsufficientCoverageError(
                    f"portal-venous top slice is {study_top - pv_top:.1f} mm below "
                    f"the study top — liver dome likely truncated",
                    slug="dome_truncated",
                    admin_override_allowed=True,
                )


__all__ = [
    "MIN_LIVER_Z_EXTENT_MM",
    "DOME_TOLERANCE_MM",
    "SliceGeometry",
    "InsufficientCoverageError",
    "check_coverage",
]
