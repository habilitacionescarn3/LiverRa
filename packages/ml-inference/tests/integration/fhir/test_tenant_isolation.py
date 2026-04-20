"""Tenant isolation integration test against ephemeral Medplum.

Plan §FHIR integration tests · Tasks T364.

Verifies FR-032a: a resource created in tenant B is NOT visible to a
tenant-A-scoped FHIR client, even when queried by its known resource ID.
The server must return an empty Bundle (for search) or 404 (for read) —
indistinguishable from "doesn't exist".

Runs against an ephemeral Medplum container (testcontainers) when available;
skips cleanly when the container backend is not reachable. This matches the
ci-fhir-integration CI lane.
"""

from __future__ import annotations

import os
from typing import Iterator

import pytest

# ---------------------------------------------------------------------------
# Ephemeral Medplum via testcontainers (optional — skip if not available)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def medplum_base_url() -> Iterator[str]:
    """Yield a Medplum base URL from (in order):
    1. ``LIVERRA_MEDPLUM_URL`` env var (CI lane provides this)
    2. testcontainers-launched Medplum container
    Otherwise skip.
    """

    env_url = os.environ.get("LIVERRA_MEDPLUM_URL")
    if env_url:
        yield env_url.rstrip("/")
        return

    try:
        from testcontainers.compose import DockerCompose  # type: ignore[import-not-found]
    except Exception as exc:
        pytest.skip(f"testcontainers not installed: {exc}")

    compose_path = os.environ.get(
        "LIVERRA_MEDPLUM_COMPOSE",
        "deploy/medplum/docker-compose.test.yml",
    )
    if not os.path.exists(compose_path):
        pytest.skip(f"Ephemeral Medplum compose file missing: {compose_path}")

    try:
        with DockerCompose(os.path.dirname(compose_path), compose_file_name=os.path.basename(compose_path)) as dc:
            host = dc.get_service_host("medplum", 8103)
            port = dc.get_service_port("medplum", 8103)
            yield f"http://{host}:{port}"
    except Exception as exc:
        pytest.skip(f"testcontainers Medplum unavailable: {exc}")


@pytest.fixture
def fhir_client(medplum_base_url: str):  # type: ignore[no-untyped-def]
    try:
        import httpx  # type: ignore[import-not-found]
    except Exception as exc:
        pytest.skip(f"httpx not installed: {exc}")
    return httpx.Client(base_url=medplum_base_url, timeout=30.0)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


TENANT_TAG_SYSTEM = "http://liverra.ai/fhir/tag/tenant"


def _tenant_headers(tenant_id: str, role: str = "radiologist") -> dict:
    """Headers identifying the caller's tenant/role.

    In a real deployment Medplum AccessPolicy selection is driven by the
    OAuth token's ``tenant_id`` claim. In the ephemeral container we rely on
    dev bypass headers consumed by the same middleware (documented in
    `deploy/medplum/README.md`).
    """

    return {
        "X-LiverRa-Test-Tenant": tenant_id,
        "X-LiverRa-Test-Role": role,
        "Authorization": f"Bearer dev:{role}:{tenant_id}",
    }


def _make_study(tenant_id: str) -> dict:
    return {
        "resourceType": "ImagingStudy",
        "status": "available",
        "subject": {"reference": f"Patient/pt-{tenant_id}"},
        "meta": {"tag": [{"system": TENANT_TAG_SYSTEM, "code": tenant_id}]},
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_tenant_a_cannot_search_tenant_b_resource(fhir_client) -> None:  # type: ignore[no-untyped-def]
    # Seed as tenant B
    resp = fhir_client.post(
        "/fhir/R4/ImagingStudy",
        json=_make_study("tenant-b"),
        headers=_tenant_headers("tenant-b"),
    )
    assert resp.status_code in (200, 201), resp.text
    tenant_b_id = resp.json()["id"]

    # Search as tenant A — should yield 0 results
    search = fhir_client.get(
        "/fhir/R4/ImagingStudy",
        headers=_tenant_headers("tenant-a"),
    )
    assert search.status_code == 200
    bundle = search.json()
    entries = bundle.get("entry", [])
    leaked = [e for e in entries if e.get("resource", {}).get("id") == tenant_b_id]
    assert not leaked, f"Tenant A saw tenant B resource: {leaked!r}"


def test_tenant_a_cannot_read_tenant_b_resource_by_id(fhir_client) -> None:  # type: ignore[no-untyped-def]
    resp = fhir_client.post(
        "/fhir/R4/ImagingStudy",
        json=_make_study("tenant-b"),
        headers=_tenant_headers("tenant-b"),
    )
    assert resp.status_code in (200, 201)
    tenant_b_id = resp.json()["id"]

    read = fhir_client.get(
        f"/fhir/R4/ImagingStudy/{tenant_b_id}",
        headers=_tenant_headers("tenant-a"),
    )
    # Non-disclosure: MUST be 404, never 403
    assert read.status_code == 404, (
        f"Cross-tenant read must return 404 (FR-032a), got {read.status_code}"
    )

    body = read.json()
    assert "patient" not in str(body).lower(), "PHI hint leaked in cross-tenant 404 body"


def test_tenant_b_can_still_read_own_resource(fhir_client) -> None:  # type: ignore[no-untyped-def]
    resp = fhir_client.post(
        "/fhir/R4/ImagingStudy",
        json=_make_study("tenant-b"),
        headers=_tenant_headers("tenant-b"),
    )
    assert resp.status_code in (200, 201)
    tenant_b_id = resp.json()["id"]

    read = fhir_client.get(
        f"/fhir/R4/ImagingStudy/{tenant_b_id}",
        headers=_tenant_headers("tenant-b"),
    )
    assert read.status_code == 200, "Tenant B must retain access to own resource"
