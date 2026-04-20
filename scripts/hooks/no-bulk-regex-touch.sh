#!/usr/bin/env bash
# no-bulk-regex-touch — pre-commit hook
#
# Rejects commits touching >3 files with identical line-level diffs.
# MediMind regression: 377 files corrupted by a regex find-and-replace.
#
# STUB: exits 0 until the real diff-analysis logic lands (Phase 2).
# Real implementation plan:
#   1. git diff --cached --numstat -> collect staged files
#   2. for each pair of files, diff their cached patches
#   3. if >3 files share the same normalized line-level delta, fail
set -euo pipefail

# TODO(phase-2): implement identical-diff-detection algorithm.
# See plan.md §Guardrail lint rules → liverra/no-bulk-regex-touch.

echo "[no-bulk-regex-touch] stub — always passes (real logic pending)"
exit 0
