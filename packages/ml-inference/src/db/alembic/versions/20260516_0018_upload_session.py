"""upload_session — tus-style resumable DICOM upload sessions.

Revision ID: 0018_upload_session
Revises: 0017_refinement_optimistic_locking
Create Date: 2026-05-16

Plain-English:
    The `/upload` route (commit 49e701e) ships a DicomDropzone widget that
    POSTs to /api/v1/ingest/uploads → PATCHes resumable chunks. The handler
    in src/api/ingest.py was written against a table named `upload_session`
    that nobody ever migrated, so every POST 500s with
    `relation "upload_session" does not exist`.

    Schema mirrors exactly what _insert_upload / _get_upload_for_update /
    _patch_upload read & write at ingest.py:165-240. Tenant-scoped + RLS
    to match the existing study / analysis isolation model.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0018_upload_session"
down_revision: Union[str, None] = "0017_refinement_optimistic_locking"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS upload_session (
            id                  uuid PRIMARY KEY,
            tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
            uploader_user_id    uuid NOT NULL,
            upload_length       bigint NOT NULL,
            upload_offset       bigint NOT NULL DEFAULT 0,
            filename            varchar(255) NOT NULL,
            client_sha256       varchar(64),
            started_at          timestamptz NOT NULL DEFAULT now(),
            last_chunk_at       timestamptz,
            CONSTRAINT upload_session_offset_nonneg CHECK (upload_offset >= 0),
            CONSTRAINT upload_session_offset_le_length CHECK (upload_offset <= upload_length)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_upload_session_tenant_id
        ON upload_session (tenant_id)
        """
    )
    # Tenant isolation — same pattern as study / analysis tables.
    op.execute("ALTER TABLE upload_session ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE upload_session FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY upload_session_tenant_isolation ON upload_session
            USING (tenant_id::text = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS upload_session")
