#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# model-bom.sh — Model Bill of Materials generator (T135, FR-038).
#
# Plain-English:
#   Walks every packages/ml-inference/triton-models/*/model.info file,
#   reads the pinned commit/source/license metadata, hashes the
#   upstream LICENSE text, and emits a single MBoM.json at the repo
#   root. A cryptographically-strong commit SHA + license hash means
#   any unannounced upstream licence change fails license-check.sh at
#   the next build — per FR-038.
#
# model.info file shape (YAML-ish "key: value" lines):
#   name: string             (e.g. "stu-net")
#   family: string           (e.g. "segmentation")
#   source_url: string       (canonical upstream repo URL)
#   pinned_commit_sha: string
#   license_file: string     (relative path to bundled LICENSE copy)
#   integration_date: YYYY-MM-DD
#   approver: string         (human name of last reviewer)
#
# Exit 0  on success.
# Exit >0 if any model lacks a LICENSE file or required key.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$REPO_ROOT/packages/ml-inference/triton-models"
OUT="$REPO_ROOT/MBoM.json"

if [[ ! -d "$MODELS_DIR" ]]; then
  echo "[model-bom] triton-models directory missing — writing empty MBoM" >&2
  mkdir -p "$(dirname "$OUT")"
  printf '{"build_sha":"%s","models":[],"python_deps":[]}\n' \
    "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" > "$OUT"
  exit 0
fi

BUILD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

# Key lookup helper — reads "key: value" from a model.info file.
kv() {
  local file="$1" key="$2"
  awk -v k="$key" -F': *' 'BEGIN{IGNORECASE=1} $1==k {sub(/^[^:]*: */, ""); print; exit}' "$file"
}

# Compose JSON array of model entries.
tmp_models="$(mktemp)"
trap 'rm -f "$tmp_models"' EXIT

model_count=0
failed=0
for info in "$MODELS_DIR"/*/model.info; do
  [[ -e "$info" ]] || continue
  model_dir="$(dirname "$info")"
  name="$(kv "$info" name || true)"
  family="$(kv "$info" family || true)"
  source_url="$(kv "$info" source_url || true)"
  pinned_sha="$(kv "$info" pinned_commit_sha || true)"
  license_rel="$(kv "$info" license_file || true)"
  integ_date="$(kv "$info" integration_date || true)"
  approver="$(kv "$info" approver || true)"

  if [[ -z "$name" || -z "$source_url" || -z "$pinned_sha" || -z "$license_rel" ]]; then
    echo "[model-bom] $info missing required keys (name, source_url, pinned_commit_sha, license_file)" >&2
    failed=1
    continue
  fi

  license_abs="$model_dir/$license_rel"
  if [[ ! -f "$license_abs" ]]; then
    echo "[model-bom] LICENSE not found: $license_abs" >&2
    failed=1
    continue
  fi

  license_hash="$(shasum -a 256 "$license_abs" | awk '{print $1}')"
  license_name="$(head -n1 "$license_abs" | tr -d '"\\' | cut -c1-120)"

  entry=$(cat <<JSON
{
  "build_sha": "$BUILD_SHA",
  "model_name": "$name",
  "model_family": "$family",
  "source_url": "$source_url",
  "pinned_commit_sha": "$pinned_sha",
  "license_text_hash": "$license_hash",
  "license_name": "$license_name",
  "integration_date": "$integ_date",
  "approver": "$approver"
}
JSON
)
  if [[ "$model_count" -gt 0 ]]; then
    printf ',' >> "$tmp_models"
  fi
  printf '%s' "$entry" >> "$tmp_models"
  model_count=$((model_count + 1))
done

# Python deps (pip-licenses if present, else best-effort list).
tmp_py="$(mktemp)"
trap 'rm -f "$tmp_models" "$tmp_py"' EXIT
if command -v pip-licenses >/dev/null 2>&1; then
  pip-licenses --format=json --with-urls >"$tmp_py" 2>/dev/null || echo '[]' >"$tmp_py"
else
  echo '[]' >"$tmp_py"
fi

{
  printf '{'
  printf '"build_sha":"%s",' "$BUILD_SHA"
  printf '"generated_at":"%s",' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '"models":['
  cat "$tmp_models"
  printf '],'
  printf '"python_deps":'
  cat "$tmp_py"
  printf '}\n'
} > "$OUT"

if [[ "$failed" -ne 0 ]]; then
  echo "[model-bom] one or more model entries failed validation" >&2
  exit 2
fi

echo "[model-bom] wrote $OUT ($model_count models)"
exit 0
