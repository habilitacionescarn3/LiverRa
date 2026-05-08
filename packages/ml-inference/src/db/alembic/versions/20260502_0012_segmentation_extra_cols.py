"""segmentation_extra_cols — add 3 columns the real cascade tasks INSERT.

Revision ID: 0012_segmentation_extra_cols
Revises: 0011_tenant_pacs_columns
Create Date: 2026-05-02

Plain-English:
    The real Couinaud + vessels Celery tasks (src/tasks/couinaud.py,
    src/tasks/vessels.py) INSERT three columns the schema doesn't yet
    create:
      - `mask_s3_uri` — duplicate of `mask_uri` carrying the explicit
        s3:// URI form. The columns drift because audit-log code wants
        the canonical S3 path while the API serves a presigned URL
        from `mask_uri`. Both stay nullable for back-compat.
      - `sanity_flags` — JSONB blob used by vessels.py to record the
        post-inference containment ratio (e.g.
        `{"outside_parenchyma_pct": 4.2}`). Surfaced by the Segments
        tab.
      - `created_by_user_id` — for reviewer-edited rows the cascade
        leaves NULL; downstream `/segments/{id}/edit` writes the
        editor's user-id. References `user(id)` with `ON DELETE SET
        NULL` so user deletion never tombstones the segmentation.

    Idempotent via `IF NOT EXISTS`.

Why now: D2 un-stubs the Couinaud + vessels Celery tasks, which
INSERT into all three columns. Without this migration every cascade
will 500 at the first segmentation INSERT.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0012_segmentation_extra_cols"
down_revision: Union[str, None] = "0011_tenant_pacs_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE segmentation
          ADD COLUMN IF NOT EXISTS mask_s3_uri        text,
          ADD COLUMN IF NOT EXISTS sanity_flags       jsonb,
          ADD COLUMN IF NOT EXISTS created_by_user_id uuid
            REFERENCES "user"(id) ON DELETE SET NULL
        """
    )


def downgrade() -> None:
    # Nullable columns — drop is safe for any data that landed.
    op.execute(
        """
        ALTER TABLE segmentation
          DROP COLUMN IF EXISTS created_by_user_id,
          DROP COLUMN IF EXISTS sanity_flags,
          DROP COLUMN IF EXISTS mask_s3_uri
        """
    )
