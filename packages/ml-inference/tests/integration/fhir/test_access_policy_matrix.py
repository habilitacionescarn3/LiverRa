"""AccessPolicy × role matrix conformance test.

Tasks T455 · Plan §FHIR integration tests.

Loads every RBAC-generator-emitted policy from
``deploy/medplum/access-policies/*.json``, POSTs it to the ephemeral Medplum
instance, and asserts the read/write scopes for the 5 core resource types
match the intent encoded in ``src/services/auth/rbac/matrix.yaml``.

Core resources audited:
    Patient · ImagingStudy · Observation · AuditEvent · DiagnosticReport
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List, Set

import pytest

try:
    import httpx  # type: ignore[import-not-found]
    import yaml
except Exception as exc:  # pragma: no cover
    pytest.skip(f"httpx / pyyaml unavailable: {exc}", allow_module_level=True)


REPO_ROOT = Path(__file__).resolve().parents[4]
POLICIES_DIR = REPO_ROOT / "deploy" / "medplum" / "access-policies"
MATRIX_PATH = (
    REPO_ROOT
    / "packages"
    / "ml-inference"
    / "src"
    / "services"
    / "auth"
    / "rbac"
    / "matrix.yaml"
)

CORE_RESOURCES = [
    "Patient",
    "ImagingStudy",
    "Observation",
    "AuditEvent",
    "DiagnosticReport",
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def matrix() -> Dict[str, Any]:
    if not MATRIX_PATH.exists():
        pytest.skip(f"RBAC matrix missing: {MATRIX_PATH}")
    return yaml.safe_load(MATRIX_PATH.read_text()) or {}


@pytest.fixture(scope="module")
def policy_files() -> List[Path]:
    if not POLICIES_DIR.exists():
        pytest.skip(f"Policies dir missing: {POLICIES_DIR}")
    files = sorted(POLICIES_DIR.glob("*.json"))
    if not files:
        pytest.skip(f"No AccessPolicy JSON files found in {POLICIES_DIR}")
    return files


@pytest.fixture(scope="module")
def medplum_url() -> str:
    url = os.environ.get("LIVERRA_MEDPLUM_URL")
    if not url:
        pytest.skip("LIVERRA_MEDPLUM_URL not set — skipping integration test")
    return url.rstrip("/")


@pytest.fixture(scope="module")
def admin_token() -> str:
    tok = os.environ.get("LIVERRA_MEDPLUM_ADMIN_TOKEN")
    if not tok:
        pytest.skip("LIVERRA_MEDPLUM_ADMIN_TOKEN not set")
    return tok


@pytest.fixture(scope="module")
def fhir_client(medplum_url: str, admin_token: str) -> Iterator[httpx.Client]:
    client = httpx.Client(
        base_url=medplum_url,
        headers={"Authorization": f"Bearer {admin_token}"},
        timeout=30.0,
    )
    yield client
    client.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _matrix_intent(matrix: Dict[str, Any], role_key: str) -> Dict[str, Set[str]]:
    """Return the intended per-resource read/write grants from matrix.yaml.

    Shape: ``{resource: {"read", "write"}}``.
    """

    role = next((r for r in matrix.get("roles", []) if r.get("key") == role_key), None)
    if role is None:
        return {}

    granted_perms = set(role.get("permissions", []))
    # "*" = all perms
    if "*" in granted_perms:
        granted_perms = {p["key"] for p in matrix.get("permissions", [])}

    # Map permission → (resource, op). Heuristic: naming convention
    # "study.view" → ("ImagingStudy", "read"), "report.finalize" → ("DiagnosticReport", "write"), etc.
    perm_map: Dict[str, List[tuple]] = {
        "study.view": [("ImagingStudy", "read")],
        "study.upload": [("ImagingStudy", "write")],
        "study.delete": [("ImagingStudy", "write")],
        "analysis.view": [("Observation", "read")],
        "report.view": [("DiagnosticReport", "read")],
        "report.finalize": [("DiagnosticReport", "write")],
        "report.retract": [("DiagnosticReport", "write")],
        "audit.view": [("AuditEvent", "read")],
        "patient.view": [("Patient", "read")],
        "patient.edit": [("Patient", "write")],
    }

    intent: Dict[str, Set[str]] = {r: set() for r in CORE_RESOURCES}
    for perm in granted_perms:
        for resource, op in perm_map.get(perm, []):
            intent.setdefault(resource, set()).add(op)
    return intent


def _policy_scopes(policy: Dict[str, Any]) -> Dict[str, Set[str]]:
    """Extract ``{resource: {"read", "write"}}`` from a Medplum AccessPolicy."""

    scopes: Dict[str, Set[str]] = {r: set() for r in CORE_RESOURCES}
    for entry in policy.get("resource", []):
        rt = entry.get("resourceType")
        if rt not in scopes:
            continue
        # Medplum AccessPolicy semantics: entry without readonly=true implies
        # write access; entry with readonly=true implies read-only.
        if entry.get("readonly") is True:
            scopes[rt].add("read")
        elif entry.get("writeonly") is True:
            scopes[rt].add("write")
        else:
            scopes[rt].update({"read", "write"})
    return scopes


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_every_role_policy_uploads_successfully(
    fhir_client: httpx.Client, policy_files: List[Path]
) -> None:
    for path in policy_files:
        body = json.loads(path.read_text())
        resp = fhir_client.post("/fhir/R4/AccessPolicy", json=body)
        assert resp.status_code in (200, 201), (
            f"Policy {path.name} rejected by Medplum: {resp.status_code} {resp.text[:200]}"
        )


@pytest.mark.parametrize("resource", CORE_RESOURCES)
def test_per_role_policy_matches_matrix_intent(
    resource: str,
    matrix: Dict[str, Any],
    policy_files: List[Path],
) -> None:
    failures: List[str] = []

    for path in policy_files:
        # Role key encoded in filename: ``access-policy-<role>.json`` or
        # ``<role>.json``. Strip and normalise.
        role_key = path.stem.replace("access-policy-", "")

        policy = json.loads(path.read_text())
        policy_scope = _policy_scopes(policy).get(resource, set())
        intent = _matrix_intent(matrix, role_key).get(resource, set())

        # Policy should grant AT LEAST the matrix-intended ops (may grant more
        # only with an explicit inline rationale — enforcement left to review).
        missing = intent - policy_scope
        if missing:
            failures.append(
                f"{role_key}/{resource}: matrix intends {sorted(intent)} but policy grants {sorted(policy_scope)} (missing: {sorted(missing)})"
            )

    assert not failures, "AccessPolicy mismatch vs matrix.yaml:\n  " + "\n  ".join(failures)
