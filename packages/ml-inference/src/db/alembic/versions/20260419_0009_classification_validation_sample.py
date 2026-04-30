"""classification_validation_sample (T467).

Revision ID: 0009_classification_validation_sample
Revises: 0008_tenant_calibration
Create Date: 2026-04-19

Per-tenant held-out validation crops used to re-fit the LiLNet
temperature-scaling parameter on every MBoM version bump.

Plain-English analogy:
    Each hospital accumulates a small collection of cases where the
    final diagnosis is known (path-confirmed or long-term follow-up).
    When we ship a new LiLNet weight, we run those cases through the
    new model, measure how over-confident the raw softmax is, and
    learn a fresh temperature to cool it down. This table is the
    storage for those reference crops + their ground-truth labels.

Entries are appended when a reviewer confirms a classification during
normal workflow (via the review UI). Only the lesion crop S3 URI is
stored — no PHI, no DICOM tags. The crop itself lives under the
case's per-case-KMS encryption, so erasure destroys the reference
along with the case.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0009_classify_val_sample"
down_revision: Union[str, None] = "0008_tenant_calibration"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        text(
            """
            CREATE TABLE classification_validation_sample (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE CASCADE,
                lesion_crop_s3_uri text NOT NULL
                    CHECK (lesion_crop_s3_uri LIKE 's3://%'),
                ground_truth_class text NOT NULL
                    CHECK (ground_truth_class IN (
                        'hcc', 'icc', 'metastasis',
                        'fnh', 'hemangioma', 'cyst'
                    )),
                added_at timestamptz NOT NULL DEFAULT now(),
                added_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
                analysis_id uuid REFERENCES analysis(id) ON DELETE SET NULL,
                lesion_id uuid REFERENCES lesion(id) ON DELETE SET NULL
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX classification_validation_sample_tenant_idx "
            "ON classification_validation_sample (tenant_id, added_at)"
        )
    )
    op.execute(
        text(
            "CREATE INDEX classification_validation_sample_class_idx "
            "ON classification_validation_sample (tenant_id, ground_truth_class)"
        )
    )


def downgrade() -> None:
    op.execute(
        text("DROP TABLE IF EXISTS classification_validation_sample")
    )
