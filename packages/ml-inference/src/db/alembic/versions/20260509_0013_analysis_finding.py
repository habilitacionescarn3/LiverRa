"""analysis_finding — store Phase 1 heuristic findings.

Revision ID: 0013_analysis_finding
Revises: 0012_segmentation_extra_cols
Create Date: 2026-05-09

Plain-English:
    Phase 1 of the wider pathology coverage roadmap (see
    `docs/research/13-additional-pathologies-model-research.md`) ships 7
    post-processing heuristics computed at the end of each cascade run:
    HU statistics, spleen volumetry, steatosis grade, calcified-lesion
    flags, simple-biliary-cyst characterisation, indeterminate-malignant
    LR-M exposure, and gallbladder volume + stones.

    Each finding is small (a few JSON fields) and independent. One row
    per (analysis_id, finding_type) keeps payloads narrow, makes future
    FHIR Observation export trivial, and lets a single failed finding
    not corrupt others. ON CONFLICT lets re-runs upsert.

Why now: enables the Phase 1 cascade hooks in
`packages/ml-inference/scripts/real_cascade.py` and the new
`<FindingsCard />` in the report view to read structured data instead
of inferring it from cascade logs.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0013_analysis_finding"
down_revision: Union[str, None] = "0012_segmentation_extra_cols"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS analysis_finding (
            id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            analysis_id   uuid NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
            finding_type  text NOT NULL,
            payload       jsonb NOT NULL,
            computed_at   timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT uq_analysis_finding_type UNIQUE (analysis_id, finding_type)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_analysis_finding_analysis_id
        ON analysis_finding (analysis_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS analysis_finding")
