"""tenant, user, notification_preference, compliance_assignment (T052).

Revision ID: 0001_tenant_user
Revises:
Create Date: 2026-04-19

Establishes multi-tenant baseline:
  - pgcrypto (gen_random_uuid), citext extensions
  - tenant, user, notification_preference, compliance_assignment
  - Row-Level Security policies scoped via current_setting('app.tenant_id')

Notes per task brief:
  - ``user`` is a reserved word in Postgres; we quote it everywhere.
  - Column types kept minimal per T052 brief (not the fuller data-model §1
    shape) — later migrations can ALTER TABLE to add the full Tenant fields.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0001_tenant_user"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Extensions ----------------------------------------------------------
    op.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
    op.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))

    # tenant --------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE tenant (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                name text NOT NULL,
                status text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'erasure_pending')),
                created_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )

    # notification_preference --------------------------------------------
    # Created before "user" so we can reference it via FK from user.
    op.execute(
        text(
            """
            CREATE TABLE notification_preference (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                user_id uuid NOT NULL,
                email_enabled boolean NOT NULL DEFAULT true,
                push_enabled boolean NOT NULL DEFAULT false,
                sms_enabled boolean NOT NULL DEFAULT false,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )

    # user ----------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE "user" (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                cognito_sub text NOT NULL UNIQUE,
                email citext NOT NULL,
                role text NOT NULL
                    CHECK (role IN (
                        'hpb_surgeon','radiologist','fellow',
                        'admin','ops','compliance','dpo'
                    )),
                theme_preference text NOT NULL DEFAULT 'system'
                    CHECK (theme_preference IN ('light','dark','system')),
                locale_preference text NOT NULL DEFAULT 'en'
                    CHECK (locale_preference IN ('en','de','ka')),
                notification_preference_id uuid
                    REFERENCES notification_preference(id) ON DELETE SET NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                last_login_at timestamptz
            )
            """
        )
    )
    op.execute(
        text('CREATE UNIQUE INDEX user_tenant_email_key ON "user" (tenant_id, email)')
    )

    # Back-fill FK from notification_preference.user_id now that user exists.
    op.execute(
        text(
            """
            ALTER TABLE notification_preference
            ADD CONSTRAINT notification_preference_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE
            """
        )
    )

    # compliance_assignment ----------------------------------------------
    # Cross-tenant mapping for compliance role (data-model §21).
    op.execute(
        text(
            """
            CREATE TABLE compliance_assignment (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                user_id uuid NOT NULL
                    REFERENCES "user"(id) ON DELETE CASCADE,
                claim_key text NOT NULL,
                assigned_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE (tenant_id, user_id, claim_key)
            )
            """
        )
    )

    # Row-Level Security --------------------------------------------------
    # Policy: tenant-scoped rows only visible when the session-local GUC
    # app.tenant_id matches tenant_id. session.py sets this via SET LOCAL.
    for table in ("tenant", "notification_preference", "compliance_assignment"):
        op.execute(text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
        op.execute(text(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))

    op.execute(text('ALTER TABLE "user" ENABLE ROW LEVEL SECURITY'))
    op.execute(text('ALTER TABLE "user" FORCE ROW LEVEL SECURITY'))

    # tenant: row-level match is on id (tenant is its own tenant_id).
    op.execute(
        text(
            """
            CREATE POLICY tenant_isolation ON tenant
            USING (id::text = current_setting('app.tenant_id', true))
            WITH CHECK (id::text = current_setting('app.tenant_id', true))
            """
        )
    )

    for table in ("user", "notification_preference", "compliance_assignment"):
        # "user" needs quoting; others don't, but the policy SQL is the same.
        tbl = f'"{table}"' if table == "user" else table
        op.execute(
            text(
                f"""
                CREATE POLICY {table}_tenant_isolation ON {tbl}
                USING (tenant_id::text = current_setting('app.tenant_id', true))
                WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
                """
            )
        )


def downgrade() -> None:
    # Drop policies + RLS + tables in reverse creation order.
    for table in ("user", "notification_preference", "compliance_assignment"):
        tbl = f'"{table}"' if table == "user" else table
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {tbl}")
        )
    op.execute(text("DROP POLICY IF EXISTS tenant_isolation ON tenant"))

    op.execute(text("DROP TABLE IF EXISTS compliance_assignment"))
    op.execute(
        text(
            "ALTER TABLE notification_preference "
            "DROP CONSTRAINT IF EXISTS notification_preference_user_id_fkey"
        )
    )
    op.execute(text('DROP TABLE IF EXISTS "user"'))
    op.execute(text("DROP TABLE IF EXISTS notification_preference"))
    op.execute(text("DROP TABLE IF EXISTS tenant"))

    # Extensions are intentionally NOT dropped — they're shared and cheap.
