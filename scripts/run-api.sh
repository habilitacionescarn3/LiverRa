#!/bin/bash
# Start the FastAPI orchestrator (port 8090) reading from .env.
# Run from repo root: ./scripts/run-api.sh
set -e
cd "$(dirname "$0")/.."

# Load .env. Source directly — process substitution + bash -c drops vars
# silently on macOS (verified 2026-05-15).
set -a
source ./.env
set +a

# Ensure the dev tenant exists (cascade dispatch needs the FK).
PGPASSWORD="${POSTGRES_PASSWORD:-liverra}" psql -h localhost -U "${POSTGRES_USER:-liverra}" -d "${POSTGRES_DB:-liverra}" \
    -c "INSERT INTO tenant (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Dev Tenant') ON CONFLICT (id) DO NOTHING;" \
    > /dev/null 2>&1 || true

# Kill any prior :8090 listener so a fresh boot picks up code edits.
lsof -t -i :8090 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1

cd packages/ml-inference
exec .venv/bin/uvicorn src.main:app --host 127.0.0.1 --port 8090 --reload --log-level info
