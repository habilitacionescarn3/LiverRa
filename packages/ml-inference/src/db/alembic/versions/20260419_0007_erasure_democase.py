"""erasure_request, demo_case (T058).

Revision ID: 0007_erasure_democase
Revises: 0006_rbac_mbom_claims
Create Date: 2026-04-19

erasure_request captures the GDPR Art.17 lifecycle including the
audit-chain sequence fence-post (before/after) so that post-erasure
verification can prove which audit events remain.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0007_erasure_democase"
down_revision: Union[str, None] = "0006_rbac_mbom_claims"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # erasure_request -----------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE erasure_request (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                subject_ref text NOT NULL,
                requested_at timestamptz NOT NULL DEFAULT now(),
                requested_by uuid
                    REFERENCES "user"(id) ON DELETE SET NULL,
                status text NOT NULL DEFAULT 'requested'
                    CHECK (status IN (
                        'requested','approved','executing',
                        'completed','rejected'
                    )),
                executed_at timestamptz,
                kms_key_scheduled_deletion_at timestamptz,
                audit_chain_seq_before bigint,
                audit_chain_seq_after bigint,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX erasure_request_tenant_status_idx "
            "ON erasure_request (tenant_id, status, requested_at DESC)"
        )
    )

    # demo_case -----------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE demo_case (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                study_id uuid NOT NULL
                    REFERENCES study(id) ON DELETE CASCADE,
                seeded_at timestamptz NOT NULL DEFAULT now(),
                provenance_tag text NOT NULL DEFAULT 'demo',
                notes text,
                UNIQUE (tenant_id, study_id)
            )
            """
        )
    )

    # RLS on both (tenant-scoped).
    for table in ("erasure_request", "demo_case"):
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


def downgrade() -> None:
    for table in ("erasure_request", "demo_case"):
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        )
    op.execute(text("DROP TABLE IF EXISTS demo_case"))
    op.execute(text("DROP TABLE IF EXISTS erasure_request"))
