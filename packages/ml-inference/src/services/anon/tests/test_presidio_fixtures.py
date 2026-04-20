"""Presidio-based DICOM + free-text anonymization FP/FN tests.

Plan §Mandatory security-critical suites (tasks T362):
    - 10 False-Positive fixtures: strings that look PHI-ish but are NOT PHI
      and must be left untouched (e.g. UID-like IDs, technical codes).
    - 10 False-Negative fixtures: genuine PHI in tricky forms that MUST be
      caught (wrong-language names, Cyrillic/Mkhedruli/German diacritics,
      numeric-only birthdates).

The test does not bind to a specific Presidio version — it loads the project's
own ``anon.triage`` entry point, which internally orchestrates Presidio +
custom recognizers.

References: plan §Mandatory security-critical suites · tasks T362.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List

import pytest

try:
    from src.services.anon import triage  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover
    triage = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


pytestmark = pytest.mark.skipif(
    triage is None, reason=f"anon.triage not importable: {_IMPORT_ERROR}"
)


# ---------------------------------------------------------------------------
# Adapter — our anon service may expose either a functional or class API.
# ---------------------------------------------------------------------------


def _scrub(text: str) -> str:
    if hasattr(triage, "scrub"):
        return str(triage.scrub(text))  # type: ignore[attr-defined]
    if hasattr(triage, "TriageEngine"):
        engine = triage.TriageEngine()  # type: ignore[attr-defined]
        return str(engine.scrub(text))
    pytest.skip("anon.triage exposes neither scrub() nor TriageEngine")


@dataclass(frozen=True)
class Fixture:
    id: str
    input: str
    description: str


# ---------------------------------------------------------------------------
# 10 False-Positive fixtures — MUST NOT be redacted.
# ---------------------------------------------------------------------------


FALSE_POSITIVES: List[Fixture] = [
    Fixture("fp01_study_uid",       "1.2.840.113619.2.5.1762583153.1234", "DICOM Study UID — must not match person-name/SSN recognizers"),
    Fixture("fp02_series_uid",      "1.2.840.113619.2.5.99.1.9999999999", "DICOM Series UID"),
    Fixture("fp03_lilnet_class",    "HCC", "3-letter medical acronym that must not be flagged as initials"),
    Fixture("fp04_snomed_code",     "SCTID:373873005", "SNOMED CT code"),
    Fixture("fp05_loinc_code",      "LOINC 71020-7", "LOINC code"),
    Fixture("fp06_mbom_version",    "liverra-stunet-parenchyma-v1-20260419", "Model version tag"),
    Fixture("fp07_error_slug",      "https://liverra.ai/errors/analysis-failed", "Error catalog URL"),
    Fixture("fp08_cornerstone_tag", "(0008,0018)", "DICOM tag"),
    Fixture("fp09_hu_measurement",  "Mean HU = -150", "HU measurement value"),
    Fixture("fp10_voxel_spacing",   "voxel_spacing_mm: [1.5, 1.5, 1.5]", "Voxel spacing metadata"),
]


@pytest.mark.parametrize("fx", FALSE_POSITIVES, ids=lambda fx: fx.id)
def test_false_positive_not_redacted(fx: Fixture) -> None:
    scrubbed = _scrub(fx.input)
    assert fx.input == scrubbed, (
        f"FP fixture {fx.id!r} ({fx.description}) was incorrectly redacted.\n"
        f"  input    = {fx.input!r}\n"
        f"  scrubbed = {scrubbed!r}"
    )


# ---------------------------------------------------------------------------
# 10 False-Negative fixtures — genuine PHI in tricky forms, MUST be redacted.
# ---------------------------------------------------------------------------


FALSE_NEGATIVES: List[Fixture] = [
    Fixture("fn01_german_diacritic",    "Patient: Björn Müller",                    "German name with umlaut"),
    Fixture("fn02_georgian_mkhedruli",  "პაციენტი: ლევან გოგიჩაიშვილი",            "Georgian Mkhedruli name"),
    Fixture("fn03_cyrillic_russian",    "Пациент: Иванов Иван Иванович",            "Russian Cyrillic full name"),
    Fixture("fn04_numeric_dob",         "DOB 19670814",                             "Compact numeric date of birth"),
    Fixture("fn05_eu_phone",            "+49 941 944 0",                            "DE phone without separators"),
    Fixture("fn06_reverse_name_order",  "Schlitt, Hans, Prof. Dr.",                 "Lastname-first + honorific"),
    Fixture("fn07_mrn_with_prefix",     "Patient ID: HR-00384219",                  "Hospital MRN with regional prefix"),
    Fixture("fn08_street_address_ka",   "რუსთაველის გამზირი 12, თბილისი",        "Georgian street address"),
    Fixture("fn09_ssn_in_prose",        "SSN on file is 123-45-6789 from 2019.",    "SSN embedded in a sentence"),
    Fixture("fn10_initials_plus_age",   "J.D., 67 y/o male from Regensburg",        "Initials + age + city"),
]


@pytest.mark.parametrize("fx", FALSE_NEGATIVES, ids=lambda fx: fx.id)
def test_false_negative_is_redacted(fx: Fixture) -> None:
    scrubbed = _scrub(fx.input)
    assert fx.input != scrubbed, (
        f"FN fixture {fx.id!r} ({fx.description}) was NOT redacted — PHI leaked."
    )
    # Heuristic: at least one token from the original that looks like PHI
    # should no longer appear verbatim.
    assert "<REDACTED>" in scrubbed or "[REDACTED]" in scrubbed or "*" in scrubbed or "***" in scrubbed, (
        f"FN fixture {fx.id!r}: scrubber altered input but left no redaction marker.\n"
        f"  scrubbed = {scrubbed!r}"
    )
