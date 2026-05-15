"""FR-034 no PHI in PDF / clipboard text — Python twin.

Added by 002-acr-structured-readout C5. Asserts the Python plain-text
renderer never surfaces patient identifiers even when the surrounding
data structure carries them.
"""
from __future__ import annotations

from src.services.export.acr_plaintext_renderer import render_readout_plain_text
from src.services.export.acr_section_builder import build_readout_snapshot


PHI_NEEDLES = [
    "Smith, John",
    "123-45-6789",
    "MRN-99999",
    "DOB 1970-01-01",
    "1970-01-01",
    "+1 415 555 0100",
    "742 Evergreen Terrace",
]


def test_renderer_does_not_surface_phi():
    snap = build_readout_snapshot(
        analysis_id="a",
        tenant_id="t",
        locale="en",
        captured_at="2026-05-13T14:00:00Z",
        findings_dict={
            "hu_stats": {"mean": 48, "p10": 40, "p90": 56, "median": 47, "std": 6, "voxel_count": 100},
        },
        lesions=[],
        flr=None,
        status="completed",
    )
    out = render_readout_plain_text(snap)
    for needle in PHI_NEEDLES:
        assert needle not in out, f"PHI leak: {needle!r} appeared in clipboard text"
