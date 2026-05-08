#!/usr/bin/env bash
# Idempotent starter for the full LiverRa GPU-host stack.
#
# Brings up, in order:
#   1. tailscaled (userspace mode) — re-uses start-tailscaled-userspace.sh
#   2. dockerd (SysV-init service)
#   3. liverra-* containers (postgres, redis, minio, orthanc, triton)
#   4. FastAPI orchestrator (uvicorn on 8090)
#   5. Celery worker (--pool=solo)
#
# Designed to run as root from /etc/wsl.conf [boot] so the whole stack
# survives `wsl --shutdown`. Re-running while everything is up is a no-op.
#
# Logs:
#   /var/log/tailscaled-userspace.log   tailscaled
#   /var/log/liverra-stack.log          this script + docker
#   /var/log/liverra-uvicorn.log        FastAPI orchestrator
#   /var/log/liverra-celery.log         Celery worker
#
# PID files:
#   /run/tailscaled-userspace.pid
#   /run/liverra-uvicorn.pid
#   /run/liverra-celery.pid
set -uo pipefail
exec >> /var/log/liverra-stack.log 2>&1
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) start-liverra-stack ==="

REPO_ROOT="/home/irakli/LiverRA/LiverRa"
ML_DIR="${REPO_ROOT}/packages/ml-inference"
OPERATOR_USER="irakli"
OPERATOR_HOME="/home/${OPERATOR_USER}"
CONDA_BIN="${OPERATOR_HOME}/anaconda3/envs/liverra-ml/bin"

COMPOSE="${REPO_ROOT}/deploy/local/docker-compose.yml"
GPU_OVERRIDE="${REPO_ROOT}/deploy/local/docker-compose.gpu.override.yml"

# 1. Tailscaled — delegate to existing script.
if [[ -x /usr/local/bin/start-tailscaled-userspace.sh ]]; then
  /usr/local/bin/start-tailscaled-userspace.sh || true
fi

# 2. Dockerd — start if not running.
if ! pgrep -x dockerd >/dev/null 2>&1; then
  echo "[dockerd] starting…"
  /usr/sbin/service docker start || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [[ -S /var/run/docker.sock ]] && break
    sleep 1
  done
fi

# 3. LiverRa containers — bring up if not all running.
if [[ -f "$COMPOSE" ]]; then
  echo "[containers] ensuring postgres/redis/minio/orthanc/triton up…"
  # Run as operator so user-namespace ownership matches existing volumes.
  su -l "$OPERATOR_USER" -c "cd '${REPO_ROOT}' && docker compose -f '${COMPOSE}' -f '${GPU_OVERRIDE}' up -d postgres redis minio orthanc triton" || true
  # Persistent restart policy so future dockerd restarts auto-revive them.
  su -l "$OPERATOR_USER" -c "docker update --restart unless-stopped liverra-postgres liverra-redis liverra-minio liverra-orthanc liverra-triton" >/dev/null 2>&1 || true
fi

# Shared env for Python services. Keep in one place; both services read it.
LIVERRA_ENV=(
  "HOME=${OPERATOR_HOME}"
  "DATABASE_URL=postgresql+asyncpg://liverra:liverra@localhost:5432/liverra"
  "DATABASE_URL_SYNC=postgresql://liverra:liverra@localhost:5432/liverra"
  "AWS_ACCESS_KEY_ID=liverra"
  "AWS_SECRET_ACCESS_KEY=liverra-dev-password"
  "AWS_ENDPOINT_URL=http://localhost:9000"
  "AWS_REGION=eu-central-1"
  "CELERY_BROKER_URL=redis://localhost:6379/0"
  "CELERY_RESULT_BACKEND=redis://localhost:6379/1"
  "LIVERRA_AUTH_BYPASS=true"
  "LIVERRA_CASCADE_REAL_MODE=true"
  "PYTHONPATH=${ML_DIR}"
)

# 4. FastAPI orchestrator (uvicorn on 8090).
UVICORN_PID=/run/liverra-uvicorn.pid
if [[ -f "$UVICORN_PID" ]] && kill -0 "$(cat "$UVICORN_PID" 2>/dev/null)" 2>/dev/null; then
  echo "[uvicorn] already running (pid $(cat $UVICORN_PID))"
else
  echo "[uvicorn] starting on 8090…"
  cd "$ML_DIR"
  nohup env "${LIVERRA_ENV[@]}" "${CONDA_BIN}/python" -m uvicorn src.main:app --port 8090 --host 0.0.0.0 \
    >> /var/log/liverra-uvicorn.log 2>&1 &
  echo $! > "$UVICORN_PID"
  disown
fi

# 5. Celery worker (--pool=solo: TS uses multiprocessing.Pool internally).
CELERY_PID=/run/liverra-celery.pid
if [[ -f "$CELERY_PID" ]] && kill -0 "$(cat "$CELERY_PID" 2>/dev/null)" 2>/dev/null; then
  echo "[celery] already running (pid $(cat $CELERY_PID))"
else
  echo "[celery] starting (--pool=solo)…"
  cd "$ML_DIR"
  nohup env "${LIVERRA_ENV[@]}" "${CONDA_BIN}/celery" -A src.workers.app worker -Q celery -l info --pool=solo \
    >> /var/log/liverra-celery.log 2>&1 &
  echo $! > "$CELERY_PID"
  disown
fi

# Best-effort: chown logs back to operator so they can `tail -f` without sudo.
chown "${OPERATOR_USER}:${OPERATOR_USER}" \
  /var/log/liverra-uvicorn.log /var/log/liverra-celery.log /var/log/liverra-stack.log 2>/dev/null || true

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) liverra stack startup complete ==="
