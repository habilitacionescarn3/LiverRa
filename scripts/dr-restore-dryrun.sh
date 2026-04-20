#!/usr/bin/env bash
# T380 — dr-restore-dryrun.sh (full implementation)
#
# Plain-English:
#   Disaster Recovery drill. Pretends prod just died, restores everything
#   into an isolated sandbox VPC, verifies the chain-of-hashes audit trail
#   still validates end-to-end, and asserts we can do the whole thing in
#   under 8 hours (our RTO target per plan §DR & Ops Drills).
#
#   On success:
#     - Writes a last-success stamp to
#       s3://liverra-ops-stamps/dr-restore/last-success.json
#     - Emits a timestamped runbook entry at
#       docs/runbooks/dr-restore-history/<ISO8601>.json
#
#   On failure:
#     - Non-zero exit + stderr message the ci-dr-drill workflow converts
#       into a PagerDuty incident.
#
# Modes:
#   --dry-run   (default)  Provision sandbox, verify, tear down. No DNS swap.
#   --execute              Real DR. Also swaps DNS to point at the sandbox.
#                          NEVER run outside of an incident.
#
# Prereqs:
#   - AWS creds with rds:restore-db-instance-to-point-in-time
#   - KMS access to the audit-anchor CMK
#   - `pg_dump`, `aws`, `jq`, `psql` on PATH
set -euo pipefail

MODE="${1:---dry-run}"
if [ "${MODE}" != "--dry-run" ] && [ "${MODE}" != "--execute" ]; then
  echo "[dr-restore-dryrun] ERROR: invalid mode ${MODE} (expected --dry-run or --execute)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS_REGION="${AWS_REGION:-eu-central-1}"
RTO_SECONDS="${RTO_SECONDS:-28800}"   # 8 h
START_TS=$(date -u +%s)
RUN_ID="dr-$(date -u +%Y%m%dT%H%M%SZ)"
SANDBOX_SUFFIX="${RUN_ID}"

SOURCE_RDS_ID="${SOURCE_RDS_ID:-liverra-prod}"
SOURCE_S3_IMAGING="${SOURCE_S3_IMAGING:-liverra-imaging-eu-central-1}"
SOURCE_S3_ANCHORS="${SOURCE_S3_ANCHORS:-liverra-audit-anchors-eu-central-1}"
OPS_STAMP_BUCKET="${OPS_STAMP_BUCKET:-liverra-ops-stamps}"
STAMP_KEY="dr-restore/last-success.json"

SANDBOX_RDS_ID="liverra-dr-${SANDBOX_SUFFIX}"
SANDBOX_SG_ID="${DR_SANDBOX_SG_ID:-}"
SANDBOX_SUBNET_GROUP="${DR_SANDBOX_SUBNET_GROUP:-liverra-dr-sandbox}"

log() { printf '[dr-restore][%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cleanup() {
  local rc=$?
  log "tearing down sandbox resources (exit=${rc})"
  aws rds delete-db-instance \
    --db-instance-identifier "${SANDBOX_RDS_ID}" \
    --skip-final-snapshot \
    --region "${AWS_REGION}" >/dev/null 2>&1 || true
  # S3 snapshot copy lives in a scratch bucket keyed on RUN_ID; drop it.
  aws s3 rm "s3://${SOURCE_S3_IMAGING}-dr-scratch/${RUN_ID}/" \
    --recursive --region "${AWS_REGION}" >/dev/null 2>&1 || true
  return $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------
# 1. Point-in-time restore RDS into sandbox VPC
# ---------------------------------------------------------------------
log "step 1/5: RDS PITR ${SOURCE_RDS_ID} → ${SANDBOX_RDS_ID}"
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "${SOURCE_RDS_ID}" \
  --target-db-instance-identifier "${SANDBOX_RDS_ID}" \
  --use-latest-restorable-time \
  --db-subnet-group-name "${SANDBOX_SUBNET_GROUP}" \
  ${SANDBOX_SG_ID:+--vpc-security-group-ids "${SANDBOX_SG_ID}"} \
  --no-publicly-accessible \
  --region "${AWS_REGION}" >/dev/null

log "waiting for ${SANDBOX_RDS_ID} to become available (max 45 min)"
aws rds wait db-instance-available \
  --db-instance-identifier "${SANDBOX_RDS_ID}" \
  --region "${AWS_REGION}"

ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier "${SANDBOX_RDS_ID}" \
  --region "${AWS_REGION}" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
log "sandbox RDS endpoint: ${ENDPOINT}"

# ---------------------------------------------------------------------
# 2. Copy latest S3 imaging snapshot into sandbox scratch
# ---------------------------------------------------------------------
log "step 2/5: S3 snapshot copy (latest day partition)"
LATEST_PARTITION=$(aws s3 ls "s3://${SOURCE_S3_IMAGING}/studies/" \
  --region "${AWS_REGION}" | awk '{print $2}' | sort | tail -n 1)
aws s3 cp \
  "s3://${SOURCE_S3_IMAGING}/studies/${LATEST_PARTITION}" \
  "s3://${SOURCE_S3_IMAGING}-dr-scratch/${RUN_ID}/studies/${LATEST_PARTITION}" \
  --recursive --region "${AWS_REGION}" >/dev/null

# ---------------------------------------------------------------------
# 3. Chain-of-hashes verifier against sandbox DB + anchors bucket
# ---------------------------------------------------------------------
log "step 3/5: chain verifier (tenants × daily Merkle anchors)"
export DR_PGHOST="${ENDPOINT}"
export DR_PGDATABASE="${DR_PGDATABASE:-liverra}"
export DR_PGUSER="${DR_PGUSER:-liverra}"
export DR_S3_ANCHORS="${SOURCE_S3_ANCHORS}"

python "${REPO_ROOT}/packages/ml-inference/scripts/verify-audit-chain.py" \
  --host "${DR_PGHOST}" \
  --database "${DR_PGDATABASE}" \
  --anchors-bucket "${DR_S3_ANCHORS}" \
  --region "${AWS_REGION}" \
  --fail-fast

# ---------------------------------------------------------------------
# 4. RTO assertion
# ---------------------------------------------------------------------
NOW_TS=$(date -u +%s)
ELAPSED=$((NOW_TS - START_TS))
log "step 4/5: RTO check — elapsed=${ELAPSED}s target=${RTO_SECONDS}s"
if [ "${ELAPSED}" -gt "${RTO_SECONDS}" ]; then
  log "RTO BREACH: ${ELAPSED}s > ${RTO_SECONDS}s"
  exit 1
fi

# ---------------------------------------------------------------------
# 5. Optional: DNS swap (execute mode only)
# ---------------------------------------------------------------------
if [ "${MODE}" = "--execute" ]; then
  log "step 5/5: DNS swap to sandbox (EXECUTE MODE)"
  aws route53 change-resource-record-sets \
    --hosted-zone-id "${ROUTE53_ZONE_ID}" \
    --change-batch "file://${REPO_ROOT}/deploy/terraform/dr-dns-swap.json" \
    --region "${AWS_REGION}" >/dev/null
else
  log "step 5/5: DNS swap skipped (dry-run)"
fi

# ---------------------------------------------------------------------
# 6. Last-success stamp
# ---------------------------------------------------------------------
STAMP=$(cat <<JSON
{
  "run_id": "${RUN_ID}",
  "mode": "${MODE}",
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "elapsed_seconds": ${ELAPSED},
  "rto_target_seconds": ${RTO_SECONDS},
  "source_rds": "${SOURCE_RDS_ID}",
  "sandbox_rds": "${SANDBOX_RDS_ID}",
  "source_s3_imaging": "${SOURCE_S3_IMAGING}",
  "source_s3_anchors": "${SOURCE_S3_ANCHORS}"
}
JSON
)
echo "${STAMP}" | aws s3 cp - "s3://${OPS_STAMP_BUCKET}/${STAMP_KEY}" \
  --region "${AWS_REGION}" \
  --content-type application/json >/dev/null

HISTORY_DIR="${REPO_ROOT}/docs/runbooks/dr-restore-history"
mkdir -p "${HISTORY_DIR}"
echo "${STAMP}" > "${HISTORY_DIR}/${RUN_ID}.json"

log "SUCCESS — stamp written to s3://${OPS_STAMP_BUCKET}/${STAMP_KEY}"
exit 0
