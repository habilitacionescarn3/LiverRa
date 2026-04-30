#!/usr/bin/env bash
# switch-env.sh — select the active LiverRa deployment target.
#
# Usage:
#   ./scripts/switch-env.sh local
#   ./scripts/switch-env.sh production
#   ./scripts/switch-env.sh onprem
#
# Effect:
#   - Symlinks `.env` -> `.env.<target>` (creates `.env.<target>` from
#     `.env.example` on first use so you do not run with missing vars).
#   - Prints the DOCKER_COMPOSE_FILE path to stdout; callers can `eval` the
#     final `export` line to pick up the variable in the current shell.
set -euo pipefail

TARGET="${1:-}"
case "${TARGET}" in
  local|production|onprem) ;;
  *)
    echo "usage: $0 {local|production|onprem}" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

ENV_FILE=".env.${TARGET}"
COMPOSE_FILE="deploy/${TARGET}/docker-compose.yml"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f ".env.example" ]]; then
    cp ".env.example" "${ENV_FILE}"
    echo "[switch-env] seeded ${ENV_FILE} from .env.example — fill in secrets before use"
  else
    echo "[switch-env] ${ENV_FILE} not found and no .env.example to seed from" >&2
    exit 1
  fi
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "[switch-env] missing ${COMPOSE_FILE} — target '${TARGET}' is not wired yet" >&2
  exit 1
fi

ln -sfn "${ENV_FILE}" ".env"

echo "[switch-env] active env:     .env -> ${ENV_FILE}"
echo "[switch-env] compose file:   ${COMPOSE_FILE}"
echo "[switch-env] deploy target:  ${TARGET}"
echo
echo "# shell-eval lines:"
echo "export LIVERRA_DEPLOY_TARGET=${TARGET}"
echo "export DOCKER_COMPOSE_FILE=${COMPOSE_FILE}"
