"""tenant_pacs_columns — add columns the admin API queries that the
original tenant schema didn't include.

Revision ID: 0011_tenant_pacs_columns
Revises: 0010_api_query_columns
Create Date: 2026-05-02

Plain-English:
    The admin router (api/admin.py) reads three tenant fields that the
    base `tenant` table from migration 0001 never created:
      - `locale_default` — fallback UI/email language for invitees
        (one of en / ru / ka / de). Defaults to 'en'.
      - `pacs_destination` — JSON config (ae_title, host, port, use_tls,
        cert_fingerprint) saved by the PACS-config page after a
        successful C-ECHO pre-flight. Nullable: a tenant has no PACS
        configured until an admin sets one up.
      - `allow_partial_coverage_override` — FR-006a tenant-level toggle
        that lets admins override `coverage_insufficient` rejections.
        Defaults to FALSE (safe default — explicit opt-in).

    Same drift pattern as 0010: API code was written ahead of the
    schema, every /api/v1/admin/tenants/me request 500'd with
    UndefinedColumnError until this migration lands.

Idempotent via `IF NOT EXISTS`.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0011_tenant_pacs_columns"
down_revision: Union[str, None] = "0010_api_query_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE tenant
          ADD COLUMN IF NOT EXISTS locale_default                  text    NOT NULL DEFAULT 'en',
          ADD COLUMN IF NOT EXISTS pacs_destination                jsonb,
          ADD COLUMN IF NOT EXISTS allow_partial_coverage_override boolean NOT NULL DEFAULT false
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE tenant
          DROP COLUMN IF EXISTS locale_default,
          DROP COLUMN IF EXISTS pacs_destination,
          DROP COLUMN IF EXISTS allow_partial_coverage_override
        """
    )
