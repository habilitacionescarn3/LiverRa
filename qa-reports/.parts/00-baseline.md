# 00 — Ground-Truth Baseline (build + lint + test)

## Verdict: FAIL

Concrete platform bugs captured from `npm run build | lint | test` on 2026-04-20.

## Operation Coverage
| Operation | Attempted | Passed | Failed |
|---|---|---|---|
| build | 4 pkgs | 4 | 0 |
| lint | 4 pkgs | 0 | 4 |
| test | 2 pkgs | 0 | 2 (core, imaging) |

## Findings

#### FINDING: [BUILD-1] Missing packageManager field
- **severity**: CRITICAL (already fixed mid-run)
- **file**: package.json
- **line**: 8
- **description**: Turbo 2.9.6 refuses to enumerate workspaces without `packageManager` field. `build`/`lint`/`test` all exited 0 with zero tasks executed — silent failure.
- **fix**: Added `"packageManager": "npm@11.6.2"` at line 9.
- **status**: FIXED

#### FINDING: [LINT-1] ESLint 9 flat-config missing in all packages
- **severity**: HIGH
- **file**: packages/app, packages/core, packages/imaging, packages/fhirtypes
- **description**: ESLint 9.39.4 errors in every package: "couldn't find an eslint.config.(js|mjs|cjs) file". Root has `.eslintrc.cjs` (legacy format). No flat configs exist.
- **suggestedFix**: Create `eslint.config.mjs` at root (or per package) using flat-config format, or pin `eslint` to ^8.x and keep `.eslintrc.cjs`.

#### FINDING: [TEST-1] Vitest globals not enabled in @liverra/core
- **severity**: HIGH
- **file**: packages/core/eslint-plugin-liverra/rules/__tests__/*.test.ts
- **line**: 5 (all 10 files)
- **description**: All 10 test files use `describe()`/`it.todo()` without importing from vitest. `ReferenceError: describe is not defined`.
- **suggestedFix**: Either set `test.globals: true` in `packages/core/vitest.config.ts`, OR add `import { describe, it } from 'vitest'` to each test file.

#### FINDING: [TEST-2] Watermark test canvas mock broken
- **severity**: HIGH
- **file**: packages/imaging/src/__tests__/watermark.test.ts
- **line**: 107
- **description**: 3/3 watermark tests fail. Canvas mock at line 26-27 sets `.width`/`.height` but test at 107:20 expects different behavior.
- **suggestedFix**: Needs inspection of actual test + watermark implementation.

#### FINDING: [PERF-1] Large main bundle (659 kB)
- **severity**: LOW
- **file**: packages/app/dist/assets/index-*.js
- **description**: Main chunk 659.88 kB (202 kB gzip). Vite warns about chunks >500 kB. Also observed: many tiny duplicate chunks (`auth-*.js` x3, `help-*.js` x3, `ops-*.js` x3 all 0.08 kB) suggesting barrel-export duplication at route split boundaries.
- **suggestedFix**: Use `build.rollupOptions.output.manualChunks` to group vendor chunks; inspect duplicate barrel re-exports.
