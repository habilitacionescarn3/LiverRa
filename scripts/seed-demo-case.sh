#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# seed-demo-case.sh — provisions the FR-042 demo fixture per tenant.
#
# Plain-English:
#   Copies a fixture CT (ct-demo-rh.dcm) + pre-computed masks into each
#   configured tenant's demo case, then marks `DemoCase.sample_case_flag=true`
#   so it surfaces through the same idempotent path as the onboarding wizard
#   (T297/T439). Re-running is safe — every insert is ON CONFLICT DO NOTHING.
#
# Usage:
#   ./scripts/seed-demo-case.sh                # seed all tenants in TENANTS env
#   ./scripts/seed-demo-case.sh <tenant-id>    # seed a single tenant
#
# Env:
#   LIVERRA_DB_URL             — required, connection string for psql
#   LIVERRA_FIXTURES_DIR       — default: ./fixtures/demo-case
#   LIVERRA_ORTHANC_URL        — default: http://localhost:8042
#   LIVERRA_DEMO_FIXTURE_KEY   — default: demo-case-v1 (shared with T297)
#   TENANTS                    — comma-separated when no arg is passed
#
# Exit codes:
#   0 — all tenants seeded (or already present)
#   1 — fixture files missing
#   2 — DB/Orthanc error
set -euo pipefail

: "${LIVERRA_DB_URL:?LIVERRA_DB_URL is required}"
LIVERRA_FIXTURES_DIR="${LIVERRA_FIXTURES_DIR:-./fixtures/demo-case}"
LIVERRA_ORTHANC_URL="${LIVERRA_ORTHANC_URL:-http://localhost:8042}"
LIVERRA_DEMO_FIXTURE_KEY="${LIVERRA_DEMO_FIXTURE_KEY:-demo-case-v1}"

DEMO_CT="${LIVERRA_FIXTURES_DIR}/ct-demo-rh.dcm"
DEMO_MASK="${LIVERRA_FIXTURES_DIR}/masks/parenchyma.seg.nii.gz"

if [[ ! -f "${DEMO_CT}" ]]; then
  echo "[seed-demo-case] FATAL: fixture missing — ${DEMO_CT}" >&2
  exit 1
fi

seed_one_tenant() {
  local tenant_id="$1"
  echo "[seed-demo-case] seeding tenant=${tenant_id}"

  # 1. Upload DICOM to Orthanc (idempotent — Orthanc de-dups by SOP Instance UID).
  if ! curl -sf -X POST --data-binary "@${DEMO_CT}" \
        -H "Content-Type: application/dicom" \
        "${LIVERRA_ORTHANC_URL}/instances" >/dev/null; then
    echo "[seed-demo-case] Orthanc upload failed for tenant=${tenant_id}" >&2
    return 2
  fi

  # 2. Insert Study + Analysis + DemoCase rows (idempotent via ON CONFLICT).
  psql "${LIVERRA_DB_URL}" -v ON_ERROR_STOP=1 <<SQL
BEGIN;
INSERT INTO study (id, tenant_id, created_at, is_demo)
VALUES (gen_random_uuid(), '${tenant_id}'::uuid, now(), true)
ON CONFLICT DO NOTHING;

WITH s AS (
  SELECT id FROM study
  WHERE tenant_id = '${tenant_id}'::uuid AND is_demo = true
  ORDER BY created_at DESC LIMIT 1
), a AS (
  INSERT INTO analysis (id, tenant_id, study_id, status, queued_at,
                        completed_at, pipeline_version, is_demo)
  SELECT gen_random_uuid(), '${tenant_id}'::uuid, s.id,
         'completed', now(), now(), 'v1-demo', true
  FROM s
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO demo_case (id, tenant_id, analysis_id, fixture_key,
                       sample_case_flag, seeded_at)
SELECT gen_random_uuid(), '${tenant_id}'::uuid, a.id,
       '${LIVERRA_DEMO_FIXTURE_KEY}', true, now()
FROM a
ON CONFLICT (tenant_id, fixture_key) DO NOTHING;
COMMIT;
SQL
}

if [[ $# -ge 1 ]]; then
  seed_one_tenant "$1"
else
  : "${TENANTS:?Either pass a tenant id as argv[1] or set TENANTS=tid1,tid2,tid3}"
  IFS=',' read -r -a TENANT_LIST <<<"${TENANTS}"
  for t in "${TENANT_LIST[@]}"; do
    seed_one_tenant "$t"
  done
fi

echo "[seed-demo-case] done."
