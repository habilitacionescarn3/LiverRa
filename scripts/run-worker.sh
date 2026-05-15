#!/bin/bash
# Start the Celery worker reading from .env.
# Run from repo root: ./scripts/run-worker.sh
set -e
cd "$(dirname "$0")/.."

set -a
source ./.env
set +a

pkill -9 -f "celery.*src.workers.app" 2>/dev/null || true
sleep 2

cd packages/ml-inference
exec .venv/bin/celery -A src.workers.app worker --loglevel=info --concurrency=1
