# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Sample-case runner (T297, T439).

Plain-English:
    When a new clinician reaches the "Run demo case" step of onboarding
    (or uses the Help menu's re-runnable demo per SC-013), we must have
    a demo fixture Analysis + Study already seeded in their tenant. This
    service provides an **idempotent** seed path shared by both the
    wizard endpoint and ``scripts/seed-demo-case.sh``.

    Idempotency: we key on ``(tenant_id, 'demo-case-v1')`` — second and
    subsequent calls return the existing row without inserting
    duplicates.

Cross-refs:
    - spec.md §FR-042 (demo case) + invariant (never pushable to real PACS)
    - data-model.md §DemoCase
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

DEMO_FIXTURE_KEY = "demo-case-v1"


@dataclass(frozen=True)
class SeedOutcome:
    tenant_id: UUID
    analysis_id: UUID
    already_existed: bool
    seeded_at: datetime


class SampleCaseRunner:
    """Idempotent demo-case seeder."""

    def __init__(
        self,
        *,
        session_factory: Optional[Any] = None,
        fixture_key: str = DEMO_FIXTURE_KEY,
    ) -> None:
        self._session_factory = session_factory
        self._fixture_key = fixture_key

    @classmethod
    def from_app_state(cls, state: Any) -> "SampleCaseRunner":
        existing = getattr(state, "sample_case_runner", None)
        if isinstance(existing, cls):
            return existing
        factory = getattr(state, "db_session_factory", None)
        return cls(session_factory=factory)

    async def _open_session(self) -> AsyncSession:
        if self._session_factory is None:
            raise RuntimeError(
                "SampleCaseRunner needs a session factory — inject via app.state."
            )
        return self._session_factory()

    async def ensure_seeded(
        self,
        *,
        tenant_id: UUID,
        session: Optional[AsyncSession] = None,
    ) -> SeedOutcome:
        """Ensure the tenant has a demo analysis row. Idempotent."""
        close_when_done = False
        if session is None:
            session = await self._open_session()
            close_when_done = True
        try:
            existing = await session.execute(
                text(
                    """
                    SELECT a.id FROM analysis a
                    JOIN demo_case dc ON dc.analysis_id = a.id
                    WHERE a.tenant_id = :tid
                      AND dc.fixture_key = :key
                      AND a.deleted_at IS NULL
                    LIMIT 1
                    """
                ),
                {"tid": str(tenant_id), "key": self._fixture_key},
            )
            hit = existing.first()
            if hit:
                return SeedOutcome(
                    tenant_id=tenant_id,
                    analysis_id=UUID(str(hit[0])),
                    already_existed=True,
                    seeded_at=datetime.now(timezone.utc),
                )

            now = datetime.now(timezone.utc)
            analysis_id = uuid4()
            study_id = uuid4()

            # Insert the stub study + analysis + demo-case marker. Real
            # mask URIs are populated by ``scripts/seed-demo-case.sh``
            # when it runs (shared path per T439).
            await session.execute(
                text(
                    """
                    INSERT INTO study (id, tenant_id, created_at, is_demo)
                    VALUES (:sid, :tid, :ts, true)
                    """
                ),
                {"sid": str(study_id), "tid": str(tenant_id), "ts": now},
            )
            await session.execute(
                text(
                    """
                    INSERT INTO analysis
                      (id, tenant_id, study_id, status, queued_at,
                       completed_at, pipeline_version, is_demo)
                    VALUES
                      (:aid, :tid, :sid, 'completed', :ts, :ts, 'v1-demo', true)
                    """
                ),
                {
                    "aid": str(analysis_id),
                    "tid": str(tenant_id),
                    "sid": str(study_id),
                    "ts": now,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO demo_case
                      (id, tenant_id, analysis_id, fixture_key,
                       sample_case_flag, seeded_at)
                    VALUES (:id, :tid, :aid, :key, true, :ts)
                    """
                ),
                {
                    "id": str(uuid4()),
                    "tid": str(tenant_id),
                    "aid": str(analysis_id),
                    "key": self._fixture_key,
                    "ts": now,
                },
            )
            await session.commit()
            return SeedOutcome(
                tenant_id=tenant_id,
                analysis_id=analysis_id,
                already_existed=False,
                seeded_at=now,
            )
        finally:
            if close_when_done:
                await session.close()
