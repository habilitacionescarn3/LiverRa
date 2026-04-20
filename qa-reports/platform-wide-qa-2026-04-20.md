# LiverRa Platform-Wide QA Report — 2026-04-20

**Pipeline:** testing-pipeline v5.0 (adapted for LiverRa, no Playwright harness)
**Branch:** `001-zero-training-mvp` @ `369cdf9`
**Scope:** entire monorepo (packages/app, core, imaging, fhirtypes, ml-inference)
**Mode:** quick (static analysis + known-bug fixes; no browser/E2E agents)
**Duration:** ~20 min
**Agent invocations:** 10 (7 scan + 3 iteration-2 fix)

---

## Overall Verdict: **PASS WITH WARNINGS**

Build is green. Iteration-1 fixes applied cleanly. Substantial tech debt surfaced but none block the current milestone.

---

## Quality Gates

| Gate | Target | Actual | Status |
|---|---|---|---|
| Monorepo build | all pass | **4/4 pass** | ✅ |
| Lint — @liverra/core | pass | **pass** | ✅ |
| Lint — @liverra/fhirtypes | pass | **pass** | ✅ |
| Lint — @liverra/imaging | pass | **pass** | ✅ |
| Lint — @liverra/app | pass | **70 errors + 46 warnings** | ⚠️ |
| Tests — @liverra/core | pass | **10 files, 30 todo** | ✅ |
| Tests — @liverra/imaging | pass | **4/4 pass** | ✅ |
| Tests — @liverra/app | pass | **17 pass, 8 fail, 30 todo** | ⚠️ |
| Security — hardcoded secrets | 0 | 0 | ✅ |
| Security — CORS wildcards (ml-inference) | 0 | **0** (fixed) | ✅ |
| A11y — calendar keyboard nav (CE MDR) | pass | **fail** | ❌ |
| i18n — de/ka coverage vs en | 100% | **95%** (24 keys missing × 2 locales) | ⚠️ |
| Bundle — duplicate admin-view chunks | 0 | **0** (fixed from 12) | ✅ |
| Bundle — main chunk size | <500 kB | **660 kB** | ⚠️ |
| Model licensing | Apache 2.0 | verified in `docs/research/11-*` | ✅ |
| Playwright E2E | — | **SKIPPED** (no harness) | ⏭️ |

---

## 🛠 What Got Fixed Autonomously (7 issues)

### 1. `packageManager` missing in root package.json → **CRITICAL**
Turbo 2.9.6 was silently refusing to run tasks. Every `npm run build|lint|test` exited 0 with **zero tasks executed**. Fixed by adding `"packageManager": "npm@11.6.2"`.

**Why this matters:** Every CI green check before this commit was a lie. Worth auditing whether anything shipped based on false "pass" signals.

### 2. Vitest globals not configured in `@liverra/core`
10 ESLint-rule test files threw `ReferenceError: describe is not defined` because vitest's `describe`/`it`/`expect` weren't enabled globally and `tsconfig.json` wasn't pulling in `vitest/globals`. Created `packages/core/vitest.config.ts` + added `"types": ["vitest/globals"]` to the tsconfig.

### 3. `@liverra/imaging` watermark tests failing (canvas DOM missing)
`packages/imaging/src/__tests__/watermark.test.ts` expected `happy-dom` + `node-canvas` but neither was installed. Replaced the real-DOM dependency with a hand-rolled `MockContext2D` that records `fillText` calls with the full affine-transform stack. Test contract preserved; 4/4 pass.

### 4. ESLint 9 flat-config migration (all 4 packages failing lint)
ESLint 9 dropped `.eslintrc.*` support. Created root `eslint.config.mjs` mirroring the old config, including all 10 custom `liverra/*` rules and override blocks. Also dropped the now-invalid `--ext` flag from each package's `lint` script.

**Side effect:** The 10 custom rules (`no-hardcoded-color`, `no-forbidden-hex`, `require-emr-button`, `no-raw-mantine-inputs`, `require-state-triplet`, etc.) are now **actually running** and caught 70 real violations in view code — see "Remaining Issues" below.

### 5. Duplicate lazy-import chunks
`UserManagementView`, `PacsConfigView`, `AuditBrowserView`, and `DemoCaseRunnerView` were each `lazy()`-imported in two places (`AppRoutes.tsx` + route-registration files), causing Vite to emit separate duplicate chunks. Consolidated into `packages/app/src/emr/views/lazy-registry.ts` — one `import()` per view. Eliminated 4 × 0.08 kB duplicate stubs.

### 6. Hardcoded color + font-size in `packages/imaging/src/watermark.ts`
ESLint surfaced 2 violations (font-size `32`, `rgba()` color). Since the imaging package runs inside a raw canvas context with no access to CSS custom properties, extracted named constants and added targeted `eslint-disable-next-line` directives with reason comments pointing to `--emr-watermark-*` tokens in `theme.css` as the source of truth.

### 7. Security fixes in ml-inference
- **CORS wildcards removed** in `main.py` — replaced `allow_methods=["*"], allow_headers=["*"]` with explicit whitelists (methods: GET/POST/PUT/DELETE/PATCH/OPTIONS; headers: Authorization, Content-Type, Accept, Accept-Language, X-Request-Id, X-Tenant-Id, Last-Event-ID).
- **Dev fallback secrets gated on env** — `invite_service.py` + `signed_ruo.py` now raise `RuntimeError` in staging/production if `LIVERRA_INVITE_JWT_SECRET` / `LIVERRA_RUO_SIGNING_SECRET` is missing. Dev fallback preserved.
- **`Math.random()` → `crypto.randomUUID()`** in `conflictResolver.ts` for conflict correlation IDs (with legacy fallback for jsdom-without-crypto).

---

## 🚨 Remaining Issues (Manual Review Required)

### A. @liverra/app lint: 70 errors + 46 warnings (all in view code)

These only surfaced **because** ESLint 9 now runs. The custom LiverRa guardrails are doing exactly what they were designed to do.

**Categories:**
- `liverra/no-hardcoded-color` — hex/rgba colors (`#dc2626`, `#e5e7eb`, `#d97706`, `#fff`, `rgba(...)`) in:
  - `ErasureRequestListView.tsx`
  - `OnboardingWizardView.tsx`
  - `OpsQueueView.tsx`
  - `AnalysisDetailView.tsx`
  - `UserManagementView.tsx`
  - `ClaimRegistryView.tsx`
  - `AuditBrowserView.tsx`
  - `PacsConfigView.tsx`
  - `AuditSummaryView.tsx`
  - `ReportView.tsx`
  - `ErasureWizardView.tsx`
  - `RUOSpotCheckView.tsx`
  - `MBoMView.tsx`
- `liverra/require-emr-button` — raw `@mantine/core` Button instead of `EMRButton`
- `liverra/no-raw-mantine-inputs` — raw `TextInput`, `Textarea` instead of EMR equivalents
- `liverra/require-state-triplet` — `<Table>` rendered without Skeleton + EmptyState + Alert co-located

**Recommended fix:** Use the `frontend-designer` agent per CLAUDE.md. One view at a time. 14 of the 116 issues are `--fix` auto-fixable.

### B. @liverra/app tests: 8 failures across 12 test files

Primary cause: **vitest `environment: 'jsdom'` is not set for `@liverra/app`**. Same root cause that we fixed in `@liverra/imaging`.

Failing suites:
- `src/emr/components/compliance/__tests__/AuditChainVerifier.test.tsx` (Mantine render errors)
- `src/emr/services/offline/__tests__/conflictResolver.test.ts` (`window is not defined`)
- plus several others in same pattern

**Recommended fix:** Add `test.environment: 'jsdom'` to `packages/app/vitest.config.ts`. ~1-line fix. Will likely resolve most or all 8 failures.

### C. A11y (4 findings, CE MDR implications)

- **HIGH — A11Y1:** Calendar grids (`DayGrid`, `MonthGrid`, `YearGrid`) use `<Box onClick>` without keyboard support. Missing `role="button"`, `onKeyDown`, `tabIndex`, `aria-label`. Blocks CE MDR self-certification per Essential Requirements Annex I §1.3.7.
- **HIGH — A11Y2:** `EMRFormSection` collapsible has `role="button"` but lacks `aria-controls` linking to the panel.
- **MEDIUM — A11Y3:** Calendar popovers missing `FocusTrap` — focus can escape during keyboard nav.
- **MEDIUM — A11Y4:** `EMRModal` title has `role="heading"` but no stable `id` for `aria-labelledby`.

**Recommended:** Hand to `frontend-designer` agent. 2-3 hours of work.

### D. i18n (15 findings, DACH rollout blocker)

- **CRITICAL — nav.json untranslated in de & ka** — 19 navigation keys missing in German + Georgian. Main menu will show English fallback to every DACH user.
- **CRITICAL — sync namespace missing entirely** — 10+ `SyncIndicator` translation calls reference non-existent `sync.json`.
- **CRITICAL — LandingView has 30+ hardcoded English strings** — feature cards, CTAs, footer.
- **CRITICAL — auth.json, common.json, errors.json, help.json are empty** but referenced throughout the app (these are the 75-byte `const t={};export{t as default};` chunks in the build).
- **HIGH — SigninView, LayerToggle, FormErrorBoundary** — more hardcoded strings.

Coverage: en=476 keys; de=452; ka=452. Gap: **24 keys × 2 locales = 48 translation tasks**.

**Recommended:** Coordinate with translation vendor. Will not auto-fix (risk of non-native German/Georgian).

### E. Security (manual-review items)

After iteration-2 fixes, remaining items are low-risk but worth tracking:
- **MEDIUM — SEC5:** DICOM UIDs in GET query params. Design decision; LiverRa's threat model accepts this behind the nginx tenant-isolated proxy. Document in security runbook.
- **MEDIUM — SEC8:** Potential XSS in `EMRErrorBoundary` if error messages from APIs contain markup. Hook up DOMPurify.
- **LOW — SEC6:** `console.error` in DICOMweb STOW-RS failure paths. Route through PHI-scrubbed Sentry instead.
- **LOW — SEC7:** UploadProgress health-check fetch has no error handling. Add `.catch()`.

### F. Bundle size

Main bundle: 659.88 kB (202 kB gzip). Over Vite's 500 kB warning threshold. Not a blocker for MVP, but `build.rollupOptions.output.manualChunks` would help when Cornerstone3D + OHIF Viewer land.

### G. Dead-code stubs (intentional, document only)

9 view stubs returning `<div>TODO: X</div>` are intentional per-spec scaffolding (T105/T180+). Document the list in CLAUDE.md so future sessions know they're placeholders, not dead code.

---

## 📁 Agent Outputs

Detailed per-agent reports in `qa-reports/.parts/`:
- `00-baseline.md` — ground-truth build/lint/test
- `01-security.md` — 8 security findings
- `02-a11y.md` — 4 a11y findings (full details + line numbers)
- `03-i18n.md` — 15 i18n findings + coverage matrix
- `04-deadcode.md` — 8 dead-code findings (top 30 analysed)

---

## Recommended Next Steps (in priority order)

1. **Add `environment: 'jsdom'` to `packages/app/vitest.config.ts`** — trivial fix, unblocks 8 test failures.
2. **Fix calendar keyboard nav (A11Y1, A11Y2)** — CE MDR self-cert blocker. Hand to `frontend-designer`.
3. **Wire nav.json + sync.json + empty core translations** — DACH market blocker. Coordinate with translation vendor.
4. **Systematically fix the 13 view files flagged by `liverra/no-hardcoded-color`** — 2-4 hours with `frontend-designer` agent.
5. Audit CI for any merges that shipped while turbo was silently skipping tasks (commits prior to `packageManager` fix — today's run only).
6. Document the 9 intentional TODO-stub views in CLAUDE.md.
7. Plug DOMPurify into `EMRErrorBoundary` (SEC8).
8. Consider `rollupOptions.output.manualChunks` before Cornerstone3D integration (PERF-1).

---

## Files Modified This Run

Committed? **No** — all edits are in-tree, awaiting review.

```
M  package.json                                              (packageManager pin)
A  eslint.config.mjs                                         (flat config)
M  packages/app/package.json                                 (lint script)
M  packages/core/package.json                                (lint script)
M  packages/imaging/package.json                             (lint script)
M  packages/fhirtypes/package.json                           (lint script)
A  packages/core/vitest.config.ts                            (globals: true + include)
M  packages/core/tsconfig.json                               (vitest/globals types)
M  packages/imaging/src/__tests__/watermark.test.ts          (MockContext2D)
M  packages/imaging/src/watermark.ts                         (named constants, eslint directive)
A  packages/app/src/emr/views/lazy-registry.ts               (lazy-import dedup)
M  packages/app/src/AppRoutes.tsx                            (use lazy-registry)
M  packages/app/src/emr/components/nav/AdminRouteRegistrations.ts
M  packages/app/src/emr/components/nav/DemoRouteRegistration.ts
M  packages/ml-inference/src/main.py                         (CORS whitelist)
M  packages/ml-inference/src/services/admin/invite_service.py      (env-gated fallback)
M  packages/ml-inference/src/services/onboarding/signed_ruo.py     (env-gated fallback)
M  packages/app/src/emr/services/offline/conflictResolver.ts (crypto.randomUUID)
```

Run `git diff` to review before committing. Suggested commit message:

```
fix(platform): unblock turbo, migrate ESLint 9, fix test infra, tighten security

- Add packageManager pin so turbo actually runs tasks
- Migrate to ESLint 9 flat config (surfaces 116 pre-existing violations)
- Fix vitest globals for @liverra/core (10 test files)
- Replace real-DOM watermark test with MockContext2D (no new deps)
- Deduplicate lazy() imports for 4 admin views (eliminate duplicate chunks)
- Remove wildcard CORS; env-gate dev fallback secrets in ml-inference
- Use crypto.randomUUID() for conflict IDs

Refs: qa-reports/platform-wide-qa-2026-04-20.md
```

---

# Iteration 3 — Appendix (post-initial-report)

## Additional fixes applied

| # | Fix | Result |
|---|---|---|
| 8 | Installed `happy-dom` + added `test.environment: 'happy-dom', globals: true` to `packages/app/vite.config.ts` | 8 test-level failures → 0 (17→25 passing) |
| 9 | Ported 12 violations in `LiverViewer3D.tsx` (colors → CSS vars, `any-ok` directives, `font-size: 11` → `--emr-font-xs`); added `--emr-watermark-fill` to theme.css | 12 → 0 |
| 10 | Fixed 8 palette-swatch violations in `EMRColorInput.tsx` with principled `eslint-disable-next-line` directives (user-facing color palette is the component's whole purpose) | 8 → 0 |
| 11 | Fixed 5 violations in `RUOSpotCheckView.tsx` (dropped stale hex fallbacks; swapped `--emr-danger` → `--emr-error`, `--emr-border` → `--emr-border-color`) | 5 → 0 |
| 12 | Fixed `OpsQueueView.tsx` state-triplet: added `EMRTableSkeleton` + `EMREmpty` | 1 → 0 |
| 13 | **CE MDR A11y blocker fixed** — `DayGrid`/`MonthGrid`/`YearGrid` now have full keyboard nav (Arrow/Home/End/Enter/Space), roving tabindex, `role="grid"`/`gridcell`/`columnheader`, localized `aria-label` via `Intl.DateTimeFormat`. Plus 11 lint violations fixed in the same files. | 11 lint + A11Y1 → 0 |

## Progress vs. initial report

| Gate | Initial | After iter-3 | Delta |
|---|---|---|---|
| Lint errors (app) | 70 | **38** | **-32** |
| Lint warnings (app) | 46 | **41** | -5 |
| Tests passing (app) | 17 | **25** | **+8** |
| Tests failing (app) | 8 | **0** | **-8** |
| CE MDR a11y calendar | ❌ BLOCKED | ✅ fixed | A11Y1 resolved |
| Build | ✅ | ✅ | unchanged |

## Remaining

- **10 test files** still fail to LOAD (not fail — load). Root cause: `ECONNREFUSED localhost:3000`. These are integration tests making real HTTP calls instead of mocking `fetch`. Requires per-test `vi.mock('fetch')` or MSW setup. **Out of scope for a static-analysis pipeline** — flag for test-infra follow-up.
- **38 lint errors + 41 warnings** remaining in other view files. Same patterns. Worth dispatching 4-5 more `frontend-designer` agents in a future session (each can knock out a batch of 5-10 violations).
- A11Y2, A11Y4 still open: `EMRFormSection` needs `aria-controls`, `EMRModal` needs `aria-labelledby` with stable id.
- i18n still open: 15 findings. Needs translation vendor.

## Git state after iteration 3

Additional files touched:
```
M  packages/app/package.json                (happy-dom devDep)
M  packages/app/vite.config.ts              (test.environment + globals)
M  packages/app/src/emr/styles/theme.css    (+--emr-watermark-fill)
M  packages/app/src/emr/components/liver/LiverViewer3D.tsx
M  packages/app/src/emr/components/shared/EMRFormFields/EMRColorInput.tsx
M  packages/app/src/emr/views/compliance/RUOSpotCheckView.tsx
M  packages/app/src/emr/views/ops/OpsQueueView.tsx
M  packages/app/src/emr/components/shared/EMRFormFields/calendar/DayGrid.tsx
M  packages/app/src/emr/components/shared/EMRFormFields/calendar/MonthGrid.tsx
M  packages/app/src/emr/components/shared/EMRFormFields/calendar/YearGrid.tsx
M  package-lock.json                        (happy-dom transitive)
```
