"""audit_event_chain (T056) — tamper-evident hash chain.

Revision ID: 0005_audit_chain
Revises: 0004_review_report
Create Date: 2026-04-19

Implements research §A.3:
  - Partitioned by LIST(tenant_id) so per-tenant partitions can be
    created on tenant onboarding (cheap isolation + per-tenant backup).
  - Append-only: a BEFORE UPDATE/DELETE trigger raises an exception AND
    writes a ``tampering_attempt`` row into ``audit_event`` for forensics.
  - ``leaf_hash`` and ``prev_leaf_hash`` form the Merkle-style chain;
    ``canonical_json`` is the deterministically serialised event body.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
from sqlalchemy import text

revision: str = "0005_audit_chain"
down_revision: Union[str, None] = "0004_review_report"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Plain audit_event table (used for tampering_attempt side-channel
    # writes and for FHIR AuditEvent projection). Minimal shape here;
    # downstream migrations may extend it.
    op.execute(
        text(
            """
            CREATE TABLE audit_event (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id uuid NOT NULL,
                category text NOT NULL,
                actor_ref text,
                target_ref text,
                payload jsonb NOT NULL DEFAULT '{}'::jsonb,
                written_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
    )
    op.execute(
        text(
            "CREATE INDEX audit_event_tenant_time_idx "
            "ON audit_event (tenant_id, written_at DESC)"
        )
    )

    # Partitioned chain table --------------------------------------------
    op.execute(
        text(
            """
            CREATE TABLE audit_event_chain (
                tenant_id uuid NOT NULL,
                sequence_no bigint NOT NULL,
                leaf_hash bytea NOT NULL,
                prev_leaf_hash bytea NOT NULL,
                canonical_json text NOT NULL,
                written_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (tenant_id, sequence_no)
            ) PARTITION BY LIST (tenant_id)
            """
        )
    )

    # Default partition so writes succeed before any tenant partition
    # is provisioned (onboarding flow will CREATE TABLE ... PARTITION OF
    # audit_event_chain FOR VALUES IN ('<tenant_uuid>')).
    op.execute(
        text(
            "CREATE TABLE audit_event_chain_default "
            "PARTITION OF audit_event_chain DEFAULT"
        )
    )

    # Tamper-evidence trigger --------------------------------------------
    op.execute(
        text(
            """
            CREATE OR REPLACE FUNCTION raise_tampering_attempt()
            RETURNS trigger AS $$
            DECLARE
                v_tenant uuid;
                v_seq    bigint;
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    v_tenant := OLD.tenant_id;
                    v_seq    := OLD.sequence_no;
                ELSE
                    v_tenant := OLD.tenant_id;
                    v_seq    := OLD.sequence_no;
                END IF;

                INSERT INTO audit_event (
                    tenant_id, category, actor_ref, target_ref, payload
                ) VALUES (
                    v_tenant,
                    'tampering_attempt',
                    current_setting('app.user_id', true),
                    'audit_event_chain:' || v_seq::text,
                    jsonb_build_object(
                        'op', TG_OP,
                        'session_user', session_user,
                        'client_addr', inet_client_addr()::text,
                        'attempted_at', now()
                    )
                );

                RAISE EXCEPTION
                    'audit_event_chain is append-only '
                    '(tenant=%, sequence_no=%, op=%)',
                    v_tenant, v_seq, TG_OP
                    USING ERRCODE = 'check_violation';
            END;
            $$ LANGUAGE plpgsql
            """
        )
    )

    # Trigger is attached to the partitioned parent; PG propagates it to
    # all partitions (including future ones and the default).
    op.execute(
        text(
            """
            CREATE TRIGGER audit_event_chain_append_only
            BEFORE UPDATE OR DELETE ON audit_event_chain
            FOR EACH ROW EXECUTE FUNCTION raise_tampering_attempt()
            """
        )
    )


def downgrade() -> None:
    op.execute(
        text(
            "DROP TRIGGER IF EXISTS audit_event_chain_append_only "
            "ON audit_event_chain"
        )
    )
    op.execute(text("DROP FUNCTION IF EXISTS raise_tampering_attempt()"))
    op.execute(text("DROP TABLE IF EXISTS audit_event_chain_default"))
    op.execute(text("DROP TABLE IF EXISTS audit_event_chain"))
    op.execute(text("DROP TABLE IF EXISTS audit_event"))
