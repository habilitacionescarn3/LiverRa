#!/usr/bin/env bash
# Upload every .dcm under fixtures/dicom/ to the local Orthanc via its REST
# /instances endpoint. This is the simplest path — Orthanc accepts the raw
# binary and indexes it. Re-uploading the same SOP UID is idempotent
# (Orthanc deduplicates by SOP Instance UID).
#
# Use this for Phase-0 "seed something so the list isn't empty" flow. The
# real end-to-end browser test goes through the app's dropzone → STOW-RS
# path instead.
#
# Requires: curl.

set -euo pipefail

ORTHANC_URL="${ORTHANC_URL:-http://localhost:8042}"
ORTHANC_USER="${ORTHANC_DEV_USER:-${ORTHANC_USERNAME:-orthanc}}"
ORTHANC_PASS="${ORTHANC_DEV_PASSWORD:-${ORTHANC_PASSWORD:-orthanc}}"
DIR="$(dirname "$0")/../fixtures/dicom"

if [[ ! -d "$DIR" ]]; then
  echo "error: ${DIR} does not exist. Run ./scripts/fetch-sample-dicom.sh first." >&2
  exit 1
fi

shopt -s nullglob
DCMS=("$DIR"/*.dcm)
if (( ${#DCMS[@]} == 0 )); then
  echo "error: no .dcm files under ${DIR}." >&2
  echo "       Either drop some in, or run ./scripts/fetch-sample-dicom.sh." >&2
  exit 1
fi

echo "[seed-orthanc] target  = ${ORTHANC_URL}"
echo "[seed-orthanc] files   = ${#DCMS[@]}"

OK=0
FAIL=0
for f in "${DCMS[@]}"; do
  if curl -sf -o /dev/null \
      -u "${ORTHANC_USER}:${ORTHANC_PASS}" \
      -H 'Expect:' \
      --data-binary @"$f" \
      "${ORTHANC_URL}/instances"; then
    OK=$((OK + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  ! failed: $(basename "$f")" >&2
  fi
done

echo "[seed-orthanc] uploaded ${OK}, failed ${FAIL}"

if (( FAIL > 0 )); then
  exit 1
fi

# Report what's now in Orthanc.
COUNT="$(curl -sfL -u "${ORTHANC_USER}:${ORTHANC_PASS}" "${ORTHANC_URL}/statistics" | grep -o '"CountInstances" : [0-9]*' | awk '{print $3}')"
echo "[seed-orthanc] Orthanc now holds ${COUNT} instances total"
