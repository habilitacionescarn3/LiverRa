# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Case-deletion service (T283).

Plain-English:
    A clinician can *request* a case be deleted, but they cannot
    actually pull the trigger. This service is the approval + soft-delete
    workflow: the admin clicks "approve" and we mark the Study + all its
    Analyses as `deleted_at = now()`, but the rows remain. Hard-delete
    (blanking S3 + scheduling KMS key deletion) is reserved for the DPO
    erasure workflow in US9.

Shape (per FR-046):
    - ``approve(request_id, approver_id, tenant_id)`` -> ``DeletionOutcome``
    - raises ``ProblemDetailException`` if request not found within tenant

Cross-refs:
    - spec.md §FR-046 (case deletion request — admin-approval gate)
    - data-model.md §Study, §Analysis
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..errors.catalog import ErrorSlug, ProblemDetailException

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DeletionOutcome:
    soft_deleted_at: datetime
    affected_analyses: int


class CaseDeletionService:
    """Admin-approval + soft-delete for case-deletion requests (FR-046)."""

    def __init__(self, *, session: AsyncSession) -> None:
        self._session = session

    async def approve(
        self,
        *,
        request_id: UUID,
        approver_id: UUID,
        tenant_id: UUID,
    ) -> DeletionOutcome:
        """Mark study + analyses soft-deleted. Hard-delete stays DPO-only."""
        now = datetime.now(timezone.utc)

        # 1. Confirm the study exists within the tenant.
        r = await self._session.execute(
            text(
                """
                SELECT id FROM study
                WHERE id = :sid AND tenant_id = :tid AND deleted_at IS NULL
                """
            ),
            {"sid": str(request_id), "tid": str(tenant_id)},
        )
        if not r.first():
            raise ProblemDetailException(
                ErrorSlug.NOT_FOUND,
                status.HTTP_404_NOT_FOUND,
                "Deletion request not found or already processed.",
            )

        # 2. Soft-delete the study.
        await self._session.execute(
            text(
                """
                UPDATE study
                SET deleted_at = :ts, deleted_by = :by
                WHERE id = :sid AND tenant_id = :tid
                """
            ),
            {"ts": now, "by": str(approver_id), "sid": str(request_id), "tid": str(tenant_id)},
        )

        # 3. Cascade soft-delete onto analyses.
        result = await self._session.execute(
            text(
                """
                UPDATE analysis
                SET deleted_at = :ts, deleted_by = :by
                WHERE study_id = :sid AND tenant_id = :tid
                  AND deleted_at IS NULL
                RETURNING id
                """
            ),
            {"ts": now, "by": str(approver_id), "sid": str(request_id), "tid": str(tenant_id)},
        )
        affected = len(result.fetchall())

        await self._session.commit()
        return DeletionOutcome(soft_deleted_at=now, affected_analyses=affected)
