#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Bootstrap a LiverRa tenant inside Medplum.

Per-tenant provisioning (research §A.2):
    1. Client-credentials OAuth2 against Medplum `/oauth2/token`.
    2. Create a `Project` resource named after the tenant.
    3. Upsert every StructureDefinition JSON from
       `packages/fhirtypes/src/liverra/extensions/` into that Project.

Idempotent: on HTTP 409 Conflict we GET by `url` and PUT the updated body.

Environment variables (all required unless --dry-run):
    MEDPLUM_BASE_URL        e.g. https://medplum.liverra.ai
    MEDPLUM_CLIENT_ID       OAuth2 client id (client-credentials)
    MEDPLUM_CLIENT_SECRET   OAuth2 client secret
    TENANT_ID               Stable, URL-safe tenant identifier
    TENANT_NAME             Human-readable tenant display name

Exit codes:
    0 — every StructureDefinition reconciled
    1 — authentication / transport / config failure
    2 — at least one StructureDefinition failed to upsert
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[3]
EXTENSIONS_DIR = REPO_ROOT / "packages" / "fhirtypes" / "src" / "liverra" / "extensions"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class BootstrapConfig:
    """Holds all env-sourced configuration for a single bootstrap run."""

    def __init__(self, *, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.base_url = os.environ.get("MEDPLUM_BASE_URL", "").rstrip("/")
        self.client_id = os.environ.get("MEDPLUM_CLIENT_ID", "")
        self.client_secret = os.environ.get("MEDPLUM_CLIENT_SECRET", "")
        self.tenant_id = os.environ.get("TENANT_ID", "")
        self.tenant_name = os.environ.get("TENANT_NAME", "")

    def validate(self) -> list[str]:
        missing: list[str] = []
        if not self.dry_run:
            for name in (
                "MEDPLUM_BASE_URL",
                "MEDPLUM_CLIENT_ID",
                "MEDPLUM_CLIENT_SECRET",
                "TENANT_ID",
                "TENANT_NAME",
            ):
                if not os.environ.get(name):
                    missing.append(name)
        return missing


# ---------------------------------------------------------------------------
# Medplum client helpers
# ---------------------------------------------------------------------------
def authenticate(client: httpx.Client, cfg: BootstrapConfig) -> str:
    """Exchange client credentials for a bearer access token."""
    resp = client.post(
        f"{cfg.base_url}/oauth2/token",
        data={
            "grant_type": "client_credentials",
            "client_id": cfg.client_id,
            "client_secret": cfg.client_secret,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30.0,
    )
    resp.raise_for_status()
    token = resp.json().get("access_token")
    if not token:
        raise RuntimeError("Medplum token response missing access_token")
    return token


def create_project(client: httpx.Client, cfg: BootstrapConfig, token: str) -> str:
    """Create or find the tenant Project. Returns the Medplum `Project.id`."""
    body: dict[str, Any] = {
        "resourceType": "Project",
        "name": cfg.tenant_name,
        "identifier": [
            {
                "system": "http://liverra.ai/fhir/sid/tenant",
                "value": cfg.tenant_id,
            }
        ],
    }
    auth = {"Authorization": f"Bearer {token}"}

    # Idempotency: search by tenant identifier first.
    search = client.get(
        f"{cfg.base_url}/fhir/R4/Project",
        params={"identifier": f"http://liverra.ai/fhir/sid/tenant|{cfg.tenant_id}"},
        headers=auth,
        timeout=30.0,
    )
    if search.status_code == 200:
        entries = search.json().get("entry") or []
        if entries:
            existing_id = entries[0]["resource"]["id"]
            print(f"[project] existing Project found: id={existing_id}")
            return existing_id

    create = client.post(
        f"{cfg.base_url}/fhir/R4/Project",
        json=body,
        headers={**auth, "Content-Type": "application/fhir+json"},
        timeout=30.0,
    )
    create.raise_for_status()
    project_id = create.json()["id"]
    print(f"[project] created Project: id={project_id} name={cfg.tenant_name!r}")
    return project_id


def upsert_structure_definition(
    client: httpx.Client,
    cfg: BootstrapConfig,
    token: str,
    project_id: str,
    resource: dict[str, Any],
) -> tuple[bool, str]:
    """Create-or-update a single StructureDefinition inside the tenant Project.

    Returns (ok, detail).
    """
    url = resource.get("url")
    if not url:
        return False, "StructureDefinition missing `url`"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/fhir+json",
        "X-Medplum-Project": project_id,
    }

    # Try POST first (new install path).
    post = client.post(
        f"{cfg.base_url}/fhir/R4/StructureDefinition",
        json=resource,
        headers=headers,
        timeout=30.0,
    )
    if post.status_code in (200, 201):
        return True, f"created ({post.status_code})"

    if post.status_code != 409:
        return False, f"POST {post.status_code}: {post.text[:200]}"

    # 409 Conflict → locate the existing instance by url and PUT.
    search = client.get(
        f"{cfg.base_url}/fhir/R4/StructureDefinition",
        params={"url": url},
        headers=headers,
        timeout=30.0,
    )
    if search.status_code != 200:
        return False, f"conflict GET {search.status_code}: {search.text[:200]}"

    entries = search.json().get("entry") or []
    if not entries:
        return False, "conflict but no matching StructureDefinition found on GET"

    existing = entries[0]["resource"]
    resource_with_id = {**resource, "id": existing["id"]}
    put = client.put(
        f"{cfg.base_url}/fhir/R4/StructureDefinition/{existing['id']}",
        json=resource_with_id,
        headers=headers,
        timeout=30.0,
    )
    if put.status_code in (200, 201):
        return True, f"updated ({put.status_code})"
    return False, f"PUT {put.status_code}: {put.text[:200]}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def discover_extensions() -> list[Path]:
    if not EXTENSIONS_DIR.is_dir():
        raise FileNotFoundError(f"Extensions directory missing: {EXTENSIONS_DIR}")
    return sorted(EXTENSIONS_DIR.glob("*.json"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bootstrap a LiverRa tenant inside Medplum."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List the StructureDefinitions that would be upserted; do not call Medplum.",
    )
    args = parser.parse_args()

    cfg = BootstrapConfig(dry_run=args.dry_run)
    missing = cfg.validate()
    if missing:
        print(f"error: missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    try:
        files = discover_extensions()
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if not files:
        print(f"error: no StructureDefinition JSON files found in {EXTENSIONS_DIR}", file=sys.stderr)
        return 1

    print(f"[bootstrap] {len(files)} StructureDefinition(s) discovered in {EXTENSIONS_DIR}")

    if cfg.dry_run:
        for path in files:
            try:
                body = json.loads(path.read_text())
                print(f"  DRY-RUN would upsert {body.get('url')} ({path.name})")
            except json.JSONDecodeError as exc:
                print(f"  DRY-RUN invalid JSON in {path.name}: {exc}", file=sys.stderr)
                return 2
        return 0

    failures: list[str] = []
    try:
        with httpx.Client() as client:
            token = authenticate(client, cfg)
            project_id = create_project(client, cfg, token)

            for path in files:
                try:
                    resource = json.loads(path.read_text())
                except json.JSONDecodeError as exc:
                    failures.append(f"{path.name}: invalid JSON ({exc})")
                    continue

                ok, detail = upsert_structure_definition(
                    client, cfg, token, project_id, resource
                )
                status = "OK" if ok else "FAIL"
                print(f"  [{status}] {path.name} — {detail}")
                if not ok:
                    failures.append(f"{path.name}: {detail}")
    except httpx.HTTPError as exc:
        print(f"error: transport failure: {exc}", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if failures:
        print(f"\n[bootstrap] {len(failures)} failure(s):", file=sys.stderr)
        for msg in failures:
            print(f"  - {msg}", file=sys.stderr)
        return 2

    print(f"\n[bootstrap] success: {len(files)} StructureDefinition(s) reconciled into tenant {cfg.tenant_id!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
