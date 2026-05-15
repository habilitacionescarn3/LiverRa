#!/bin/bash
# Container entrypoint — picks API or worker process based on PROCESS env var.
# Fly.io reads `[processes]` from fly.toml and sets PROCESS_GROUP per machine.
set -euo pipefail

ROLE="${PROCESS_GROUP:-${PROCESS:-api}}"

case "$ROLE" in
  api)
    # Honor PORT (Fly.io sets it to 8080 by default; localhost uses 8090).
    exec uvicorn src.main:app --host 0.0.0.0 --port "${PORT:-8090}" --proxy-headers --forwarded-allow-ips='*'
    ;;
  worker)
    exec celery -A src.workers.app worker --loglevel=info --concurrency="${CELERY_CONCURRENCY:-2}"
    ;;
  migrate)
    # One-shot: apply alembic migrations then exit. Used by `fly deploy` release_command.
    exec alembic upgrade head
    ;;
  *)
    echo "Unknown PROCESS_GROUP/PROCESS=$ROLE (expected api|worker|migrate)"
    exit 1
    ;;
esac
