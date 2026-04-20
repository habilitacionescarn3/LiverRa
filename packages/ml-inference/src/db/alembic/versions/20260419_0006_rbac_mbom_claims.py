"""permission_grant, model_bill_of_materials, regulatory_claim_registry (T057).

Revision ID: 0006_rbac_mbom_claims
Revises: 0005_audit_chain
Create Date: 2026-04-19

Seeds 7 RUO regulatory claims per existing tenant:
  flr_volumetry, parenchyma_segmentation, couinaud_segmentation,
  lesion_detection, lesion_classification, mask_refinement, dicom_export
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0006_rbac_mbom_claims"
down_revision: Union[str, None] = "0005_audit_chain"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEED_CLAIMS = (
    "flr_volumetry",
    "parenchyma_segmentation",
    "couinaud_segmentation",
    "lesion_detection",
    "lesion_classification",
    "mask_refinement",
    "dicom_export",
)


def upgrade() -> None:
    # permission_grant ----------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE permission_grant (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id uuid NOT NULL
                    REFERENCES "user"(id) ON DELETE CASCADE,
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                permission text NOT NULL,
                granted_by uuid
                    REFERENCES "user"(id) ON DELETE SET NULL,
                granted_at timestamptz NOT NULL DEFAULT now(),
                expires_at timestamptz,
                revoked_at timestamptz
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX permission_grant_user_perm_active_key "
            "ON permission_grant (user_id, tenant_id, permission) "
            "WHERE revoked_at IS NULL"
        )
    )

    # model_bill_of_materials --------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE model_bill_of_materials (
                build_sha text PRIMARY KEY,
                model_name text NOT NULL,
                model_family text NOT NULL,
                source_url text NOT NULL,
                pinned_commit_sha text NOT NULL,
                license_text_hash text NOT NULL,
                license_name text NOT NULL,
                integration_date date NOT NULL,
                approver text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )

    # regulatory_claim_registry ------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE regulatory_claim_registry (
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                claim_key text NOT NULL,
                status text NOT NULL DEFAULT 'ruo'
                    CHECK (status IN ('ruo','ce_class_iib','fda_510k')),
                activated_at timestamptz,
                superseded_by_claim_id uuid,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (tenant_id, claim_key)
            )
            """
        )
    )

    # Seed 7 RUO claims for every existing tenant. Idempotent via ON CONFLICT.
    claim_keys = ", ".join(f"('{k}')" for k in SEED_CLAIMS)
    op.execute(
        text(
            f"""
            INSERT INTO regulatory_claim_registry (tenant_id, claim_key, status)
            SELECT t.id, c.claim_key, 'ruo'
            FROM tenant t
            CROSS JOIN (VALUES {claim_keys}) AS c(claim_key)
            ON CONFLICT (tenant_id, claim_key) DO NOTHING
            """
        )
    )

    # RLS on permission_grant + regulatory_claim_registry (tenant-scoped).
    for table in ("permission_grant", "regulatory_claim_registry"):
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
    for table in ("permission_grant", "regulatory_claim_registry"):
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        )
    op.execute(text("DROP TABLE IF EXISTS regulatory_claim_registry"))
    op.execute(text("DROP TABLE IF EXISTS model_bill_of_materials"))
    op.execute(text("DROP TABLE IF EXISTS permission_grant"))
