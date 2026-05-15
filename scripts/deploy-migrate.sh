#!/bin/bash
# One-shot: apply all 17 LiverRa Alembic migrations against the cloud Postgres.
# Run this once after creating the Supabase project, before the first `fly deploy`.
#
# Usage:
#   DATABASE_URL_SYNC="postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres" \
#     ./scripts/deploy-migrate.sh
set -euo pipefail

if [ -z "${DATABASE_URL_SYNC:-}" ]; then
  echo "ERROR: set DATABASE_URL_SYNC to the cloud Postgres sync URL first."
  echo "       (Supabase: Project Settings → Database → Connection string → URI)"
  exit 1
fi

cd "$(dirname "$0")/../packages/ml-inference"

if [ ! -d .venv ]; then
  echo "Creating venv…"
  python3.12 -m venv .venv
  ./.venv/bin/pip install --quiet -r requirements.txt
fi

# alembic.ini reads DATABASE_URL_SYNC via env.py
echo "Current revision:"
./.venv/bin/alembic current

echo ""
echo "Applying migrations 0001 → head…"
./.venv/bin/alembic upgrade head

echo ""
echo "Final revision:"
./.venv/bin/alembic current

echo ""
echo "Verifying RLS on PHI tables…"
psql "$DATABASE_URL_SYNC" -c "
  SELECT tablename, rowsecurity, forcerowsecurity::text AS forced
  FROM pg_tables pt
  JOIN pg_class pc ON pc.relname = pt.tablename
  WHERE schemaname='public'
    AND tablename IN ('audit_event','audit_event_chain','analysis_finding','lesion_classification_override');
"

echo ""
echo "Seeding dev tenant (idempotent)…"
psql "$DATABASE_URL_SYNC" -c "
  INSERT INTO tenant (id, name)
  VALUES ('00000000-0000-0000-0000-000000000001', 'Staging Tenant')
  ON CONFLICT (id) DO NOTHING;
"

echo "Done."
