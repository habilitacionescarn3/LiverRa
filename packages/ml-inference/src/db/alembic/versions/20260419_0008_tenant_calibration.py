"""tenant_calibration (T215).

Revision ID: 0008_tenant_calibration
Revises: 0007_erasure_democase
Create Date: 2026-04-19

Per-tenant temperature-scaling calibration parameter for LiLNet
classification (research §C.7). One row per tenant; if no row exists,
the service layer falls back to the model-family default (T=1.5).

Plain-English analogy:
    Each hospital's CT scanner has its own personality — some produce
    images that make the AI "too sure" of its guesses. The temperature
    is a dial we turn per hospital to cool down over-confident
    predictions before we decide whether to show or abstain.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0008_tenant_calibration"
down_revision: Union[str, None] = "0007_erasure_democase"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text(
            """
            CREATE TABLE tenant_calibration (
                tenant_id uuid PRIMARY KEY
                    REFERENCES tenant(id) ON DELETE CASCADE,
                temperature numeric(5,3) NOT NULL DEFAULT 1.500,
                fitted_at timestamptz,
                sample_count integer NOT NULL DEFAULT 0
                    CHECK (sample_count >= 0),
                CONSTRAINT tenant_calibration_temp_chk
                    CHECK (temperature > 0 AND temperature <= 1000)
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX tenant_calibration_fitted_idx "
            "ON tenant_calibration (fitted_at)"
        )
    )


def downgrade() -> None:
    op.execute(text("DROP TABLE IF EXISTS tenant_calibration"))
