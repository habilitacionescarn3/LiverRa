"""LiverRa RBAC code generator.

Reads matrix.yaml (the single source of truth for permissions + roles) and
emits three artifact families:

1. packages/app/src/emr/constants/permissions.gen.ts
   TypeScript string-literal union + ROLE_PERMISSIONS map + STEP_UP set.

2. packages/ml-inference/src/services/auth/rbac/permissions_registry.py
   Python Enum + ROLE_PERMISSIONS frozenset map + STEP_UP frozenset.

3. deploy/medplum/access-policies/<role>.json
   One Medplum AccessPolicy resource per role. FHIR resource R/W is inferred
   from the permission key (best-effort mapping — see PERMISSION_FHIR_MAP).

The generator is idempotent: repeated runs against unchanged inputs produce
byte-identical output. When running against pre-existing files, a one-line
diff summary is printed per file.

Usage (from repo root)::

    python -m src.services.auth.rbac.generator

Executed automatically via the `generate:permissions` Turbo task.

Spec references: T060-T064, research.md §X.3, plan.md §Frontend RBAC wiring.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

# This file lives at: packages/ml-inference/src/services/auth/rbac/generator.py
# Parents: [rbac, auth, services, src, ml-inference, packages, <repo-root>]
_THIS_FILE = Path(__file__).resolve()
REPO_ROOT = _THIS_FILE.parents[6]

MATRIX_PATH = _THIS_FILE.parent / "matrix.yaml"
TS_OUTPUT = REPO_ROOT / "packages/app/src/emr/constants/permissions.gen.ts"
PY_OUTPUT = _THIS_FILE.parent / "permissions_registry.py"
ACCESS_POLICY_DIR = REPO_ROOT / "deploy/medplum/access-policies"

BANNER_TS = (
    "// AUTO-GENERATED from "
    "packages/ml-inference/src/services/auth/rbac/matrix.yaml — DO NOT EDIT\n"
    "// Regenerate via: `npm run generate:permissions`\n"
)
BANNER_PY = (
    '"""AUTO-GENERATED from '
    "packages/ml-inference/src/services/auth/rbac/matrix.yaml -- DO NOT EDIT.\n\n"
    "Regenerate via: `npm run generate:permissions`.\n"
    '"""\n'
)


# ---------------------------------------------------------------------------
# Matrix parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Permission:
    key: str
    description: str
    step_up: bool
    tenant_scoped: bool


@dataclass(frozen=True)
class Role:
    key: str
    description: str
    permissions: tuple[str, ...]


@dataclass(frozen=True)
class Matrix:
    permissions: tuple[Permission, ...]
    roles: tuple[Role, ...]

    @property
    def permission_keys(self) -> tuple[str, ...]:
        return tuple(p.key for p in self.permissions)

    @property
    def step_up_keys(self) -> tuple[str, ...]:
        return tuple(p.key for p in self.permissions if p.step_up)

    @property
    def role_keys(self) -> tuple[str, ...]:
        return tuple(r.key for r in self.roles)


def load_matrix(path: Path = MATRIX_PATH) -> Matrix:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)

    raw_perms = data.get("permissions") or []
    raw_roles = data.get("roles") or {}

    permissions: list[Permission] = []
    seen_keys: set[str] = set()
    for entry in raw_perms:
        key = entry["key"]
        if key in seen_keys:
            raise ValueError(f"Duplicate permission key in matrix.yaml: {key}")
        seen_keys.add(key)
        permissions.append(
            Permission(
                key=key,
                description=entry.get("description", "").strip(),
                step_up=bool(entry.get("step_up", False)),
                tenant_scoped=bool(entry.get("tenant_scoped", True)),
            )
        )

    permissions.sort(key=lambda p: p.key)
    valid_keys = {p.key for p in permissions}

    roles: list[Role] = []
    for name in sorted(raw_roles.keys()):
        entry = raw_roles[name]
        perms = tuple(entry.get("permissions") or [])
        unknown = [p for p in perms if p not in valid_keys]
        if unknown:
            raise ValueError(
                f"Role {name!r} references unknown permissions: {unknown}"
            )
        roles.append(
            Role(
                key=name,
                description=(entry.get("description") or "").strip(),
                permissions=tuple(sorted(set(perms))),
            )
        )

    return Matrix(permissions=tuple(permissions), roles=tuple(roles))


# ---------------------------------------------------------------------------
# TypeScript emitter
# ---------------------------------------------------------------------------


def render_typescript(matrix: Matrix) -> str:
    lines: list[str] = [BANNER_TS, ""]

    # Permission union
    lines.append("export type LiverraPermission =")
    for i, key in enumerate(matrix.permission_keys):
        suffix = ";" if i == len(matrix.permission_keys) - 1 else ""
        prefix = "  |" if i > 0 else "  |"
        lines.append(f"{prefix} '{key}'{suffix}")
    lines.append("")

    # Permission list
    lines.append(
        "export const LIVERRA_PERMISSIONS: readonly LiverraPermission[] = ["
    )
    for key in matrix.permission_keys:
        lines.append(f"  '{key}',")
    lines.append("] as const;")
    lines.append("")

    # Role union
    lines.append("export type LiverraRole =")
    for i, key in enumerate(matrix.role_keys):
        suffix = ";" if i == len(matrix.role_keys) - 1 else ""
        lines.append(f"  | '{key}'{suffix}")
    lines.append("")

    # Role list
    lines.append("export const LIVERRA_ROLES: readonly LiverraRole[] = [")
    for key in matrix.role_keys:
        lines.append(f"  '{key}',")
    lines.append("] as const;")
    lines.append("")

    # Role → permissions
    lines.append(
        "export const ROLE_PERMISSIONS: "
        "Record<LiverraRole, readonly LiverraPermission[]> = {"
    )
    for role in matrix.roles:
        lines.append(f"  {role.key}: [")
        for p in role.permissions:
            lines.append(f"    '{p}',")
        lines.append("  ],")
    lines.append("} as const;")
    lines.append("")

    # Step-up set
    lines.append(
        "export const STEP_UP_PERMISSIONS: ReadonlySet<LiverraPermission> ="
    )
    lines.append("  new Set<LiverraPermission>([")
    for key in matrix.step_up_keys:
        lines.append(f"    '{key}',")
    lines.append("  ]);")
    lines.append("")

    # Helper
    lines.append(
        "export function roleHasPermission("
        "role: LiverraRole, perm: LiverraPermission): boolean {"
    )
    lines.append("  return ROLE_PERMISSIONS[role].includes(perm);")
    lines.append("}")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Python emitter
# ---------------------------------------------------------------------------


def _py_enum_name(key: str) -> str:
    return key.upper().replace(".", "_")


def render_python(matrix: Matrix) -> str:
    lines: list[str] = [BANNER_PY]
    lines.append("from __future__ import annotations")
    lines.append("")
    lines.append("from enum import Enum")
    lines.append("")
    lines.append("")
    lines.append("class Permission(str, Enum):")
    lines.append('    """LiverRa permission enumeration."""')
    lines.append("")
    for p in matrix.permissions:
        lines.append(f"    {_py_enum_name(p.key)} = {p.key!r}")
    lines.append("")
    lines.append("")

    lines.append("ROLE_PERMISSIONS: dict[str, frozenset[Permission]] = {")
    for role in matrix.roles:
        lines.append(f"    {role.key!r}: frozenset({{")
        for perm in role.permissions:
            lines.append(f"        Permission.{_py_enum_name(perm)},")
        lines.append("    }),")
    lines.append("}")
    lines.append("")

    lines.append("STEP_UP_PERMISSIONS: frozenset[Permission] = frozenset({")
    for key in matrix.step_up_keys:
        lines.append(f"    Permission.{_py_enum_name(key)},")
    lines.append("})")
    lines.append("")

    lines.append("TENANT_SCOPED_PERMISSIONS: frozenset[Permission] = frozenset({")
    for p in matrix.permissions:
        if p.tenant_scoped:
            lines.append(f"    Permission.{_py_enum_name(p.key)},")
    lines.append("})")
    lines.append("")

    lines.append(
        "def role_has_permission(role: str, perm: Permission) -> bool:"
    )
    lines.append('    """Return True if `role` grants `perm`."""')
    lines.append("    return perm in ROLE_PERMISSIONS.get(role, frozenset())")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Medplum AccessPolicy emitter
# ---------------------------------------------------------------------------

# Permission-key -> FHIR resource R/W mapping.
# `write=True` means the role may create/update/delete that resource type.
# This is a best-effort translation; server-side `@require_permission`
# remains the authoritative gate.
PERMISSION_FHIR_MAP: dict[str, list[tuple[str, bool]]] = {
    "study.upload": [("ImagingStudy", True), ("DocumentReference", True), ("Patient", True)],
    "study.view": [("ImagingStudy", False), ("Patient", False)],
    "study.delete": [("ImagingStudy", True)],
    "analysis.view": [("Task", False), ("Observation", False), ("DiagnosticReport", False)],
    "analysis.retry": [("Task", True)],
    "analysis.cancel": [("Task", True)],
    "review.refine_mask": [("Observation", True), ("Media", True)],
    "review.reprompt_lesion": [("Observation", True), ("Media", True)],
    "review.override_classification": [("Observation", True)],
    "review.seat_takeover": [("Task", True)],
    "review.flr_adjust": [("Observation", True)],
    "report.finalize": [("DiagnosticReport", True), ("DocumentReference", True)],
    "report.retract": [("DiagnosticReport", True)],
    "report.view": [("DiagnosticReport", False)],
    "report.pacs_push": [("Task", True), ("DocumentReference", True)],
    "report.pacs_retry": [("Task", True)],
    "report.download": [("DocumentReference", False), ("Binary", False)],
    "pacs.config_read": [("Endpoint", False)],
    "pacs.config_write": [("Endpoint", True)],
    "pacs.c_echo": [("Task", True)],
    "audit.view": [("AuditEvent", False)],
    "audit.export": [("AuditEvent", False)],
    "audit.verify_chain": [("AuditEvent", False)],
    "admin.user_create": [("Practitioner", True), ("PractitionerRole", True)],
    "admin.user_role_change": [("PractitionerRole", True)],
    "admin.tenant_config": [("Organization", True), ("Parameters", True)],
    "mbom.view": [("DocumentReference", False)],
    "mbom.upload": [("DocumentReference", True), ("Binary", True)],
    "claim_registry.view": [("Basic", False)],
    "claim_registry.activate": [("Basic", True)],
    "erasure.request": [("Task", True)],
    "erasure.approve": [("Task", True)],
    "erasure.execute": [("Task", True), ("Patient", True), ("ImagingStudy", True)],
    "ops.queue_view": [("Task", False)],
    "ops.case_unstick": [("Task", True)],
    "ops.gpu_status": [],  # telemetry — not a FHIR resource
    "compliance.view": [("AuditEvent", False), ("DocumentReference", False), ("Basic", False)],
    "compliance.sign_off": [("Basic", True), ("DocumentReference", True)],
}


def _role_resources(role: Role) -> list[dict[str, Any]]:
    """Collapse a role's permission list into a deduped FHIR resource table."""
    accumulator: dict[str, bool] = {}
    for perm_key in role.permissions:
        for resource_type, writable in PERMISSION_FHIR_MAP.get(perm_key, []):
            # Escalate: if any permission grants write, final entry is writable.
            accumulator[resource_type] = accumulator.get(resource_type, False) or writable

    entries: list[dict[str, Any]] = []
    for resource_type in sorted(accumulator.keys()):
        entries.append(
            {
                "resourceType": resource_type,
                "readonly": not accumulator[resource_type],
            }
        )
    return entries


def render_access_policy(role: Role) -> dict[str, Any]:
    return {
        "resourceType": "AccessPolicy",
        "name": f"liverra-{role.key.replace('_', '-')}",
        "meta": {
            "tag": [
                {
                    "system": "http://liverra.ai/fhir/CodeSystem/access-policy-role",
                    "code": role.key,
                    "display": role.description or role.key,
                }
            ]
        },
        "resource": _role_resources(role),
        "compartment": {"reference": "Project/${tenant_id}"},
    }


# ---------------------------------------------------------------------------
# Idempotent writer
# ---------------------------------------------------------------------------


def _ensure_trailing_newline(text: str) -> str:
    return text if text.endswith("\n") else text + "\n"


def _write_if_changed(path: Path, content: str) -> str:
    content = _ensure_trailing_newline(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if existing == content:
            return "unchanged"
        status = "updated"
    else:
        status = "created"
    path.write_text(content, encoding="utf-8")
    return status


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> int:
    matrix = load_matrix()

    outputs: list[tuple[Path, str]] = []

    # TS
    outputs.append((TS_OUTPUT, render_typescript(matrix)))

    # Python registry
    outputs.append((PY_OUTPUT, render_python(matrix)))

    # Medplum AccessPolicies
    for role in matrix.roles:
        policy = render_access_policy(role)
        policy_path = ACCESS_POLICY_DIR / f"{role.key.replace('_', '-')}.json"
        outputs.append(
            (policy_path, json.dumps(policy, indent=2, sort_keys=False))
        )

    print(
        f"[rbac] matrix: {len(matrix.permissions)} permissions, "
        f"{len(matrix.roles)} roles, "
        f"{len(matrix.step_up_keys)} step-up"
    )
    for path, content in outputs:
        status = _write_if_changed(path, content)
        rel = path.relative_to(REPO_ROOT)
        print(f"[rbac] {status:9s} {rel}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
