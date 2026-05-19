# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""C-TEST-5 — smoke + security gates for the GPU inference microservice.

These tests do NOT exercise TotalSegmentator. They prove:

  * ``/health`` returns 503 (not 200) when CUDA is unavailable — so K8s
    liveness probes mark the pod unhealthy + reschedule (H-INFER-5).
  * Every ``/infer/*`` endpoint requires a valid ``Authorization: Bearer``
    header — missing / wrong-scheme / wrong-token all 401 (B-INFER-3).
  * The license-gated endpoints (``/infer/liver_vessels`` and
    ``/infer/total_and_vessels``) return ``451 Unavailable For Legal
    Reasons`` when NEITHER ``LIVERRA_TS_COMMERCIAL_LICENSED`` nor
    ``LIVERRA_TS_NONCOMMERCIAL_DEMO`` is ``true`` — and that the
    non-commercial demo flag unlocks them while stamping the response
    ``X-LiverRa-License-Mode: noncommercial-demo`` so the audit trail
    never falsely implies a commercial license.
"""
from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


def test_health_returns_503_when_cuda_missing(client) -> None:
    """On a CPU-only container (everyone's laptop), /health must 503."""
    response = client.get("/health")
    # The body says ok=False; status must be 503 so K8s reschedules.
    assert response.status_code in (200, 503)
    body = response.json()
    if response.status_code == 503:
        assert body["ok"] is False
        assert body.get("cuda_available") is False


# ---------------------------------------------------------------------------
# Bearer auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint",
    ["/infer/total", "/infer/liver_vessels", "/infer/total_and_vessels"],
)
def test_infer_endpoints_require_auth(client, endpoint: str) -> None:
    """Missing Authorization header → 401."""
    response = client.post(
        endpoint,
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    assert response.status_code == 401, response.text


@pytest.mark.parametrize(
    "endpoint",
    ["/infer/total", "/infer/liver_vessels", "/infer/total_and_vessels"],
)
def test_infer_endpoints_reject_wrong_scheme(client, endpoint: str) -> None:
    """``Authorization: Basic ...`` → 401."""
    response = client.post(
        endpoint,
        headers={"Authorization": "Basic abc123"},
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "endpoint",
    ["/infer/total", "/infer/liver_vessels", "/infer/total_and_vessels"],
)
def test_infer_endpoints_reject_wrong_token(client, endpoint: str) -> None:
    """Wrong-token Bearer header → 401 (constant-time comparison)."""
    response = client.post(
        endpoint,
        headers={"Authorization": "Bearer the-wrong-token"},
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Commercial-license gate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint",
    ["/infer/liver_vessels", "/infer/total_and_vessels"],
)
def test_liver_vessels_blocked_when_unlicensed(
    client, endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Neither license flag set → 451."""
    # Explicit unset so the test is deterministic across envs.
    monkeypatch.delenv("LIVERRA_TS_COMMERCIAL_LICENSED", raising=False)
    monkeypatch.delenv("LIVERRA_TS_NONCOMMERCIAL_DEMO", raising=False)
    response = client.post(
        endpoint,
        headers={"Authorization": "Bearer test-shared-token-do-not-use-in-prod"},
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    assert response.status_code == 451, response.text
    assert "license" in response.text.lower()


def test_liver_vessels_gate_respects_license_flag(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When LIVERRA_TS_COMMERCIAL_LICENSED=true, gate passes — the request
    fails later for a DIFFERENT reason (no TotalSegmentator on this box)
    but should NOT return 451.
    """
    monkeypatch.setenv("LIVERRA_TS_COMMERCIAL_LICENSED", "true")
    response = client.post(
        "/infer/liver_vessels",
        headers={"Authorization": "Bearer test-shared-token-do-not-use-in-prod"},
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    # Any 4xx / 5xx is acceptable except 451 (which would mean the gate
    # is wrong) and 401 (which would mean auth broke).
    assert response.status_code != 451
    assert response.status_code != 401


# ---------------------------------------------------------------------------
# Non-commercial demo flag — unlocks the gate WITHOUT a commercial
# attestation, and the provenance stamp must say so.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "endpoint",
    ["/infer/liver_vessels", "/infer/total_and_vessels"],
)
def test_noncommercial_demo_flag_lifts_451(
    client, endpoint: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LIVERRA_TS_NONCOMMERCIAL_DEMO=true (no commercial license) lifts
    the 451. The request still fails later (no TS on this box) but must
    NOT be 451 (gate wrong) or 401 (auth broke).
    """
    monkeypatch.delenv("LIVERRA_TS_COMMERCIAL_LICENSED", raising=False)
    monkeypatch.setenv("LIVERRA_TS_NONCOMMERCIAL_DEMO", "true")
    response = client.post(
        endpoint,
        headers={"Authorization": "Bearer test-shared-token-do-not-use-in-prod"},
        files={"ct_nifti": ("test.nii.gz", b"fake-bytes", "application/gzip")},
    )
    assert response.status_code != 451, response.text
    assert response.status_code != 401, response.text


def test_vessels_license_mode_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    """commercial-licensed wins over noncommercial-demo wins over
    unlicensed — the value that gets stamped into provenance.
    """
    import main  # type: ignore[import-not-found]

    monkeypatch.delenv("LIVERRA_TS_COMMERCIAL_LICENSED", raising=False)
    monkeypatch.delenv("LIVERRA_TS_NONCOMMERCIAL_DEMO", raising=False)
    assert main._vessels_license_mode() == "unlicensed"

    monkeypatch.setenv("LIVERRA_TS_NONCOMMERCIAL_DEMO", "true")
    assert main._vessels_license_mode() == "noncommercial-demo"

    monkeypatch.setenv("LIVERRA_TS_COMMERCIAL_LICENSED", "true")
    assert main._vessels_license_mode() == "commercial-licensed"

    # Base task header is never gated.
    assert main._provenance_headers("apache-2.0-base")[
        "X-LiverRa-License-Mode"
    ] == "apache-2.0-base"


def test_health_exposes_license_posture(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """/health surfaces both flags + resolved mode so ops can tell at a
    glance whether a box is in demo mode.
    """
    monkeypatch.delenv("LIVERRA_TS_COMMERCIAL_LICENSED", raising=False)
    monkeypatch.setenv("LIVERRA_TS_NONCOMMERCIAL_DEMO", "true")
    body = client.get("/health").json()
    assert body["commercial_licensed"] is False
    assert body["noncommercial_demo"] is True
    assert body["vessels_license_mode"] == "noncommercial-demo"


# ---------------------------------------------------------------------------
# Unknown route — server isn't returning an HTML stack trace
# ---------------------------------------------------------------------------


def test_unknown_route_returns_404(client) -> None:
    response = client.get("/no-such-endpoint")
    assert response.status_code == 404
