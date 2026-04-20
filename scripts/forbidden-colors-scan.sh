#!/usr/bin/env bash
# T378 — forbidden-colors-scan.sh
#
# Plain-English:
#   Scans all TypeScript, TSX, CSS, and CSS-module files in packages/app/src
#   for hard-coded hex colors that are explicitly banned by the unified
#   color system (CLAUDE.md §Unified Color System). If any of the forbidden
#   hexes appear outside theme.css, the build fails.
#
#   Forbidden:
#     - Tailwind blues: #3b82f6, #60a5fa, #2563eb
#     - Facebook blue : #4267B2
#
#   Why these specifically? They're the default-blues our team kept reaching
#   for in past projects — they clash with the LiverRa primary gradient and
#   fail contrast ratios in dark mode. All colors must resolve through CSS
#   variables declared in packages/app/src/emr/styles/theme.css.
#
#   theme.css is excluded because it is the single source of truth for the
#   palette and is allowed to declare any literal hex it needs.
#
# Exit codes:
#   0 — clean
#   1 — at least one forbidden hex found
#   2 — invocation error
#
# Usage:
#   ./scripts/forbidden-colors-scan.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_ROOT="${REPO_ROOT}/packages/app/src"

if [ ! -d "${SCAN_ROOT}" ]; then
  echo "[forbidden-colors-scan] ERROR: ${SCAN_ROOT} does not exist" >&2
  exit 2
fi

# Case-insensitive match (hex literals may appear as #3B82F6 or #3b82f6).
# ERE pattern: anchored by `#`, then one of the four forbidden codes.
FORBIDDEN_RE='#(3[bB]82[fF]6|60[aA]5[fF][aA]|2563[eE][bB]|4267[bB]2)'

# grep returns 1 when no match; we want to INVERT that — finding nothing is
# success. We exclude theme.css by path and also exclude node_modules / dist
# just in case someone runs this without turbo having cleaned those up.
matches=$(grep -REn "${FORBIDDEN_RE}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.css' \
  --include='*.module.css' \
  --include='*.scss' \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=.turbo \
  --exclude='theme.css' \
  "${SCAN_ROOT}" || true)

if [ -n "${matches}" ]; then
  echo "[forbidden-colors-scan] FAIL — forbidden hex colors detected:"
  echo
  echo "${matches}"
  echo
  echo "Use CSS variables from packages/app/src/emr/styles/theme.css instead."
  echo "See CLAUDE.md §Unified Color System for the approved palette."
  exit 1
fi

echo "[forbidden-colors-scan] OK — no forbidden hex colors found in ${SCAN_ROOT}"
exit 0
