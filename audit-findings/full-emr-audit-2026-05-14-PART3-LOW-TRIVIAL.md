# Full EMR Audit — 2026-05-14 — PART 3: LOW + TRIVIAL

> **Pointers:** BLOCKER / CRITICAL / HIGH findings live in [`full-emr-audit-2026-05-14-PART1-BLOCKER-CRITICAL-HIGH.md`](./full-emr-audit-2026-05-14-PART1-BLOCKER-CRITICAL-HIGH.md). MEDIUM findings live in [`full-emr-audit-2026-05-14-PART2-MEDIUM.md`](./full-emr-audit-2026-05-14-PART2-MEDIUM.md).

**Audit area:** full (whole monorepo) · **Agents:** 24 · **Date:** 2026-05-14

## Grand Summary — LOW counts per area

| Area | LOW |
|------|----:|
| Wave 0 — Dependencies | 4 |
| Wave 0 — Unit Tests | 17 (placeholder/it.todo files; counted at file level, not per-test) |
| PACS | 2 |
| Cases | 3 |
| Cascade | 2 |
| Inference | 2 |
| Clinical Algorithms | 2 |
| ACR Readout | 3 |
| Refinement | 2 |
| Audit & Compliance | 1 |
| Design System | 2 |
| i18n core | 3 |
| Auth & Settings | 2 |
| Schema | 2 |
| Wave 2 — FHIR Validator | 2 |
| Wave 2 — Security | 1 |
| Wave 2 — i18n Quality | 1 |
| Wave 2 — UI/UX | 4 |
| Sweep — Catch Blocks | 9 |
| Sweep — Optimistic Locking | 2 |
| Sweep — Test Quality | 3 |
| Sweep — Type Safety | 4 |
| Sweep — React Hooks | 4 |
| Sweep — i18n Literals | 4 |
| **TOTAL (raw, pre-dedup)** | **81** |
| **TOTAL (canonical, post-dedup)** | **66** |

---

## LOW Findings (grouped by area; compact format)

### Wave 0 — Dependencies

- **L-DEP-1** `packages/app/src/emr/components/pacs/ComparisonView.tsx:348,365` | D9 | Two `(viewport as any).setStack(...)` casts — Cornerstone3D type narrowing. Fix: `if ('setStack' in viewport) { (viewport as Types.IStackViewport).setStack(...) }`.
- **L-DEP-2** `packages/app/src/emr/views/cases/AnalysisDrawerTabs.tsx:123,131,133` | D9 | Three `@ts-expect-error` on React.lazy prop forwarding (commented, harmless). Optional `<TypedLazy>` helper.
- **L-DEP-3** `packages/app/package.json:39` | D2 | `@lhci/cli@0.14.0` chain — 8 low-severity dev-only CVEs (cookie, tmp, inquirer, lighthouse, etc.). Fix: bump to `^0.15.1`. Do NOT use `npm audit fix --force`.
- **L-DEP-4** `packages/ml-inference/requirements.txt:42` | D9 | Stale `numpy<2.0` pin — author's own comment notes the monai-1.4 reason is gone. Fix: drop upper bound.

### Wave 0 — Unit Tests (UT5 — placeholder coverage)

- **L-UT-1** 6 EMR common-component test files are 100% `it.todo`:
  - `EMRButton.test.tsx` (6 todos)
  - `EMRPageHeader.test.tsx` (4)
  - `EMRConfirmationModal.test.tsx` (5)
  - `EMRCard.test.tsx` (5)
  - `EMRModal.test.tsx` (6)
  - `EMRErrorBoundary.test.tsx` (4)
- **L-UT-2** 10 ESLint plugin tests are 100% `it.todo`:
  - `no-hardcoded-fhir-url`, `no-hardcoded-font-size`, `no-raw-mantine-inputs`, `no-forbidden-hex`, `no-hardcoded-color`, `mantine-button-padding-check`, `no-russian-locale`, `no-any-without-justification`, `require-emr-button`, `require-state-triplet` — 3 `it.todo` each.

### PACS

- **L-PACS-1** `pacs/nginx/.gitkeep`, `pacs/bridge/.gitkeep` | D9/D11 | Empty infrastructure directories implying components that don't exist. Add README pointing at the spec section, or remove the directories.
- **L-PACS-2** Redundant `pynetdicom` imports inside `ping()` despite outer-scope import. `packages/ml-inference/src/services/pacs_cecho.py:46-48`; `pacs/anon-sidecar/main.py:99-100`. Drop redundant inner imports.

### Cases

- **L-CASE-1** `CasesListView.tsx:310,320,447,574,610` | D7 | Hardcoded `var(--emr-gray-N)` for backgrounds — inverts in dark mode. Fix: swap to `var(--emr-border-color)` for borders, `var(--emr-bg-hover)` for thumbnail wells.
- **L-CASE-2** `CasesListView.tsx:189-260` | D9 | `useCasesListStub` is a "stub" in production code with hardcoded `Authorization: 'Bearer dev-access-token'`. Fix: land T183 (`useCasesList`) or remove the dev token.
- **L-CASE-3** `AnalysisDrawerTabs.tsx` | D9 | 154 lines of unused code shipping in every bundle; registered nowhere. Fix: delete the file.

### Cascade

- **L-CASCADE-1** `_DEFAULT_VOXEL_VOLUME_ML = (2.3 ** 3) / 1000.0` duplicated in 4 task modules — `parenchyma.py:58`, `couinaud.py:390`, `vessels.py:364`, `flr_default.py:56`. Fix: move into `src/orchestrator/constants.py`.
- **L-CASCADE-2** Stub-model SHA detection in `workers/app.py:120-156` references models with no path on current layout (Triton dormant). Fix: delete or gate behind `LIVERRA_TRITON_PATH_ACTIVE=true`.

### Inference

- **L-INFER-1** Default IP `100.124.94.29` hardcoded into source (5 files). Tailnet IPs are private and rotate. Fix: in-code default `None`; raise clear RuntimeError if unset and client is called.
- **L-INFER-2** Hardcoded `roi_subset` list in two places — `main.py:119` and `:160` must stay in sync. Fix: module-level constant `_TOTAL_ROI_SUBSET`.

### Clinical Algorithms

- **L-CLIN-1** `FLRPanel.tsx:183` | D8 | `{t('analysis:detail.flr.subtitle') || 'Remnant pct functional'}` — hardcoded English fallback. Fix: define the key in all locales; remove `|| '...'`.
- **L-CLIN-2** `FLRPanel.tsx:256, 183, 298, 315, 332` | D8 | "Adequacy thresholds", "Low", "Borderline", "Adequate", "< 30%", "30–40%", "≥ 40%" hardcoded English in JSX. Fix: add `analysis:flr.thresholdsHeader`, `analysis:flr.adequacy.low/borderline/adequate.label`, `analysis:flr.adequacy.*.range` keys.

### ACR Readout

- **L-ACR-1** `acrPlainTextRenderer.ts:32` vs `acr_plaintext_renderer.py:28-32` | D9 | TS regex strips one `---` prefix; Python while-loop strips multiple. Edge case `--- --- RUO ---` produces different banners. Fix: pick one (recommend while-loop pattern).
- **L-ACR-2** `ACRSection.module.css:91-95` | D9 | `.stale` CSS class defined and never applied (resolves once BLOCKER B-ACR-1 lands).
- **L-ACR-3** `useAcrCopyAction.ts:62, 145` | D9 | Unused `snapshot` field in return type — no caller reads `result.snapshot`. Fix: remove until needed.

### Refinement

- **L-REFINE-1** `LesionsPanelView.tsx:144-145` | D9 | Synthesized `bbox3d: [0,0,0,0,0,0]` because API doesn't return it. "Click a lesion → recenter" silently fails. Fix: add bbox to lesion API response.
- **L-REFINE-2** `RefinementView.tsx:526-532,684-690` + `LesionsPanelView.tsx:411-420` | D7 | Inline `<style>{...}` blocks in render — minor styling-drift risk. Fix: move into CSS modules.

### Audit & Compliance

- **L-AUDIT-1** `clipboard_export_event.py:219` | D9 | `import json` inside function body. Move to module top.

### Design System

- **L-DS-1** `EMRBadge.module.css:22` | D7 | Single hardcoded `font-size: 10px` — should be `var(--emr-font-2xs)`.
- **L-DS-2** `EMRConfirmationModal.tsx:4` | D9 | Imports raw Mantine `Text` (allowed layout primitive — listed for completeness only).

### i18n core

- **L-I18N-1** `packages/core/src/i18n/index.ts:1-9` | D9 | 9-line stub that does nothing and has zero importers. Fix: delete or repurpose as canonical re-export source.
- **L-I18N-2** `TranslationContext.tsx:319-327` (set-locale double-write to localStorage) | D9 | Listed during review; downgraded to "Already Handled" after re-reading — single localStorage write, in-memory setLocaleState. No fix needed.
- **L-I18N-3** `TranslationContext.tsx:334-344` | D6 | `forceRender((n) => n + 1)` queues a render per missing-namespace key on first paint. Fix: accumulate "needs load" set in a ref; flush once per tick.

### Auth & Settings

- **L-AUTH-1** `ProfileView.tsx:316` | D8 | `t(\`profile:role.${user.role}\`)` constructs dynamic translation key; missing key shows raw key as visible label. Fix: typed `ROLE_LABELS: Record<LiverraRole, string>`.
- **L-AUTH-2** `NotificationPreferencesView.tsx:232` | D9 | `if (ordered.length === 0) return <></>;` — prefer `return null;`.

### Schema

- **L-SCHEMA-1** Migration 0014 is essentially a no-op assertion — adds documentation overhead without DDL impact; pattern will multiply as more categories are added. Fix: centralize known-categories registry in a seed table.
- **L-SCHEMA-2** `pipeline_checkpoint` has no `tenant_id`, no FK to tenant, no RLS — relies on transitive isolation. URI is per-tenant-KMS-encrypted blob, not PHI. Fix: tighten for consistency.

### Wave 2 — FHIR Validator

- **L-FHIR-1** `tests/integration/fhir/test_bundle_transaction_rollback.py:47` and `test_tenant_isolation.py:75` — test fixtures invent identifier system URLs not in `FHIR_SYSTEMS`. Fix: back with real systems or document as test-only.
- **L-FHIR-2** Comments admitting "fhir-systems constants inlined locally" — `pacs/macroService.ts:26`, `pacs/criticalAlertService.ts:23`, `pacs/hangingProtocolEngine.ts:30`, `pacs/peerReviewService.ts:24`. Fix: migrate to centralized imports.

### Wave 2 — Security

- **L-SEC-1** `python-jose` long-tail liability (LOW today / HIGH next CVE). Duplicate of H-DEP-1.

### Wave 2 — i18n Quality

- **L-I18NQ-1** 16 orphaned non-en keys (`__comment__`, `__reviewers`, `_meta.*`) in `de/ka/ru` bundles. Schema noise but doesn't render. Fix: either add `__comment__` to en as schema metadata or strip from non-en bundles.

### Wave 2 — UI/UX

- **L-UI-1** F13 — 11 hardcoded `font-size: NNpx` in CSS-module rules (mostly LandingView marketing). Fix: replace with `var(--emr-font-*)`.
- **L-UI-2** F14 — 10 hardcoded `font-weight: NNN` in CSS-module rules. Same root cause.
- **L-UI-3** F5 partial — `useSegmentation`/`useDicomSR` use old-brand-blue hex (`#2b6cb0`, `#3182ce`) for DICOM-SR color tag / segmentation default. Likely intentional but doc'd as "theme secondary". Fix: import from `theme-colors.ts`.
- **L-UI-4** F20 — `auth/NotFoundView.tsx` is intentional minimal stub per CLAUDE.md "View Implementation Tracker". No fix needed (deferred).

### Sweep — Catch Blocks (9 LOW silent-catches on non-critical paths)

- **L-CATCH-1** `dicomSRService.ts:316` — silent JSON.parse on SR-export annotationCount calc
- **L-CATCH-2** `analysis.py:397` — `_revoke_cascade` swallow at INFO level
- **L-CATCH-3** `analysis.py:1619` — silent `bbox_3d = None` on JSON parse failure in lesion-thumbnail render
- **L-CATCH-4** `RUOClaimRegistryContext.tsx:162,170` — silent localStorage JSON.parse + setItem catches
- **L-CATCH-5** `AnalysisDetailView.tsx:297,306` — silent localStorage rail-collapsed state catches
- **L-CATCH-6** `RefinementView.tsx:128` — silent URLSearchParams parse for `?devMockMask=1`
- **L-CATCH-7** `RefinementView.tsx:162,176` — silent catches on seat.acquire/release (justified comments, intentional)
- **L-CATCH-8** `ReviewSeatContext.tsx:196,236` — silent catches on heartbeat release/failure (236 is intentional; bumps missedRef + UI degraded badge)
- **L-CATCH-9** `ReportMeasurements.tsx:100` + `dicomSRService.ts:287` — silent JSON.parse / fire-and-forget audit on radiology report PDF surface

### Sweep — Optimistic Locking

- **L-LOCK-1** `audit_rewriter.py:193-202` — `UPDATE audit_event SET canonical_json` with no version guard (single-leader by Celery routing key, acceptable today). Fix: take advisory lock at top of `execute()`.
- **L-LOCK-2** `ingest.py:476-529` — tus PATCH `Upload-Offset` compare-and-set TOCTOU (corruption surfaces via final SHA mismatch — bounded blast). Fix: `SELECT ... FOR UPDATE` + conditional UPDATE.

### Sweep — Test Quality

- **L-TEST-1** `test_acr_plaintext_renderer.py` 1 skip
- **L-TEST-2** `test_couinaud_iou.py` 2 tests / 2 skipped — no fixtures wired
- **L-TEST-3** Empty/decorative skipped specs without follow-up ticket (multiple)

### Sweep — Type Safety

- **L-TYPE-1** `AnalysisDrawerTabs.tsx:123,131,133` — 3 `@ts-expect-error` on lazy-loaded child components (commented; covered by L-DEP-2).
- **L-TYPE-2** `AuthContext.tsx:178` — dev-bypass mock user cast via `as unknown as User`. Test-helper, acceptable.
- **L-TYPE-3** `niftiLoader.ts:154` — `nifti.readHeader(buffer) as unknown as NiftiHeader | null`. Library type gap; runtime guard exists.
- **L-TYPE-4** `EMRSwitch.tsx` 6× `as Record` — Mantine prop forwarding pattern. Acceptable.

### Sweep — React Hooks

- **L-HOOK-1** `RUOClaimRegistryContext.tsx:222` — `testOverrides` object in useCallback deps
- **L-HOOK-2** `ResectionPlaneTool.tsx:143` — `useEffect(() => { scheduleCompute(pose); }, [])` with stale-closure
- **L-HOOK-3** `EMRBottomSheet.tsx:165` — focus effect may run before children render
- **L-HOOK-4** `AuthContext.tsx:150` — init effect with `[]` deps captures `testOverrides` from first render

### Sweep — i18n Literals

- **L-I18NLIT-1** `EMRPage.tsx:80` hardcoded "Research Use Only" badge (regulatory-required persistent UI)
- **L-I18NLIT-2** `ReportInlineView.tsx` 3 hardcoded table headers
- **L-I18NLIT-3** `auth.py:180,190` Python `HTTPException` strings (not user-facing today)
- **L-I18NLIT-4** `pdf_templates/ka/report.html` partial Georgian translation (~37/328 lines)

---

## Trivia (Bulk Counts)

Aggregated across all 24 agents' Trivia footers. Each item is a count, not an individual finding card.

### Stub / placeholder markers
- **`TODO(phase-4)` / `TODO(phase-4-supabase)`** markers in PACS services: 47 (auditService.ts × 7, imagingStudyService.ts × 2, criticalAlertService.ts × 3, peerReviewService.ts × 2, hangingProtocolEngine.ts × 3, markAsReadService.ts × 1, keyImageService.ts × 3, annotationService.ts × 5, dicomSRService.ts × 4, radiologyReportService.ts × 3, notificationHelpers.ts × 2, etc.)
- **Stale comments referring to MediMind / Medplum legacy origins:** 12
- **"STUB:" docstrings on persistence functions in imagingStudyService.ts:** 23
- **`// eslint-disable-next-line no-console` markers in PACS code:** 8
- **`AnalysisDrawerTabs.tsx:19-21` TODO** ("once us1-ui stabilises ...") — parent feature stabilized; TODO is dated.
- **EMRTableSkeleton.tsx:2, EMRFormFields/index.ts:33** — TODO comments on benign re-export stubs.

### Bulk-counted dead code & cleanup
- **Unused imports across all 12 areas:** 8 verified (`io` in 6 files, `nib` lazy in 4)
- **`@ts-expect-error` escapes with justification comments:** 5 (4 in views, 1 in DicomDropzone)
- **`@ts-ignore`:** 0
- **`@ts-nocheck`:** 0
- **Pure `as any` casts in non-test TS source:** 2 (ComparisonView.tsx — both covered above)
- **Non-null `!.` assertions in services/hooks:** 0
- **Magic-number exemptions encountered:** 12 (named constants already; HEARTBEAT_INTERVAL_MS, LOST_AFTER_MISSES, etc.)
- **Documented intentional mismatches:** 3 (LesionsPanelView.tsx lines 17-28, 60, 410-419)
- **Inline styles repeated 3+ times in views:** 2 (table-cell padding, card border-radius)
- **Tautological CHECK constraints in migrations:** 1 (`flr_calculation.flr_sum_invariant_chk` always true)
- **Always-true RLS policies:** 2 (series_parent_isolation, pipeline_checkpoint_parent_isolation)
- **Identical block in PL/pgSQL trigger:** 1 (0005:91-97 both branches of `IF TG_OP = 'DELETE'` assign same values)
- **`IF NOT EXISTS` inconsistent idempotency pattern in migrations:** 1 (0001-0009 vs 0010+)

### `_meta` / `__comment__` review metadata keys (intentional, not drift)
- **`_meta` review-metadata keys in de/ka bundles:** 6 occurrences (`de/glossary.__reviewers`, `de/profile.__comment__`, `de/lesions._meta.*`, `de/refine._codeowners`, ka mirrors)
- **`__comment__` keys in ru/ bundles:** 4 occurrences (`ru/glossary`, `ru/help`, `ru/profile`, `ru/notifications`)

### `noqa` / blanket-except suppressions (each annotated with justification — counted, not promoted)
- **`# noqa: BLE001` blanket-exception suppressions with per-line justification:** 7 (orchestrator.py × 5, crypto_shred.py × 2 — covered by parent BLOCKER/CRITICAL findings on the same code paths)
- **`noqa: BLE001` in ml-inference-gpu/main.py:** 2 (justified by FastAPI HTTPException convention)
- **Magic time constants in fhir_extensions/orchestrator in exempt list (60, 7, 3600):** 6 occurrences

### Trivial `console.warn` / silent-catch zombies (catch params unused)
- **TS `catch (err)` / `catch (e)` with no usage of the parameter (TS sweep counted):** ~30 occurrences across packages/app/src — covered by sweep-01-catch-blocks Trivia floor.
- **Python `except ImportError:` soft-imports across services + tests:** ~80 occurrences (CLAUDE.md anti-pattern carve-out: graceful degradation pattern with logger.warning + fallback — these are correct).

### License compliance (verified clean)
- **GPL / AGPL / LGPL / NC / SA licenses anywhere in `node_modules`:** 0 (1,053 packages walked: MIT 767, Apache-2.0 133, ISC 73, BSD-3-Clause 41, BSD-2-Clause 21, 0BSD 7, MPL-2.0 2, Python-2.0 2, others ≤1)
- **CC-BY-4.0 (permissive for code use):** 1 occurrence
- **TotalSegmentator weights:** CC-BY-NC-SA-4.0 (NOT in node_modules; counted as a HIGH finding above)

### Python `print()` statements on production paths
- **`scripts/real_cascade.py` `print()` calls:** ~50 (`[1/7]`, `[2/7]`, etc.) — acceptable as CLI but goes to stdout when invoked via Celery worker.

### CSS / theme drift (counted, rolled to higher severity)
- **Old-brand-blue hexes (`#1a365d`, `#2b6cb0`, `#3182ce`) inside `theme.css`:** 74 (bundled into C-DS-1 / CC-6)
- **Old-brand-blue hexes outside `theme.css`:** 6 feature-file references (bundled into H-ACR-3 + H-UI-2)
- **Inline gradient-blue fallbacks outside design-system scope:** 4 (UserMenuButton, SegmentationPanel, ReportPanel)
- **`var(--emr-gray-N)` as background outside design-system scope:** 11 hits in views/cases, views/admin, etc.
- **Forbidden-blue denylist hexes (`#3b82f6` etc.) in feature code:** 1 (ReportInlineView.tsx — covered by H-ACR-3 / H-UI-1)
- **Forbidden-blue denylist hexes in `theme.css` itself:** 1 occurrence as drift-warning constant (intentional)

### Test infrastructure noise (counted, addressed in test-quality sweep)
- **`it.todo()` across packages/app/src and packages/core:** 90 placeholders
- **Pytest `@pytest.mark.skip` / `pytest.skip` calls without follow-up ticket:** 75 ml-inference + 3 frontend
- **Pytest `xfail`:** 9
- **`test_triton_stage_shapes.py` parameterized failures (Triton dormant):** 20 (noise; should be `xfail`)

### Documentation / docstring drift
- **`Locale` doc-comment claims "Russian dropped" in 2 files:** 2 (rolled into M-I18N-5)
- **Same-file contradictory locale docstring:** 1 (M-I18N-6)
- **`AuditCategory` doc says both "24-member" and "Exactly 25 members" in same file:** 1 (rolled into H-SCHEMA-1)

### `_unused_export` / dead surface counts
- **Unused-but-exported constants in fhir_extensions.py:** 5 (`RUO_CLAIM_KEY`, `RUO_WATERMARK_PRESENT`, etc. — mirror-only, documented intent)
- **Pass-through wrappers / no-decoration components:** `ACRHeroCopyButton` (renders EMRButton with no decoration beyond the hook call — acceptable until it grows)

### Cleanups inherited from MediMind port
- **Header comments admitting "fhir-systems constants inlined locally":** 4 (covered by L-FHIR-2)
- **Stale TODO referencing replaced upstream models:** docstrings in `services/couinaud_heuristic.py:1-23` mentioning "Pictorial-Couinaud Triton" (historical fallback context; not flagged as the algorithm itself is being deleted per B-CLIN-2)

### Trivial single-quote findings
- **Hardcoded English UI strings (single-instance, not yet promoted to i18n debt) on FLRPanel.tsx:215** ('mL total')
- **CE disclaimer fallback on FLRPanel.tsx:137** ('Approved for surgical planning. Not a substitute for clinical judgment.')

---

End of PART 3.
