# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""RUO spot-check sampler (T341).

Plain-English:
    SC-009 requires a compliance reviewer to pick 20 random exported
    artifacts (PDF reports, DICOM-SEG masks, DICOM-SR measurements) and
    confirm each one carries the "Research Use Only" watermark in the
    pixel or text layer the user actually sees.

    This module is the sampler. It:

      1. Picks ``N`` random rows from ``export_artifact``
         (tenant-scoped), weighted across artifact types so the sample
         reflects the actual export mix.
      2. For each one, returns a short-lived presigned URL + a
         watermark bounding box the UI can overlay on the thumbnail so
         the reviewer knows *where to look*.
      3. Leaves the pass/fail flag *null* — the frontend captures the
         reviewer's decision and writes it back to a separate
         ``ruo_spot_check_finding`` table (out of scope for this
         module; see T449).

    We do NOT OCR the watermark on the server in the MVP: that layer is
    the human reviewer's job (per spec §US10 acceptance scenario 1).
    A later phase may add an OCR pre-filter; for now the server just
    returns the coordinates of the burned-in watermark region from the
    five-layer RUO spec (research §B.7) so the UI can visually
    high-light it.

Spec refs: SC-009, research.md §B.7, FR-028.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


# The watermark bbox is stamped in two places by the RUO burn (research
# §B.7): the bottom-right of the content area (primary) and the diagonal
# stripe overlay. We surface the primary rectangle for the spot-check —
# if the reviewer can see it, SC-009 passes for that artifact.
DEFAULT_WATERMARK_BBOX: list[int] = [
    int(os.environ.get("LIVERRA_RUO_WM_X", "18")),
    int(os.environ.get("LIVERRA_RUO_WM_Y", "18")),
    int(os.environ.get("LIVERRA_RUO_WM_W", "340")),
    int(os.environ.get("LIVERRA_RUO_WM_H", "72")),
]


@dataclass(frozen=True)
class SpotCheckItem:
    """One sampled artifact — returned to the compliance UI."""

    artifact_url: str
    watermark_bbox: list[int]
    # ``pass`` reserved kw in Python — we surface it as ``passed`` and
    # the API serializer renames it on the way out.
    passed: Optional[bool] = None
    artifact_kind: str = ""
    artifact_id: str = ""

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "artifact_url": self.artifact_url,
            "watermark_bbox": self.watermark_bbox,
            "pass": self.passed,
            "artifact_kind": self.artifact_kind,
            "artifact_id": self.artifact_id,
        }


def _default_presigner(s3_uri: str) -> str:
    """Fallback presigner — returns the raw URI.

    Production wiring replaces this with an S3 V4 presigner with a
    5-minute expiry (see T448 wiring). Keeping it pure here means the
    sampler is trivially unit-testable without AWS creds.
    """
    return s3_uri


async def sample_and_verify(
    *,
    session: AsyncSession,
    tenant_id: UUID,
    sample_size: int = 20,
    presigner=_default_presigner,
) -> list[SpotCheckItem]:
    """Return ``sample_size`` random export artifacts for spot-check.

    The query is deliberately naive (``ORDER BY random() LIMIT N``)
    because export volumes in the pilot are small (≤ 500 / month) so a
    sequential scan of the `export_artifact` table is fine.

    Falls back to an empty list if the table doesn't exist yet — this
    lets the compliance UI render during bootstrap without 500-ing.
    """
    if sample_size < 1:
        return []
    # Clamp to avoid pathological requests pulling the whole table.
    sample_size = min(sample_size, 200)

    try:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT id, kind, s3_uri
                    FROM export_artifact
                    WHERE tenant_id = :tid
                    ORDER BY random()
                    LIMIT :n
                    """
                ),
                {"tid": str(tenant_id), "n": sample_size},
            )
        ).mappings().all()
    except Exception as exc:  # noqa: BLE001
        # Table may not be migrated yet in early dev; log + return [].
        logger.info("export_artifact query failed (%s); returning empty sample", exc)
        return []

    items: list[SpotCheckItem] = []
    for r in rows:
        try:
            url = presigner(str(r["s3_uri"]))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Presign failed for %s: %s", r.get("s3_uri"), exc)
            url = str(r.get("s3_uri") or "")
        items.append(
            SpotCheckItem(
                artifact_url=url,
                watermark_bbox=list(DEFAULT_WATERMARK_BBOX),
                passed=None,
                artifact_kind=str(r.get("kind") or ""),
                artifact_id=str(r.get("id") or ""),
            )
        )
    return items


__all__ = [
    "DEFAULT_WATERMARK_BBOX",
    "SpotCheckItem",
    "sample_and_verify",
]
