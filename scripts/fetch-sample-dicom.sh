#!/usr/bin/env bash
# Fetch a small public DICOM series into `fixtures/dicom/` so Phase-0 and the
# PACS E2E test have real pixels to work with. The data is sourced from
# Orthanc's public demo server (anonymized CT), which is an Apache-2.0-spirit
# public sandbox maintained by the Orthanc Team.
#
# We intentionally pull a small number of instances (capped below) so the
# fixture commits to zero and the dev loop stays snappy — the goal is "enough
# slices to prove stack-scroll works", not a production dataset.
#
# Re-running is idempotent: files that already exist are skipped.
#
# Requires: curl, jq.

set -euo pipefail

DEMO_ROOT="${LIVERRA_DEMO_ORTHANC:-https://orthanc-demo.liverra.ai}"
# Fall back to the public demo server run by the Orthanc team if no
# LiverRa-curated mirror exists.
PUBLIC_FALLBACK="https://demo.orthanc-server.com"
OUT_DIR="$(dirname "$0")/../fixtures/dicom"
MAX_INSTANCES="${LIVERRA_SAMPLE_MAX_INSTANCES:-40}"

mkdir -p "$OUT_DIR"

resolve_root() {
  # Prefer the LiverRa mirror if it answers; fall back to the Orthanc public
  # demo server.
  if curl -sfL --max-time 5 "${DEMO_ROOT}/system" >/dev/null 2>&1; then
    echo "$DEMO_ROOT"
  elif curl -sfL --max-time 8 "${PUBLIC_FALLBACK}/system" >/dev/null 2>&1; then
    echo "$PUBLIC_FALLBACK"
  else
    echo ""
  fi
}

ROOT="$(resolve_root)"
if [[ -z "$ROOT" ]]; then
  echo "error: neither ${DEMO_ROOT} nor ${PUBLIC_FALLBACK} is reachable." >&2
  echo "       If you already have DICOMs locally, drop them in ${OUT_DIR}/." >&2
  exit 1
fi

echo "[fetch-sample-dicom] source = ${ROOT}"
echo "[fetch-sample-dicom] target = ${OUT_DIR} (max ${MAX_INSTANCES} instances)"

STUDY_IDS_JSON="$(curl -sfL "${ROOT}/studies")"
FIRST_STUDY="$(echo "$STUDY_IDS_JSON" | jq -r '.[0] // empty')"
if [[ -z "$FIRST_STUDY" ]]; then
  echo "error: ${ROOT}/studies returned no studies." >&2
  exit 1
fi

echo "[fetch-sample-dicom] picking study ${FIRST_STUDY}"

INSTANCES_JSON="$(curl -sfL "${ROOT}/studies/${FIRST_STUDY}/instances")"
INSTANCE_IDS=$(echo "$INSTANCES_JSON" | jq -r '.[].ID' | head -n "$MAX_INSTANCES")

DOWNLOADED=0
SKIPPED=0
for ID in $INSTANCE_IDS; do
  OUT="${OUT_DIR}/${ID}.dcm"
  if [[ -f "$OUT" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  curl -sfL -o "$OUT" "${ROOT}/instances/${ID}/file"
  DOWNLOADED=$((DOWNLOADED + 1))
done

echo "[fetch-sample-dicom] downloaded ${DOWNLOADED}, skipped ${SKIPPED} (already present)"
echo "[fetch-sample-dicom] ready. Next: ./scripts/seed-orthanc.sh"
