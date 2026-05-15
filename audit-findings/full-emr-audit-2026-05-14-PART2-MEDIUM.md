# Full EMR Audit — 2026-05-14 — PART 2: MEDIUM

> **Pointers:** BLOCKER / CRITICAL / HIGH findings + cross-cutting issues live in [`full-emr-audit-2026-05-14-PART1-BLOCKER-CRITICAL-HIGH.md`](./full-emr-audit-2026-05-14-PART1-BLOCKER-CRITICAL-HIGH.md). LOW + TRIVIAL bulk counts live in [`full-emr-audit-2026-05-14-PART3-LOW-TRIVIAL.md`](./full-emr-audit-2026-05-14-PART3-LOW-TRIVIAL.md).

**Audit area:** full (whole monorepo) · **Agents:** 24 · **Date:** 2026-05-14

## Grand Summary — MEDIUM counts per area

| Area | MEDIUM |
|------|-------:|
| Wave 0 — Dependencies | 5 |
| Wave 0 — Unit Tests | 4 |
| PACS | 6 |
| Cases | 8 |
| Cascade | 5 |
| Inference | 4 |
| Clinical Algorithms | 5 |
| ACR Readout | 6 |
| Refinement | 4 |
| Audit & Compliance | 3 |
| Design System | 8 |
| i18n core | 6 |
| Auth & Settings | 4 |
| Schema | 5 |
| Wave 2 — FHIR Validator | 4 |
| Wave 2 — Security | 2 |
| Wave 2 — i18n Quality | 2 |
| Wave 2 — UI/UX | 10 |
| Sweep — Catch Blocks | 8 |
| Sweep — Optimistic Locking | 6 |
| Sweep — Test Quality | 6 |
| Sweep — Type Safety | 3 |
| Sweep — React Hooks | 6 |
| Sweep — i18n Literals | 6 |
| **TOTAL (raw, pre-dedup)** | **126** |
| **TOTAL (canonical, post-dedup)** | **102** |

---

## MEDIUM Findings

### Wave 0 — Dependencies (Agent 01)

#### M-DEP-1 — Mantine 7.17.8 → 9.2.0 (two major versions behind)
- **Dimension:** D9 | **File:** `packages/app/package.json:18-21`
- Plan a "Mantine 7 → 9" sprint; coordinate with Vite + Vitest. Read v8 + v9 migration guides upfront.
- **ELI5:** Our UI library is two majors behind. Plan one sprint to do it cleanly.

#### M-DEP-2 — Vite 7.3.2 → 8.0.12 and Vitest 3.2.4 → 4.1.6
- **Dimension:** D9 | **File:** `packages/app/package.json:52-54`
- Order: Vite 8 → plugin-react 6 → vitest 4 → Mantine 9.

#### M-DEP-3 — Medplum types frozen at 3.3.0; migration off Medplum is ongoing
- **Dimension:** D9 | **File:** `packages/app/package.json:40-41`
- Decision-time. Either bump to 4.5.2 or finish migrating to `packages/fhirtypes/`. The codebase shouldn't pretend both.

#### M-DEP-4 — Sentry React 8.55 → 10.53 (two majors behind)
- **Dimension:** D2 | **File:** `packages/app/package.json:24`
- Sentry 9/10 added privacy controls. Review `beforeSend` / `beforeSendTransaction` for PHI scrubbing alignment.

#### M-DEP-5 — TypeScript 5.9.3 → 6.0.3
- **Dimension:** D9 | **File:** `package.json:34`
- Try TS 6 in a branch; take it if ≤10 issues, defer one quarter if 30+.

### Wave 0 — Unit Tests

#### M-UT-1 — useReviewSeat happy path test fails
- `packages/app/src/emr/hooks/__tests__/useReviewSeat.test.tsx:58` — `acquires a seat on the happy path` fails (likely mock-vs-implementation drift).

#### M-UT-2 — PDF watermark missing in ka/ru locales
- `packages/ml-inference/src/services/export/tests/test_pdf_watermark.py` — Georgian + Russian templates miss watermark. Inspect base-template inheritance.

#### M-UT-3 — Alembic reversibility test fails
- `packages/ml-inference/tests/migrations/test_alembic_reversibility.py` — `alembic history` reports zero migrations despite 13+ on disk. Likely cwd/path-resolution issue.

#### M-UT-4 — Frontend ACR section components have no individual tests
- 6 `ACRSection*.tsx` components (Liver/Vessels/Lesions/FLR/Spleen/Gallbladder + HeroCopyButton); service-level tests exist but component-level tests would catch React render regressions independent of the renderer.

### PACS

#### M-PACS-1 — `dicomParserService` parses every uploaded file on JS main thread — UI freezes
- D6 | `packages/app/src/emr/services/pacs/dicomParserService.ts` — 500+ files at ~5 ms parse = ~2.5s jank. Fix: move parsing to Web Worker.

#### M-PACS-2 — `dicomwebClient.stowInstances` rejects entire request on `DicomWebAuthError` — partial-upload state poisons retries
- D4 | `packages/app/src/emr/services/pacs/dicomwebClient.ts:357-371` — JWT expiry mid-upload causes "1 success, 499 unaccounted" with no resume. Fix: on auth error, refresh JWT silently and retry; if fails, surface typed `UploadInterrupted{successfulCount, remainingFiles}`.

#### M-PACS-3 — `PacsStudyViewerView.waitForEngine` polls every 50ms for up to 1s — silent race window
- D6 | `packages/app/src/emr/views/pacs/PacsStudyViewerView.tsx:236-246` — Slow CI machines exceed 1s; viewport unrendered with generic "Viewport was not initialized" error. Fix: expose `initCornerstone()` promise that resolves to the engine.

#### M-PACS-4 — `PACSErrorBoundary.componentDidCatch` logs raw `error` + `errorInfo` to console — error stack may contain DICOM tag fragments
- D10 | `packages/app/src/emr/components/pacs/PACSErrorBoundary.tsx:92-95` — Cornerstone errors include failing imageId. Fix: route through `captureException` and strip message to a category code.

#### M-PACS-5 — `auditService.logBreakGlass` retry loop has no exponential cap + no jitter — thundering herd on outage
- D6 | `packages/app/src/emr/services/pacs/auditService.ts:394-407` — Fix: add `± 250ms` jitter to each retry delay.

#### M-PACS-6 — Stub `console.warn` calls litter every PACS service — when persistence wires up, becomes a logging firehose
- D9 | 40+ occurrences across `imagingStudyService.ts`, `auditService.ts`, etc. Fix: centralize via single `phaseStubLog(serviceName, fn, args)` helper toggleable via flag.

### Cases

#### M-CASE-1 — CasesListView and AnalysisDetailView accept `auth` permission gate only at route boundary
- D2 | `AnalysisDetailView.tsx:174-192`, `CasesListView.tsx:192-260` — Data-fetching hooks issue raw fetch with no client-side permission check. Fix: `useHasPermission('analysis.view')` early-return.

#### M-CASE-2 — `LesionsPanelView` synthesizes degenerate bbox `[0,0,0,0,0,0]` when API has no bbox — viewer cannot recenter and reviewer doesn't know
- D3 | `LesionsPanelView.tsx:141-147` — Surface a UI badge "Position unknown" or extend `useLesions` to map `bbox3d`.

#### M-CASE-3 — `pickStageStat` falls back to `model_version` for unknown stages — leaks internal model identifiers into user-facing badge
- D7 | `CascadeStageTimeline.tsx:142-144` — Return `null` (no badge) for unknown stages; surface model version in expanded row only.

#### M-CASE-4 — Case detail does NOT expose FHIR DiagnosticReport / ImagingStudy references on screen — CE-MDR traceability artifact buried
- D5 | Entire `views/cases/` + `components/cases/` trees — Render DiagnosticReport reference once `report_id` exists; add "About this analysis" expandable.

#### M-CASE-5 — `AnalysisDetailView` is 1,082 lines (god component)
- D11 | `packages/app/src/emr/views/cases/AnalysisDetailView.tsx` — 16+ hooks. Fix: extract `useAnalysisDetailKeyboard()`, `useRailCollapse()`, `<AnalysisDetailHero>`, `<AnalysisDetailMobileSheets>`. Target <500 lines.

#### M-CASE-6 — `RefinementView` keyboard handler ESLint-disable suppression hides potential stale-id bug
- D6 | `RefinementView.tsx:178-182` — `seat.acquire` may have unstable identity. Fix: stabilize via `useEvent`/`useCallback`.

#### M-CASE-7 — Cascade timeline `useEffect` reset of `expanded` on status change ignores user intent
- D6 | `CascadeStageTimeline.tsx:177-180` — Comment promises behavior the code doesn't deliver (auto-resets on every status change). Fix: track explicit user toggle in a ref.

#### M-CASE-8 — `LesionsTabContent` inline `JSON.parse` silently treats parse errors as "no classification"
- D4 | `AnalysisDetailView.tsx:249-261` — Catch comment is literally `/* ignore */`. Reviewer can't tell "AI didn't run" from "data is corrupt." Fix: `logger.warn` + render "Parse error" pill.

### Cascade

#### M-CASCADE-1 — `volume_mm3 = voxel_count * np.prod(spacing_mm)` mixes mm³ with ml convention
- D6/numeric | `findings.py:385` — Future maintainer mixing scales is the bug; today's math is correct. Fix: rename `volume_mm3` to `volume_mm3_for_sphericity` with comment.

#### M-CASCADE-2 — `compute_couinaud` falls through on tiny bbox without raising — produces 0-voxel segments silently
- D4 | `couinaud_heuristic.py:188-192` — Surfaces only as warning, never raises; `flr_pct = 0.0` ships. Fix: when `non_empty < 4`, raise; mark `partial_result`.

#### M-CASCADE-3 — `demo_cascade` opens 8 separate Postgres connections in serial (4 inside per-lesion loop)
- D6 | `tasks/demo_cascade.py:127-249` — 12 connection setup/teardown per cascade. Fix: open one connection per task body.

#### M-CASCADE-4 — `cascade.py:117` STAGE_BUDGETS has stage_no=0 for ingest, mixed with cascade stages
- D3 | `orchestrator/cascade.py:115-125` — Benign today; future iteration may include ingest in the cascade soft-limit sum. Fix: comment documenting the convention.

#### M-CASCADE-5 — Couinaud sub-mask uploads happen serially (8 sequential S3 PUTs)
- D11 (perf-flavored) | `scripts/real_cascade.py:491-514` — ~5-10s cumulative latency. Fix: `concurrent.futures.ThreadPoolExecutor(max_workers=4)`.

### Inference

#### M-INFER-1 — `/health` endpoint does not load TS or run a one-voxel test
- D6/D10 | `ml-inference-gpu/main.py:40-46, 185-198` — Weights load on first call. Fix: add `_warm_cache` running TS on tiny synthetic CT during lifespan; cache duration in `/health` response.

#### M-INFER-2 — `infer_total_and_vessels` uses inconsistent ZIP extraction pattern vs `_post_and_extract`
- D9 | `inference_client.py:44-74` vs `:104-155` — Near-duplicate functions; safe path used in one, unsafe in the other (covered in C-INFER-2). Fix: extract `_post_for_zip` + `_extract_safe` helpers.

#### M-INFER-3 — Module-level `INFERENCE_URL` + `TIMEOUT_S` are frozen at import — env changes invisible
- D4/D6 | `inference_client.py:34-41` — Long-running Celery workers cache at boot. Fix: move env reads inside `_post_and_extract`.

#### M-INFER-4 — `1e6` for byte-to-MB conversion misreports by ~5% — should be `1024*1024` or `1 << 20`
- D9 | `ml-inference-gpu/main.py:108, 178, 179`; `inference_client.py:56, 72, 152` — `MAX_UPLOAD_BYTES = 500 * 1024 * 1024` (binary MiB); log strings use decimal `1e6`. Cosmetic but trips you up during incident triage.

### Clinical Algorithms

#### M-CLIN-1 — `_voxel_volume_ml` in findings.py multiplies spacing tuple positionally — order convention undocumented
- D3 | `findings.py:47-48` — Footgun for future refactor that switches NIfTI loader. Fix: docstring `(spacing_x, spacing_y, spacing_z) in millimeters` + assertion `assert all(0.1 < s < 10.0 for s in spacing_mm)`.

#### M-CLIN-2 — Steatosis HU thresholds are single-criterion; literature uses combined HU + liver-spleen Δ
- D10 | `findings.py:268-276` — Over-calls "severe" on iron-overload patients; under-calls when spleen missing. Fix: two-criterion grading; downgrade confidence with warning when delta unavailable.

#### M-CLIN-3 — `compute_steatosis` reads `hu_stats.get("mean", 0)` — malformed dict silently becomes "severe steatosis"
- D1 | `findings.py:247` — Fix: `liver_mean = hu_stats.get("mean"); if liver_mean is None: return None`.

#### M-CLIN-4 — LI-RADS classifier defaults to weak `metastasis` prior on no-rule-matched lesions — confidently reports "metastasis" with no clinical basis
- D10 | `lirads_classifier.py:166-172` — Even small priors produce 31% confidence on metastasis after softmax. Fix: add `top1_class = "indeterminate"` path when `max(scores.values()) < 1.0`.

#### M-CLIN-5 — `_wall_thickness_mm` returns `5 * in_plane` as fallback when no fluid interior reached
- D3 | `findings.py:100-116` — Caps measurement at 3.5mm on 0.7mm scans (real cholecystitis walls 4-10mm). Fix: track whether loop exited via inner-HU vs max-iter; return `"capped": True` flag.

### ACR Readout

#### M-ACR-1 — `clipboard_export_audit` route falls back to `uuid4()` for `actor_id` when `request.state.user` missing
- D2 | `packages/ml-inference/src/api/analysis.py:1460-1461` — Codepath unreachable today (decorator raises 401 first); becomes fail-open if decorator removed. Fix: explicit `if not user or not user.id: raise HTTPException(401)`.

#### M-ACR-2 — Clipboard idempotency check uses `LIKE '%"valueUuid": "<uuid>"%'` — brittle
- D9 | `clipboard_export_event.py:200-217` — Duplicate of B-AUDIT-2 plus LIKE-cannot-use-index performance concern. Fix: dedicated `client_action_id uuid` column with UNIQUE index.

#### M-ACR-3 — `useAcrCopyAction` swallows unknown-error toast `catch {}` with no logging
- D4 | `useAcrCopyAction.ts:129-135` — Bug in copy path shows generic retry toast and leaves no console trace. Fix: `console.error('[useAcrCopyAction]', err)` + `trackCopyFailed({...})` + EMRToast.

#### M-ACR-4 — Cosmetic NFC unicode test — input string is NOT actually decomposed
- D9 | `acrPlainTextRenderer.spec.ts:121-159` — `'á'` literal is NFC, not NFD. Test trivially passes (or contradicts itself). Fix: `const decomposed = 'a' + '́';`.

#### M-ACR-5 — `ACRStructuredReadout` is god-component (16 hooks)
- D11 | `ACRStructuredReadout.tsx:100-363` — Adopt `useAcrCopyAction` (drops 4 hooks); extract `useAcrPanelLifecycle(analysisId)` (drops 6). Target <140 lines.

#### M-ACR-6 — Migration 0014 documents `audit_event.category` as needing CHECK constraint but is a no-op marker
- D9 | `0014_audit_category_readout_clipboard_export.py` — Caller docs reference a constraint that doesn't exist. Fix: update CLAUDE.md to say "unconstrained text"; add comment to `audit_event` table.

### Refinement

#### M-REFINE-1 — `seat.acquire` retry button does not reset `acquireAttemptedRef` until clicked — silent first-load failure stays stuck
- D3 | `RefinementView.tsx:146-182, 353-356` — Transient acquire failure latches ref permanently. Fix: reset `acquireAttemptedRef.current = null` inside `.catch`.

#### M-REFINE-2 — Cleanup effect uses `eslint-disable-next-line react-hooks/exhaustive-deps` to suppress `seat` dep — stale-closure on seat handle
- D4/D6 | `RefinementView.tsx:180-182` — Suppression justified by comment but `seat.release` may be stale-captured. Fix: ref-pin via `releaseRef.current = seat.release`.

#### M-REFINE-3 — `RefinementView` is 709 lines (god component)
- D11 — 5 useState/8 useEffect/5 useCallback. Fix: extract `useRefinementSeatLifecycle`, `useRefinementKeyboardShortcuts`, `useOverlayFlash`, `useViewerClickDispatch`. Target <350 lines.

#### M-REFINE-4 — `LesionsPanelView.handleAddLesion` catch swallows actual error
- D4 | `LesionsPanelView.tsx:285-289` — Generic "something went wrong"; no console.warn, no Sentry, no `res.status` surface. Fix: `console.warn` + `Sentry.captureException`.

### Audit & Compliance

#### M-AUDIT-1 — No direct unit tests for `audit_event_emitter.py` (224 LOC)
- D9 | PHI scrub + Medplum-vs-chain order not regression-protected. Fix: `tests/test_audit_event_emitter.py` covering scrub failure raise, Medplum-no-id raise with FR-029b reference, chain failure propagation, happy path emits exactly one AuditEvent + one chain row in that order.

#### M-AUDIT-2 — No direct unit tests for `erasure/orchestrator.py` (403 LOC)
- D9 | `execute()` 6-step pipeline has zero coverage. Fix: `tests/test_orchestrator.py` covering happy path, partial failure in stage 2, partial failure in stage 6, idempotency on rerun.

#### M-AUDIT-3 — `_emit_audit` in crypto_shred logs alias (encodes tenant_id + study_id) on every failure path
- D10 borderline | `crypto_shred.py:213-225, 302-315` — Study UUID correlates with patient data via FHIR. Fix: log `tenant_id` only; replace `study_id` with `f"study:{sha256(study_id)[:12]}"`.

### Design System

#### M-DS-1 — `var(--emr-*, hex-fallback)` antipattern across CSS modules + inline styles (30+ sites)
- D7 | `theme.css:3801-3925` (21 instances), `SessionTimeoutModal.module.css` (8), `EMRBadge.module.css:37`, `EMRTabs.module.css:8` — Dead code that misleads + masks future regressions. Fix: bulk-strip the fallbacks.

#### M-DS-2 — `--emr-gray-N` used as backgrounds (Rule #6 — inverts in dark mode)
- D7 | `EMRTabs.module.css:8`, `emr-fields.css:361` + many cross-area instances — Tab tray loses visible boundary in dark mode. Fix: swap to `--emr-bg-hover` or `--emr-bg-page`.

#### M-DS-3 — EMRNotificationCenter bypasses EMRButton/EMRBadge wrappers + uses Mantine palette colors
- D7 | `EMRNotificationCenter.tsx:35-42, 288-295, 372` — Critical clinician alert surface; Mantine `red`/`orange` won't track brand swap. Fix: `<EMRButton variant="danger">`, `<EMRBadge variant="danger|warning">`.

#### M-DS-4 — EMRWizardStepper uses Mantine palette `color="blue"` + hardcoded English `aria-label="Next step"`
- D7/D8 | `EMRWizardStepper.tsx:134, 145` — Fix: `aria-label={t('common.nextStep', 'Next step')}`; drop `color="blue"`.

#### M-DS-5 — EMRFAB uses inline gradient instead of `--emr-gradient-secondary` token
- D7 | `EMRFAB.tsx:87` — `secondary: 'linear-gradient(135deg, var(--emr-secondary) 0%, var(--emr-accent) 100%)'` inlined; other variants use tokens. Fix: `secondary: 'var(--emr-gradient-secondary)'`.

#### M-DS-6 — TODO stubs in production-path component library (EMRErrorCard, EMRTableEmptyState)
- D9 | `EMRErrorCard.tsx:2-3`, `EMRTableEmptyState.tsx:2` — Stubs ship the wrong visuals into FailClosedErrorStates (regulator-visible surface). Fix: port full MediMind versions using EMRAlert + EMRButton.

#### M-DS-7 — FormErrorBoundary uses `var(--mantine-spacing-md)` (wrong token namespace)
- D9 | `FormErrorBoundary.tsx:126` — Bypasses LiverRa token system. Fix: `var(--emr-spacing-md)`.

#### M-DS-8 — LesionBadge dark-mode hex overrides write module-level overrides (Rule #5 violation)
- D7 | `LesionBadge.module.css:108-126` — 6 `:global([data-mantine-color-scheme='dark'])` blocks. Fix: promote dark variants into theme.css as semantic tokens (`--emr-lesion-malignant` etc.).

### i18n

#### M-I18N-1 — `de` and `ka` bundles ship 369 and 432 `__TODO_TRANSLATE__` markers (accumulated debt)
- D8 | `de/`, `ka/` — Above the 20-marker MEDIUM threshold. Fix: three parallel tracks (reportAcr first; analysis + pacs in CODEOWNERS batches; CI check that fails when marker count exceeds baseline).

#### M-I18N-2 — `nav.json` has 11 RU-missing keys loaded at app shell mount
- D8 | `ru/nav.json` — Nav is visible on every page. Fix: complete the 11 missing keys as highest-priority RU batch.

#### M-I18N-3 — `splitKey` namespace dispatch silently swallows keys with namespace prefix word containing dot
- D8/D3 | `TranslationContext.tsx:226-241` — Inconsistency between colon-form `'common:foo.bar'` and dot-form `'common.foo.bar'` when ns is `common`. Fix: collapse both forms to same behavior or document with unit tests.

#### M-I18N-4 — `loadBundle` silently caches an empty object on failure — masks broken namespaces for rest of session
- D4 | `TranslationContext.tsx:155-173` — Transient flake caches empty bundle forever until refresh. Fix: don't cache empty result on catch; allow retry on next call.

#### M-I18N-5 — Doc comments in both files claim "Russian dropped" — contradicts code and CLAUDE.md
- D9 | `localeService.ts:8`, `TranslationContext.tsx:8` — Future maintainer may "clean up" RU bundles. Fix: rewrite docstrings to match CLAUDE.md triad.

#### M-I18N-6 — Doc comment on `Locale` type contradicts itself in adjacent lines
- D9 | `TranslationContext.tsx:38-47` — Same file: header says "Russian dropped", inline says "Triad en/ru/ka". Fix: delete the stale header note.

### Auth & Settings

#### M-AUTH-1 — `_get_user_permissions` accepts both `getattr(user, 'permissions')` AND `user.get('permissions')`
- D9/D4 | `require_permission.py:151-157` — No canonical type; "either-or" pattern silently returns empty set on third branch. Fix: replace `request.state.user` with frozen dataclass `AuthenticatedUser(id, email, cognito_sub, permissions: frozenset[str], groups)`.

#### M-AUTH-2 — `ProtectedRoute.requires` uses AND semantics only — no `anyOf`
- D3 | `ProtectedRoute.tsx:62-67` — "Audit log" route should be visible to anyone with `audit.view` OR `compliance.view`. Fix: add `anyOf?: readonly LiverraPermission[]` prop.

#### M-AUTH-3 — `NotificationPreferencesView.handleToggle` setTimeout(...,300) without ref cleanup — fires after unmount
- D6/D4 | `NotificationPreferencesView.tsx:365-372` — React 19 warning. Fix: track timeout in `useRef<NodeJS.Timeout | null>`; clear in cleanup.

#### M-AUTH-4 — `ProfileView` is 1051 lines (god component)
- D11 | 9 sub-components, 8 useStates, 5 useCallbacks, 2 useEffects. Fix: extract `SectionCard`, `InfoTile`, `InlineBadge`, `SecurityRow`, `ThemeSwitcher` into `components/profile/`. Extract `useMfaReset`, `useRuoAccept` hooks. Target <400 lines.

### Schema

#### M-SCHEMA-1 — AnalysisStatus drift between TS (7 states) and Postgres CHECK (5 states)
- D5/D1 | `core/src/types/analysis.ts:18-27` vs `0002_study_series_analysis.py:85-89` — TS has `Succeeded`, `Expired`, `ImplausibleOutput` not in DB; DB has `completed` not in TS. Fix: reconcile in one migration; rename DB `completed` → `succeeded`; add `expired` and `implausible_output` to CHECK.

#### M-SCHEMA-2 — `Locale` type drift: tenant.ts (en/de/ka), user.locale_preference CHECK (en/de/ka), clipboard_export (en/ru/ka/de), CLAUDE.md (en/ru/ka)
- D5/D1 | Five sources of truth. Russian user can't be saved as `user.locale_preference = 'ru'` (CHECK fails). Fix: settle on `en/de/ka/ru` per actual coverage; CHECK update; shared `core/src/i18n/supported-locales.ts`.

#### M-SCHEMA-3 — Migration 0010 backfills `lesion.couinaud_location` alongside existing `couinaud_segment` — two columns for same concept
- D9/D1 | `0010_api_query_columns.py:77-85` — No NOT NULL, no CHECK ensuring agreement. Repeated 4× in this single migration. Fix: backfill v1 → v2; deprecate one side; add CHECK constraint requiring agreement.

#### M-SCHEMA-4 — Migration 0003 `classification` table has only `lesion_id` as PK — no soft-delete/versioning for re-classification
- D1/D3 | `0003_segmentation_lesion.py:80-91` — Every override silently overwrites. CE-MDR validation prefers history. Fix: add `created_at` + `version`; switch PK to `(lesion_id, version)`. OR `is_active boolean` + partial unique index.

#### M-SCHEMA-5 — `audit_event.payload jsonb DEFAULT '{}'::jsonb` and `actor_ref`/`target_ref` nullable text with no contract
- D5/D1 | `0005_audit_chain.py:35-44` — Two parallel audit tables with overlapping but non-identical fields. No documentation of which gets used when. Fix: document in column COMMENTs that `audit_event` is "side channel for trigger events" and `audit_event_chain` is "user-action chain."

### Wave 2 — FHIR Validator

#### M-FHIR-1 — Hardcoded accession-number identifier system URL
- D6 | `StudyManagementPanel.tsx:79`, `imagingStudyService.ts:183` — Not in `FHIR_SYSTEMS`. Fix: add `ACCESSION_NUMBER_SID` constant; import.

#### M-FHIR-2 — Hardcoded RBAC system URL
- D1 | `rbac/generator.py:356` — Not in `FHIR_SYSTEMS` or Python constants. Fix: add `ACCESS_POLICY_ROLE_CS`.

#### M-FHIR-3 — `audit-subtype` singular/plural CodeSystem URL drift
- D1/D2 | TS singular vs Python plural — Cross-stack chain verification will not match. Fix: declare once (prefer plural).

#### M-FHIR-4 — `audit-permission-checked` SD declares min=1 but emitters don't enforce
- D4 | `StructureDefinition-audit-permission-checked.json:24-25` vs `audit_event_emitter.py:170` — Validator will reject every event without this extension. Fix: either require `permission_key` at every call site OR relax SD to `min=0`.

### Wave 2 — Security

#### M-SEC-1 — No allowlist on `LIVERRA_INFERENCE_URL` — SSRF surface if env-var attacker-controlled
- D4 | `inference_client.py:34-36` — Combined with C-INFER-2 (ZIP-slip) = RCE chain. Fix: hostname/port allowlist; raise at boot.

#### M-SEC-2 — GPU `/health` endpoint leaks device/error info to anonymous callers
- D7/D11 | `ml-inference-gpu/main.py:185` — Combined with C-INFER-3 (no auth) = free reconnaissance. Fix: strip device name + error string from public response.

### Wave 2 — i18n Quality

#### M-I18NQ-1 — `ruo` namespace missing for ru (5 keys)
- D8 | `translations/ru/ruo.json` — RUO disclaimer falls back to English for ru.

#### M-I18NQ-2 — 17 hardcoded `toLocaleDateString()` calls without locale arg
- D8 | `components/pacs/*.tsx` (15 sites), `views/settings/ProfileView.tsx` (2) — Uses browser locale, not LiverRa active. Russian user on US-locale browser sees `5/14/2026` instead of `14.05.2026`. Fix: replace with `formatDate(x)` from `localeService.ts`.

### Wave 2 — UI/UX

#### M-UI-1 — `UserMenuButton.tsx` old-blue gradient as `var()` fallback (2 sites)
- D7 | `UserMenuButton.tsx:104, 129` — Duplicate of H-DS-5.

#### M-UI-2 — EMRTable wrapper code-side (3 raw `<Table>` uses)
- D7 | `UserManagementView.tsx:12`, `LiverraPacsTable.tsx:20`, `EMRSkeleton.tsx:5` — Real tables on production routes (admin + PACS). Fix: when EMRTable lands, port all 3.

#### M-UI-3 — Raw Mantine form-fields in feature components (9 sites)
- D7 | `StudyListFilters` (Button), `CoverageOverridePanel` (Switch), `ArrowAnnotateTextInput` (TextInput + Button), `DicomTagBrowser` (TextInput), `LayerTogglePanel` (Checkbox), `LiverViewer3D` (Button + Select) — Fix per-site swap to EMR* wrapper.

#### M-UI-4 — CSS modules with hardcoded hexes outside dark-locked PACS viewer
- D7 | `LesionBadge.module.css:73`, `CloudOfflineBanner.css:18,48`, `SegmentationPanel.css:15,61,66,67,88,97` — Some panels claim "dark-locked imaging" in comments but selectors apply in light mode too. Fix: scope inside `data-imaging-canvas="true"` or use `var(--emr-bg-modal)`.

#### M-UI-5 — No mobile-first responsive props in clinical views
- D7 | `span={{ base: N, md: N }}` pattern: 0 occurrences in views/components — Tablet viewport (md 992px) is a realistic clinical-workstation form factor. Fix: feature-by-feature responsive audit.

#### M-UI-6 — `EMRColorInput.tsx` ships old-brand-blue swatches
- D7 | `EMRColorInput.tsx:15, 17` — `#1a365d`, `#2b6cb0` in default palette. Persists drift into user FHIR data. Fix: generate palette from `--liverra-primary-*` ramp at render time.

#### M-UI-7 — `radiologyReportService.ts` server-side report HTML hardcodes `#1a365d`
- D7 | `radiologyReportService.ts:955, 961, 970` — Exported reports won't track brand swap. Fix: move to `BRAND_COLORS.primary` constants imported from `theme-colors.ts`.

#### M-UI-8 — Views with no empty state
- D7 | `RefinementView`, `LesionsPanelView`, `NotificationPreferencesView`, `ProfileView`, `DemoCaseRunnerView`, `OnboardingWizardView`, `ErasureWizardView`, `PacsStudyViewerView`, `PacsConfigView` — Have loading + error but no empty. Fix: audit each list; plumb in `EMREmptyState`.

#### M-UI-9 — F11 raw Mantine modal `SessionTimeoutModal`
- D7 | Duplicate of H-DS-2.

#### M-UI-10 — F6 var(--emr-*, hex-fallback) antipattern
- D7 | Duplicate of M-DS-1.

### Sweep — Catch Blocks

#### M-CATCH-1 — `erasure-request DB lookup` swallows table-missing as "not found"
- D4 | `api/erasure.py:163` — Caller can't distinguish "not found" from "table missing." Fix: specific `NoSuchTableError` re-raise.

#### M-CATCH-2 — `real_cascade_chain.apply_async()` failure → 202 Accepted but cascade never runs
- D4/D3 | `api/analysis.py:386` — Documented in C-CASES-1 root cause analysis. Fix: surface the Celery dispatch failure via 503.

#### M-CATCH-3 — Phase 1 findings swallow loses analysis_id context
- D4 | `findings.py:521` — Per-finding try/except is the documented intentional graceful degradation; the issue is missing analysis_id in the log line. Fix: add to `logger.warning(extra={"analysis_id": ...})`.

#### M-CATCH-4 — Report summary endpoint silently drops findings when DB query fails
- D4 | `api/analysis.py:1330` — Surgeon sees fewer findings than reality. Fix: re-raise after logging; surface error to UI.

#### M-CATCH-5 — QC flags silently skipped at INFO level on report summary endpoint
- D4 | `api/analysis.py:1304` — Fix: route errors through Sentry; emit a per-flag counter.

#### M-CATCH-6 — `erasure_execute.delay` failure swallowed at INFO level (GDPR)
- D4 | `api/erasure.py:176` — GDPR fire-and-forget that never fires. Fix: re-raise after logging; user receives 503 with retry guidance.

#### M-CATCH-7 — DELETE FROM each table swallow buries actual SQL errors as "table may not exist"
- D4 | `erasure/orchestrator.py:135` — Duplicate of C-AUDIT-3 broader form.

#### M-CATCH-8 — Tombstone INSERT swallow with same "table may not exist" misattribution
- D4 | `erasure/orchestrator.py:180` — Same root cause as M-CATCH-7.

### Sweep — Optimistic Locking

#### M-LOCK-1 — `ruo_accept` UPDATE without re-acceptance version guard
- D1 | `api/onboarding.py:187-205` — Idempotent in docstring but two concurrent accepts of different RUO versions silently land last-wins.

#### M-LOCK-2 — `put_pacs_destination` UPDATE tenant without version guard
- D1 | `api/admin.py:393-405` — Two admins setting different PACS destinations race; audit-event reflects each writer's body, not actual post-state.

#### M-LOCK-3 — `annotationService.saveAnnotations` passes `meta.versionId` but client drops it
- D1 | `pacs/annotationService.ts:153-228` — Illusory locking; the 412 catch is dead code. Fix once C-LOCK-3 (fhirClient API) lands.

#### M-LOCK-4 — `macroService.updateMacro` / `deleteMacro` — read-modify-write with no versionId
- D1 | `pacs/macroService.ts:186-226` — Two radiologists editing same .impression macro: second overwrites first.

#### M-LOCK-5 — `markAsReadService` read-modify-write of `ImagingStudy.extension[]` with no version
- D1 | `pacs/markAsReadService.ts:174-214` — Two "Mark as Read" clicks at same time → timeline becomes lossy.

#### M-LOCK-6 — `suspend_user` — compare-and-set on `suspended_at IS NULL`
- (Documented as race-safe; listed to prevent re-flag.)

### Sweep — Test Quality

#### M-TEST-1 — `acrPlainTextRenderer.parity.spec.ts` skip without ticket
#### M-TEST-2 — `test_acr_renderer_cross_channel_parity.py` 1/2 skipped
#### M-TEST-3 — `test_lilnet_accuracy.py` tests reference model whose weights don't exist (de-scoped)
#### M-TEST-4 — `test_clipboard_export_fhir_conformance.py` has 2 tests with 0 `assert` statements
#### M-TEST-5 — `test_step_up_on_finalize.py` is fully placeholder `@pytest.mark.placeholder`
#### M-TEST-6 — `test_acr_pdf_parity.py` whole file skipped

### Sweep — Type Safety

#### M-TYPE-1 — `useReportSummary.ts:63` `as unknown as UseQueryResult<...>` reshapes TanStack Query result
- D9 | TanStack discriminated union violated — `status: success` may co-exist with `data: undefined`. Fix: return small wrapper type explicitly.

#### M-TYPE-2 — `sentryInit.ts:54` Sentry event re-cast through `unknown` before PHI scrubbing
- D6/D9 | `scrubObject(event as unknown as Record<string, unknown>) as typeof event` — Inline note missing. Fix: define explicit `ScrubableSentryEvent` type.

#### M-TYPE-3 — `MeasurementPanel.tsx` 13× `as Record<string, unknown>`
- D9 | Systemic in one file. Fix: define a `MeasurementMetadata` interface.

### Sweep — React Hooks

#### M-HOOK-1 — `ViewerStateContext.tsx:202` stale-closure on unmount persistence flush
#### M-HOOK-2 — `AnalysisDetailView.tsx:478` `seat` context object in `handleFinalize` useCallback deps causes thrashing
#### M-HOOK-3 — `CascadeStageTimeline.tsx:179` `eslint-disable-next-line react-hooks/exhaustive-deps` with NO justification
#### M-HOOK-4 — `useRadiologyReport.ts:264` `eslint-disable-next-line react-hooks/exhaustive-deps` with NO justification
#### M-HOOK-5 — `NotificationPreferencesView.tsx:424` `eslint-disable-next-line react-hooks/exhaustive-deps` with NO justification on `useMemo`
#### M-HOOK-6 — `StudyManagementPanel.tsx:263` `handlePatientSearch` missing AbortController on user-initiated FHIR search

### Sweep — i18n Literals

#### M-I18NLIT-1 — `EMRErrorBoundary.tsx` 5 hardcoded English fallbacks in regulatory-critical component (duplicate of H-DS-3 broader form)
#### M-I18NLIT-2 — `acrAnatomicalMapping.ts` 32 × `t('reportAcr:…', 'English fallback')` calls
#### M-I18NLIT-3 — `radiologyReportService.ts` 20 report templates with inline Russian/Georgian `name` triads + English-only HTML `content`
#### M-I18NLIT-4 — `PacsStudiesView.tsx` 11 hardcoded English UI strings
#### M-I18NLIT-5 — `SessionTimeoutModal.tsx` + `EMRNotificationCenter.tsx` + `EMRModal.tsx` 8 × `t(key, 'English fallback')` calls
#### M-I18NLIT-6 — `notificationHelpers.ts` bilingual notification dictionary hardcoded in source instead of translation files

---

End of PART 2. Continue to PART 3 (LOW + TRIVIAL bulk counts).
