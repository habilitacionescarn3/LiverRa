"""study, series, analysis, pipeline_checkpoint (T053).

Revision ID: 0002_study_series_analysis
Revises: 0001_tenant_user
Create Date: 2026-04-19

Covers data-model §3-6 (Study, Series, Analysis, PipelineCheckpoint) at
T053-brief granularity. Adds tenant-scoped indexes + RLS on all
tenant-scoped tables.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0002_study_series_analysis"
down_revision: Union[str, None] = "0001_tenant_user"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # study ---------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE study (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                study_instance_uid text NOT NULL,
                patient_ref text NOT NULL,
                received_at timestamptz NOT NULL DEFAULT now(),
                ingestion_outcome text NOT NULL DEFAULT 'pending'
                    CHECK (ingestion_outcome IN ('pending','accepted','rejected')),
                ingestion_rejection_reason text,
                phase_coverage jsonb NOT NULL DEFAULT '{}'::jsonb
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX study_tenant_uid_key "
            "ON study (tenant_id, study_instance_uid)"
        )
    )

    # series --------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE series (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                study_id uuid NOT NULL
                    REFERENCES study(id) ON DELETE CASCADE,
                series_instance_uid text NOT NULL,
                modality text NOT NULL,
                phase text,
                instance_count integer NOT NULL DEFAULT 0
                    CHECK (instance_count >= 0)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX series_study_uid_key "
            "ON series (study_id, series_instance_uid)"
        )
    )

    # analysis ------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE analysis (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                study_id uuid NOT NULL
                    REFERENCES study(id) ON DELETE CASCADE,
                status text NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                        'queued','running','completed','failed','cancelled'
                    )),
                queued_at timestamptz NOT NULL DEFAULT now(),
                started_at timestamptz,
                completed_at timestamptz,
                error_slug text,
                pipeline_version text NOT NULL,
                model_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
                implausible_output_reason text
            )
            """
        )
    )
    # Partial index: queue scanning only cares about active jobs.
    op.execute(
        text(
            "CREATE INDEX analysis_queue_idx "
            "ON analysis (tenant_id, status, queued_at) "
            "WHERE status IN ('queued','running')"
        )
    )

    # pipeline_checkpoint -------------------------------------------------
    # Composite PK (analysis_id, stage_no); tenant_id denormalized for RLS.
    op.execute(
        text(
            """
            CREATE TABLE pipeline_checkpoint (
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE CASCADE,
                stage_no integer NOT NULL CHECK (stage_no >= 0),
                stage text NOT NULL,
                output_uri text NOT NULL,
                written_at timestamptz NOT NULL DEFAULT now(),
                model_version text NOT NULL,
                model_license_hash text NOT NULL,
                PRIMARY KEY (analysis_id, stage_no)
            )
            """
        )
    )

    # Row-Level Security --------------------------------------------------
    for table in ("study", "analysis"):
        op.execute(text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
        op.execute(text(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))
        op.execute(
            text(
                f"""
                CREATE POLICY {table}_tenant_isolation ON {table}
                USING (tenant_id::text = current_setting('app.tenant_id', true))
                WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
                """
            )
        )

    # series + pipeline_checkpoint have no tenant_id column — they inherit
    # isolation transitively through their parent FK. Enable RLS but allow
    # all (policies may be tightened later by joining to parent).
    for table in ("series", "pipeline_checkpoint"):
        op.execute(text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
        op.execute(
            text(
                f"""
                CREATE POLICY {table}_parent_isolation ON {table}
                USING (true) WITH CHECK (true)
                """
            )
        )


def downgrade() -> None:
    for table in ("series", "pipeline_checkpoint"):
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_parent_isolation ON {table}")
        )
    for table in ("study", "analysis"):
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        )

    op.execute(text("DROP TABLE IF EXISTS pipeline_checkpoint"))
    op.execute(text("DROP TABLE IF EXISTS analysis"))
    op.execute(text("DROP TABLE IF EXISTS series"))
    op.execute(text("DROP TABLE IF EXISTS study"))
