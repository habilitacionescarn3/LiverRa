---
description: "Task list for 002-acr-structured-readout"
---

# Tasks: Structured ACR-Style Radiologic Readout

**Input**: Design documents from `/specs/002-acr-structured-readout/`
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Test tasks ARE included — FR-038 requires automated test evidence as a release gate (CE MDR Class IIb).

**Organization**: Tasks are grouped by user story so each story is independently implementable and testable. The MVP is User Story 1 alone.

## Format: `[ID] [P?] [W?] [Story?] Description`

- **[P]**: Parallelizable (different files, no incomplete dependencies)
- **[W]**: Integration wire task — connects a created artifact to its consumer. Must run AFTER its producer; never `[P]` against the producer.
- **[Story]**: User story label (US1–US5) on user-story-phase tasks only.
- **[frontend-designer]**: UI deliverable — `/speckit.implement` MUST invoke the `frontend-designer` agent.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pre-conditions before foundational and story phases.

- [ ] T001 Create directory tree per plan.md project-structure: `packages/app/src/emr/components/report/` (already exists), `packages/app/src/emr/services/report/` (already exists), `packages/app/src/emr/hooks/` (already exists), `packages/app/src/emr/views/__e2e__/acr-readout/` (NEW), `packages/app/src/emr/views/__e2e__/acr-readout/helpers/` (NEW), `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/` (NEW), `packages/ml-inference/src/services/audit/` (verify), `packages/ml-inference/src/jobs/` (NEW if absent), `packages/ml-inference/tests/fixtures/acr_snapshots/` (NEW)
- [ ] T002 Add `ReadoutClipboardExport` to the `AuditCategory` enum in `packages/core/src/types/audit.ts`; update the "exactly 24 members" comment to 25; add a JSDoc note `Added by 002-acr-structured-readout — clipboard export of the ACR structured readout panel.`
- [ ] T003 Create Postgres alembic migration `packages/ml-inference/src/db/alembic/versions/<timestamp>_0014_audit_category_readout_clipboard_export.py` that adds `'readout_clipboard_export'` to any `CHECK` constraint or enum constraining the `audit_category` column; migration MUST be reversible
- [ ] T004 [P] Add CI step in `.github/workflows/lint.yml` enforcing the theming-compliance grep gate: `git grep -nE '#([0-9a-fA-F]{3,8})\b' packages/app/src/emr/components/report/ACR` MUST return empty; CI fails if non-empty
- [ ] T005 [P] Add CI step in `.github/workflows/test.yml` making `packages/ml-inference/tests/integration/test_acr_renderer_cross_channel_parity.py` a release-blocking job (not part of `nightly`); failure prevents merge to `main`

**Checkpoint**: Postgres schema accepts the new category; CI gates in place.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Infrastructure that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Translation + namespace registration

- [ ] T006 Register the new translation namespace by editing `packages/app/src/emr/contexts/TranslationContext.tsx`: (a) append `| 'reportAcr'` to the `TranslationNamespace` union (around line 59); (b) append `'reportAcr'` to the `TRANSLATION_NAMESPACES` readonly tuple (around line 90). Do NOT edit `localeService.ts` — `Locale` and `SUPPORTED_LOCALES` already enumerate `en/de/ka/ru` (verified)
- [ ] T007 [P] [frontend-designer] Create the English translation bundle at `packages/app/src/emr/translations/en/reportAcr.json` with the exact key shape specified in `data-model.md` §5 (ruoDisclaimer, sections, status, labels, copy, staleness)
- [ ] T008 [P] [frontend-designer] Create `packages/app/src/emr/translations/de/reportAcr.json` mirroring the English keyset; values prefixed `__TODO_TRANSLATE__:` pending medical CODEOWNERS review (de is legacy bundle)
- [ ] T009 [P] [frontend-designer] Create `packages/app/src/emr/translations/ka/reportAcr.json` mirroring the English keyset; values prefixed `__TODO_TRANSLATE__:` pending medical CODEOWNERS review
- [ ] T010 [P] [frontend-designer] Create `packages/app/src/emr/translations/ru/reportAcr.json` mirroring the English keyset; values prefixed `__TODO_TRANSLATE__:` pending medical CODEOWNERS review

### FHIR extension registration

- [ ] T011 Add new extension URL keys to `LIVERRA_EXTENSIONS` in `packages/app/src/emr/constants/fhir-extensions.ts`: `auditLocale`, `auditTenant`, `auditClientActionId`, `auditFailureCategory` — each resolving to `http://liverra.ai/fhir/StructureDefinition/audit-<key-name>`. Hardcoded URLs in audit code are forbidden per file-header convention
- [ ] T012 Create or extend the matching Python-side FHIR-extension constants module at `packages/ml-inference/src/services/audit/fhir_extensions.py` exporting the same four URL constants; import-style identical to TS side

### Shared report-summary infrastructure

- [ ] T013 Extract `ReportSummary` interface and `fetchReportSummary` from `packages/app/src/emr/components/report/ReportInlineView.tsx` (lines 46–92) into a new module `packages/app/src/emr/services/report/reportSummary.ts`; export both as the canonical wire-shape source consumed by both old and new renderers
- [ ] T014 [W] Wire `reportSummary` module into `ReportInlineView.tsx` — replace local `ReportSummary` interface and `fetchReportSummary` with `import { ReportSummary, fetchReportSummary } from '../../services/report/reportSummary'` in `packages/app/src/emr/components/report/ReportInlineView.tsx`
- [ ] T015 Create `packages/app/src/emr/hooks/useReportSummary.ts` — a TanStack Query wrapper over `fetchReportSummary` with `staleTime: 60_000`; expose `etag` from response headers; consumed by both `ACRStructuredReadout` (US1) and `ReportInlineView` (Phase 2 wiring follows)
- [ ] T016 [W] Wire `useReportSummary` into `ReportInlineView.tsx` — replace the inline `useQuery` call (around line 152) with `useReportSummary(analysisId)` in `packages/app/src/emr/components/report/ReportInlineView.tsx`

### Canonical anatomical-section mapping

- [ ] T017 Create `packages/app/src/emr/services/report/acrAnatomicalMapping.ts` exporting (a) `ANATOMICAL_SECTIONS` tuple per data-model.md §2; (b) `AnatomicalSection` type; (c) `findingTypeToAnatomicalSection(type)` function; (d) `buildReadoutSnapshot(reportSummary, locale, ruoDisclaimer)` factory. Port the implicit display rules from `packages/app/src/emr/components/report/FindingsCard.tsx` verbatim: `hu_stats` value format `mean ${hu.mean.toFixed(0)} HU · range ${p10}–${p90} HU`, `STEATOSIS_BADGE` color map (none=gray / mild=yellow / moderate=orange / severe=red), the `steatosis.grade === 'none'` skip filter (line 153), splenomegaly badge-and-warn logic, gallbladder flag concatenation rule. Name each ported rule explicitly in code comments referencing the original FindingsCard line numbers

### Backend report-summary contract upgrades

- [ ] T018 Extend the `GET /api/v1/analyses/{id}/report/summary` handler in `packages/ml-inference/src/api/analysis.py` (around line 1164) to (a) include `updated_at: ISO8601` in the JSON body taken from `analysis.updated_at`; (b) emit a strong `ETag` header derived from `sha256(updated_at || finding_count)`; (c) keep `Cache-Control: no-store, must-revalidate` unchanged
- [ ] T019 Add a `HEAD /api/v1/analyses/{id}/report/summary` route in `packages/ml-inference/src/api/analysis.py` that reuses the GET handler via a `Response` media-type switch, returning only the `ETag` and `Last-Modified` headers (no body)

### Unit + parity test foundations

- [ ] T020 [P] Create `packages/app/tests/i18n/acr-namespace-key-parity.spec.ts` — asserts `en/reportAcr.json` is the golden master and `de/ka/ru/reportAcr.json` each contain an identical key set (values may differ)
- [ ] T021 [P] Create `packages/app/tests/i18n/acr-no-todo-translate-in-prod.spec.ts` — reads the production build output and fails if any `__TODO_TRANSLATE__:` substring is present
- [ ] T022 [P] Create `packages/app/tests/i18n/acr-translation-keys-cover-renderer.spec.ts` — asserts every `t()` key the plain-text renderer calls exists in `en/reportAcr.json`
- [ ] T023 [P] Create `packages/app/src/emr/services/report/__tests__/acrAnatomicalMapping.spec.ts` — Vitest unit; asserts mapping enum order, `findingTypeToAnatomicalSection` correctness for all 7 finding types, ported FindingsCard rules behave identically to the original

**Checkpoint**: Translations registered; ReportSummary extracted; useReportSummary live; ETag/HEAD contract live; anatomical mapping ready. User-story phases can now run.

---

## Phase 3: User Story 1 — Radiologist drops AI readout into PACS dictation (Priority: P1) 🎯 MVP

**Goal**: A radiologist opens a completed analysis, sees the six-section ACR readout, clicks Copy, and pastes clean plain text into PACS dictation. One audit event is recorded per click.

**Independent Test**: Open any finalized analysis, verify the six section headers in fixed order, click Copy, paste into a text editor — content is plain text bookended by the RUO disclaimer with no HTML/markdown/JSON artifacts. One row appears in `audit_event_chain` with subtype `readout-clipboard-export`.

### Plain-text renderer + clipboard service

- [ ] T024 Create `packages/app/src/emr/services/report/acrPlainTextRenderer.ts` per `contracts/plaintext-renderer.md` — pure function `renderReadoutPlainText(snapshot: ReadoutSnapshot): string`; NFC normalization at boundary; deterministic output; RUO first and last line; no markdown / HTML; section order fixed
- [ ] T025 Create `packages/app/src/emr/services/report/acrClipboardService.ts` — exposes `copyReadout(snapshot)` orchestrating (a) `navigator.clipboard.writeText` with `document.execCommand('copy')` fallback for iOS Safari; (b) freshness check via `HEAD /report/summary` ETag comparison BEFORE clipboard write; (c) audit POST to `/api/v1/analyses/{id}/report/clipboard-export` after successful clipboard write; (d) on audit failure, enqueue to IndexedDB via the existing `idb` pattern at `services/offline/offlineQueue.ts`; (e) preserve `client_action_id` (UUID generated once per click) across retries
- [ ] T026 Create `packages/app/src/emr/services/report/acrTelemetry.ts` — thin wrapper around `capture()` from `services/telemetry/postHogClient.ts`; four event helpers `trackReadoutViewed`, `trackCopySucceeded`, `trackCopyFailed`, `trackPdfSectionRendered`; property allowlists enforced per `contracts/readout-api.md` §5; fail-safe when `globalThis.posthog` is undefined
- [ ] T027 Add the four new PostHog event names to BOTH the `PostHogEventName` union type AND the `POSTHOG_EVENTS` runtime array in `packages/app/src/emr/services/telemetry/events.ts`: `acr_readout_viewed`, `acr_clipboard_copy_succeeded`, `acr_clipboard_copy_failed`, `acr_pdf_section_rendered`

### Backend audit-emission endpoint

- [ ] T028 Create `packages/ml-inference/src/services/audit/clipboard_export_event.py` — exposes `emit_clipboard_export(payload: ClipboardExportAuditPayload, *, audit_chain_writer)` that builds a FHIR R4 AuditEvent per `contracts/audit-event.md` §1 and appends to the existing chain via `AuditChainWriter`. Supports success and failure variants per §2; idempotent on `client_action_id` (INSERT ... ON CONFLICT DO NOTHING semantics)
- [ ] T029 Add `POST /api/v1/analyses/{analysis_id}/report/clipboard-export` route to `packages/ml-inference/src/api/analysis.py` following the existing domain-action pattern at `_emit_analysis_audit` (lines 261–300); inherits analysis-detail authorization (so tenant boundary applies automatically); returns the response shape from `contracts/audit-event.md` §3; rejects unauthenticated with 401 and cross-tenant with 403 (each producing its own audit row server-side)
- [ ] T030 [W] Wire `clipboard_export_event.emit_clipboard_export` into the new POST handler — add the import at the top of `packages/ml-inference/src/api/analysis.py` and call from within the new route handler after validating the request body
- [ ] T031 [W] Wire `acrClipboardService.copyReadout` to consume `auditLocale`/`auditTenant`/`auditClientActionId`/`auditFailureCategory` from `LIVERRA_EXTENSIONS` — add the import at the top of `packages/app/src/emr/services/report/acrClipboardService.ts` so the POST body uses extension keys never literal URLs

### Section UI components (all [frontend-designer])

- [ ] T032 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSection.module.css` — shared section-card styles per plan §Component-library binding: `EMRCard` container styles, h3 header (`var(--emr-font-lg)` weight 600), field rows (`var(--emr-font-sm)`), warning callout (`var(--emr-bg-warning)` / `var(--emr-text-warning)`), flex-overflow rules per plan §Flexbox text-overflow rules
- [ ] T033 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionLiver.tsx` — renders `hu_stats` + `steatosis` rows from the anatomical mapping; binds to `EMRCard`, `EMRAlert variant='warning'` for degraded warnings, `EMRSkeleton` for loading state; handles all 4 states (loading/empty/error/degraded) per plan §Per-section state matrix; NEVER `return null`
- [ ] T034 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionLesions.tsx` — renders `calcified_lesions`, `simple_biliary_cysts`, `indeterminate_malignant` + the lesion list; same state matrix rules; per-finding row layout: outer `<Group justify='space-between' wrap='wrap'>`, label cluster `flex: 1, minWidth: 0`, badges `flexShrink: 0`
- [ ] T035 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionVessels.tsx` — renders the existing `<StageImage stage='vessels' />` (already at `report/render/vessels` endpoint, used at `ReportInlineView.tsx:305`) as the visible content; structural h3 heading always present per FR-002 even if image is missing
- [ ] T036 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionGallbladder.tsx` — renders `gallbladder` finding (volume, wall thickness, stones); same state matrix
- [ ] T037 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionSpleen.tsx` — renders `spleen` finding (volume, splenomegaly, degraded-mask warning); same state matrix
- [ ] T038 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRSectionFLR.tsx` — renders `flr` block (plan pattern, FLR mL + %, safety classification, recommendation)
- [ ] T039 [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRStructuredReadout.tsx` — parent component; uses `useReportSummary(analysisId)` (from Phase 2 hook); builds the `ReadoutSnapshot` via `buildReadoutSnapshot` from `acrAnatomicalMapping`; renders the six section components in fixed order; hosts the Copy `EMRButton` with `aria-describedby` pointing at the section-count badge; calls `acrClipboardService.copyReadout` on click; emits PostHog `acr_readout_viewed` on mount via `acrTelemetry`; success/failure toast via `EMRToast` (do NOT add a second aria-live region)
- [ ] T040 [P] [frontend-designer] [US1] Create `packages/app/src/emr/components/report/ACRStructuredReadout.module.css` — root section layout, gap tokens, mobile-first base styles (`<768px`) then sm/md enhancements; transition `var(--emr-transition-smooth)` for FR-040 placeholder→content swap; honors `prefers-reduced-motion`

### Wiring into hosts

- [ ] T041 [W] [US1] Wire `ACRStructuredReadout` into `ReportInlineView.tsx` — remove `import FindingsCard from './FindingsCard'` and the `<FindingsCard … />` call site; add `import { ACRStructuredReadout } from './ACRStructuredReadout'`; render `<ACRStructuredReadout analysisId={analysisId} />` in the heuristic-findings position in `packages/app/src/emr/components/report/ReportInlineView.tsx`
- [ ] T042 [frontend-designer] [US1] Modify `packages/app/src/emr/views/cases/AnalysisDetailView.tsx` to host the readout panel — add `const ACRStructuredReadout = React.lazy(() => import('../../components/report/ACRStructuredReadout'))`; render inside the existing `<Suspense fallback={…}>` + `<EMRErrorBoundary>` block, full-width card directly below `main.workspace` and above `footer`; MUST NOT be hidden when theater mode toggles other rails
- [ ] T043 [frontend-designer] [US1] Add a mobile `EMRBottomSheet` trigger for `ACRStructuredReadout` in `AnalysisDetailView.tsx` at the existing `mobileSheetTriggers` row (around line 838); third sheet alongside workspace + FLR sheets at lines 961–1005; trigger label uses `t('reportAcr:openPanel')`
- [ ] T044 [W] [US1] Wire the discoverability tooltip (FR-041) — add a Mantine `Popover` anchored to the Copy button in `ACRStructuredReadout.tsx`; store `liverra.acr.copy-tooltip.seen='1'` in `localStorage` keyed per `useAuth().user.id`; emit `acr_copy_tooltip_seen` and `acr_copy_tooltip_dismissed` via `acrTelemetry`; reuse the `components/onboarding/GuidedTourStep.tsx` styling pattern; tooltip MUST NOT block keyboard focus to the Copy button

### FindingsCard removal

- [ ] T045 [US1] Delete `packages/app/src/emr/components/report/FindingsCard.tsx` and the unused `STEATOSIS_BADGE` constant block; rerun TypeScript compile to confirm zero remaining imports; the ported rules now live in `acrAnatomicalMapping.ts` (T017)

### Unit + integration tests for US1

- [ ] T046 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrPlainTextRenderer.spec.ts` — Vitest unit; asserts deterministic output, NFC normalization, RUO bookends, no markdown chars, fixed section order
- [ ] T047 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrPlainTextRenderer.snapshot.spec.ts` — Vitest `toMatchSnapshot`; 4 locales × 5 scenarios = 20 text snapshots from shared fixtures
- [ ] T048 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrClipboardService.spec.ts` — Vitest unit with mocks for `navigator.clipboard`, fetch, and fake-indexeddb
- [ ] T049 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrClipboardService.indexeddb-queue.spec.ts` — fake-indexeddb queue persistence with attempt_count + last_error
- [ ] T050 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrClipboardService.retry-drain.spec.ts` — simulate audit POST failure → reload → drain → server idempotency via duplicate `client_action_id`
- [ ] T051 [P] [US1] Create `packages/app/src/emr/services/report/__tests__/acrTelemetry.spec.ts` — mocks PostHog; asserts 4 events fire in expected workflow order, required-property presence, forbidden-property absence (no actor identity, no patient identifiers, no copied text)

### E2E tests for US1

- [ ] T052 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/helpers/mock-backend-acr.ts` — extends the existing `helpers/mock-backend.ts` pattern with ACR-specific fixtures (complete, no-lesions, degraded-spleen, stale-finding, partial-payload)
- [ ] T053 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/snapshot-complete.json` — golden ReadoutSnapshot with all 7 findings
- [ ] T054 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/snapshot-no-lesions.json`
- [ ] T055 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/snapshot-degraded-spleen.json`
- [ ] T056 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/snapshot-stale-finding.json`
- [ ] T057 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/fixtures/snapshot-partial-payload.json`
- [ ] T058 [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-us1-radiologist-copy.ts` — Playwright; covers US1 acceptance scenarios 1–5 (six-section order, Copy produces plain text, degraded warning preserved, missing-findings graceful, queued/running placeholder)
- [ ] T059 [P] [US1] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-1-9.ts` — Playwright; covers testing scenarios TS-01 through TS-09 (DOM order, clean text, audit-per-click, locale-at-click, unsupported-locale fallback, degraded across channels, partial payload, surgeon viewport scan, view-only audit) using mock backend + assertions on intercepted POST requests
- [ ] T060 [US1] Run the theming-compliance grep gate locally — `git grep -nE '#([0-9a-fA-F]{3,8})\b' packages/app/src/emr/components/report/ACR` MUST return empty (CI also blocks per T004)

**Checkpoint**: User Story 1 fully functional end-to-end — radiologist can copy structured readout, audit row appears, FindingsCard gone, no hex literals.

---

## Phase 4: User Story 2 — HPB surgeon scans the readout for three numbers (Priority: P1)

**Goal**: A surgeon on a 13" laptop sees FLR %, primary lesion size + class, and steatosis grade within five seconds without scrolling.

**Independent Test**: Open three different finalized analyses on a 1280×800 viewport; for each, locate FLR %, primary lesion size + class, and steatosis grade within five seconds without scrolling.

### Implementation for US2

> Rendering already done in US1 (T032–T040). US2 verifies the surgeon scan pathway is hit; additional UI work is verification + responsive tuning.

- [ ] T061 [frontend-designer] [US2] Verify the responsive layout collapses correctly between 1280×800 (desktop), 1024×768 (tablet), 360×640 (mobile) — visual check that FLR, primary lesion, and steatosis remain above-the-fold on the desktop viewport; adjust gap tokens or section ordering in `ACRStructuredReadout.module.css` (T040) ONLY IF the test in T062 fails
- [ ] T062 [US2] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-us2-surgeon-scan.ts` — Playwright on `chromium-desktop` project at 1280×800; assert `data-testid='flr-percent'`, `data-testid='primary-lesion-size'`, `data-testid='steatosis-grade'` all return `isVisibleInViewport()=true` without scrolling for three fixture analyses

**Checkpoint**: Surgeon viewport scan path verified; readout passes the five-second scan test.

---

## Phase 5: User Story 3 — PDF export mirrors on-screen structure (Priority: P2)

**Goal**: The PDF report organizes findings using the same six anatomical sections in the same order as the on-screen readout, with the same field labels and degraded-warning rendering.

**Independent Test**: Generate a PDF from a finalized analysis; extract the text; compare against the on-screen readout; the heuristic-findings section MUST share section ordering, field labels, units, and warning text.

### Python plain-text renderer (mirror of TS)

- [ ] T063 Create `packages/ml-inference/src/services/export/acr_plaintext_renderer.py` — Python twin of `acrPlainTextRenderer.ts` per `contracts/plaintext-renderer.md` §5; same NFC normalization (`unicodedata.normalize('NFC', value)`); same output format and ordering; byte-equivalent for the same ReadoutSnapshot

### PDF section builder

- [ ] T064 Create `packages/ml-inference/src/services/export/acr_section_builder.py` — `build_acr_sections(findings_dict, lesions, flr, locale) -> dict[AnatomicalSection, list[Mapping]]`; consumes the same `analysis_finding` rows as the screen renderer; uses the canonical mapping (duplicated from TS per Complexity Tracking row 1)
- [ ] T065 [W] Wire `build_acr_sections` into `packages/ml-inference/src/services/report_renderer.py` — invoke adjacent to existing `_build_findings_rows()` at line 555; run both in sequence; `findings_rows` (legacy) kept during transition, `acr_sections` (new) added; pass both to Jinja2 context
- [ ] T066 Modify `packages/ml-inference/src/services/export/pdf_builder.py` — extend `PDFBuildInput` dataclass with `acr_sections: Mapping[str, Sequence[Mapping]] = field(default_factory=dict)`; pass through to the template at the existing render call

### PDF templates (per locale)

- [ ] T067 [P] [frontend-designer] [US3] Modify `packages/ml-inference/src/services/export/pdf_templates/en/report.html` — replace the legacy flat `findings_rows` heuristic-findings section with a six-block ACR layout consuming `acr_sections`; include RUO disclaimer line at the section footer; preserve section ordering: Liver → Lesions → Vessels → Gallbladder → Spleen → FLR Assessment
- [ ] T068 [P] [frontend-designer] [US3] Modify `packages/ml-inference/src/services/export/pdf_templates/de/report.html` — same structural change as T067
- [ ] T069 [P] [frontend-designer] [US3] Modify `packages/ml-inference/src/services/export/pdf_templates/ka/report.html` — same structural change as T067
- [ ] T070 [P] [frontend-designer] [US3] Create `packages/ml-inference/src/services/export/pdf_templates/ru/report.html` — mirror of `en/report.html` adjusted for Russian; medical strings pending CODEOWNERS review

### Print stylesheet

- [ ] T071 [frontend-designer] [US3] Create `packages/app/src/emr/components/report/ACRStructuredReadout.print.module.css` — `@media print` block that: (a) sets `display: block !important` on `[data-testid='acr-readout-root']`; (b) sets `display: none !important` on `.hero`, `.rail`, `.railRight`, `.viewerCard`, `.footer`, the mobile bottom-sheet triggers, the global RUO banner; (c) renders the case-identifier banner and readout-section RUO footer as print-only blocks
- [ ] T072 [W] [frontend-designer] [US3] Wire the print stylesheet into `AnalysisDetailView.tsx` — add `import './ACRStructuredReadout.print.module.css'` (or imported via the readout component) so `Cmd/Ctrl+P` produces the print layout

### Tests for US3

- [ ] T073 [P] [US3] Create `packages/ml-inference/tests/unit/test_acr_section_builder.py` — pytest; asserts mapping correctness for all 7 finding types, fixed section order, empty-section fallback
- [ ] T074 [P] [US3] Create `packages/ml-inference/tests/unit/test_acr_plaintext_renderer.py` — pytest; golden-output parity with the TS renderer for each scenario × locale combination
- [ ] T075 Create `packages/ml-inference/tests/fixtures/acr_snapshots/complete.json`, `no_lesions.json`, `degraded_spleen.json`, `stale_finding.json`, `partial_payload.json` (workspace-symlinked or copied from the TS fixture set in T053–T057)
- [ ] T076 Create `packages/ml-inference/tests/integration/test_acr_pdf_parity.py` — pytest; renders the PDF for each scenario, extracts the heuristic-findings section text via `pdfplumber`, compares against the Python-renderer output for byte-equivalence
- [ ] T077 Create `packages/ml-inference/tests/integration/test_acr_renderer_cross_channel_parity.py` — pytest; runs the TS renderer (via Node subprocess) AND the Python renderer AND PDF extraction over the shared fixtures; asserts byte-equivalence across all three channels for each scenario × locale (THE test that backs Complexity Tracking row 1; release-blocking per T005)
- [ ] T078 Create `packages/app/src/emr/services/report/__tests__/acrPlainTextRenderer.parity.spec.ts` — TS-side companion to T077; reads the same shared fixtures and asserts the TS golden output matches the expected text files under `tests/fixtures/acr_snapshots/expected/`
- [ ] T079 [US3] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-us3-pdf-mirroring.ts` — Playwright; covers US3 acceptance scenarios 1–3 + testing scenario TS-10 (PDF section order matches screen, degraded warning in PDF, print preview)
- [ ] T080 [US3] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-18-print.ts` — Playwright with `emulateMedia({ media: 'print' })`; asserts only the readout + case identifiers + RUO are visible, viewer chrome / rails / canvas hidden

**Checkpoint**: PDF and screen are byte-equivalent for the same locale + analysis state; print works.

---

## Phase 6: User Story 4 — Compliance officer audits every clipboard export (Priority: P2)

**Goal**: Every clipboard export produces a tamper-evident audit row carrying actor identity, role-at-action-time, analysis ID, locale, timestamp.

**Independent Test**: Trigger five copies from three analyses across two users; query the audit chain; five distinct rows appear with correct metadata.

### Backend tests for audit invariants

- [ ] T081 [P] [US4] Create `packages/ml-inference/tests/unit/test_clipboard_export_event.py` — pytest; success-path FHIR AuditEvent shape conformance (type, subtype, action, outcome, agent, entity, extensions)
- [ ] T082 [P] [US4] Create `packages/ml-inference/tests/unit/test_clipboard_export_fhir_conformance.py` — pytest; validates the emitted AuditEvent against the FHIR R4 schema using `fhir.resources` library
- [ ] T083 [P] [US4] Create `packages/ml-inference/tests/unit/test_clipboard_export_failure_variants.py` — pytest; asserts all 5 `failure_category` enum values (`network`, `clipboard_blocked`, `audit_chain_unavailable`, `auth_denied`, `tenant_violation`) produce the correct outcome code AND the failure-category extension
- [ ] T084 [P] [US4] Create `packages/ml-inference/tests/integration/test_clipboard_export_idempotency.py` — pytest; the same `client_action_id` submitted N times produces exactly one chain row and returns the original `audit_event_id` on every replay
- [ ] T085 [P] [US4] Create `packages/ml-inference/tests/integration/test_clipboard_export_chain_continuity.py` — pytest; asserts `leaf_hash = sha256(canonical_json || prev_leaf_hash)` math after insert; asserts the existing tamper-detection trigger fires on UPDATE/DELETE attempts against `audit_event_chain`

### Permission and tenancy tests

- [ ] T086 [P] [US4] Create `packages/ml-inference/tests/integration/test_clipboard_export_view_only_role_captured.py` — pytest; view-only-role copy produces 200 with `view_only` recorded in `agent[0].role`
- [ ] T087 [P] [US4] Create `packages/ml-inference/tests/integration/test_clipboard_export_tenant_violation.py` — pytest; cross-tenant attempt returns 403 AND emits a `tenant_violation` AuditEvent on the actor's home tenant
- [ ] T088 [P] [US4] Create `packages/ml-inference/tests/integration/test_clipboard_export_revoked_mid_session.py` — pytest; access revoked between session start and copy → 401/403 + `auth_denied` AuditEvent with revoked role captured

### PDF failure audit
- [ ] T089 [P] [US4] Create `packages/ml-inference/tests/integration/test_pdf_timeout_audit.py` — pytest; PDF generation timeout produces a user-facing error AND a `failure` audit row with `failure_category=audit_chain_unavailable` (per FR-020c)
- [ ] T090 [P] [US4] Create `packages/ml-inference/tests/integration/test_pdf_failure_audit_row.py` — pytest; PDF generation 5xx → audit row recorded with the same actor/analysis/locale/timestamp; no partial PDF served

### Retention attestation job

- [ ] T091 [US4] Create `packages/ml-inference/src/jobs/audit_retention_attestation.py` — annual scheduled job; counts `audit_event_chain` rows per tenant per year for `subtype=readout-clipboard-export`; writes a signed JSON attestation to the S3 retention bucket; idempotent if run twice in the same year
- [ ] T092 [W] [US4] Schedule the attestation job via APScheduler — add the cron entry to `packages/ml-inference/src/main.py` (or the existing scheduler bootstrap module); annual cadence; failure alerts to Sentry
- [ ] T093 [P] [US4] Create `packages/ml-inference/tests/integration/test_audit_retention_attestation.py` — pytest; asserts (a) DELETE blocked by trigger; (b) attestation job produces signed JSON with correct row counts; (c) rows survive >10-year simulated clock advance

### E2E coverage for compliance flow

- [ ] T094 [US4] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-us4-compliance-audit.ts` — Playwright; covers US4 acceptance scenarios 1–3 (audit row created per copy, view-only audited, audit-failure surfaces warning)
- [ ] T095 [P] [US4] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-10-13.ts` — Playwright; covers testing scenarios TS-10 (PDF order — overlaps US3 but indexed here), TS-11 (running placeholder), TS-12 (audit failure warning), TS-13 (concurrent finalize blocks copy)
- [ ] T096 [P] [US4] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-14-15-permissions.ts` — Playwright; covers TS-14 (tenant boundary) and TS-15 (revoked mid-session) using mock backend authZ failures
- [ ] T097 [P] [US4] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-12-audit-retry-across-reload.ts` — Playwright; routes the audit POST to `abort('failed')`, reloads the page, asserts the queued audit replays with the same `client_action_id`

**Checkpoint**: Compliance officer can produce a date-ranged audit export with full traceability; FR-022 / FR-022a / FR-022b / FR-022c / FR-028 verified.

---

## Phase 7: User Story 5 — Resident, MDT coordinator, referring physician export the readout (Priority: P2)

**Goal**: Non-attending roles can copy the readout; their role-at-action-time is captured distinctly in the audit chain.

**Independent Test**: Three users (resident, coordinator, referring physician) each click Copy on the same analysis; three distinct audit rows appear, each with the correct role.

- [ ] T098 [US5] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-us5-multi-role-export.ts` — Playwright; signs in as resident → Copy → audit row has `actor_role=resident`; repeats for `mdt_coordinator` and `referring_physician`; asserts the date-ranged audit export distinguishes all three

**Checkpoint**: All five user stories are independently functional and audited.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Accessibility, visual regression, performance, monitoring, and Quickstart validation.

### Accessibility

- [ ] T099 Modify `packages/app/tests/a11y/axe-sweep.spec.ts` to append `'/cases/<demo-id>'` (the analysis-detail route with the readout panel rendered) to the `ROUTES` array around line 17–28; run sweep in both color schemes
- [ ] T100 [P] Create `packages/app/tests/a11y/acr-readout-a11y.spec.ts` — discrete Playwright assertions for FR-031: (a) Copy reachable via Tab; (b) success/failure announced via `aria-live='polite'`; (c) warning callouts have a non-color indicator AND meet 4.5:1 contrast; (d) section headers form a logical h1→h2→h3 hierarchy; (e) 44×44 px hit area verified by computed style on `chromium-mobile` project; (f) light AND dark contrast both meet AA
- [ ] T101 [P] Create `packages/app/src/emr/views/__e2e__/acr-readout/test-scenarios-16-17-a11y-theme.ts` — Playwright; covers TS-16 (keyboard-only operability + live-region announcement) and TS-17 (light/dark theme legibility for warnings, headers, values)

### Visual regression

- [ ] T102 [P] Create `packages/app/tests/visual/acr-readout-locale-theme-matrix.spec.ts` — Playwright `toHaveScreenshot`; matrix 4 locales × 2 themes × 2 viewports (1280×720, 360×640) × 4 states (complete, no-lesions, degraded, computing) = 128 screenshots; runs nightly with a release-blocking subset (en + light + 1280×720 across the 4 states)

### Performance budgets

- [ ] T103 [P] Create `packages/app/tests/performance/acr-readout-render-budget.spec.ts` — Playwright; measures the time from `/report/summary` 200 response to first paint of all six section headers; CI-blocking budget 500ms (FR-025) on `chromium-desktop`
- [ ] T104 [P] Create `packages/app/tests/performance/acr-clipboard-copy-budget.spec.ts` — Playwright; measures the time from Copy click to `clipboard.writeText` resolved; CI-blocking budgets 200ms @ 20 lesions and 1s @ 100 lesions (FR-026); uses `performance.now()` spans

### Operational monitoring

- [ ] T105 Configure a Sentry alert rule: `POST /api/v1/analyses/*/report/clipboard-export 5xx rate > 1% over 5 minutes` → PagerDuty notification
- [ ] T106 Configure a PostHog dashboard tile reconciling `acr_clipboard_copy_succeeded` event count against the server `audit_event_chain` row count for `subtype=readout-clipboard-export`; alert if 24h discrepancy > 0.5%
- [ ] T107 Add a `pendingQueueDepth` property to the `acr_clipboard_copy_succeeded` event in `acrTelemetry.ts` (read from IndexedDB at copy time) and configure an alert if the 95th-percentile across the fleet exceeds 5

### Quickstart + documentation

- [ ] T108 Update `specs/002-acr-structured-readout/quickstart.md` step 5 — replace the manual PDF-vs-screen diff with: "Run `pytest packages/ml-inference/tests/integration/test_acr_renderer_cross_channel_parity.py -v` which automatically asserts three-way byte-equivalence; manual eyeball is not part of release evidence."
- [ ] T109 Run the full Quickstart validation end-to-end against a real Todua-CT analysis: bring up local stack, trigger cascade, verify all 10 quickstart steps pass; record results in a `quickstart-validation-2026-MM-DD.md` log file in the feature dir
- [ ] T110 Update `CLAUDE.md` at the repo root to note the new feature is live (one line under "Active Features" section, run via the agent-context script: `.specify/scripts/bash/update-agent-context.sh claude`)

**Checkpoint**: All accessibility, visual, performance, and monitoring gates active; quickstart validates end-to-end; release-blocking CI passes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately.
- **Foundational (Phase 2)**: Depends on Setup. BLOCKS all user-story phases.
- **User Story 1 (Phase 3)**: Depends on Foundational. MVP — can ship alone.
- **User Story 2 (Phase 4)**: Depends on US1 rendering (T032–T040) being in place; otherwise verification-only.
- **User Story 3 (Phase 5)**: Depends on Foundational; uses Phase 2 ETag/HEAD work and US1 anatomical mapping. Can run in parallel with US4.
- **User Story 4 (Phase 6)**: Depends on Foundational + US1 backend endpoint (T029) + audit-emission code (T028).
- **User Story 5 (Phase 7)**: Depends on US4 audit infrastructure.
- **Polish (Phase 8)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 (P1, MVP)**: Independent — only Foundational required.
- **US2 (P1)**: Verification of US1 rendering; could be folded into US1 testing if scope tightens.
- **US3 (P2)**: Independent of US1 frontend (PDF is server-side); shares the canonical mapping.
- **US4 (P2)**: Independent; depends only on the audit POST endpoint being callable.
- **US5 (P2)**: Independent; same audit infrastructure as US4.

### Within Each User Story

- Translations registered → renderer + clipboard service → section components → wire into hosts → tests.
- Tests for the same story run in parallel where possible.
- **Wiring rule**: every `Create [service / hook / utility / component]` task in this file has a matching `[W]` task linking it to its consumer. Wiring tasks are NEVER parallel against their producers.

---

## Parallel Execution Examples

### Phase 2 — Foundational (parallelizable across translation bundles + i18n tests)

After T006 (namespace registered) is committed, run in parallel:

- T007 en/reportAcr.json
- T008 de/reportAcr.json
- T009 ka/reportAcr.json
- T010 ru/reportAcr.json
- T020 i18n key parity test
- T021 no-TODO-translate test
- T022 renderer-key coverage test
- T023 acrAnatomicalMapping.spec.ts

### Phase 3 — US1 section components (parallelizable across files)

After T032 shared CSS is committed:

- T033 ACRSectionLiver.tsx
- T034 ACRSectionLesions.tsx
- T035 ACRSectionVessels.tsx
- T036 ACRSectionGallbladder.tsx
- T037 ACRSectionSpleen.tsx
- T038 ACRSectionFLR.tsx

### Phase 3 — US1 unit tests (parallel)

- T046 acrPlainTextRenderer.spec.ts
- T047 acrPlainTextRenderer.snapshot.spec.ts
- T048 acrClipboardService.spec.ts
- T049 acrClipboardService.indexeddb-queue.spec.ts
- T050 acrClipboardService.retry-drain.spec.ts
- T051 acrTelemetry.spec.ts

### Phase 5 — PDF templates (parallel across locales)

- T067 en/report.html
- T068 de/report.html
- T069 ka/report.html
- T070 ru/report.html (new)

### Phase 6 — Audit tests (parallel)

- T081 success-path shape
- T082 FHIR conformance
- T083 failure variants
- T084 idempotency
- T085 chain continuity
- T086 view-only role
- T087 tenant violation
- T088 revoked mid-session
- T089 PDF timeout audit
- T090 PDF failure audit row

---

## Implementation Strategy

**Recommended path**:

1. **Sprint 1 — Foundational + US1 MVP** (Phases 1 + 2 + 3): the radiologist copy workflow lands fully functional with audit logging. This is the shippable MVP — every other phase enhances it.
2. **Sprint 2 — US3 PDF parity** (Phase 5): unlocks the PDF interchange flow. Cross-channel parity test becomes release-blocking.
3. **Sprint 3 — US4 compliance suite + US5 multi-role** (Phases 6 + 7): completes regulatory-evidence coverage for CE MDR Class IIb.
4. **Sprint 4 — Polish** (Phase 8): accessibility, visual regression, performance budgets, operational monitoring, Quickstart validation.

**MVP scope (ship alone)**: Phases 1 + 2 + 3 only. Even without PDF mirroring or full audit coverage, the structured readout + clipboard + per-click audit row delivers the killer-feature value to radiologists. PDF and compliance flows enhance — they don't gate.

---

## Wiring Checklist (validate before phase completion)

Every `Create [service|hook|utility|component]` task above has a matching `[W]` task connecting it to a consumer:

| Producer | Consumer | Wire task |
|---|---|---|
| T013 reportSummary.ts | ReportInlineView.tsx | T014 |
| T015 useReportSummary.ts | ReportInlineView.tsx | T016 |
| T015 useReportSummary.ts | ACRStructuredReadout.tsx | bundled into T039 |
| T017 acrAnatomicalMapping.ts | ACRStructuredReadout.tsx, ACRSection*.tsx | bundled into T039 + T033–T038 |
| T024 acrPlainTextRenderer.ts | acrClipboardService.ts | bundled into T025 |
| T025 acrClipboardService.ts | ACRStructuredReadout.tsx | bundled into T039 |
| T026 acrTelemetry.ts | ACRStructuredReadout.tsx + acrClipboardService.ts | bundled into T039 + T025 |
| T028 clipboard_export_event.py | new POST endpoint | T030 |
| T032 ACRSection.module.css | ACRSection*.tsx | bundled into T033–T038 |
| T033–T038 ACRSection*.tsx | ACRStructuredReadout.tsx | bundled into T039 |
| T039 ACRStructuredReadout.tsx | ReportInlineView.tsx | T041 |
| T039 ACRStructuredReadout.tsx | AnalysisDetailView.tsx | T042 + T043 + T044 |
| T063 acr_plaintext_renderer.py | test_acr_renderer_cross_channel_parity.py | T077 (consumer is the test itself) |
| T064 acr_section_builder.py | report_renderer.py | T065 |
| T071 print stylesheet | AnalysisDetailView.tsx | T072 |
| T091 audit_retention_attestation.py | APScheduler in main.py | T092 |
| T011 LIVERRA_EXTENSIONS additions | acrClipboardService.ts | T031 |

**Orphans detected**: 0 — every artifact created has a documented consumer site.

---

## Task Summary

- **Total tasks**: 110
- **Phase 1 Setup**: 5 (T001–T005)
- **Phase 2 Foundational**: 18 (T006–T023)
- **Phase 3 US1 MVP**: 37 (T024–T060)
- **Phase 4 US2**: 2 (T061–T062)
- **Phase 5 US3 PDF**: 18 (T063–T080)
- **Phase 6 US4 Compliance**: 17 (T081–T097)
- **Phase 7 US5 Multi-role**: 1 (T098)
- **Phase 8 Polish**: 12 (T099–T110)

- **Parallel-tagged [P]**: 49
- **Wire-tagged [W]**: 8 explicit + 11 bundled = 19 wiring touchpoints documented
- **Frontend-designer tasks**: 20
- **MVP scope (US1 alone)**: 60 tasks across Phases 1–3 (T001–T060)
- **Test tasks**: 39 (covering FR-038 release gate)
- **Format validation**: every task line follows `- [ ] T### [labels] description with file path`
