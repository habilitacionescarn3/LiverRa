# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Tests for the PHI scrubber (T071).

Covers:

1. Real-world anonymized DICOM header dumps (5+ curated samples).
2. German names — top-50 surface + compound ("Meyer-Schulze") +
   Turkish-German ("Özdemir").
3. Georgian names — Latin transliteration ("Gogichaishvili") + native
   script ("გოგიჩაიშვილი").
4. MRN patterns — labeled + bare digit bursts + tenant-specific.
5. Emails.
6. Allowlisted fields pass through unchanged (even MRN-shaped digits).
7. Fail-closed: when an internal regex op raises, ``ScrubberFailure``
   fires AND ``phi_scrubber_failed_total`` Prometheus counter increments.
"""
from __future__ import annotations

import re
from typing import Any
from unittest.mock import patch

import pytest

from src.observability.phi_scrubber import (
    PHIScrubber,
    REDACTION,
    ScrubberFailure,
    phi_scrubber_failed_total,
)


# ---------------------------------------------------------------------------
# Fixtures — curated dumps / payload examples
# ---------------------------------------------------------------------------


@pytest.fixture
def scrubber() -> PHIScrubber:
    return PHIScrubber()


def _counter_value(reason: str) -> float:
    """Helper — read the current counter value for a given reason label."""
    return phi_scrubber_failed_total.labels(reason=reason)._value.get()  # type: ignore[attr-defined]


# Curated DICOM headers (synthetic, anonymized-looking). Each is a nested
# dict like a typical pydicom→dict dump.
DICOM_HEADERS: list[dict[str, Any]] = [
    {
        "PatientName": "Schmidt^Hans",
        "PatientID": "MRN: 1234567",
        "StudyInstanceUID": "1.2.840.113619.2.55.3.604688.8.1234567890.1234.1",
        "SeriesInstanceUID": "1.2.840.113619.2.55.3.604688.8.1234567890.1234.2",
        "ReferringPhysicianName": "Müller^Anna",
    },
    {
        "PatientName": "Gogichaishvili^Levan",
        "PatientID": "Patient ID: X-5532/2025",
        "StudyInstanceUID": "1.3.6.1.4.1.14519.5.2.1.7085.2626.822645453932810355104200223293",
        "Email": "levan@hospital.ge",
    },
    {
        "PatientName": "Özdemir^Kemal",
        "PatientID": "MRN: 9988776",
        "StudyInstanceUID": "1.2.276.0.7230010.3.1.4.8323329.5432.1521499995.891234",
    },
    {
        "PatientName": "Meyer-Schulze^Sabine",
        "PatientID": "Patient ID: 5532199",
        "ReferringPhysicianName": "Dr. Weber",
    },
    {
        "PatientName": "გოგიჩაიშვილი^ლევან",
        "PatientID": "MRN: 4455667",
        "ReferringPhysicianName": "გიორგაძე^ირაკლი",
    },
]


# ---------------------------------------------------------------------------
# (1) DICOM headers — scrub each and assert zero leakage of obvious PHI.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("header", DICOM_HEADERS)
def test_dicom_header_zero_leakage(scrubber: PHIScrubber, header: dict[str, Any]) -> None:
    scrubbed = scrubber.scrub_dict(header)

    flat = " ".join(
        str(v) for v in _flatten_values(scrubbed)
    )

    # Every named individual in the sample headers must be gone.
    forbidden_substrings = [
        "Schmidt", "Hans", "Müller", "Anna",
        "Gogichaishvili", "Levan",
        "Özdemir", "Kemal",
        "Meyer-Schulze", "Sabine", "Weber",
        "გოგიჩაიშვილი", "გიორგაძე", "ირაკლი",
        "levan@hospital.ge",
        "1234567", "9988776", "5532199", "4455667",
    ]
    for needle in forbidden_substrings:
        if needle in str(header):  # only assert what was in the input
            assert needle not in flat, f"PHI leaked: {needle!r} still present"


def _flatten_values(obj: Any) -> list[Any]:
    out: list[Any] = []
    if isinstance(obj, dict):
        for v in obj.values():
            out.extend(_flatten_values(v))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out.extend(_flatten_values(v))
    else:
        out.append(obj)
    return out


# ---------------------------------------------------------------------------
# (2) German names — direct strings
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sample",
    [
        "Schmidt, Hans",
        "Dr. Müller",
        "Meyer-Schulze",
        "Özdemir",
        "Weber and Koch examined the patient",
        "Hofmann-König",
    ],
)
def test_german_names_scrubbed(scrubber: PHIScrubber, sample: str) -> None:
    out = scrubber.scrub_string(sample)
    for german_token in ("Schmidt", "Müller", "Meyer", "Schulze", "Özdemir", "Weber", "Koch", "Hofmann", "König"):
        if german_token in sample:
            assert german_token not in out, f"{german_token!r} leaked from {sample!r}"


# ---------------------------------------------------------------------------
# (3) Georgian names — Latin + native script
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sample",
    [
        "Gogichaishvili",
        "Dr. Giorgadze performed the resection",
        "Svanadze",
        "Japaridze",
        "გოგიჩაიშვილი",
        "გიორგაძე",
        "სვანაძე",
        "patient: ლევან გიორგაძე",
    ],
)
def test_georgian_names_scrubbed(scrubber: PHIScrubber, sample: str) -> None:
    out = scrubber.scrub_string(sample)
    for needle in (
        "Gogichaishvili", "Giorgadze", "Svanadze", "Japaridze",
        "გოგიჩაიშვილი", "გიორგაძე", "სვანაძე", "ლევან",
    ):
        if needle in sample:
            assert needle not in out, f"{needle!r} leaked from {sample!r}"


# ---------------------------------------------------------------------------
# (4) MRN patterns
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sample,leaked",
    [
        ("MRN: 1234567", "1234567"),
        ("Patient ID: X-5532/2025", "X-5532/2025"),
        ("PatientID:ABC12345", "ABC12345"),
        ("Pat. Nr. 4455667", "4455667"),
        ("Medical Record Number: 998877-X", "998877"),
        ("note: 1234567 on chart", "1234567"),  # bare-digit MRN
    ],
)
def test_mrn_patterns_scrubbed(scrubber: PHIScrubber, sample: str, leaked: str) -> None:
    out = scrubber.scrub_string(sample)
    assert leaked not in out, f"MRN leaked: {leaked!r} from {sample!r}"


# ---------------------------------------------------------------------------
# (5) Emails
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sample",
    [
        "john.doe@hospital.de",
        "Contact surgeon at k.oezdemir@charite.berlin",
        "email: l.gogichaishvili@geohospitals.ge",
        "Hans.Schmidt+consult@uniklinikum-regensburg.de",
    ],
)
def test_emails_scrubbed(scrubber: PHIScrubber, sample: str) -> None:
    out = scrubber.scrub_string(sample)
    assert "@" not in out, f"Email @ sign leaked in {out!r}"


# ---------------------------------------------------------------------------
# (6) Allowlisted fields pass through unchanged
# ---------------------------------------------------------------------------


def test_allowlisted_fields_pass_through(scrubber: PHIScrubber) -> None:
    safe_uid = "1.2.840.113619.2.55.3.604688.8.1234567890.1234.1"
    payload = {
        "study_instance_uid": safe_uid,
        "series_instance_uid": safe_uid + ".2",
        "analysis_id": "a-5532199",
        "sequence_no": "5532199",  # string-encoded bigint on the wire
        "model_version": "stu-net-lung-parenchyma-v1.4.0-sha256-abc123def",
        "tenant_id": "1234567",  # tenant UUID-string may contain 6-10 digits
        # But a non-safe field with the same content should be scrubbed:
        "patient_label": "Hans Schmidt, MRN: 5532199",
    }
    scrubbed = scrubber.scrub_dict(payload)

    assert scrubbed["study_instance_uid"] == safe_uid
    assert scrubbed["series_instance_uid"] == safe_uid + ".2"
    assert scrubbed["analysis_id"] == "a-5532199"
    assert scrubbed["sequence_no"] == "5532199"
    assert scrubbed["model_version"].startswith("stu-net-")
    assert scrubbed["tenant_id"] == "1234567"

    # Unsafe field: everything identifiable must be gone.
    assert "Hans" not in scrubbed["patient_label"]
    assert "Schmidt" not in scrubbed["patient_label"]
    assert "5532199" not in scrubbed["patient_label"]


# ---------------------------------------------------------------------------
# (7) Fail-closed: any exception raises ScrubberFailure + increments counter
# ---------------------------------------------------------------------------


def test_fail_closed_on_regex_crash(scrubber: PHIScrubber) -> None:
    before = _counter_value("scrub_string")

    # Force re.Pattern.sub to explode on a specific input.
    def _boom(self: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ARG001
        raise RuntimeError("synthetic regex failure")

    with patch.object(re.Pattern, "sub", _boom):
        with pytest.raises(ScrubberFailure):
            scrubber.scrub_string("payload with MRN: 1234567")

    after = _counter_value("scrub_string")
    assert after == before + 1, "phi_scrubber_failed_total did not increment"


def test_fail_closed_on_dict_scrub_crash(scrubber: PHIScrubber) -> None:
    before = _counter_value("scrub_dict")

    class Exploding:
        def __deepcopy__(self, memo: dict[int, Any]) -> Any:
            raise RuntimeError("synthetic deepcopy failure")

    payload = {"x": Exploding()}
    with pytest.raises(ScrubberFailure):
        scrubber.scrub_dict(payload)

    after = _counter_value("scrub_dict")
    assert after == before + 1


# ---------------------------------------------------------------------------
# (8) Nested structures + deeply nested lists
# ---------------------------------------------------------------------------


def test_nested_scrubbing(scrubber: PHIScrubber) -> None:
    payload = {
        "outer": {
            "inner_list": [
                "Schmidt",
                {"deeper": "MRN: 1234567"},
                ["Gogichaishvili", "levan@hospital.ge"],
            ],
        },
        "study_instance_uid": "1.2.3.4.5.6.7.8.9.10.11",  # allowlisted
    }
    out = scrubber.scrub_dict(payload)

    flat = " ".join(str(v) for v in _flatten_values(out))
    for leaked in ("Schmidt", "1234567", "Gogichaishvili", "levan@hospital.ge"):
        assert leaked not in flat, f"{leaked!r} leaked after nested scrub"
    # The allowlisted UID must survive.
    assert out["study_instance_uid"] == "1.2.3.4.5.6.7.8.9.10.11"


def test_safe_field_name_protects_digit_content(scrubber: PHIScrubber) -> None:
    """A bare digit run inside ``sequence_no`` must survive even though it
    matches the bare-MRN regex."""
    payload = {"sequence_no": "1234567", "body": "MRN: 1234567"}
    out = scrubber.scrub_dict(payload)
    assert out["sequence_no"] == "1234567"
    assert "1234567" not in out["body"]


# ---------------------------------------------------------------------------
# (9) Tenant-specific MRN pattern extension
# ---------------------------------------------------------------------------


def test_tenant_specific_mrn_pattern_extension() -> None:
    scrubber = PHIScrubber(extra_mrn_patterns=(r"CASE-[A-Z]{2}\d{6}",))
    out = scrubber.scrub_string("Case ref CASE-HP123456 opened today")
    assert "CASE-HP123456" not in out


# ---------------------------------------------------------------------------
# (10) Non-string scalars pass through
# ---------------------------------------------------------------------------


def test_non_string_scalars_untouched(scrubber: PHIScrubber) -> None:
    payload = {"count": 42, "ratio": 0.75, "active": True, "nil": None}
    assert scrubber.scrub_dict(payload) == payload
