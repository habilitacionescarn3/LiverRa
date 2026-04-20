#!/usr/bin/env python3
"""T401 — verify-audit-chain.

Plain-English summary: LiverRa stores a tamper-evident audit log as a
per-tenant linear hash chain (see ADR-0003). Nightly we anchor the
Merkle root to S3 (write-once-read-many). This script replays each
tenant's chain, recomputes every `leaf_hash`, and cross-checks the
computed Merkle root against the S3 anchor for that date. If any chain
link is broken or any anchor mismatches, we have a tamper incident.

SC-010: "Audit chain verifier 100% pass over 24 h".

Exit codes:
    0 - every tenant's chain + anchor verified
    1 - chain broken for one or more tenants
    2 - usage error
    3 - environment error (DB / S3 unreachable)
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import Iterator

logger = logging.getLogger("verify-audit-chain")


@dataclass
class ChainResult:
    tenant_id: str
    rows_checked: int
    chain_valid: bool
    computed_root: str
    anchor_root: str | None
    anchor_match: bool
    errors: list[str] = field(default_factory=list)


def _env(name: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"missing required env var: {name}")
    return value or ""


def _connect_db():
    try:
        import psycopg  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"psycopg not installed: {exc}") from exc
    dsn = _env("LIVERRA_DATABASE_URL", required=True)
    return psycopg.connect(dsn)


def _tenants(cursor, explicit: list[str]) -> list[str]:
    if explicit:
        return explicit
    cursor.execute("SELECT id::text FROM tenant ORDER BY created_at ASC")
    return [r[0] for r in cursor.fetchall()]


def _iter_chain(cursor, tenant_id: str) -> Iterator[tuple[int, str, str, bytes]]:
    cursor.execute(
        """
        SELECT sequence_no, prev_leaf_hash, leaf_hash, payload_canonical
          FROM audit_event_chain
         WHERE tenant_id = %s
         ORDER BY sequence_no ASC
        """,
        (tenant_id,),
    )
    for seq, prev_hash, leaf_hash, payload in cursor:
        yield seq, prev_hash, leaf_hash, payload


def _expected_leaf(prev_hash: str, payload: bytes) -> str:
    h = hashlib.sha256()
    h.update(prev_hash.encode("utf-8"))
    h.update(b"\n")
    h.update(payload if isinstance(payload, (bytes, bytearray)) else str(payload).encode("utf-8"))
    return h.hexdigest()


def _merkle_root(leaves: list[str]) -> str:
    if not leaves:
        return ""
    layer = [bytes.fromhex(h) for h in leaves]
    while len(layer) > 1:
        if len(layer) % 2:
            layer.append(layer[-1])
        layer = [hashlib.sha256(layer[i] + layer[i + 1]).digest() for i in range(0, len(layer), 2)]
    return layer[0].hex()


def _fetch_anchor(tenant_id: str, day: dt.date, bucket: str) -> str | None:
    try:
        import boto3  # type: ignore
    except Exception as exc:  # noqa: BLE001
        logger.error("boto3 not installed: %s", exc)
        return None
    key = f"{tenant_id}/{day.isoformat()}.json"
    s3 = boto3.client("s3", region_name=_env("AWS_REGION", "eu-central-1"))
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("anchor missing for %s/%s: %s", tenant_id, day.isoformat(), exc)
        return None
    body = obj["Body"].read()
    try:
        data = json.loads(body)
    except Exception as exc:  # noqa: BLE001
        logger.error("anchor JSON parse failed: %s", exc)
        return None
    return data.get("merkle_root")


def verify_tenant(cursor, tenant_id: str, bucket: str, anchor_date: dt.date) -> ChainResult:
    result = ChainResult(
        tenant_id=tenant_id,
        rows_checked=0,
        chain_valid=True,
        computed_root="",
        anchor_root=None,
        anchor_match=False,
    )
    leaves: list[str] = []
    prev_hash = ("0" * 64)
    for seq, stored_prev, stored_leaf, payload in _iter_chain(cursor, tenant_id):
        result.rows_checked += 1
        if stored_prev != prev_hash:
            result.chain_valid = False
            result.errors.append(f"seq={seq} prev_hash mismatch (stored={stored_prev[:8]} expected={prev_hash[:8]})")
        expected = _expected_leaf(prev_hash, payload)
        if expected != stored_leaf:
            result.chain_valid = False
            result.errors.append(f"seq={seq} leaf_hash mismatch (stored={stored_leaf[:8]} expected={expected[:8]})")
        leaves.append(stored_leaf)
        prev_hash = stored_leaf

    result.computed_root = _merkle_root(leaves)
    result.anchor_root = _fetch_anchor(tenant_id, anchor_date, bucket)
    result.anchor_match = bool(result.anchor_root) and result.anchor_root == result.computed_root
    if result.anchor_root and not result.anchor_match:
        result.errors.append(
            f"merkle root mismatch: computed={result.computed_root[:12]} anchor={result.anchor_root[:12]}"
        )
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", action="append", default=[], help="UUID (repeatable)")
    parser.add_argument("--all-tenants", action="store_true")
    parser.add_argument(
        "--anchor-bucket",
        default=os.environ.get("LIVERRA_AUDIT_ANCHOR_BUCKET", "liverra-audit-anchors-eu-central-1"),
    )
    parser.add_argument(
        "--anchor-date",
        default=dt.date.today().isoformat(),
        help="ISO date (YYYY-MM-DD) of the anchor to compare against",
    )
    parser.add_argument(
        "--report-path",
        default=".tmp/verify-audit-chain-report.json",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    if not (args.tenant_id or args.all_tenants):
        parser.error("either --tenant-id or --all-tenants is required")

    try:
        anchor_date = dt.date.fromisoformat(args.anchor_date)
    except ValueError as exc:
        parser.error(f"bad --anchor-date: {exc}")
        return 2

    try:
        conn = _connect_db()
    except RuntimeError as exc:
        logger.error("%s", exc)
        return 3

    overall_ok = True
    report = {"sc": "SC-010", "anchor_date": anchor_date.isoformat(), "tenants": []}
    with conn.cursor() as cur:
        tenants = _tenants(cur, [] if args.all_tenants else args.tenant_id)
        if not tenants:
            logger.error("no tenants to verify")
            return 3
        for tid in tenants:
            logger.info("verifying tenant %s", tid)
            res = verify_tenant(cur, tid, args.anchor_bucket, anchor_date)
            logger.info(
                "  rows=%d chain_valid=%s anchor_match=%s errors=%d",
                res.rows_checked,
                res.chain_valid,
                res.anchor_match,
                len(res.errors),
            )
            for err in res.errors:
                logger.error("    %s", err)
            if not (res.chain_valid and res.anchor_match):
                overall_ok = False
            report["tenants"].append(res.__dict__)

    report_path = args.report_path
    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, default=str)
    logger.info("report: %s", report_path)

    if overall_ok:
        logger.info("SC-010 audit chain: PASS")
        return 0

    logger.error("SC-010 audit chain: FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
