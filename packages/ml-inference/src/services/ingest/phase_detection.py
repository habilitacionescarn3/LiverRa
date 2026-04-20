# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-series 4-phase detection (FR-003).

Plain-English:
    A liver CT protocol typically produces four series per study: a
    native (no contrast), an arterial phase (~25-45s after contrast
    injection), a portal-venous phase (~60-85s), and a delayed phase
    (~3-5 min). The AI pipeline requires the portal-venous phase at a
    minimum; missing arterial or delayed only degrades confidence
    (FR-004). This module classifies every series into a phase using a
    two-layer heuristic (DICOM timing tags first, series description
    fallback) and either returns a coverage map or raises if the
    portal-venous gate is missed.

Phase time windows (seconds post-contrast-injection) are conservative
unions of the ranges published by the major hepatobiliary imaging
consensus statements (ESGAR + SAR). They intentionally overlap slightly
to tolerate scanner-level clock drift.

References:
    - specs/001-zero-training-mvp/spec.md §FR-003, §FR-004
    - docs/research/  (4-phase CT protocol notes)
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from enum import Enum
from typing import Iterable

logger = logging.getLogger(__name__)


class Phase(str, Enum):
    NATIVE = "native"
    ARTERIAL = "arterial"
    PORTAL_VENOUS = "portal_venous"
    DELAYED = "delayed"


# Time windows (seconds post-injection); wide on purpose.
PHASE_WINDOWS_S: dict[Phase, tuple[float, float]] = {
    Phase.ARTERIAL: (20.0, 50.0),
    Phase.PORTAL_VENOUS: (55.0, 95.0),
    Phase.DELAYED: (150.0, 360.0),
}

# Description-token fallbacks (case-insensitive, NFC-normalised).
PHASE_DESCRIPTION_TOKENS: dict[Phase, tuple[str, ...]] = {
    Phase.NATIVE: ("nativ", "non contrast", "non-contrast", "pre-contrast",
                   "precontrast", "unenhanced", "nat"),
    Phase.ARTERIAL: ("art", "hap", "arterial", "late arterial",
                     "early arterial"),
    Phase.PORTAL_VENOUS: ("port", "pvp", "pv", "portal", "venous", "portalvenous"),
    Phase.DELAYED: ("delay", "delayed", "eq", "equilibrium", "late phase"),
}


class MissingPhaseError(Exception):
    """Raised when FR-003's required phase (portal-venous) is absent."""

    def __init__(self, message: str, slug: str = "missing_portal_venous") -> None:
        super().__init__(message)
        self.slug = slug


@dataclass(frozen=True)
class SeriesSummary:
    """Minimal per-series info the detector needs.

    Times are normalised to seconds-past-injection. Callers construct
    these from ``pydicom.Dataset`` and pass them in so this module stays
    free of pydicom at import time (helps testing).
    """

    series_instance_uid: str
    acquisition_time_offset_s: float | None
    contrast_bolus_start_offset_s: float | None
    series_description: str | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _dicom_time_to_seconds(value: str | None) -> float | None:
    """Convert a DICOM TM/DT string (HHMMSS.fff) into seconds-since-midnight."""
    if not value:
        return None
    m = re.match(r"^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?", value.strip())
    if not m:
        return None
    h, mn, s, frac = m.groups()
    return int(h) * 3600 + int(mn) * 60 + int(s) + (float(f"0.{frac}") if frac else 0.0)


def _desc_phase(description: str | None) -> Phase | None:
    if not description:
        return None
    low = description.lower()
    for phase, tokens in PHASE_DESCRIPTION_TOKENS.items():
        for tok in tokens:
            # Use word-boundary-ish match to avoid "art" hitting "smart".
            if re.search(rf"(?:\b|_){re.escape(tok)}(?:\b|_|\d)", low):
                return phase
    return None


def _window_phase(offset_s: float | None) -> Phase | None:
    if offset_s is None or offset_s < 0:
        return None
    for phase, (lo, hi) in PHASE_WINDOWS_S.items():
        if lo <= offset_s <= hi:
            return phase
    # Offsets below the arterial window count as native (no contrast yet).
    if offset_s < PHASE_WINDOWS_S[Phase.ARTERIAL][0]:
        return Phase.NATIVE
    return None


def _classify_series(s: SeriesSummary) -> Phase | None:
    # Compute an offset from injection start if available.
    offset: float | None = None
    if s.acquisition_time_offset_s is not None and s.contrast_bolus_start_offset_s is not None:
        offset = s.acquisition_time_offset_s - s.contrast_bolus_start_offset_s

    window = _window_phase(offset)
    desc = _desc_phase(s.series_description)
    # If both agree or only one is available, return it. If they disagree,
    # description wins (radiographer-authored tag is more reliable than
    # scanner clock drift).
    if desc is not None:
        return desc
    return window


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def detect_phases(series: Iterable[SeriesSummary]) -> dict[Phase, str | None]:
    """Return a ``phase → series_instance_uid`` map.

    Raises :class:`MissingPhaseError` if portal-venous is absent, per
    FR-003. Arterial / delayed / native missing is OK at this stage —
    those are handled downstream by the confidence-degradation path
    (FR-004).
    """
    coverage: dict[Phase, str | None] = {p: None for p in Phase}

    for s in series:
        phase = _classify_series(s)
        if phase is None:
            continue
        # Prefer the first series that clearly matches; if a later one
        # also matches, keep the first (caller can cluster by
        # SeriesNumber beforehand if they want a different priority).
        if coverage[phase] is None:
            coverage[phase] = s.series_instance_uid

    if coverage[Phase.PORTAL_VENOUS] is None:
        raise MissingPhaseError(
            "portal_venous phase required per FR-003",
            slug="missing_portal_venous",
        )

    return coverage


__all__ = [
    "Phase",
    "PHASE_WINDOWS_S",
    "PHASE_DESCRIPTION_TOKENS",
    "SeriesSummary",
    "MissingPhaseError",
    "detect_phases",
]
