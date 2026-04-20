# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Per-study UID + acquisition-window consistency (FR-003a).

Plain-English:
    One of the most dangerous failure modes in medical imaging is
    studying the wrong patient's scan. This module runs three structural
    checks at ingest to catch mixed-patient or mixed-study uploads:

      1. Every series shares the same Patient ID.
      2. Every series shares the same Study Instance UID.
      3. All series were acquired within a single 24 h window.

    Any inconsistency raises ``UIDConsistencyError`` with a slug the
    API layer maps to the FR-003a "mixed_patient_uid" /
    "missing_portal_venous" etc. rejection reasons.

References:
    - specs/001-zero-training-mvp/spec.md §FR-003a
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterable


MAX_ACQUISITION_WINDOW = timedelta(hours=24)


class UIDConsistencyError(Exception):
    """Raised on any FR-003a consistency violation."""

    def __init__(self, slug: str, detail: str) -> None:
        super().__init__(detail)
        self.slug = slug
        self.detail = detail


@dataclass(frozen=True)
class SeriesIdentity:
    """Minimal DICOM identity fields the consistency check needs."""

    series_instance_uid: str
    study_instance_uid: str
    patient_id: str
    # ISO-formatted; we parse defensively.
    acquisition_date_iso: str | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_DICOM_DATE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")


def _parse_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    raw = raw.strip()
    # DICOM DA VR: YYYYMMDD
    m = _DICOM_DATE.match(raw)
    if m:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    # ISO fallback
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_study_consistency(series: Iterable[SeriesIdentity]) -> None:
    """Raise ``UIDConsistencyError`` on any FR-003a violation."""
    series_list = list(series)
    if not series_list:
        raise UIDConsistencyError("empty_study", "no series found in upload")

    # --- Gate 1: Patient ID must be identical everywhere -----------------
    patient_ids = _unique(s.patient_id for s in series_list)
    if len(patient_ids) != 1:
        raise UIDConsistencyError(
            "mixed_patient_uid",
            f"series carry {len(patient_ids)} distinct PatientIDs; expected 1",
        )

    # --- Gate 2: Study Instance UID must be identical everywhere --------
    study_uids = _unique(s.study_instance_uid for s in series_list)
    if len(study_uids) != 1:
        raise UIDConsistencyError(
            "mixed_study_uid",
            f"series carry {len(study_uids)} distinct StudyInstanceUIDs; expected 1",
        )

    # --- Gate 3: Acquisition dates within a 24 h window -----------------
    dates = [
        d for d in (_parse_date(s.acquisition_date_iso) for s in series_list)
        if d is not None
    ]
    if dates:
        span = max(dates) - min(dates)
        if span > MAX_ACQUISITION_WINDOW:
            raise UIDConsistencyError(
                "acquisition_window_exceeded",
                f"series span {span} which exceeds the {MAX_ACQUISITION_WINDOW} limit",
            )


__all__ = [
    "MAX_ACQUISITION_WINDOW",
    "SeriesIdentity",
    "UIDConsistencyError",
    "validate_study_consistency",
]
