"""api_query_columns — add columns the API queries that the original
schema didn't include.

Revision ID: 0010_api_query_columns
Revises: 0009_classify_val_sample
Create Date: 2026-05-01

Plain-English:
    Earlier router code (analysis.py, onboarding.py) was written
    against a richer schema than migrations 0001-0009 actually create.
    Specifically:
      - `user` lacked the four onboarding-tracking timestamps
        (`ruo_accepted_at`, `mfa_enrolled_at`, `sample_case_run_at`,
        `tour_completed_at`) that the onboarding-status endpoint
        SELECTs.
      - `segmentation` lacked the layer-metadata columns
        (`anatomy_category`, `anatomy_detail`, `volume_ml`, `mask_url`,
        `snomed_code`) the analysis-results endpoint returns.
      - `lesion` lacked `couinaud_location`, `longest_diameter_mm`,
        `volume_ml`, and `classification` (these are duplicated
        column names the API uses; the original schema names like
        `couinaud_segment` and `diameter_mm` stay for backward
        compatibility — the API can read both).
      - `flr_calculation` lacked the v2 plane-pose decomposition
        (`plane_normal`, `plane_offset_mm`) and the per-author
        breakdown (`resected_volume_ml`, `remnant_volume_ml`,
        `remnant_pct_functional`, `author`) that finalize uses.

    All columns nullable, no defaults — code paths handle null. Lets
    legacy rows persist while new analyses populate the v2 fields.

    Idempotent via `IF NOT EXISTS` so re-running on a DB that already
    had these columns added by hand is a no-op.

Why a single migration: the four tables drift together because the
API service treats them as one bounded context (cascade outputs).
Splitting per-table would yield 4 fragmented migrations with the
same justification.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0010_api_query_columns"
down_revision: Union[str, None] = "0009_classify_val_sample"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- user: onboarding tracking timestamps ---------------------------
    op.execute(
        """
        ALTER TABLE "user"
          ADD COLUMN IF NOT EXISTS ruo_accepted_at    timestamptz,
          ADD COLUMN IF NOT EXISTS mfa_enrolled_at    timestamptz,
          ADD COLUMN IF NOT EXISTS sample_case_run_at timestamptz,
          ADD COLUMN IF NOT EXISTS tour_completed_at  timestamptz
        """
    )

    # --- segmentation: layer-metadata for results endpoint --------------
    op.execute(
        """
        ALTER TABLE segmentation
          ADD COLUMN IF NOT EXISTS anatomy_category text,
          ADD COLUMN IF NOT EXISTS anatomy_detail   text,
          ADD COLUMN IF NOT EXISTS volume_ml        numeric(10,2),
          ADD COLUMN IF NOT EXISTS mask_url         text,
          ADD COLUMN IF NOT EXISTS snomed_code      text
        """
    )

    # --- lesion: v2 names alongside the v1 originals --------------------
    op.execute(
        """
        ALTER TABLE lesion
          ADD COLUMN IF NOT EXISTS couinaud_location    integer,
          ADD COLUMN IF NOT EXISTS longest_diameter_mm  numeric(6,2),
          ADD COLUMN IF NOT EXISTS volume_ml            numeric(10,2),
          ADD COLUMN IF NOT EXISTS classification       text
        """
    )

    # --- flr_calculation: v2 pose decomposition + per-author ------------
    op.execute(
        """
        ALTER TABLE flr_calculation
          ADD COLUMN IF NOT EXISTS plane_normal           jsonb,
          ADD COLUMN IF NOT EXISTS plane_offset_mm        numeric(6,2),
          ADD COLUMN IF NOT EXISTS resected_volume_ml     numeric(10,2),
          ADD COLUMN IF NOT EXISTS remnant_volume_ml      numeric(10,2),
          ADD COLUMN IF NOT EXISTS remnant_pct_functional numeric(5,2),
          ADD COLUMN IF NOT EXISTS author                 text
        """
    )


def downgrade() -> None:
    # No data loss: dropping nullable columns is safe.
    op.execute(
        """
        ALTER TABLE flr_calculation
          DROP COLUMN IF EXISTS plane_normal,
          DROP COLUMN IF EXISTS plane_offset_mm,
          DROP COLUMN IF EXISTS resected_volume_ml,
          DROP COLUMN IF EXISTS remnant_volume_ml,
          DROP COLUMN IF EXISTS remnant_pct_functional,
          DROP COLUMN IF EXISTS author
        """
    )
    op.execute(
        """
        ALTER TABLE lesion
          DROP COLUMN IF EXISTS couinaud_location,
          DROP COLUMN IF EXISTS longest_diameter_mm,
          DROP COLUMN IF EXISTS volume_ml,
          DROP COLUMN IF EXISTS classification
        """
    )
    op.execute(
        """
        ALTER TABLE segmentation
          DROP COLUMN IF EXISTS anatomy_category,
          DROP COLUMN IF EXISTS anatomy_detail,
          DROP COLUMN IF EXISTS volume_ml,
          DROP COLUMN IF EXISTS mask_url,
          DROP COLUMN IF EXISTS snomed_code
        """
    )
    op.execute(
        """
        ALTER TABLE "user"
          DROP COLUMN IF EXISTS ruo_accepted_at,
          DROP COLUMN IF EXISTS mfa_enrolled_at,
          DROP COLUMN IF EXISTS sample_case_run_at,
          DROP COLUMN IF EXISTS tour_completed_at
        """
    )
