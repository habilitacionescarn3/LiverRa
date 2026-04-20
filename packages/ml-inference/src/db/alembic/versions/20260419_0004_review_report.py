"""surgeon_review, report, report_delivery (T055).

Revision ID: 0004_review_report
Revises: 0003_segmentation_lesion
Create Date: 2026-04-19

- surgeon_review has a UNIQUE partial index
  ``(analysis_id) WHERE finalized_at IS NULL`` so only one open review
  exists per analysis at any time (seat-holding semantics).
- report.supersedes_report_id is a self-FK forming an amendment chain.
- report_delivery.idempotency_key is globally unique to survive retries.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0004_review_report"
down_revision: Union[str, None] = "0003_segmentation_lesion"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # surgeon_review ------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE surgeon_review (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE CASCADE,
                user_id uuid NOT NULL
                    REFERENCES "user"(id) ON DELETE RESTRICT,
                seat_held_until timestamptz,
                finalized_at timestamptz,
                timeline_events jsonb NOT NULL DEFAULT '[]'::jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    # Only one OPEN review per analysis.
    op.execute(
        text(
            """
            CREATE UNIQUE INDEX surgeon_review_open_unique
            ON surgeon_review (analysis_id)
            WHERE finalized_at IS NULL
            """
        )
    )

    # report --------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE report (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE RESTRICT,
                review_id uuid NOT NULL
                    REFERENCES surgeon_review(id) ON DELETE RESTRICT,
                version integer NOT NULL CHECK (version >= 1),
                supersedes_report_id uuid
                    REFERENCES report(id) ON DELETE SET NULL,
                pdf_uri text NOT NULL,
                seg_sop_uid text NOT NULL,
                sr_sop_uid text NOT NULL,
                finalized_at timestamptz NOT NULL DEFAULT now(),
                retracted_at timestamptz
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX report_analysis_version_key "
            "ON report (analysis_id, version)"
        )
    )

    # report_delivery -----------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE report_delivery (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                report_id uuid NOT NULL
                    REFERENCES report(id) ON DELETE CASCADE,
                destination_id text NOT NULL,
                state text NOT NULL DEFAULT 'pending'
                    CHECK (state IN (
                        'pending','in_flight','delivered','failed','retracted'
                    )),
                attempt_count integer NOT NULL DEFAULT 0
                    CHECK (attempt_count >= 0),
                last_error text,
                next_attempt_at timestamptz,
                idempotency_key text NOT NULL UNIQUE,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX report_delivery_pending_idx "
            "ON report_delivery (state, next_attempt_at) "
            "WHERE state IN ('pending','in_flight','failed')"
        )
    )


def downgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS report_delivery"))
    op.execute(text("DROP TABLE IF EXISTS report"))
    op.execute(text("DROP TABLE IF EXISTS surgeon_review"))
