"""Unit tests for ACR plain-text renderer Python twin (T074).

Asserts byte-equivalence with the TS renderer by comparing against the
shared expected outputs under ``tests/fixtures/acr_snapshots/expected/``.
"""
from __future__ import annotations

import json
import pathlib
import unicodedata

import pytest

from src.services.export.acr_plaintext_renderer import render_readout_plain_text
from src.services.export.acr_section_builder import build_readout_snapshot

FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "acr_snapshots"
EXPECTED = FIXTURES / "expected"


@pytest.mark.parametrize("scenario", [
    "complete", "no_lesions", "degraded_spleen", "stale_finding", "partial_payload",
])
def test_renderer_produces_deterministic_output(scenario):
    fx = json.loads((FIXTURES / f"{scenario}.json").read_text(encoding="utf-8"))
    snap = build_readout_snapshot(
        analysis_id=fx["analysis_id"],
        tenant_id=fx["tenant_id"],
        locale=fx["locale"],
        captured_at=fx["captured_at"],
        findings_dict=fx.get("findings") or {},
        lesions=fx.get("lesions") or [],
        flr=fx.get("flr"),
        status=fx.get("status", "completed"),
    )
    out1 = render_readout_plain_text(snap)
    out2 = render_readout_plain_text(snap)
    assert out1 == out2, "non-deterministic render"
    # NFC normalized
    assert out1 == unicodedata.normalize("NFC", out1)
    # RUO bookends
    assert out1.splitlines()[0].startswith("--- ")
    assert out1.splitlines()[-1].startswith("--- ")
    # No markdown chars
    for ch in ("*", "_", "~", "<", ">", "`"):
        assert ch not in out1, f"unexpected char {ch!r} in render"


def test_complete_scenario_section_order():
    fx = json.loads((FIXTURES / "complete.json").read_text(encoding="utf-8"))
    snap = build_readout_snapshot(
        analysis_id=fx["analysis_id"],
        tenant_id=fx["tenant_id"],
        locale="en",
        captured_at=fx["captured_at"],
        findings_dict=fx["findings"],
        lesions=fx["lesions"],
        flr=fx["flr"],
        status="completed",
    )
    out = render_readout_plain_text(snap)
    # Headers appear in fixed order.
    headers = [line for line in out.splitlines() if line and not line.startswith(" ") and not line.startswith("---")]
    assert headers == ["LIVER", "LESIONS", "VESSELS", "GALLBLADDER", "SPLEEN", "FLR ASSESSMENT"]


def test_degraded_warning_surfaces_with_bang_prefix():
    fx = json.loads((FIXTURES / "degraded_spleen.json").read_text(encoding="utf-8"))
    snap = build_readout_snapshot(
        analysis_id=fx["analysis_id"],
        tenant_id=fx["tenant_id"],
        locale="en",
        captured_at=fx["captured_at"],
        findings_dict=fx["findings"],
        lesions=fx["lesions"],
        flr=fx["flr"],
        status=fx["status"],
    )
    out = render_readout_plain_text(snap)
    assert "! Volumetry degraded" in out


@pytest.mark.skipif(not EXPECTED.exists(), reason="golden text fixtures not yet authored")
@pytest.mark.parametrize("scenario", [
    "complete", "no_lesions", "degraded_spleen", "stale_finding", "partial_payload",
])
def test_golden_text_byte_equivalence(scenario):
    """Read the canonical expected text from tests/fixtures/acr_snapshots/expected/.

    Skipped until the golden files are generated (one-shot via:
    `python -m src.services.export.acr_plaintext_renderer fixtures/<x>.json
    > tests/fixtures/acr_snapshots/expected/<x>.en.txt`).
    """
    fx = json.loads((FIXTURES / f"{scenario}.json").read_text(encoding="utf-8"))
    snap = build_readout_snapshot(
        analysis_id=fx["analysis_id"],
        tenant_id=fx["tenant_id"],
        locale=fx["locale"],
        captured_at=fx["captured_at"],
        findings_dict=fx.get("findings") or {},
        lesions=fx.get("lesions") or [],
        flr=fx.get("flr"),
        status=fx.get("status", "completed"),
    )
    expected = (EXPECTED / f"{scenario}.en.txt").read_text(encoding="utf-8")
    assert render_readout_plain_text(snap) == expected
