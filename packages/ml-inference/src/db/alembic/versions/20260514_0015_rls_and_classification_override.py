"""RLS hardening + classification-override table + audit-chain constraints.

Revision ID: 0015_rls_and_classification_override
Revises: 0014_audit_category_readout_clipboard_export
Create Date: 2026-05-14

Plain-English:
    Closes a batch of audit findings (B-SCHEMA-1, B-SCHEMA-2, B-REFINE-1,
    B-AUDIT-5, C-SCHEMA-1, C-SCHEMA-2, C-SCHEMA-3, H-SCHEMA-3,
    H-SCHEMA-4, H-SCHEMA-5, H-SCHEMA-6) on the schema integrity / RLS /
    audit-chain front. In one migration so the production-audit fix is
    atomic — partial apply leaves no half-secured tables.

    Changes:
      1. Enable Row-Level Security on ``audit_event`` and
         ``audit_event_chain`` with tenant-isolation policies mirroring
         ``study`` / ``analysis`` (B-SCHEMA-1).
      2. Add a ``tenant_id`` column + RLS + tenant-isolation policy on
         ``analysis_finding``; backfill from the parent ``analysis`` row,
         then enforce ``NOT NULL`` (H-SCHEMA-5).
      3. Create ``lesion_classification_override`` table — the
         ``POST /reviews/{id}/classification-override`` endpoint inserts
         into it today but the table did not exist, causing every
         step-up-MFA override to 500 (B-REFINE-1).
      4. Add foreign keys from ``audit_event`` and ``audit_event_chain``
         to ``tenant(id)`` with ``ON DELETE RESTRICT`` so audit rows
         survive accidental tenant deletion (C-SCHEMA-1).
      5. Add a STORED generated column ``canonical_json_hash`` plus a
         UNIQUE index for O(1) idempotency lookups; replaces O(N)
         substring scans (C-SCHEMA-2).
      6. Add an index on ``audit_event_chain (category, written_at DESC)``
         for forensic queries. ``category`` lives on the
         ``audit_event`` table; the parallel index ``audit_event``
         already has ``(tenant_id, written_at)`` from 0005 — we
         augment with a category-filtered variant (H-SCHEMA-6).
      7. Add a CHECK constraint on ``audit_event_chain.category`` and
         on ``audit_event.category`` listing the 25 canonical
         ``AuditCategory`` values (H-SCHEMA-3). Note: ``audit_event_chain``
         did not previously have a ``category`` column; the audit's
         "C-SCHEMA-3 / H-SCHEMA-3" finding language calls out the
         chain's ``category`` as an open text contract — the CHECK is
         applied on ``audit_event`` where the column actually exists.
      8. Annotate ``study.patient_ref`` as PHI via ``COMMENT`` and add a
         format CHECK enforcing the FHIR-reference shape
         (``Patient/<uuid-like>``) (H-SCHEMA-4).
      9. Document (in comment only — no DDL) that the default partition
         ``audit_event_chain_default`` is a fallback only and
         per-tenant partitions should be provisioned at tenant
         onboarding. We DO NOT drop the default partition (still
         needed for legacy / unsharded tenants) (C-SCHEMA-3).

    The fix for B-AUDIT-5 / B-SCHEMA-2 (sequence_no race) is a code
    change in ``packages/ml-inference/src/services/audit/chain_of_hashes.py``
    that takes a per-tenant ``pg_advisory_xact_lock`` before reading
    the previous leaf hash — no schema change required.

Reversibility note: every CREATE has a matching DROP; every ALTER has
a matching reverse ALTER; the generated column + UNIQUE index +
RLS policies all unwind cleanly. The lesion_classification_override
DROP cascades the unique partial index automatically.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0015_rls_and_classification_override"
down_revision: Union[str, None] = "0014_audit_category_readout_clipboard_export"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The 25 canonical AuditCategory values. Source of truth:
# packages/core/src/types/audit.ts (lines 16-44). Keep this list in sync
# with that enum AND with the TypeScript test
# `audit-category-parity.test.ts` (T056e).
_AUDIT_CATEGORIES: tuple[str, ...] = (
    "study_upload",
    "anonymization",
    "analysis_start",
    "analysis_complete",
    "mask_edit",
    "lesion_reprompt",
    "classification_override",
    "report_finalize",
    "report_retract",
    "pacs_push_attempt",
    "pacs_push_success",
    "pacs_push_failure",
    "artifact_export",
    "permission_check",
    "review_seat_acquired",
    "review_seat_released",
    "erasure_requested",
    "erasure_executed",
    "license_drift_detected",
    "tenant_create",
    "user_role_change",
    "step_up_mfa",
    "config_change",
    "tampering_attempt",
    "readout_clipboard_export",
)


def _category_check_sql() -> str:
    """Render the CHECK predicate listing the 25 canonical categories."""
    values = ", ".join(f"'{c}'" for c in _AUDIT_CATEGORIES)
    return f"category IN ({values})"


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. RLS on audit_event + audit_event_chain (B-SCHEMA-1)
    # ------------------------------------------------------------------
    for table in ("audit_event", "audit_event_chain"):
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

    # ------------------------------------------------------------------
    # 2. analysis_finding: add tenant_id + RLS (H-SCHEMA-5)
    # ------------------------------------------------------------------
    op.execute(text("ALTER TABLE analysis_finding ADD COLUMN tenant_id uuid"))
    op.execute(
        text(
            """
            UPDATE analysis_finding af
               SET tenant_id = a.tenant_id
              FROM analysis a
             WHERE af.analysis_id = a.id
               AND af.tenant_id IS NULL
            """
        )
    )
    op.execute(
        text("ALTER TABLE analysis_finding ALTER COLUMN tenant_id SET NOT NULL")
    )
    op.execute(
        text(
            "ALTER TABLE analysis_finding "
            "ADD CONSTRAINT fk_analysis_finding_tenant "
            "FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE"
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_analysis_finding_tenant_id "
            "ON analysis_finding (tenant_id)"
        )
    )
    op.execute(text("ALTER TABLE analysis_finding ENABLE ROW LEVEL SECURITY"))
    op.execute(text("ALTER TABLE analysis_finding FORCE ROW LEVEL SECURITY"))
    op.execute(
        text(
            """
            CREATE POLICY analysis_finding_tenant_isolation ON analysis_finding
            USING (tenant_id::text = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
            """
        )
    )

    # ------------------------------------------------------------------
    # 3. lesion_classification_override (B-REFINE-1)
    # ------------------------------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE lesion_classification_override (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                analysis_id uuid NOT NULL
                    REFERENCES analysis(id) ON DELETE RESTRICT,
                lesion_id uuid NOT NULL,
                override_class text NOT NULL,
                reviewer_user_id uuid NOT NULL,
                reviewer_role text NOT NULL,
                ack_id uuid,
                before_class text,
                before_confidence numeric,
                is_active boolean NOT NULL DEFAULT TRUE,
                created_at timestamptz NOT NULL DEFAULT now(),
                tenant_id uuid NOT NULL
                    REFERENCES tenant(id) ON DELETE RESTRICT
            )
            """
        )
    )
    # Partial unique index — only one active override per (analysis, lesion).
    op.execute(
        text(
            """
            CREATE UNIQUE INDEX ix_lci_active
            ON lesion_classification_override (analysis_id, lesion_id)
            WHERE is_active
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX ix_lci_tenant "
            "ON lesion_classification_override (tenant_id, created_at DESC)"
        )
    )
    op.execute(
        text(
            "ALTER TABLE lesion_classification_override "
            "ENABLE ROW LEVEL SECURITY"
        )
    )
    op.execute(
        text(
            "ALTER TABLE lesion_classification_override "
            "FORCE ROW LEVEL SECURITY"
        )
    )
    op.execute(
        text(
            """
            CREATE POLICY lci_tenant_isolation
            ON lesion_classification_override
            USING (tenant_id::text = current_setting('app.tenant_id', true))
            WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true))
            """
        )
    )

    # ------------------------------------------------------------------
    # 4. FK from audit tables to tenant(id) (C-SCHEMA-1)
    # ------------------------------------------------------------------
    # ON DELETE RESTRICT — audit rows must survive tenant deletion (they
    # are evidentiary; erasure flows mark rows as redacted but never DROP).
    op.execute(
        text(
            "ALTER TABLE audit_event "
            "ADD CONSTRAINT fk_audit_event_tenant "
            "FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT"
        )
    )
    # audit_event_chain is partitioned; the FK lives on the parent and is
    # enforced on every partition row.
    op.execute(
        text(
            "ALTER TABLE audit_event_chain "
            "ADD CONSTRAINT fk_audit_event_chain_tenant "
            "FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT"
        )
    )

    # ------------------------------------------------------------------
    # 5. canonical_json_hash + UNIQUE index (C-SCHEMA-2)
    # ------------------------------------------------------------------
    # md5 is 16 bytes — collision-safe at audit-row volumes and gives a
    # fixed-size index. The hash mirrors the canonical_json field 1:1 so
    # the row remains the only authority on equality; the hash is just a
    # cheap index key.
    op.execute(
        text(
            """
            ALTER TABLE audit_event_chain
            ADD COLUMN canonical_json_hash text
            GENERATED ALWAYS AS (md5(canonical_json)) STORED
            """
        )
    )
    op.execute(
        text(
            "CREATE UNIQUE INDEX ix_audit_event_chain_canonical_hash "
            "ON audit_event_chain (tenant_id, canonical_json_hash)"
        )
    )

    # ------------------------------------------------------------------
    # 6. Forensic index on audit_event (tenant_id, category, written_at)
    #    (H-SCHEMA-6)
    # ------------------------------------------------------------------
    op.execute(
        text(
            "CREATE INDEX audit_event_tenant_category_time_idx "
            "ON audit_event (tenant_id, category, written_at DESC)"
        )
    )

    # ------------------------------------------------------------------
    # 7. CHECK on audit_event.category — the 25 canonical values
    #    (H-SCHEMA-3)
    # ------------------------------------------------------------------
    # NOTE: 0014 added a precondition guard that fails if a check on
    # audit_event.category exists. That guard runs ONLY when 0014 is
    # being applied; once we land 0015 with the CHECK in place, future
    # 0014 re-applies (e.g. on downgrade-then-upgrade) will see the
    # constraint and intentionally fail loud — that's the protocol. The
    # downgrade of 0015 drops the CHECK before 0014 ever re-runs.
    op.execute(
        text(
            f"ALTER TABLE audit_event "
            f"ADD CONSTRAINT audit_event_category_check "
            f"CHECK ({_category_check_sql()})"
        )
    )

    # ------------------------------------------------------------------
    # 8. study.patient_ref PHI annotation + format CHECK (H-SCHEMA-4)
    # ------------------------------------------------------------------
    op.execute(
        text(
            "COMMENT ON COLUMN study.patient_ref IS "
            "'PHI: pseudonymized FHIR Patient reference "
            "(Patient/<uuid-like>); original DICOM PatientID never stored'"
        )
    )
    # NOT VALID — applies to new rows only; legacy rows (pre-Patient/<id>
    # convention) skipped without backfill. Tenant migration owns the
    # backfill + revalidation step when ready.
    op.execute(
        text(
            "ALTER TABLE study "
            "ADD CONSTRAINT study_patient_ref_format "
            "CHECK (patient_ref ~ '^Patient/[a-zA-Z0-9_.-]+$') NOT VALID"
        )
    )


def downgrade() -> None:
    # Unwind in reverse order so dependents disappear before dependencies.

    # 8. study.patient_ref annotations
    op.execute(
        text(
            "ALTER TABLE study DROP CONSTRAINT IF EXISTS study_patient_ref_format"
        )
    )
    op.execute(text("COMMENT ON COLUMN study.patient_ref IS NULL"))

    # 7. audit_event.category CHECK
    op.execute(
        text(
            "ALTER TABLE audit_event "
            "DROP CONSTRAINT IF EXISTS audit_event_category_check"
        )
    )

    # 6. forensic index
    op.execute(
        text("DROP INDEX IF EXISTS audit_event_tenant_category_time_idx")
    )

    # 5. canonical_json_hash + UNIQUE index
    op.execute(
        text("DROP INDEX IF EXISTS ix_audit_event_chain_canonical_hash")
    )
    op.execute(
        text(
            "ALTER TABLE audit_event_chain "
            "DROP COLUMN IF EXISTS canonical_json_hash"
        )
    )

    # 4. tenant FKs
    op.execute(
        text(
            "ALTER TABLE audit_event_chain "
            "DROP CONSTRAINT IF EXISTS fk_audit_event_chain_tenant"
        )
    )
    op.execute(
        text(
            "ALTER TABLE audit_event "
            "DROP CONSTRAINT IF EXISTS fk_audit_event_tenant"
        )
    )

    # 3. lesion_classification_override
    op.execute(
        text(
            "DROP POLICY IF EXISTS lci_tenant_isolation "
            "ON lesion_classification_override"
        )
    )
    op.execute(text("DROP TABLE IF EXISTS lesion_classification_override"))

    # 2. analysis_finding tenant_id + RLS
    op.execute(
        text(
            "DROP POLICY IF EXISTS analysis_finding_tenant_isolation "
            "ON analysis_finding"
        )
    )
    op.execute(
        text("ALTER TABLE analysis_finding DISABLE ROW LEVEL SECURITY")
    )
    op.execute(text("DROP INDEX IF EXISTS ix_analysis_finding_tenant_id"))
    op.execute(
        text(
            "ALTER TABLE analysis_finding "
            "DROP CONSTRAINT IF EXISTS fk_analysis_finding_tenant"
        )
    )
    op.execute(
        text("ALTER TABLE analysis_finding DROP COLUMN IF EXISTS tenant_id")
    )

    # 1. RLS on audit_event + audit_event_chain
    for table in ("audit_event_chain", "audit_event"):
        op.execute(
            text(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        )
        op.execute(text(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))
