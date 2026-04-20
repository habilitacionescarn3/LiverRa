"""segmentation, lesion, classification, flr_calculation (T054).

Revision ID: 0003_segmentation_lesion
Revises: 0002_study_series_analysis
Create Date: 2026-04-19

Invariants enforced as CHECK constraints:
  - classification.probs_vec components sum to 1.0 ± 0.01
  - flr_calculation: 0 <= flr_ml <= total_ml, sum invariant within 0.5 mL
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0003_segmentation_lesion"
down_revision: Union[str, None] = "0002_study_series_analysis"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # segmentation --------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE segmentation (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE CASCADE,
                generation_source text NOT NULL
                    CHECK (generation_source IN ('ai','reviewer_edited')),
                parent_segmentation_id uuid
                    REFERENCES segmentation(id) ON DELETE SET NULL,
                mask_uri text NOT NULL,
                sop_instance_uid text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX segmentation_analysis_idx "
            "ON segmentation (analysis_id, created_at)"
        )
    )

    # lesion --------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE lesion (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE CASCADE,
                bbox3d jsonb NOT NULL,
                couinaud_segment integer
                    CHECK (couinaud_segment BETWEEN 1 AND 8),
                diameter_mm numeric(6,2)
                    CHECK (diameter_mm IS NULL OR diameter_mm >= 0),
                mask_uri text,
                discovery_source text NOT NULL
                    CHECK (discovery_source IN ('ai','reviewer_prompted'))
            )
            """
        )
    )
    op.execute(
        text("CREATE INDEX lesion_analysis_idx ON lesion (analysis_id)")
    )

    # classification ------------------------------------------------------
    # probs_vec is a {class_name: probability} object; sum must be ~1.0.
    op.execute(
        text(
            """
            CREATE TABLE classification (
                lesion_id uuid PRIMARY KEY
                    REFERENCES lesion(id) ON DELETE CASCADE,
                probs_vec jsonb NOT NULL,
                suggested_class text,
                temperature numeric,
                abstained boolean NOT NULL DEFAULT false,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text(
            """
            ALTER TABLE classification
            ADD CONSTRAINT classification_probs_sum_chk
            CHECK (
                (
                    SELECT SUM(value::numeric)
                    FROM jsonb_each_text(probs_vec)
                ) BETWEEN 0.99 AND 1.01
            )
            """
        )
    )

    # flr_calculation -----------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE flr_calculation (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE CASCADE,
                plane_pose jsonb NOT NULL,
                total_ml numeric(10,2) NOT NULL CHECK (total_ml >= 0),
                flr_ml numeric(10,2) NOT NULL,
                flr_pct numeric(5,2),
                computed_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT flr_bounds_chk
                    CHECK (flr_ml >= 0 AND flr_ml <= total_ml),
                CONSTRAINT flr_sum_invariant_chk
                    CHECK (
                        abs((flr_ml + (total_ml - flr_ml)) - total_ml) < 0.5
                    )
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX flr_calculation_analysis_idx "
            "ON flr_calculation (analysis_id, computed_at)"
        )
    )


def downgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS flr_calculation"))
    op.execute(text("DROP TABLE IF EXISTS classification"))
    op.execute(text("DROP TABLE IF EXISTS lesion"))
    op.execute(text("DROP TABLE IF EXISTS segmentation"))
