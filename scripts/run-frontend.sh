#!/bin/bash
# Start the Vite frontend on port 5173.
# Run from repo root: ./scripts/run-frontend.sh
set -e
cd "$(dirname "$0")/.."

set -a
source ./.env
set +a

cd packages/app
# DO NOT set LIVERRA_API_ORIGIN — proxy defaults to 127.0.0.1:8090 (correct).
exec npx vite --port 5173
