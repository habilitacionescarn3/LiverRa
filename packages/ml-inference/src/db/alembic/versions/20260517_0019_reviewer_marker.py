"""reviewer_marker — sticky-note annotations placed by the reviewer.

Revision ID: 0019_reviewer_marker
Revises: 0018_upload_session
Create Date: 2026-05-17

Plain-English:
    Phase G of the Refine page production-readiness work (see
    `/Users/toko/.claude/plans/on-this-page-i-soft-nebula.md`).
    The Marker refine tool drops voxel-anchored "sticky notes" — a
    label/note pinned to (i,j,k) inside the CT volume — so a reviewer
    can flag a region for a colleague or for their own follow-up
    without modifying the AI masks.

    One row per marker. Cascades to the analysis it belongs to; the
    review_id links to the seat that placed it (and through that to
    the user). Markers are additive — DELETE goes through a future
    endpoint, not here.

    No RLS policy at the table level: the API enforces tenant scope by
    requiring `_load_analysis_row(analysis_id, tenant_id)` in the GET
    handler and via the seat heartbeat (which is tenant-bound) in the
    POST handler. Same posture as `analysis_finding` (migration 0013)
    and `lesion`.

    `client_version` matches the optimistic-locking convention from
    migration 0017 — currently unused for markers (they're additive)
    but reserved for a future PATCH /markers/{id} endpoint that
    updates label/note.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0019_reviewer_marker"
down_revision: Union[str, None] = "0018_upload_session"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS reviewer_marker (
            id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id         uuid NOT NULL,
            analysis_id       uuid NOT NULL
                                  REFERENCES analysis(id) ON DELETE CASCADE,
            review_id         uuid NOT NULL
                                  REFERENCES surgeon_review(id) ON DELETE CASCADE,
            voxel_x           integer NOT NULL,
            voxel_y           integer NOT NULL,
            voxel_z           integer NOT NULL,
            couinaud_segment  varchar(8),
            segmentation_id   varchar(64),
            label             varchar(80),
            note              text,
            created_at        timestamptz NOT NULL DEFAULT now(),
            created_by        uuid NOT NULL,
            client_version    integer NOT NULL DEFAULT 1
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_reviewer_marker_analysis_created
        ON reviewer_marker (analysis_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_reviewer_marker_tenant
        ON reviewer_marker (tenant_id)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS reviewer_marker")
