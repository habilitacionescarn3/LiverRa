#!/usr/bin/env bash
# no-handedit-gen.sh — reject hand edits to `*.gen.ts` files.
#
# Plain-language: code-generated files (types from OpenAPI, permissions, etc.)
# must be regenerated, not hand-edited. This hook fails the commit if it
# touches any `*.gen.ts` file unless the contract source that drives it was
# also updated in the same commit.
#
# Wired from .pre-commit-config.yaml hook `no-handedit-gen-files` (T075).
set -euo pipefail

# List staged files. Pre-commit also passes filenames as $@, but we re-query
# git so the logic works identically when invoked manually.
staged="$(git diff --cached --name-only)"

gen_files="$(echo "$staged" | grep -E '\.gen\.ts$' || true)"
if [[ -z "$gen_files" ]]; then
  exit 0
fi

# Contract sources that legitimately cause `.gen.ts` regeneration.
contract_changed="$(echo "$staged" | grep -E '(contracts/api-openapi\.yaml|matrix\.yaml)$' || true)"
if [[ -n "$contract_changed" ]]; then
  exit 0
fi

cat >&2 <<EOF
ERROR: Hand edit to generated file(s) detected:

$gen_files

Generated files (*.gen.ts) must only change alongside their contract source.
Run the appropriate regenerator instead:

  npm run generate:openapi-client      # for api-schema.gen.ts
  npm run generate:permissions         # for permissions.gen.ts / permissions_gen.py
  npm run generate:fhir-types          # for fhirtypes/src/gen/**

If you genuinely need to bypass (e.g. merge conflict resolution), run:

  git commit --no-verify

…and flag it in the PR description.
EOF
exit 1
