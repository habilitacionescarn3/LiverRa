# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Compliance MBoM reader (T340).

Plain-English:
    The Model Bill of Materials lists every ML model we ship — each
    one's source URL, pinned git commit, license hash at build time,
    and the human who approved it. Two places keep this information:

      - ``MBoM.json``  (live file on disk; current build),
      - ``model_bill_of_materials`` (Postgres history; one row per
        build_sha × model_name combo).

    The compliance dashboard wants BOTH: the current build for the
    header "what's live" panel, and the historical rows for the
    "who approved this" drill-down. This module wraps them into a
    single response shaped exactly like the OpenAPI
    ``/compliance/mbom`` 200 response.

    Built on top of ``services/mbom/reader.py`` (T414) for the on-disk
    file + a direct Postgres query for the history.

Spec refs: FR-038, data-model.md §16.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..mbom.reader import MBoMReader, get_default_reader

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MBoMRow:
    """Flattened projection used by the compliance API."""

    model_name: str
    source_url: str
    pinned_commit_sha: str
    license_text_hash_hex: str
    license_name: str
    integration_date: Optional[date]
    approver: str

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "model_name": self.model_name,
            "source_url": self.source_url,
            "pinned_commit_sha": self.pinned_commit_sha,
            "license_text_hash_hex": self.license_text_hash_hex,
            "license_name": self.license_name,
            "integration_date": (
                self.integration_date.isoformat() if self.integration_date else None
            ),
            "approver": self.approver,
        }


class MBoMAggregator:
    """Reads the live MBoM file + historical table; merges into rows."""

    def __init__(self, reader: Optional[MBoMReader] = None) -> None:
        self._reader: MBoMReader = reader or get_default_reader()

    async def load(self, session: AsyncSession) -> list[MBoMRow]:
        """Return one row per model on the current build.

        Live values (commit SHA, license hash) come from ``MBoM.json``.
        Historical metadata we can't get from the file (source URL,
        license name, approver, integration date) comes from
        ``model_bill_of_materials``. If no historical row exists we
        still return the live row with empty historical fields —
        callers can surface this as "pending approval" in the UI.
        """
        live = self._reader.all()
        rows_by_name: dict[str, MBoMRow] = {}

        if live:
            # Hit Postgres once for the most-recent approval per model.
            names = list(live.keys())
            hist = await session.execute(
                text(
                    """
                    SELECT DISTINCT ON (model_name)
                           model_name, source_url, license_name,
                           integration_date, approver_user_id
                    FROM model_bill_of_materials
                    WHERE model_name = ANY(:names)
                    ORDER BY model_name, integration_date DESC
                    """
                ),
                {"names": names},
            )
            hist_map = {r["model_name"]: dict(r) for r in hist.mappings()}

            for name, info in live.items():
                h = hist_map.get(name, {})
                rows_by_name[name] = MBoMRow(
                    model_name=name,
                    source_url=str(h.get("source_url") or ""),
                    pinned_commit_sha=info.pinned_commit_sha,
                    license_text_hash_hex=info.license_hash,
                    license_name=str(h.get("license_name") or info.license_spdx or ""),
                    integration_date=h.get("integration_date"),
                    approver=str(h.get("approver_user_id") or ""),
                )

        # Surface historical rows not present in live (e.g. models that
        # were removed from the current build) so the auditor can still
        # see them. These are appended after the live rows so the UI
        # default ordering matches "current build first".
        extras = await session.execute(
            text(
                """
                SELECT DISTINCT ON (model_name)
                       model_name, source_url, pinned_commit_sha,
                       encode(license_text_hash, 'hex') AS license_text_hash_hex,
                       license_name, integration_date, approver_user_id
                FROM model_bill_of_materials
                WHERE model_name <> ALL(:names)
                ORDER BY model_name, integration_date DESC
                """
            ),
            {"names": list(rows_by_name.keys())},
        )
        for r in extras.mappings():
            row = dict(r)
            rows_by_name[row["model_name"]] = MBoMRow(
                model_name=row["model_name"],
                source_url=str(row.get("source_url") or ""),
                pinned_commit_sha=str(row.get("pinned_commit_sha") or ""),
                license_text_hash_hex=str(row.get("license_text_hash_hex") or ""),
                license_name=str(row.get("license_name") or ""),
                integration_date=row.get("integration_date"),
                approver=str(row.get("approver_user_id") or ""),
            )

        return list(rows_by_name.values())


async def load(session: AsyncSession) -> list[dict[str, Any]]:
    """Module-level convenience — returns API-ready dicts."""
    agg = MBoMAggregator()
    rows = await agg.load(session)
    return [r.to_api_dict() for r in rows]


__all__ = ["MBoMAggregator", "MBoMRow", "load"]
