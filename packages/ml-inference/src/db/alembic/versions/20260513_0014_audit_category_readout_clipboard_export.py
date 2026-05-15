"""audit_category — register readout_clipboard_export.

Revision ID: 0014_audit_category_readout_clipboard_export
Revises: 0013_analysis_finding
Create Date: 2026-05-13

Plain-English:
    Feature 002-acr-structured-readout adds a new ``AuditCategory`` enum
    member ``ReadoutClipboardExport`` (value: ``readout_clipboard_export``)
    used by the new ``POST /api/v1/analyses/{id}/report/clipboard-export``
    endpoint.

    The ``audit_event.category`` column is plain ``text`` with no CHECK
    constraint and the ``audit_event_chain.canonical_json`` body is JSON
    — neither requires a DDL change to accept the new value. This
    migration is therefore a marker that:

      1. Documents the new category in version history.
      2. Asserts the precondition (column is unconstrained text) so that
         if a future migration adds a CHECK or enum the precondition
         break is loudly visible.
      3. Provides a no-op reversible downgrade for auditor traceability.

    Source: ``specs/002-acr-structured-readout/plan.md`` §Constitution
    Check row "Auditability"; ``packages/core/src/types/audit.ts`` lines
    16, 44 (the canonical 25-member enum).
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0014_audit_category_readout_clipboard_export"
down_revision: Union[str, None] = "0013_analysis_finding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_CATEGORY = "readout_clipboard_export"


def upgrade() -> None:
    # Precondition assertion: audit_event.category must be unconstrained
    # text (migration 0005). If a CHECK constraint has been introduced
    # since, fail loudly so the engineer adding the constraint can
    # extend it to include the new category.
    result = op.get_bind().execute(
        text(
            """
            SELECT conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
             WHERE t.relname = 'audit_event'
               AND c.contype = 'c'
               AND pg_get_constraintdef(c.oid) ILIKE '%category%'
            """
        )
    ).fetchall()
    if result:
        # If we ever land a constraint, extend it to include the new
        # category here. Until then, this assertion guards the contract.
        raise RuntimeError(
            "audit_event.category is now constrained "
            f"({[row[0] for row in result]}); extend the constraint to "
            f"accept {_NEW_CATEGORY!r} before re-running this migration."
        )

    # M-ACR-6: make the "unconstrained text by design" contract visible
    # to anyone reading psql \d+ output. The canonical enum lives in
    # ``packages/core/src/types/audit.ts`` (TS) +
    # ``packages/ml-inference/src/services/audit/audit_categories.py``
    # (Python). New members must be added there first; this column
    # is intentionally not gated by a CHECK so the migration to add
    # one is its own deliberate event.
    op.execute(
        text(
            "COMMENT ON COLUMN audit_event.category IS "
            "'Audit category slug. Intentionally unconstrained text — "
            "canonical enum is application-side (packages/core/src/types/audit.ts). "
            "Adding a CHECK constraint requires reviewing every emitter and "
            "every chain reader; see migration 0014 for precondition guard.'"
        )
    )


def downgrade() -> None:
    # Reverse the column comment so the schema returns to its prior state.
    op.execute(text("COMMENT ON COLUMN audit_event.category IS NULL"))
    # No other DDL change to revert. Downgrade is otherwise a no-op so
    # older revisions of the application continue to function — the new
    # category simply stops being emitted.
