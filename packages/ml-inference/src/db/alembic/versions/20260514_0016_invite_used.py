"""invite_used table — single-use enforcement for invite-accept JWTs.

Revision ID: 0016_invite_used
Revises: 0015_rls_and_classification_override
Create Date: 2026-05-14

Plain-English:
    Closes B-AUTH-4 / H-AUTH-6: invite-accept JWTs were stateless and could
    be replayed. This table records the ``jti`` claim of every consumed
    invite. ``InviteService.consume_invite`` does an
    ``INSERT … ON CONFLICT DO NOTHING RETURNING jti`` against this table;
    the absence of a returned row means another caller already burned the
    token, and we raise ``InviteAlreadyUsed``.

    The row is small — ``jti`` (uuid-hex string, 32 chars) + a timestamp —
    so retention is cheap. We keep rows forever (no GC) because invite
    TTLs are 72h and replay attempts decades later are still useful audit
    signal.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_invite_used"
down_revision = "0015_rls_and_classification_override"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "invite_used",
        sa.Column("jti", sa.String(length=64), nullable=False, primary_key=True),
        sa.Column(
            "consumed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("invite_used")
