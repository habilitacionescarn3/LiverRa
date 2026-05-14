"""refinement optimistic-locking + missing review columns.

Revision ID: 0017_refinement_optimistic_locking
Revises: 0016_invite_used
Create Date: 2026-05-14

Plain-English:
    Closes audit Phase 3.3 (CC-3, refinement + optimistic locking) by
    adding the columns the refinement endpoints have been READING/WRITING
    without ever provisioning:

      - ``analysis.flr_plane_json`` / ``analysis.flr_updated_at`` —
        ``POST /reviews/{id}/flr`` writes these (review.py:531) but the
        migrations never created them. The write currently 500s with
        ``column "flr_plane_json" of relation "analysis" does not exist``.

      - ``analysis.coverage_override_reason`` /
        ``analysis.coverage_override_by`` /
        ``analysis.coverage_override_at`` — ``POST
        /admin/analyses/{id}/override-coverage`` writes these (admin.py:583)
        same story.

      - ``analysis.radiologist_user_id`` — required for the dual-authorization
        rule (C-REFINE-2): a reviewer cannot also be the radiologist who
        produced the original analysis.

    AND adds ``client_version`` columns to every row the four refinement
    endpoints plus claim_registry + override_coverage mutate, so the
    optimistic-locking pattern can finally do its job (H-LOCK-1..6):

      - ``lesion.client_version`` — mask_refine + lesion_prompt +
        classification_override use the lesion as the optimistic key
        (mask refine bumps the analysis through the segmentation, which
        bumps lesion versions transitively).
      - ``analysis.flr_version`` — flr_update CAS check.
      - ``regulatory_claim_registry.client_version`` — claim toggle CAS.

    Each column defaults to ``1`` so existing rows are immediately
    routable; the CAS handlers will only stale-409 if the client sent a
    smaller-or-equal value than the row's current.

    No schema change is required for the audit's "B-REFINE-1 +
    lesion_classification_override INSERT contract" — migration 0015
    already shipped the new column set; the code change is just
    ``review.py``'s ``INSERT INTO ... VALUES`` SQL.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0017_refinement_optimistic_locking"
down_revision: Union[str, None] = "0016_invite_used"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. analysis: FLR + coverage-override + radiologist + flr_version
    # ------------------------------------------------------------------
    # IF NOT EXISTS because some envs (dev seed scripts) may already have
    # added these columns ad-hoc when the endpoints first 500'd.
    op.execute(
        text(
            """
            ALTER TABLE analysis
              ADD COLUMN IF NOT EXISTS flr_plane_json jsonb,
              ADD COLUMN IF NOT EXISTS flr_updated_at timestamptz,
              ADD COLUMN IF NOT EXISTS flr_version integer NOT NULL DEFAULT 1,
              ADD COLUMN IF NOT EXISTS coverage_override_reason text,
              ADD COLUMN IF NOT EXISTS coverage_override_by text,
              ADD COLUMN IF NOT EXISTS coverage_override_at timestamptz,
              ADD COLUMN IF NOT EXISTS coverage_override_version integer
                NOT NULL DEFAULT 1,
              ADD COLUMN IF NOT EXISTS radiologist_user_id uuid
            """
        )
    )

    # ------------------------------------------------------------------
    # 2. lesion: client_version for mask + classification override CAS
    # ------------------------------------------------------------------
    op.execute(
        text(
            """
            ALTER TABLE lesion
              ADD COLUMN IF NOT EXISTS client_version integer
                NOT NULL DEFAULT 1
            """
        )
    )

    # ------------------------------------------------------------------
    # 3. regulatory_claim_registry: client_version for claim toggle CAS
    # ------------------------------------------------------------------
    # The table is created by migration 0006 (rbac_mbom_claims). Some
    # bootstrap-only flavours may not have it; guard with IF EXISTS so
    # this migration is a no-op on those.
    op.execute(
        text(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'regulatory_claim_registry'
              ) THEN
                ALTER TABLE regulatory_claim_registry
                  ADD COLUMN IF NOT EXISTS client_version integer
                    NOT NULL DEFAULT 1;
              END IF;
            END
            $$;
            """
        )
    )


def downgrade() -> None:
    op.execute(
        text(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_name = 'regulatory_claim_registry'
              ) THEN
                ALTER TABLE regulatory_claim_registry
                  DROP COLUMN IF EXISTS client_version;
              END IF;
            END
            $$;
            """
        )
    )
    op.execute(
        text("ALTER TABLE lesion DROP COLUMN IF EXISTS client_version")
    )
    op.execute(
        text(
            """
            ALTER TABLE analysis
              DROP COLUMN IF EXISTS radiologist_user_id,
              DROP COLUMN IF EXISTS coverage_override_version,
              DROP COLUMN IF EXISTS coverage_override_at,
              DROP COLUMN IF EXISTS coverage_override_by,
              DROP COLUMN IF EXISTS coverage_override_reason,
              DROP COLUMN IF EXISTS flr_version,
              DROP COLUMN IF EXISTS flr_updated_at,
              DROP COLUMN IF EXISTS flr_plane_json
            """
        )
    )
