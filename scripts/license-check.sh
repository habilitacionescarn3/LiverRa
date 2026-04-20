#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# license-check.sh — upstream LICENSE drift detector (T136, FR-038).
#
# Plain-English:
#   For every model listed in MBoM.json we fetch the upstream LICENSE
#   file at the pinned commit SHA, compute its sha256, and compare
#   against the license_text_hash we recorded at integration time.
#   Any mismatch is a "licence drift" — upstream changed the licence
#   since our last review — and blocks the build per FR-038 until a
#   human re-verifies.
#
# Required tools: jq, shasum, curl.
# Exit 0 on clean, 1 on any drift.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MBOM="$REPO_ROOT/MBoM.json"

if [[ ! -f "$MBOM" ]]; then
  echo "[license-check] MBoM.json not found — run scripts/model-bom.sh first" >&2
  exit 1
fi

for tool in jq shasum curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[license-check] required tool missing: $tool" >&2
    exit 2
  fi
done

# Convert a source_url + pinned_sha into a raw LICENSE URL.
raw_url() {
  local src="$1" sha="$2"
  # GitHub:  https://github.com/{org}/{repo}
  if [[ "$src" =~ ^https://github.com/([^/]+)/([^/]+)/?$ ]]; then
    local org="${BASH_REMATCH[1]}" repo="${BASH_REMATCH[2]}"
    # Try both LICENSE (no extension) and LICENSE.md at that commit.
    echo "https://raw.githubusercontent.com/$org/$repo/$sha/LICENSE"
    return
  fi
  # Fall-back: append /raw/$sha/LICENSE (works for most forges).
  echo "${src%/}/raw/$sha/LICENSE"
}

drift=0
checked=0

jq -c '.models[]' "$MBOM" | while read -r row; do
  name="$(echo "$row" | jq -r '.model_name')"
  src="$(echo "$row" | jq -r '.source_url')"
  sha="$(echo "$row" | jq -r '.pinned_commit_sha')"
  expected="$(echo "$row" | jq -r '.license_text_hash')"

  if [[ -z "$src" || -z "$sha" || -z "$expected" || "$expected" == "null" ]]; then
    echo "[license-check] $name — missing fields, skipping" >&2
    continue
  fi

  url="$(raw_url "$src" "$sha")"
  tmpfile="$(mktemp)"
  if ! curl -fsSL "$url" -o "$tmpfile" 2>/dev/null; then
    # Retry with LICENSE.md fallback.
    url_md="${url}.md"
    if ! curl -fsSL "$url_md" -o "$tmpfile" 2>/dev/null; then
      echo "[license-check] FAIL: $name — could not fetch LICENSE from $url" >&2
      drift=$((drift + 1))
      rm -f "$tmpfile"
      continue
    fi
  fi
  actual="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
  rm -f "$tmpfile"

  if [[ "$actual" != "$expected" ]]; then
    echo "[license-check] DRIFT: $name" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  url:      $url" >&2
    drift=$((drift + 1))
  else
    checked=$((checked + 1))
  fi
done

# Note: the while-read subshell hides the `drift` variable. We re-derive
# it from the exit code of a second pass using a tempfile counter.
counter="$(mktemp)"
trap 'rm -f "$counter"' EXIT
echo 0 > "$counter"

while read -r row; do
  name="$(echo "$row" | jq -r '.model_name')"
  src="$(echo "$row" | jq -r '.source_url')"
  sha="$(echo "$row" | jq -r '.pinned_commit_sha')"
  expected="$(echo "$row" | jq -r '.license_text_hash')"
  [[ -z "$src" || -z "$sha" || -z "$expected" || "$expected" == "null" ]] && continue

  url="$(raw_url "$src" "$sha")"
  tmpfile="$(mktemp)"
  if ! curl -fsSL "$url" -o "$tmpfile" 2>/dev/null; then
    url_md="${url}.md"
    if ! curl -fsSL "$url_md" -o "$tmpfile" 2>/dev/null; then
      echo $(( $(cat "$counter") + 1 )) > "$counter"
      rm -f "$tmpfile"
      continue
    fi
  fi
  actual="$(shasum -a 256 "$tmpfile" | awk '{print $1}')"
  rm -f "$tmpfile"
  if [[ "$actual" != "$expected" ]]; then
    echo $(( $(cat "$counter") + 1 )) > "$counter"
  fi
done < <(jq -c '.models[]' "$MBOM")

final_drift="$(cat "$counter")"
if [[ "$final_drift" -gt 0 ]]; then
  echo "[license-check] FAIL: $final_drift drifted licence(s) detected" >&2
  exit 1
fi

echo "[license-check] OK — all upstream licences match MBoM hashes"
exit 0
