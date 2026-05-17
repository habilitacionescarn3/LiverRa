"""refinement_missing_columns — schema drift for mask-refine + lesion-prompt.

Revision ID: 0021_refinement_missing_columns
Revises: 0020_dev_bypass_user_seed
Create Date: 2026-05-18

Plain-English:
    Phase H of the Refine page production-readiness work (see
    `/Users/toko/.claude/plans/on-this-page-i-soft-nebula.md`). The
    mask-refine recompute service and the lesion-prompt handler both
    reference columns that no previous migration ever created — every
    click on Add Mask, Subtract Mask, or Lesion Prompt currently
    500s with `column "X" does not exist`.

    Discovered via a Playwright sweep after Phase G shipped.
    Specifically:

      - `refinement_local_recompute.py:141, 152, 158, 176` reads
        `segmentation.mask_object_key`, `segmentation.shape`, and
        `segmentation.last_server_version` off the parent row. Without
        these columns, the recompute fails before it even loads the
        existing mask blob.

      - `review.py` lesion-prompt handler INSERTs into
        `lesion(..., origin, prompt_voxel, created_by, created_at)`.
        Without these columns the INSERT fails with a column-mismatch
        error. The `lesion` table is also missing `created_by` and
        `created_at` entirely — gaps that should have been there from
        day one but slipped through migrations 0003/0010/0017.

    Defaults are chosen so pre-existing rows backfill semantically:

      - `mask_object_key` / `shape` / `prompt_voxel` / `lesion.created_by`
        are nullable — pre-existing AI segmentations and AI-discovered
        lesions don't have any of these (they're populated only by
        reviewer-driven flows).
      - `last_server_version` defaults to 1 — first refinement bumps
        to 2 via the CAS check at L176.
      - `lesion.origin` defaults to `'ai'` — every existing lesion IS
        AI-generated (the prompt flow has never worked because of this
        bug, so no `'reviewer_prompt'` rows can exist yet). New rows
        from the prompt handler set `'reviewer_prompt'` explicitly.
      - `lesion.created_at` backfills to `now()` — original timestamps
        are lost (regrettable but unavoidable; the column was never
        recorded), but new rows are accurate from this point forward.

    `discovery_source` is left in place — list endpoints + UI reference
    it. Going forward both `origin` (canonical) and `discovery_source`
    (legacy) will populate; no migration of existing data is required.

    Idempotent via IF NOT EXISTS / IF EXISTS so re-running the migration
    is safe.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0021_refinement_missing_columns"
down_revision: Union[str, None] = "0020_dev_bypass_user_seed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. segmentation: three columns the mask-refine recompute reads
    # ------------------------------------------------------------------
    # `mask_object_key`: raw S3/Supabase Storage key for the full-res
    #   reviewer-edited mask blob. Distinct from `mask_s3_uri` (which
    #   carries the full `s3://bucket/key` URI) — recompute wants the
    #   bare key so it can pass it to the configured mask_store backend
    #   without re-parsing.
    # `shape`: volume shape as a JSON array [dim_x, dim_y, dim_z],
    #   stamped at ingest time so the recompute service can validate
    #   click voxels against the volume bounds without re-loading the
    #   NRRD header.
    # `last_server_version`: optimistic-lock cursor. Bumped on every
    #   reviewer-driven mask edit; recompute reads-modify-writes under
    #   this CAS so concurrent edits stale-409 properly.
    op.execute(
        text(
            """
            ALTER TABLE segmentation
              ADD COLUMN IF NOT EXISTS mask_object_key text,
              ADD COLUMN IF NOT EXISTS shape jsonb,
              ADD COLUMN IF NOT EXISTS last_server_version integer
                NOT NULL DEFAULT 1
            """
        )
    )

    # ------------------------------------------------------------------
    # 2. lesion: four columns the lesion-prompt handler INSERTs
    # ------------------------------------------------------------------
    # `origin`: provenance of the lesion row. `'ai'` for cascade-detected
    #   lesions, `'reviewer_prompt'` for ones the surgeon prompted via
    #   the lesion-prompt tool, `'manual'` reserved for a future
    #   fully-manual drawing flow. CHECK constraint guards the enum.
    # `prompt_voxel`: the (i, j, k) inside the CT volume the reviewer
    #   clicked when prompting. Stored as a JSON array for symmetry with
    #   `bbox3d` and to keep the column flexible.
    # `created_by`: user who created the row. AI-generated lesions land
    #   with NULL (the cascade has no human author); reviewer-prompted
    #   rows reference the user-id from the seat that placed them.
    # `created_at`: timestamp. NOT NULL DEFAULT now() backfills existing
    #   rows to the migration's run time — not historically accurate
    #   but the lesser of two evils vs leaving it nullable.
    op.execute(
        text(
            """
            ALTER TABLE lesion
              ADD COLUMN IF NOT EXISTS origin text
                NOT NULL DEFAULT 'ai',
              ADD COLUMN IF NOT EXISTS prompt_voxel jsonb,
              ADD COLUMN IF NOT EXISTS created_by uuid
                REFERENCES "user"(id) ON DELETE SET NULL,
              ADD COLUMN IF NOT EXISTS created_at timestamptz
                NOT NULL DEFAULT now()
            """
        )
    )

    # CHECK constraint applied separately so we can guard it with a
    # NOT-EXISTS lookup (alembic's `op.create_check_constraint` raises
    # if it already exists; raw SQL with the DO block is idempotent).
    op.execute(
        text(
            """
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'lesion_origin_check'
              ) THEN
                ALTER TABLE lesion
                  ADD CONSTRAINT lesion_origin_check
                  CHECK (origin IN ('ai', 'reviewer_prompt', 'manual'));
              END IF;
            END
            $$;
            """
        )
    )


def downgrade() -> None:
    # Drop in reverse order. The CHECK constraint goes first so the
    # column drop doesn't trip on a dangling dependency.
    op.execute(
        text(
            """
            ALTER TABLE lesion
              DROP CONSTRAINT IF EXISTS lesion_origin_check
            """
        )
    )
    op.execute(
        text(
            """
            ALTER TABLE lesion
              DROP COLUMN IF EXISTS created_at,
              DROP COLUMN IF EXISTS created_by,
              DROP COLUMN IF EXISTS prompt_voxel,
              DROP COLUMN IF EXISTS origin
            """
        )
    )
    op.execute(
        text(
            """
            ALTER TABLE segmentation
              DROP COLUMN IF EXISTS last_server_version,
              DROP COLUMN IF EXISTS shape,
              DROP COLUMN IF EXISTS mask_object_key
            """
        )
    )
