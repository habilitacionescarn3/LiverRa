"""Unit tests for ACR anatomical section builder (002-acr-structured-readout T073).

Asserts: mapping enum order, finding-type → section correctness for all
7 types, empty-section fallback.
"""
from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest

from src.services.export.acr_section_builder import (
    ANATOMICAL_SECTION_ORDER,
    AnatomicalSection,
    FINDING_TYPE_TO_SECTION,
    build_acr_sections,
    build_readout_snapshot,
    finding_type_to_section,
)

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "acr_snapshots"


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_anatomical_section_order_matches_data_model():
    assert [s.value for s in ANATOMICAL_SECTION_ORDER] == [
        "liver", "lesions", "vessels", "gallbladder", "spleen", "flrAssessment",
    ]


@pytest.mark.parametrize("finding_type,expected", [
    ("hu_stats", AnatomicalSection.LIVER),
    ("steatosis", AnatomicalSection.LIVER),
    ("spleen", AnatomicalSection.SPLEEN),
    ("gallbladder", AnatomicalSection.GALLBLADDER),
    ("calcified_lesions", AnatomicalSection.LESIONS),
    ("simple_biliary_cysts", AnatomicalSection.LESIONS),
    ("indeterminate_malignant", AnatomicalSection.LESIONS),
])
def test_finding_type_to_section(finding_type, expected):
    assert finding_type_to_section(finding_type) is expected
    assert FINDING_TYPE_TO_SECTION[finding_type] is expected


def test_finding_type_to_section_unknown_returns_none():
    assert finding_type_to_section("nonsense") is None


def test_build_acr_sections_produces_six_sections_in_order():
    fx = _load("complete.json")
    sections = build_acr_sections(
        findings_dict=fx["findings"],
        lesions=fx["lesions"],
        flr=fx["flr"],
        status=fx["status"],
    )
    assert list(sections.keys()) == [
        "liver", "lesions", "vessels", "gallbladder", "spleen", "flrAssessment",
    ]


def test_steatosis_grade_none_is_skipped():
    fx = _load("no_lesions.json")
    sections = build_acr_sections(
        findings_dict=fx["findings"],
        lesions=fx["lesions"],
        flr=fx["flr"],
        status=fx["status"],
    )
    liver_rows = sections["liver"]
    steatosis_keys = [r["key"] for r in liver_rows]
    assert "steatosis" not in steatosis_keys, "grade='none' should suppress the row"


def test_empty_section_fallback_used_for_running_status():
    snap = build_readout_snapshot(
        analysis_id="x",
        tenant_id="t",
        locale="en",
        captured_at="2026-05-13T14:23:00Z",
        findings_dict={},
        lesions=[],
        flr=None,
        status="running",
    )
    for sec in snap["sections"]:
        assert sec["status"] == "computing"


def test_completed_with_no_findings_is_empty_not_unavailable():
    snap = build_readout_snapshot(
        analysis_id="x",
        tenant_id="t",
        locale="en",
        captured_at="2026-05-13T14:23:00Z",
        findings_dict={},
        lesions=[],
        flr=None,
        status="completed",
    )
    for sec in snap["sections"]:
        assert sec["status"] == "empty"


def test_per_lesion_rows_sorted_by_id():
    snap = build_readout_snapshot(
        analysis_id="x",
        tenant_id="t",
        locale="en",
        captured_at="2026-05-13T14:23:00Z",
        findings_dict={},
        lesions=[
            {"id": "L3", "size_mm": 11.4, "segment": "II"},
            {"id": "L1", "size_mm": 89.6, "segment": "VIII"},
            {"id": "L2", "size_mm": 22.1, "segment": "IVa"},
        ],
        flr=None,
        status="completed",
    )
    lesions_sec = next(s for s in snap["sections"] if s["section"] == "lesions")
    item_ids = [r["itemId"] for r in lesions_sec["rows"] if r.get("itemId")]
    assert item_ids == ["L1", "L2", "L3"]
