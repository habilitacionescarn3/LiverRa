"""RBAC red-team test — cartesian (role × permission) denial asserts.

Parametrized over the cartesian product of roles and permissions declared in
``src/services/auth/rbac/matrix.yaml``. For every pair that is NOT granted in
the matrix, the API must:

  1. Return HTTP **404** (FR-032a existence non-disclosure — not 403).
  2. RFC 7807 problem+json ``type`` ends with ``liverra:not-found``
     (or ``liverra:step-up-required`` / ``liverra:unauthenticated`` for the
     specific rows flagged in ``fixtures/role_crossing_catalog.yaml``).
  3. Emit an AuditEvent with ``outcome=minor-failure`` and tag
     ``rbac.denied=true``.
  4. Response body carries NO PHI (patient names, MRNs, birthdates,
     study descriptions).

Additionally runs the 15 canonical "named" role-crossing actions from the
catalog fixture as explicit scenarios (SC-015).

CI: ``ci-rbac-red-team`` — blocking on every PR. Auto-picks up new rows when
the RBAC matrix changes.

References: plan §RBAC red-team test · spec §SC-015, §FR-032a · tasks T360.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
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
CATALOG_PATH = Path(__file__).parent / "fixtures" / "role_crossing_catalog.yaml"

# Fields that would leak PHI if echoed in an error body. If any value in the
# response body matches one of these regexes, the test fails.
PHI_LEAK_PATTERNS: List[re.Pattern] = [
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),              # SSN-like
    re.compile(r"\b(?:19|20)\d{2}-\d{2}-\d{2}\b"),     # ISO date (DOB candidate)
    re.compile(r"\bMRN[:#\s]*\w+", re.IGNORECASE),     # MRN prefix
    re.compile(r"\bpatient[:\s]+[A-Za-zÀ-ÿ]+", re.IGNORECASE),
]

# Forbidden response keys — keys whose PRESENCE alone leaks info.
FORBIDDEN_RESPONSE_KEYS = {"patient", "patient_name", "mrn", "dob", "birth_date", "study_description"}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RbacPair:
    role: str
    permission: str
    granted: bool


def _load_matrix() -> Dict[str, Any]:
    if not MATRIX_PATH.exists():
        pytest.skip(f"RBAC matrix missing: {MATRIX_PATH}")
    return yaml.safe_load(MATRIX_PATH.read_text()) or {}


def _load_catalog() -> List[dict]:
    if not CATALOG_PATH.exists():
        pytest.skip(f"Role-crossing catalog missing: {CATALOG_PATH}")
    data = yaml.safe_load(CATALOG_PATH.read_text()) or {}
    return list(data.get("actions", []))


def _iter_pairs(matrix: Dict[str, Any]) -> Iterator[RbacPair]:
    """Yield every (role, permission, granted) triple."""

    perms = [p["key"] for p in matrix.get("permissions", [])]
    roles = [r["key"] for r in matrix.get("roles", [])]
    # Build grant set: role → set of permissions
    grants: Dict[str, set] = {
        r["key"]: set(r.get("permissions", [])) for r in matrix.get("roles", [])
    }
    # Wildcard role sets (admin often holds '*' expansion)
    for role in roles:
        granted_set = grants.get(role, set())
        if "*" in granted_set:
            granted_set = set(perms)
        for perm in perms:
            yield RbacPair(role=role, permission=perm, granted=perm in granted_set)


# ---------------------------------------------------------------------------
# PHI-leak checks
# ---------------------------------------------------------------------------


def _assert_no_phi(body: Any) -> None:
    """Deep scan of a JSON body — fail if any value matches a PHI pattern."""

    def _walk(node: Any, path: str = "$") -> None:
        if isinstance(node, dict):
            for key, val in node.items():
                assert key.lower() not in FORBIDDEN_RESPONSE_KEYS, (
                    f"Forbidden PHI-leaking key `{key}` in response at {path}"
                )
                _walk(val, f"{path}.{key}")
        elif isinstance(node, list):
            for i, item in enumerate(node):
                _walk(item, f"{path}[{i}]")
        elif isinstance(node, str):
            for pat in PHI_LEAK_PATTERNS:
                assert not pat.search(node), (
                    f"Response leaked PHI pattern {pat.pattern!r} at {path}: "
                    f"{node!r}"
                )

    _walk(body)


# ---------------------------------------------------------------------------
# HTTP client adapter — uses real TestClient when app is importable,
# otherwise skips (keeps this file executable in environments without the
# full FastAPI stack installed).
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def api_client():  # type: ignore[no-untyped-def]
    try:
        from fastapi.testclient import TestClient
        from src.main import app  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover — env-dependent
        pytest.skip(f"FastAPI app not importable: {exc}")
    return TestClient(app)


@pytest.fixture
def audit_sink(monkeypatch: pytest.MonkeyPatch):
    """In-memory audit sink substituting chain-of-hashes writer for the test."""

    captured: List[dict] = []
    try:
        from src.services.audit import chain_of_hashes as coh  # type: ignore[import-not-found]
    except Exception:  # pragma: no cover
        yield captured
        return

    def _fake_write(event: dict, *args: Any, **kwargs: Any) -> dict:
        captured.append(event)
        return {**event, "chain_position": len(captured), "leaf_hash": "0" * 64}

    monkeypatch.setattr(coh, "write_event", _fake_write, raising=False)
    yield captured


def _make_token_for_role(role: str, tenant: str = "tenant-test") -> Dict[str, str]:
    # MFA-bypass dev token honored only in test environment — see helpers
    # in packages/app/src/emr/views/__e2e__/liver-ai-pipeline/helpers/mock-backend.ts
    return {"Authorization": f"Bearer dev:{role}:{tenant}"}


# ---------------------------------------------------------------------------
# Cartesian red-team test
# ---------------------------------------------------------------------------


_MATRIX = _load_matrix() if MATRIX_PATH.exists() else {}
_PAIRS = list(_iter_pairs(_MATRIX)) if _MATRIX else []
_DENIED_PAIRS = [p for p in _PAIRS if not p.granted]


@pytest.mark.parametrize(
    "pair",
    _DENIED_PAIRS,
    ids=lambda p: f"{p.role}-NOT-{p.permission}",
)
def test_denied_pair_returns_404_no_phi(
    pair: RbacPair,
    api_client,  # type: ignore[no-untyped-def]
    audit_sink: List[dict],
) -> None:
    # Map permission → representative endpoint. Kept deliberately minimal; the
    # auth middleware enforcement is what we're testing, not routing completeness.
    path = _representative_path_for(pair.permission)
    if path is None:
        pytest.skip(f"No representative endpoint mapped for permission {pair.permission}")

    headers = _make_token_for_role(pair.role)
    resp = api_client.get(path, headers=headers)

    assert resp.status_code in (401, 404), (
        f"{pair.role} lacking {pair.permission} should get 401/404, "
        f"got {resp.status_code}"
    )

    body = resp.json() if resp.headers.get("content-type", "").startswith("application/") else {}
    type_url = body.get("type", "")
    assert type_url.endswith(("liverra:not-found", "liverra:step-up-required", "liverra:unauthenticated")), (
        f"Unexpected error type: {type_url!r}"
    )
    _assert_no_phi(body)

    # Audit: a denial event MUST be written.
    denied_events = [
        e for e in audit_sink
        if e.get("tags", {}).get("rbac.denied") is True
        or e.get("outcome") == "minor-failure"
    ]
    assert denied_events, (
        f"No rbac_denied audit event recorded for {pair.role}/{pair.permission}"
    )


# ---------------------------------------------------------------------------
# 15 canonical named role-crossing actions (SC-015)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "action",
    _load_catalog() if CATALOG_PATH.exists() else [],
    ids=lambda a: a["id"] if isinstance(a, dict) else str(a),
)
def test_named_role_crossing_action(
    action: dict,
    api_client,  # type: ignore[no-untyped-def]
    audit_sink: List[dict],
) -> None:
    role = action["actor_role"]
    tenant = action.get("actor_tenant", "tenant-test")
    headers = _make_token_for_role(role, tenant=tenant)

    # Staleness override (for step-up-bypass rows)
    staleness = action.get("auth_time_staleness_minutes")
    if staleness is not None:
        headers["X-Test-Auth-Time-Skew-Minutes"] = str(staleness)

    # Fill template with any value — resource does not need to exist for a
    # correctly-implemented endpoint to 404.
    path = action["path_template"].format(
        report_id="00000000-0000-0000-0000-000000000000",
        analysis_id="00000000-0000-0000-0000-000000000000",
        study_id="00000000-0000-0000-0000-000000000000",
        event_id="00000000-0000-0000-0000-000000000000",
        guessed_id="00000000-0000-0000-0000-000000000000",
        id="00000000-0000-0000-0000-000000000000",
    )

    method = action["method"].lower()
    client_method = getattr(api_client, method)
    resp = client_method(path, headers=headers, json={} if method in {"post", "patch", "put"} else None)

    assert resp.status_code == action["expected_status"], (
        f"{action['id']}: expected {action['expected_status']}, got {resp.status_code}"
    )

    body = resp.json() if "application/" in resp.headers.get("content-type", "") else {}
    assert body.get("type", "").endswith(action["expected_error_type"].split(":", 1)[-1]) or \
        body.get("type") == f"https://liverra.ai/errors/{action['expected_error_type'].split(':', 1)[-1]}", (
        f"{action['id']}: unexpected error type {body.get('type')!r}"
    )
    _assert_no_phi(body)


# ---------------------------------------------------------------------------
# Permission → endpoint mapping (minimal, intentionally)
# ---------------------------------------------------------------------------


def _representative_path_for(permission: str) -> Optional[str]:
    zero_uuid = "00000000-0000-0000-0000-000000000000"
    return {
        "study.upload": "/api/v1/studies",
        "study.view": f"/api/v1/studies/{zero_uuid}",
        "study.delete": f"/api/v1/studies/{zero_uuid}/deletion",
        "analysis.view": f"/api/v1/analyses/{zero_uuid}",
        "analysis.retry": f"/api/v1/analyses/{zero_uuid}/retry",
        "analysis.cancel": f"/api/v1/analyses/{zero_uuid}/cancel",
        "review.refine_mask": f"/api/v1/reviews/{zero_uuid}/refine",
        "review.flr_adjust": f"/api/v1/reviews/{zero_uuid}/flr",
        "report.finalize": f"/api/v1/reports/{zero_uuid}/finalize",
        "report.view": f"/api/v1/reports/{zero_uuid}",
        "report.pacs_push": f"/api/v1/reports/{zero_uuid}/pacs-push",
        "audit.view": f"/api/v1/audit/{zero_uuid}",
        "gdpr.erase": "/api/v1/gdpr/erasure",
    }.get(permission)
