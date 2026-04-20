"""FHIR extension URL roundtrip integrity test.

Tasks T456 · Plan §FHIR integration tests.

Creates:
    - AuditEvent carrying all 4 LiverRa AuditEvent extensions
      (permission-checked, model-version, chain-sequence-no, chain-leaf-hash)
    - Observation carrying ``ruo-claim-key`` extension

Roundtrips each via Medplum GET and asserts:
    - Every extension URL is preserved verbatim (no rewriting).
    - Every extension value is preserved lossless (including base64 + integer).
"""

from __future__ import annotations

import base64
import os
from typing import Any, Dict, Iterator

import pytest

try:
    import httpx  # type: ignore[import-not-found]
except Exception as exc:  # pragma: no cover
    pytest.skip(f"httpx unavailable: {exc}", allow_module_level=True)


# LiverRa extension URLs (mirrors packages/app/src/emr/constants/fhir-extensions.ts)
FHIR_BASE_URL = "http://liverra.ai/fhir"
EXT_BASE = f"{FHIR_BASE_URL}/StructureDefinition"

AUDIT_PERMISSION_CHECKED = f"{EXT_BASE}/audit-permission-checked"
AUDIT_MODEL_VERSION = f"{EXT_BASE}/audit-model-version"
AUDIT_CHAIN_SEQUENCE_NO = f"{EXT_BASE}/audit-chain-sequence-no"
AUDIT_CHAIN_LEAF_HASH = f"{EXT_BASE}/audit-chain-leaf-hash"
RUO_CLAIM_KEY = f"{EXT_BASE}/ruo-claim-key"


@pytest.fixture(scope="module")
def fhir_client() -> Iterator[httpx.Client]:
    url = os.environ.get("LIVERRA_MEDPLUM_URL")
    tok = os.environ.get("LIVERRA_MEDPLUM_ADMIN_TOKEN")
    if not url or not tok:
        pytest.skip("LIVERRA_MEDPLUM_URL / LIVERRA_MEDPLUM_ADMIN_TOKEN not set")
    client = httpx.Client(
        base_url=url.rstrip("/"),
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30.0,
    )
    yield client
    client.close()


def _audit_event_with_all_ext() -> Dict[str, Any]:
    leaf_hash_bytes = b"\x01" * 32
    return {
        "resourceType": "AuditEvent",
        "recorded": "2026-04-19T12:00:00Z",
        "action": "E",
        "outcome": "0",
        "agent": [{"type": {"coding": [{"code": "humanuser"}]}, "requestor": True}],
        "source": {"observer": {"reference": "Organization/tenant-ext-test"}},
        "extension": [
            {"url": AUDIT_PERMISSION_CHECKED, "valueBoolean": True},
            {"url": AUDIT_MODEL_VERSION, "valueString": "liverra-stunet-parenchyma-v1-20260419"},
            {"url": AUDIT_CHAIN_SEQUENCE_NO, "valuePositiveInt": 42},
            {
                "url": AUDIT_CHAIN_LEAF_HASH,
                "valueBase64Binary": base64.b64encode(leaf_hash_bytes).decode(),
            },
        ],
    }


def _observation_with_ruo_claim() -> Dict[str, Any]:
    return {
        "resourceType": "Observation",
        "status": "final",
        "code": {"coding": [{"system": "http://loinc.org", "code": "71020-7"}]},
        "valueQuantity": {"value": 42.5, "unit": "mL"},
        "extension": [
            {"url": RUO_CLAIM_KEY, "valueCode": "flr-v1"},
        ],
    }


def _get_ext(resource: Dict[str, Any], url: str) -> Dict[str, Any]:
    return next(e for e in resource.get("extension", []) if e.get("url") == url)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_audit_event_all_four_extensions_roundtrip(fhir_client: httpx.Client) -> None:
    original = _audit_event_with_all_ext()
    resp = fhir_client.post("/fhir/R4/AuditEvent", json=original)
    assert resp.status_code in (200, 201), resp.text
    created_id = resp.json()["id"]

    fetched = fhir_client.get(f"/fhir/R4/AuditEvent/{created_id}").json()

    # URL verbatim preservation
    returned_urls = {e.get("url") for e in fetched.get("extension", [])}
    for expected_url in (
        AUDIT_PERMISSION_CHECKED,
        AUDIT_MODEL_VERSION,
        AUDIT_CHAIN_SEQUENCE_NO,
        AUDIT_CHAIN_LEAF_HASH,
    ):
        assert expected_url in returned_urls, f"URL dropped/rewritten: {expected_url}"

    # Value fidelity
    assert _get_ext(fetched, AUDIT_PERMISSION_CHECKED)["valueBoolean"] is True
    assert _get_ext(fetched, AUDIT_MODEL_VERSION)["valueString"] == "liverra-stunet-parenchyma-v1-20260419"
    assert _get_ext(fetched, AUDIT_CHAIN_SEQUENCE_NO)["valuePositiveInt"] == 42
    returned_hash = _get_ext(fetched, AUDIT_CHAIN_LEAF_HASH)["valueBase64Binary"]
    assert base64.b64decode(returned_hash) == b"\x01" * 32, "leaf_hash bytes mangled on roundtrip"


def test_observation_ruo_claim_key_roundtrip(fhir_client: httpx.Client) -> None:
    original = _observation_with_ruo_claim()
    resp = fhir_client.post("/fhir/R4/Observation", json=original)
    assert resp.status_code in (200, 201), resp.text
    created_id = resp.json()["id"]

    fetched = fhir_client.get(f"/fhir/R4/Observation/{created_id}").json()
    returned_ext = _get_ext(fetched, RUO_CLAIM_KEY)
    assert returned_ext["url"] == RUO_CLAIM_KEY, "URL rewritten on roundtrip"
    assert returned_ext["valueCode"] == "flr-v1", "ruo-claim-key value lost"
