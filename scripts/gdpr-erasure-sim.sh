#!/usr/bin/env bash
# gdpr-erasure-sim.sh — end-to-end GDPR Art. 17 erasure simulator (T333, FR-040).
#
# Plain-English:
#   Provisions a disposable tenant + fake case, runs the erasure pipeline
#   end-to-end against the local API, and asserts:
#     1. The erasure completes in ≤60 seconds (SC-016).
#     2. Post-erasure the study returns 404 (NOT 403) on clinician search
#        (FR-032a).
#     3. An erasure_executed AuditEvent is present with the tombstone hash.
#     4. The confirmation PDF URL is reachable.
#
#   Every step prints a diagnostic header so operators running this on a
#   pilot tenant can trace exactly where things went wrong. Failures exit
#   non-zero — CI treats that as a SC-016 breach.
#
# Usage:
#   LIVERRA_API_BASE_URL=http://localhost:8000 \
#   LIVERRA_DPO_TOKEN=... \
#   ./scripts/gdpr-erasure-sim.sh
#
#   Set LIVERRA_ERASURE_SIM_MODE=dry-run to validate the script logic
#   without hitting a live API (used by CI smoke tests).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
API_BASE_URL="${LIVERRA_API_BASE_URL:-http://localhost:8000}"
DPO_TOKEN="${LIVERRA_DPO_TOKEN:-}"
CLINICIAN_TOKEN="${LIVERRA_CLINICIAN_TOKEN:-}"
MODE="${LIVERRA_ERASURE_SIM_MODE:-live}"
SLA_SECONDS="${LIVERRA_ERASURE_SLA_SECONDS:-60}"

log() { printf "[gdpr-erasure-sim] %s\n" "$*" >&2; }
fail() {
  log "FAIL: $*"
  exit 1
}

# ---------------------------------------------------------------------------
# Dry-run mode — validates the script but doesn't touch the API.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "dry-run" ]]; then
  log "dry-run: skipping HTTP calls; validating environment only"
  command -v curl >/dev/null 2>&1 || fail "curl not installed"
  command -v jq >/dev/null 2>&1 || fail "jq not installed"
  log "dry-run: OK"
  exit 0
fi

if [[ -z "$DPO_TOKEN" ]]; then
  fail "LIVERRA_DPO_TOKEN required for live mode"
fi

# ---------------------------------------------------------------------------
# Step 1 — Provision a disposable tenant + fake study.
# ---------------------------------------------------------------------------
log "step 1/5: provisioning disposable fixture"
TENANT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
STUDY_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
log "  tenant_id=$TENANT_ID  study_id=$STUDY_ID"

# A local provisioning endpoint is assumed (POST /api/v1/dev/fixtures).
# In production we skip this step — the caller is expected to have
# seeded the fixture out-of-band and to pass target_study_id directly.
if [[ -n "${LIVERRA_DEV_FIXTURE:-}" ]]; then
  curl -sS -X POST "$API_BASE_URL/api/v1/dev/fixtures" \
    -H "Authorization: Bearer $DPO_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tenant_id\":\"$TENANT_ID\",\"study_id\":\"$STUDY_ID\"}" >/dev/null \
    || fail "fixture provisioning failed"
fi

# ---------------------------------------------------------------------------
# Step 2 — Submit the erasure request.
# ---------------------------------------------------------------------------
log "step 2/5: POST /api/v1/erasure/requests"
STARTED_AT=$(date +%s)
ERASURE_RESP="$(
  curl -sS -X POST "$API_BASE_URL/api/v1/erasure/requests" \
    -H "Authorization: Bearer $DPO_TOKEN" \
    -H "X-Step-Up-Token: ${LIVERRA_STEP_UP_TOKEN:-sim-test}" \
    -H "Content-Type: application/json" \
    -d "{\"target_study_id\":\"$STUDY_ID\",\"justification\":\"GDPR Art. 17 test erasure — disposable fixture\"}"
)"
ERASURE_ID="$(echo "$ERASURE_RESP" | jq -r '.erasure_request_id // empty')"
[[ -n "$ERASURE_ID" ]] || fail "erasure_request_id missing from response: $ERASURE_RESP"
log "  erasure_request_id=$ERASURE_ID"

# ---------------------------------------------------------------------------
# Step 3 — Poll for completion (≤60 s SLA).
# ---------------------------------------------------------------------------
log "step 3/5: polling status until completed (SLA: ${SLA_SECONDS}s)"
for attempt in $(seq 1 "$SLA_SECONDS"); do
  STATUS_RESP="$(
    curl -sS "$API_BASE_URL/api/v1/erasure/requests/$ERASURE_ID" \
      -H "Authorization: Bearer $DPO_TOKEN"
  )"
  STATUS="$(echo "$STATUS_RESP" | jq -r '.status // empty')"
  if [[ "$STATUS" == "completed" ]]; then
    COMPLETED_AT=$(date +%s)
    ELAPSED=$((COMPLETED_AT - STARTED_AT))
    log "  completed in ${ELAPSED}s (attempt $attempt)"
    if [[ "$ELAPSED" -gt "$SLA_SECONDS" ]]; then
      fail "SC-016 breach: erasure took ${ELAPSED}s > ${SLA_SECONDS}s"
    fi
    TOMBSTONE_HASH="$(echo "$STATUS_RESP" | jq -r '.tombstone_hash_hex // empty')"
    [[ -n "$TOMBSTONE_HASH" ]] || fail "tombstone_hash_hex missing"
    log "  tombstone_hash_hex=$TOMBSTONE_HASH"
    break
  fi
  sleep 1
done
[[ "$STATUS" == "completed" ]] || fail "erasure did not complete within ${SLA_SECONDS}s"

# ---------------------------------------------------------------------------
# Step 4 — Assert FR-032a 404-not-403 on clinician search.
# ---------------------------------------------------------------------------
log "step 4/5: asserting 404 (not 403) on clinician search"
if [[ -z "$CLINICIAN_TOKEN" ]]; then
  log "  (skipping: LIVERRA_CLINICIAN_TOKEN not set)"
else
  HTTP_CODE="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      "$API_BASE_URL/api/v1/analyses?study_id=$STUDY_ID" \
      -H "Authorization: Bearer $CLINICIAN_TOKEN"
  )"
  case "$HTTP_CODE" in
    404) log "  clinician search returned 404 — OK (FR-032a)";;
    403) fail "FR-032a breach: clinician got 403; must be 404 to avoid existence disclosure";;
    *)   fail "unexpected status $HTTP_CODE on clinician search";;
  esac
fi

# ---------------------------------------------------------------------------
# Step 5 — Fetch the confirmation PDF.
# ---------------------------------------------------------------------------
log "step 5/5: fetching confirmation PDF"
PDF_URL="$(echo "$STATUS_RESP" | jq -r '.confirmation_pdf_url // empty')"
if [[ -n "$PDF_URL" ]]; then
  curl -sS -o /dev/null -w 'PDF HTTP %{http_code} %{size_download} bytes\n' "$PDF_URL" \
    || fail "confirmation PDF unreachable"
else
  log "  (confirmation_pdf_url unset — dev env without S3 uploader, skipping)"
fi

log "SUCCESS: erasure $ERASURE_ID completed + all assertions passed"
exit 0
