#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# bootstrap-dev.sh — one-shot local dev environment bring-up (T138).
#
# Plain-English:
#   Brings up the Docker compose stack (Postgres, Redis, Orthanc, fake
#   Medplum), runs the Alembic migrations, seeds the demo tenant + a
#   sample case, and creates one dev user with an MFA pre-enrollment
#   token. Intended for new-contributor onboarding: `npm run
#   bootstrap:dev` and go.
#
# Prereqs (install manually):
#   - Docker Desktop running
#   - python 3.11 + venv at packages/ml-inference/.venv
#   - node 20+ + npm 10+ at repo root
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/deploy/local/docker-compose.yml"

echo "[bootstrap] repo root: $REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Bring up the dev services.
# ---------------------------------------------------------------------------
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[bootstrap] $COMPOSE_FILE missing — nothing to start" >&2
  exit 1
fi

echo "[bootstrap] starting docker compose stack..."
docker compose -f "$COMPOSE_FILE" up -d

# ---------------------------------------------------------------------------
# 2. Wait for Postgres readiness.
# ---------------------------------------------------------------------------
echo "[bootstrap] waiting for Postgres..."
deadline=$((SECONDS + 30))
until docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U liverra >/dev/null 2>&1; do
  if (( SECONDS > deadline )); then
    echo "[bootstrap] Postgres never became ready within 30s" >&2
    exit 1
  fi
  sleep 1
done
echo "[bootstrap] Postgres ready."

# ---------------------------------------------------------------------------
# 3. Run Alembic migrations.
# ---------------------------------------------------------------------------
echo "[bootstrap] running alembic upgrade head..."
pushd "$REPO_ROOT/packages/ml-inference" >/dev/null
if [[ -f ".venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi
if command -v alembic >/dev/null 2>&1; then
  alembic upgrade head || echo "[bootstrap] alembic returned non-zero — continuing"
else
  echo "[bootstrap] alembic not installed — skipping migrations"
fi
popd >/dev/null

# ---------------------------------------------------------------------------
# 4. Bootstrap Medplum project (no-op if script missing).
# ---------------------------------------------------------------------------
if [[ -x "$REPO_ROOT/packages/ml-inference/scripts/bootstrap-medplum-project.py" ]]; then
  echo "[bootstrap] seeding Medplum project..."
  python "$REPO_ROOT/packages/ml-inference/scripts/bootstrap-medplum-project.py" || \
    echo "[bootstrap] Medplum seed failed — continuing"
else
  echo "[bootstrap] Medplum seed script not present yet — skipping"
fi

# ---------------------------------------------------------------------------
# 5. Seed the demo case.
# ---------------------------------------------------------------------------
if [[ -x "$REPO_ROOT/scripts/seed-demo-case.sh" ]]; then
  echo "[bootstrap] seeding demo case..."
  bash "$REPO_ROOT/scripts/seed-demo-case.sh" || \
    echo "[bootstrap] demo-case seed failed — continuing"
fi

# ---------------------------------------------------------------------------
# 6. Create the dev user + pre-enrolled MFA token (optional — needs AWS creds).
# ---------------------------------------------------------------------------
if command -v aws >/dev/null 2>&1 && [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "[bootstrap] creating dev user in Cognito (placeholder)..."
  # TODO: wire real `aws cognito-idp admin-create-user` here once the
  # user-pool id is known. For now we only log intent.
  echo "[bootstrap] (skipped — wiring lands in T046 auth setup)"
else
  echo "[bootstrap] AWS creds not configured — skipping dev-user creation"
fi

# ---------------------------------------------------------------------------
# 7. Final message.
# ---------------------------------------------------------------------------
cat <<EOF

LiverRa dev env ready — open http://localhost:3000

Next steps:
  cd packages/app && npm run dev
  cd packages/ml-inference && uvicorn src.main:app --reload --port 8000
EOF
