# Implementation Plan: Structured ACR-Style Radiologic Readout

<!-- UPGRADED -->

**Branch**: `002-acr-structured-readout` | **Date**: 2026-05-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-acr-structured-readout/spec.md`

## Summary

Render the seven already-persisted Phase 1 heuristic findings as six fixed ACR/RSNA anatomical sections (Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment) on the analysis detail view AND the inline report view AND the PDF AND a copy-to-clipboard plain-text export. The clipboard export emits an auditable FHIR R4 `AuditEvent` participating in the existing tamper-evident chain. Every export carries the Research Use Only disclaimer.

**Technical approach**: Pure rendering + audit-emission feature. Zero changes to the cascade, zero new finding types, zero new migrations to the `analysis_finding` table. One new `AuditCategory` enum value. One canonical anatomical-section mapping shared by the React renderer, the Jinja2 PDF template renderer, and a plain-text serializer. New translation namespace `reportAcr.*` in en/de/ka/ru with the `__TODO_TRANSLATE__:` convention for `de`/`ka`/`ru` medical terms pending CODEOWNERS review.

**Reference architecture**: The closest existing analog is `packages/app/src/emr/components/report/FindingsCard.tsx` + `ReportInlineView.tsx`. The new ACR readout REPLACES `FindingsCard.tsx` while reusing the wider pattern (TanStack Query data fetch → `EMR*` component primitives → `report` translation namespace → optional PDF render path). Before deletion, the implicit display rules in `FindingsCard.tsx` (badge color maps, "skip steatosis grade=none" filter, splenomegaly badge logic, gallbladder flag concatenation) are ported verbatim into `acrAnatomicalMapping.ts` so behavior is preserved.

## Technical Context

**Language/Version**: TypeScript 5 strict (frontend), Python 3.11 (PDF render)
**Primary Dependencies**: React 19 + Mantine 7 + TanStack Query (frontend); FastAPI + Jinja2 + existing PDF builder (Python); existing `AuditChainWriter` infrastructure; existing PostHog client; existing `idb` (IndexedDB wrapper)
**Storage**: PostgreSQL — reuses `analysis_finding` table (migration 0013) and `audit_event_chain` table (migration 0005); no new tables; one new `audit_category` enum value (Postgres CHECK constraint update required)
**Testing**: Vitest + React Testing Library (frontend unit), Playwright (E2E + a11y + visual + performance), pytest (Python unit + integration), `fake-indexeddb` for IndexedDB unit tests, `@axe-core/playwright` (already wired), `pdfplumber` (PDF text extraction for parity)
**Target Platform**: Web (Chrome/Edge/Safari/Firefox latest), responsive down to mobile (`<768px`); iPad Safari clipboard API support required
**Project Type**: Web application (monorepo packages: `app` frontend, `ml-inference` Python services, `core` types)
**Performance Goals**: readout render ≤500ms (FR-025); clipboard copy ≤200ms (≤20 lesions) / ≤1s (≤100 lesions) (FR-026); PDF section render adds ≤1s to existing PDF generation budget
**Constraints**: must inherit existing tenant authorization boundary; clipboard write must function on iOS/iPadOS Safari; audit emission must survive transient network failure via durable retry; cross-channel parity (screen/PDF/clipboard) byte-equivalent for same locale + state; performance budgets enforced via CI, not just informational
**Scale/Scope**: 0–100 lesions per analysis; 7 finding types → 6 anatomical sections; 4 locales (en/de/ka/ru); ~52 functional requirements + 18 testing scenarios from the upgraded spec

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| **I. Spec-Driven Development** | ✅ PASS | Spec exists, upgraded to v2 with 52 FRs. This plan is the next mandated artifact. |
| **II. Apache 2.0 Model Licensing** | ✅ N/A | No model integration. Pure rendering feature. |
| **III. Cascaded Inference Architecture** | ✅ N/A | No cascade change. |
| **IV. FHIR-First Healthcare Data** | ✅ PASS | FR-030 mandates FHIR R4 `AuditEvent` with extensions registered in `LIVERRA_EXTENSIONS` (`packages/app/src/emr/constants/fhir-extensions.ts`). AuditEvent is in the v1 canonical resource vocabulary. |
| **V. Auditability & Regulatory Traceability** | ✅ PASS | FR-017..FR-020c capture actor, role-at-action-time, analysis, locale, timestamp; FR-028 mandates 10-year retention enforced by an annual attestation job; PHI scope explicit (FR-020, FR-034). |
| **VI. Research Use Only Until CE Mark** | ✅ PASS | FR-027 makes RUO disclaimer binding on every surface (screen, PDF, clipboard first and last line). |
| **VII. Security, Privacy & Data Residency** | ✅ PASS | FR-022b tenant boundary inheritance; FR-034 forbids identifying patient data in clipboard/PDF section; existing AuthZ path reused at `analysis.py` endpoint. |
| **VIII. Type Safety & Strict Mode** | ✅ PASS | Plan adopts strict TS for frontend renderer + Pydantic models for the audit-event payload + Python type hints for PDF section builder. |
| **IX. Unified Design System** | ✅ PASS | FR-032 explicitly requires semantic color variables + EMR component library, forbidden hex blues, dark-mode parity, mobile-first (FR-035). Component bindings enumerated in Phase 1. |
| **X. Internationalization** | ✅ PASS | All four constitution-required locales (`en/de/ka/ru`) are already declared in `TranslationContext.tsx` (lines 45–47) and `localeService.ts` (lines 19–22). The plan ships all four bundles; `de/ka/ru` use the `__TODO_TRANSLATE__:` convention until medical CODEOWNERS review. |

**Gate verdict**: ✅ PASS — proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/002-acr-structured-readout/
├── spec.md                  # Feature specification (upgraded v2)
├── plan.md                  # This file
├── research.md              # Phase 0 — design decisions
├── data-model.md            # Phase 1 — entity & payload shapes
├── contracts/               # Phase 1 — public interface contracts
│   ├── audit-event.md         # FHIR AuditEvent payload contract
│   ├── readout-api.md         # /report/summary contract additions
│   └── plaintext-renderer.md  # Plain-text serializer contract
├── quickstart.md            # Phase 1 — local dev quickstart
├── checklists/
│   └── requirements.md      # Spec quality validation
└── tasks.md                 # Phase 2 — /speckit.tasks output (not created here)
```

### Source Code (repository root)

**Convention reminder**: All `.tsx`, `.module.css`, `.css`, and `.print.module.css` deliverables below are **[frontend-designer]**-owned per CLAUDE.md and Constitution IX. `/speckit.implement` MUST invoke the `frontend-designer` agent for each, not write them directly. `.ts` (non-tsx) services, Python modules, and tests are normal `coder`-agent territory.

```text
packages/app/                                                              # Vite + React 19 + Mantine 7 frontend
├── src/emr/
│   ├── components/report/
│   │   ├── ACRStructuredReadout.tsx                                       # NEW [frontend-designer] — six-section renderer; wrapped in EMRErrorBoundary + React.lazy + Suspense by host
│   │   ├── ACRStructuredReadout.module.css                                # NEW [frontend-designer]
│   │   ├── ACRStructuredReadout.print.module.css                          # NEW [frontend-designer] — print-only @media print rules suppressing viewer chrome, rails, footer; imported by AnalysisDetailView.tsx
│   │   ├── ACRSectionLiver.tsx                                            # NEW [frontend-designer]
│   │   ├── ACRSectionLesions.tsx                                          # NEW [frontend-designer]
│   │   ├── ACRSectionVessels.tsx                                          # NEW [frontend-designer] — renders existing <StageImage stage='vessels' /> (already at report/render/vessels endpoint, used in ReportInlineView.tsx line 305) as visible content; structural heading always present per FR-002
│   │   ├── ACRSectionGallbladder.tsx                                      # NEW [frontend-designer]
│   │   ├── ACRSectionSpleen.tsx                                           # NEW [frontend-designer]
│   │   ├── ACRSectionFLR.tsx                                              # NEW [frontend-designer]
│   │   ├── ACRSection.module.css                                          # NEW [frontend-designer] — shared section-card styles
│   │   ├── ReportInlineView.tsx                                           # MODIFY [frontend-designer] — swap FindingsCard for ACRStructuredReadout; extract ReportSummary + fetchReportSummary to shared module (see services/report/reportSummary.ts)
│   │   └── FindingsCard.tsx                                               # DELETE in same release (replacement contract per Assumptions); port implicit display rules into acrAnatomicalMapping.ts first
│   ├── services/report/
│   │   ├── reportSummary.ts                                               # NEW — extracted from ReportInlineView.tsx local scope; exports ReportSummary interface + fetchReportSummary(analysisId); the canonical wire-shape source consumed by both old and new renderers
│   │   ├── acrAnatomicalMapping.ts                                        # NEW — single canonical finding→section mapping (FR-024b); also ports STEATOSIS_BADGE color map, "grade===none filter", splenomegaly/gallbladder badge logic from FindingsCard.tsx verbatim
│   │   ├── acrPlainTextRenderer.ts                                        # NEW — pure transform: ReadoutSnapshot → plain text; NFC normalization at boundary
│   │   ├── acrClipboardService.ts                                         # NEW — clipboard write + audit-event POST + IndexedDB durable retry (reuses idb pattern from services/offline/offlineQueue.ts: lazy singleton, ULID keys, attempt_count + last_error)
│   │   └── acrTelemetry.ts                                                # NEW — thin wrapper around capture() from services/telemetry/postHogClient.ts; 4 events MUST be added to BOTH the PostHogEventName union AND POSTHOG_EVENTS runtime array in services/telemetry/events.ts
│   ├── hooks/
│   │   └── useReportSummary.ts                                            # NEW — TanStack Query wrapper over fetchReportSummary; 60s staleTime; ETag tracking for concurrency gate; consumed by BOTH ACRStructuredReadout and modified ReportInlineView
│   ├── contexts/
│   │   └── TranslationContext.tsx                                         # MODIFY — append `| 'reportAcr'` to TranslationNamespace union (line ~59) AND `'reportAcr'` to TRANSLATION_NAMESPACES readonly tuple (line ~90). NO Locale-type edit (en/de/ka/ru already present at lines 45,47). No localeService.ts edit (Locale + SUPPORTED_LOCALES already correct at lines 19,21).
│   ├── translations/{en,de,ka,ru}/
│   │   └── reportAcr.json                                                 # NEW — namespace `reportAcr.*` per locale; de/ka/ru use __TODO_TRANSLATE__: until medical CODEOWNERS sign off
│   ├── constants/
│   │   └── fhir-extensions.ts                                             # MODIFY — append new LIVERRA_EXTENSIONS keys: audit-locale, audit-tenant, audit-client-action-id, audit-failure-category; hardcoded extension URLs forbidden elsewhere per file-header convention
│   ├── views/cases/
│   │   └── AnalysisDetailView.tsx                                         # MODIFY [frontend-designer] — host the readout panel below main.workspace, above footer (NOT inside theater mode toggle); import ACRStructuredReadout.print.module.css; add third EMRBottomSheet for mobile <768px alongside existing workspace + flr sheets (see AnalysisDetailView.tsx:961-1005 pattern); add print-mode rules
│   └── (theme.css unchanged unless a new semantic warning token is needed; check existing var(--emr-bg-warning) / var(--emr-text-warning) first)
└── (test trees consolidated under Testing Strategy)

packages/core/                                                             # Shared types
└── src/types/audit.ts                                                     # MODIFY — append `ReadoutClipboardExport` to AuditCategory enum; update the "exactly 24 members" comment to 25; bump any per-category invariants

packages/ml-inference/                                                     # Python FastAPI services
├── src/services/export/
│   ├── pdf_templates/
│   │   ├── en/report.html                                                 # MODIFY [frontend-designer] — heuristic-findings section grouped by ACR; renders acr_sections dict alongside legacy findings_rows (kept during transition, removed in same PR if frontend swap is clean)
│   │   ├── de/report.html                                                 # MODIFY [frontend-designer]
│   │   ├── ka/report.html                                                 # MODIFY [frontend-designer]
│   │   └── ru/report.html                                                 # NEW [frontend-designer]
│   ├── acr_section_builder.py                                             # NEW — build_acr_sections(findings_dict, locale) → dict; invoked adjacent to existing _build_findings_rows() at report_renderer.py:555; the two run in sequence and feed Jinja2 in the same PDFBuildInput
│   ├── acr_plaintext_renderer.py                                          # NEW — Python twin of TS acrPlainTextRenderer; byte-equivalent output for the same ReadoutSnapshot per contracts/plaintext-renderer.md §5
│   └── pdf_builder.py                                                     # MODIFY — extend PDFBuildInput dataclass with acr_sections: Mapping[str, Sequence[Mapping]] field; pass through to template
├── src/api/
│   └── analysis.py                                                        # MODIFY — (a) extend GET /report/summary handler at line ~1164 to include updated_at: ISO8601 in body AND emit strong ETag header derived from sha256(updated_at || finding_count); (b) add HEAD /report/summary reusing handler via Response media-type switch; (c) add new POST /api/v1/analyses/{id}/report/clipboard-export endpoint (domain action; audit-chain row is a side-effect via AuditChainWriter, matching cancel/retry pattern at _emit_analysis_audit lines 261-300, NOT a new /audit/ route family)
├── src/services/audit/
│   ├── clipboard_export_event.py                                          # NEW — emits AuditEvent into existing audit_event_chain via AuditChainWriter; FHIR R4 shape per contracts/audit-event.md
│   └── (fhir_extensions constants module — verify or add matching Python-side registry parallel to fhir-extensions.ts)
├── src/jobs/
│   └── audit_retention_attestation.py                                     # NEW — annual scheduled job; counts audit_event_chain rows per tenant per year; writes signed JSON attestation to S3 retention bucket (FR-028)
└── (tests consolidated under Testing Strategy)
```

**Structure Decision**: Web-application layout reusing the existing monorepo split. **Frontend** owns the rendering, clipboard write, plain-text serialization, and product-analytics emission. **Backend** owns the audit-event persistence into the existing tamper-evident chain and the PDF template wiring. The shared anatomical-section mapping is duplicated in TS and Python on purpose — the contract is a stable enumeration, and synchronizing it via a shared schema is over-engineering for 7 finding types. Drift is prevented by the cross-channel parity test (see Testing Strategy).

### Concrete UI placement on AnalysisDetailView

- **Desktop / tablet (≥768px)**: render `ACRStructuredReadout` as a new full-width card directly **below** the `main.workspace` element (after the viewer + rails row) and above the bottom `footer` block. The card MUST NOT be hidden when theater mode is active — the readout is a primary radiologist surface, not viewer chrome.
- **Mobile (<768px)**: expose via a third `EMRBottomSheet` triggered by an additional button in the `mobileSheetTriggers` row at `AnalysisDetailView.tsx:838`, adjacent to the existing workspace + FLR sheets at lines 961–1005. The trigger label uses `t('reportAcr:openPanel')`.
- **No new route, no new menu**: routes `LIVERRA_ROUTES.CASE_DETAIL` (`/cases/:id`) and `LIVERRA_ROUTES.REPORT_VIEW` (`/reports/:id`) already exist; no changes to `routes.ts`, `AppRoutes.tsx`, or `permissions.gen.ts`. No `EMRTabs drawerTab` items modified.

### Component-library binding (Phase 1) — [frontend-designer]

All `ACRSection*` components MUST bind to existing wrappers from `packages/app/src/emr/components/common/`. Raw Mantine imports (`Card`, `Button`, `Modal`, etc.) are forbidden in the new files. Bindings:

| Element | Wrapper |
|---|---|
| Section container | `EMRCard` with `withBorder padding='md'` |
| Loading state per section | `EMRSkeleton` rows mirroring the section layout |
| Empty per-section status line | inline localized status text — NOT a full-card `EMREmptyState` |
| Section-scoped error fallback | `EMRAlert variant='error' size='sm'` with retry callback |
| Degraded-quality warning callout | `EMRAlert variant='warning'` adjacent to affected value |
| Panel-level error boundary | `EMRErrorBoundary` wrapping the readout root + `EMRErrorCard` fallback |
| Copy button | `EMRButton variant='primary'` (NOT raw Mantine Button) |
| Copy success/failure announcement | `EMRToast.success(...)` / `EMRToast.error(...)` — already aria-live polite (`EMRNotificationCenter.tsx:398`); do NOT add a second aria-live `<div>` |
| Per-finding badges | `EMRBadge` |
| First-time tooltip (FR-041) | reuse `GuidedTourStep`-style Mantine `Popover` pattern; `localStorage` key `liverra.acr.copy-tooltip.seen='1'` namespaced per user-id |

### Per-section state matrix

Each `ACRSection*` component handles four explicit states — NEVER `return null` (FindingsCard's wrong default):

1. **Loading** — `useReportSummary.isLoading` OR analysis status ∈ {`running`, `queued`} → `EMRSkeleton` rows; section header still visible (FR-040).
2. **Empty** — section has zero findings → render localized neutral status line `t('reportAcr:status.noFindings')` inline; section header still visible (FR-004).
3. **Error** — payload malformed or section-scoped fetch failed → `EMRAlert variant='error' size='sm'` inline with retry callback (FR-033).
4. **Degraded** — finding present but `warning` field non-empty → `EMRAlert variant='warning'` adjacent to value (FR-007).

### Mobile-first authorship rules

- Every `ACRSection*.module.css` declares base styles for `<768px` viewports (single column, full-width card, `min-height: 44px` for Copy button, `font-size: var(--emr-font-md)` ≥ 16px per Constitution IX).
- Tablet enhancements gated on `@media (min-width: 768px)` (sm).
- Desktop on `@media (min-width: 992px)` (md).
- Clipboard write MUST be tested on iOS / iPadOS Safari (FR-035); fallback to `document.execCommand('copy')` via a hidden textarea when `navigator.clipboard` is unavailable or denied.

### Typography + heading hierarchy

- `<h1>` is the existing page title (`AnalysisDetailView.hero` `styles.heroTitle:757`).
- `ACRStructuredReadout` wraps everything in `<section aria-labelledby='acr-readout-heading'>` with a visually-hidden `<h2 id='acr-readout-heading'>` using `t('reportAcr:panelHeading')`.
- Each `ACRSection*` renders its title as `<h3>` with `font-size: var(--emr-font-lg)`, `font-weight: 600`.
- Field labels: `var(--emr-font-sm)` weight 500.
- Values: `var(--emr-font-sm)` weight 400 dimmed.
- Degraded warnings: `var(--emr-font-sm)` weight 500 in `var(--emr-text-warning)`.

### Flexbox text-overflow rules

Per CLAUDE.md and verified anti-pattern at `FindingsCard.tsx:104-128`:

- Per-finding row: outer `<Group justify='space-between' wrap='wrap'>` (never `wrap='nowrap'`).
- Label cluster on the left: `style={{ flex: 1, minWidth: 0 }}` for graceful truncation.
- Badges + warning icons: `style={{ flexShrink: 0 }}`.
- Labels with units: `whiteSpace: 'nowrap'`.
- Copy button at the panel header: `flexShrink: 0`.
- Long Couinaud labels in Georgian (FR-013a combining diacritics) MUST NOT be truncated; if they overflow, wrap to the next line.

### Theming compliance gate

Before any `ACRSection*` PR merges:

```bash
git grep -nE '#([0-9a-fA-F]{3,8})\b' packages/app/src/emr/components/report/ACR
# Output MUST be empty.
```

Also CI-enforced in `.github/workflows/lint.yml`. Forbidden literals to block specifically: `#3b82f6`, `#60a5fa`, `#2563eb`, `#4267B2`, `#b45309`, `#1e40af`, `#f59e0b` (last three are the bugs that already snuck into `FindingsCard.tsx:106-107`). Warning callouts MUST use `var(--emr-bg-warning)` / `var(--emr-text-warning)` (already present in `theme.css`); if a token is missing, add it under both `:root[data-mantine-color-scheme='light']` and `:root[data-mantine-color-scheme='dark']` FIRST and only then consume from the component.

### Motion policy

- FR-040 placeholder→content swap uses a 200ms opacity cross-fade with `transition: var(--emr-transition-smooth)` (existing token).
- The toast on copy success uses `EMRToast`'s built-in slide animation (no override).
- All animations MUST be suppressed under `@media (prefers-reduced-motion: reduce)` — already enforced globally at `theme.css:2786`.
- No new keyframes are introduced.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Duplicating anatomical-section mapping in TS and Python** | The mapping is 7 entries → 6 sections, immutable, and read once per render. Generating it from a shared JSON schema or proto would add a build-time codegen step for a one-time gain. | Drift is caught by the cross-channel parity test (TS renderer → Python renderer → PDF text extraction — all three must be byte-equivalent). The cost of codegen tooling exceeds the cost of the test. |
| **Adding a 25th `AuditCategory` enum member** | The existing enum comment at `packages/core/src/types/audit.ts:10` declares "exactly 24 members" and warns that adding a new category requires touching Postgres CHECK constraints. We need the new category to satisfy FR-018 (chain participation). | Reusing an existing category (e.g., `ReportExport`) would conflate semantically distinct events and make compliance reconciliation harder. The migration overhead (one CHECK constraint update + one comment edit) is one-time and cheap. |

No other constitutional violations. (The earlier Constitution X i18n "deviation" claim was wrong — `en/de/ka/ru` are all already registered runtime locales per `TranslationContext.tsx` and `localeService.ts`. Row removed.)

## Phase 0 — Outline & Research

Resolved in `research.md`. Key decisions (with corrections from architecture audit):

1. **Clipboard API approach**: `navigator.clipboard.writeText` with legacy `execCommand` fallback gated by feature detection (iOS Safari compatibility).
2. **Audit emission ordering**: optimistic clipboard write → audit POST → toast (per FR-020a). Failure path queues to IndexedDB **via the existing `idb`-based pattern at `services/offline/offlineQueue.ts`** (lazy singleton, ULID keys, attempt_count + last_error) for next-session retry (FR-020b). Do NOT add `idb-keyval` or a second IndexedDB wrapper.
3. **Plain-text format**: section headers ALL-CAPS in en, locale-appropriate emphasis in de/ka/ru; blank-line separators; indented sub-items; RUO first and last line; NFC unicode normalization.
4. **PDF parity**: `acr_section_builder.py` is invoked from `report_renderer.py` **adjacent to** the existing `_build_findings_rows()` at line 555. The two run in sequence: `_build_findings_rows()` for the legacy flat-list rendering (kept during transition), then `build_acr_sections()` for the new grouped rendering. `PDFBuildInput` dataclass in `pdf_builder.py` gains a new `acr_sections: Mapping[str, Sequence[Mapping]] = field(default_factory=dict)` field.
5. **Concurrency detection wire format**: GET `/report/summary` handler at `analysis.py:1164` is extended to include `updated_at: ISO8601` in the body AND emit a strong `ETag` header derived from `sha256(updated_at || finding_count)`. A new `HEAD /report/summary` returns only headers (no body). Clipboard service captures ETag at render time, issues a `HEAD` immediately before audit POST; on mismatch blocks copy with "data changed — refresh" toast.
6. **Translation namespace registration**: a two-line edit in `TranslationContext.tsx` — append `| 'reportAcr'` to `TranslationNamespace` union (line ~59) AND `'reportAcr'` to `TRANSLATION_NAMESPACES` readonly tuple (line ~90). `localeService.ts` requires NO change (Locale + SUPPORTED_LOCALES already enumerate `en/de/ka/ru`, verified 2026-05-13). `bundleCache`/`inFlight` per-locale objects auto-resolve.
7. **Audit category + endpoint shape**: add `ReadoutClipboardExport` to `AuditCategory` in `packages/core/src/types/audit.ts`, updating the "exactly 24 members" comment to 25 AND any Postgres CHECK constraint or enum on the audit table. Endpoint is `POST /api/v1/analyses/{id}/report/clipboard-export` (**domain action**, not `/audit/` route family) — matches the existing pattern at `analysis.py:_emit_analysis_audit` lines 261-300 where audit-chain rows are side-effects of domain actions like `cancel`/`retry`. Server-side `AuditChainWriter` does the chain append.
8. **FindingsCard disposition**: replace and delete in the same PR series. **Before deletion**, port the implicit display rules into `acrAnatomicalMapping.ts` verbatim: `hu_stats` value format (`mean ${hu.mean.toFixed(0)} HU · range ${p10}–${p90} HU`), STEATOSIS_BADGE color map (none=gray/mild=yellow/moderate=orange/severe=red), `steatosis.grade === 'none'` filter rule (skip the row entirely — line 153), splenomegaly badge-and-warn logic, gallbladder flag concatenation. Name these explicitly in code comments so behavior is preserved.
9. **Shared `ReportSummary` extraction**: `ReportInlineView.tsx`'s local `ReportSummary` interface (lines 46–83) and `fetchReportSummary` (line 85) are extracted to a new `services/report/reportSummary.ts`. A new `useReportSummary(analysisId)` hook (`hooks/useReportSummary.ts`) is a TanStack Query wrapper with 60s staleTime + ETag tracking. BOTH `ReportInlineView.tsx` and `ACRStructuredReadout.tsx` consume the hook — single source of truth for the wire shape (enforces FR-024a).
10. **FHIR extensions in central registry**: every new `StructureDefinition` URL the audit event uses (`audit-locale`, `audit-tenant`, `audit-client-action-id`, `audit-failure-category`) MUST be added to `LIVERRA_EXTENSIONS` in `fhir-extensions.ts` (frontend) AND a matching Python constants module under `packages/ml-inference/src/services/audit/`. The audit-event payload references extensions BY KEY, never by literal URL string — per file-header convention.

## Phase 1 — Design & Contracts

**Prerequisites**: research.md complete.

### Data model (`data-model.md`)

Captures the four entities from the spec (Anatomical Section, Anatomical-Section Mapping, Finding, Clipboard Export Event, Readout Plain-Text Renderer) as TypeScript and Python type shapes, plus the exact JSON payload of the new audit event and the row-level expectations on `analysis_finding` (read-only — no schema changes). Clipboard-export ephemeral state lives in component-local `useState`, NOT in `AnalysisContext` — the state is render-instance-scoped (two simultaneous mounts each track their own copy attempts); IndexedDB retry queue is the shared persistence keyed by `analysis_id + client_action_id`.

### Contracts (`contracts/`)

Three documents:
- **`audit-event.md`** — FHIR R4 AuditEvent payload shape for `ReadoutClipboardExport`, including required fields, the locale extension URL, role-at-action-time capture, and the failure-event variant.
- **`readout-api.md`** — additive surface on existing `GET /api/v1/analyses/{id}/report/summary` (no breaking change): asserts `findings`, `lesions`, `flr`, `updated_at` are returned with `ETag` header; specifies `HEAD` semantics; introduces `POST /api/v1/analyses/{id}/report/clipboard-export` (domain action with audit-chain side effect).
- **`plaintext-renderer.md`** — pure-function contract: input `{findings, lesions, flr, locale, ruoEnabled}` → output `string`. Specifies header casing, separators, list formatting, RUO placement, unicode normalization (NFC), no-truncation guarantee, byte-equivalence with the Python twin renderer and the PDF section text.

### Agent context update

Run `.specify/scripts/bash/update-agent-context.sh claude` to refresh `CLAUDE.md`'s "Active Features" markers (preserves all manual additions). Already executed during initial plan write.

### Quickstart (`quickstart.md`)

Step-by-step: bring up the local stack (Postgres + Redis + MinIO + Orthanc per CLAUDE.md), run a cascade against the Todua-CT sample, open analysis detail, verify all six sections render, click Copy, confirm the audit event appears in the chain, **run the automated cross-channel parity test** (NOT a manual diff) and switch locale to re-verify parity.

## Testing Strategy

### Test infrastructure conventions (verified on disk 2026-05-13)

- **Playwright config**: `packages/app/playwright.config.ts` — `testDir: './src/emr/views/__e2e__'`, `testMatch: /test-.*\.ts$/`. ALL E2E test files MUST live under `src/emr/views/__e2e__/<feature-slug>/` and MUST match `test-*.ts`. Files outside this path are silently skipped by the runner.
- **Specialized test trees**: `packages/app/tests/{a11y,i18n,performance,visual}/` — each with their own `*.spec.ts` files.
- **`@axe-core/playwright`**: already wired at `packages/app/tests/a11y/axe-sweep.spec.ts` line 15.
- **Python test layout**: `packages/ml-inference/tests/{unit,integration,fixtures,contracts,regression,security}/`.
- **Fake-IndexedDB**: `fake-indexeddb` package for Vitest unit tests of the durable-retry queue.
- **pdfplumber**: PDF text extraction for the cross-channel parity test.

### File tree (additive to Project Structure)

```text
packages/app/src/emr/views/__e2e__/acr-readout/                            # NEW — replaces the wrongly-pathed `tests/e2e/cases/` stub
├── helpers/
│   └── mock-backend-acr.ts                                                # extends existing helpers/mock-backend.ts pattern
├── fixtures/
│   ├── snapshot-complete.json                                             # golden ReadoutSnapshot (all 7 findings)
│   ├── snapshot-no-lesions.json
│   ├── snapshot-degraded-spleen.json
│   ├── snapshot-stale-finding.json
│   └── snapshot-partial-payload.json
├── test-us1-radiologist-copy.ts                                           # US1 acceptance scenarios 1-5
├── test-us2-surgeon-scan.ts                                               # US2 acceptance scenarios 1-3
├── test-us3-pdf-mirroring.ts                                              # US3 acceptance scenarios 1-3
├── test-us4-compliance-audit.ts                                           # US4 acceptance scenarios 1-3
├── test-us5-multi-role-export.ts                                          # US5 acceptance scenarios 1-2
├── test-scenarios-1-9.ts                                                  # Testing scenarios 1-9 (rendering, copy, locale, degraded, partial)
├── test-scenarios-10-13.ts                                                # Testing scenarios 10-13 (PDF, running, audit-failure-warning, concurrent-finalize)
├── test-scenarios-14-15-permissions.ts                                    # Testing scenarios 14-15 (tenant + revoke)
├── test-scenarios-16-17-a11y-theme.ts                                     # Testing scenarios 16-17 (keyboard, theme)
├── test-scenarios-18-print.ts                                             # Testing scenario 18 (print stylesheet)
└── test-scenarios-12-audit-retry-across-reload.ts                         # FR-020b durable-retry-across-reload

packages/app/src/emr/services/report/__tests__/
├── acrAnatomicalMapping.spec.ts                                           # Vitest unit
├── acrPlainTextRenderer.spec.ts                                           # Vitest unit
├── acrPlainTextRenderer.snapshot.spec.ts                                  # Vitest toMatchSnapshot: 4 locales × 5 scenarios = 20 text snapshots
├── acrPlainTextRenderer.parity.spec.ts                                    # Reads shared fixtures (workspace symlink), asserts byte-equivalence with golden expected/<scenario>.<locale>.txt files
├── acrClipboardService.spec.ts                                            # mocks navigator.clipboard, audit POST, fake-indexeddb
├── acrClipboardService.indexeddb-queue.spec.ts                            # fake-indexeddb queue persistence
├── acrClipboardService.retry-drain.spec.ts                                # simulates audit failure → reload → drain → server idempotency
└── acrTelemetry.spec.ts                                                   # mocks PostHog; asserts 4 events + property allowlist + forbidden-property guard

packages/app/tests/i18n/
├── acr-namespace-key-parity.spec.ts                                       # en is golden; de/ka/ru must share all keys
├── acr-no-todo-translate-in-prod.spec.ts                                  # asserts production build contains no __TODO_TRANSLATE__: substrings
└── acr-translation-keys-cover-renderer.spec.ts                            # asserts every t() key the renderer calls exists in en/reportAcr.json

packages/app/tests/a11y/
├── axe-sweep.spec.ts                                                      # MODIFY — add '/cases/<demo-id>' to ROUTES array (line 17-28) with both color schemes
└── acr-readout-a11y.spec.ts                                               # NEW — discrete assertions for FR-031: keyboard tab order, aria-live polite, contrast on warning callouts, heading hierarchy (h1→h2→h3), 44×44px hit area on chromium-mobile project, dark-mode contrast parity

packages/app/tests/visual/
└── acr-readout-locale-theme-matrix.spec.ts                                # Playwright toHaveScreenshot: 4 locales × 2 themes × 2 viewports (1280×720, 360×640) × 4 states (complete, no-lesions, degraded, computing) = 128 screenshots

packages/app/tests/performance/
├── acr-readout-render-budget.spec.ts                                      # measures /report/summary 200 → first paint of all 6 section headers; CI-blocking budget 500ms (FR-025)
└── acr-clipboard-copy-budget.spec.ts                                      # measures click → clipboard.writeText resolved; CI-blocking budgets 200ms @ 20 lesions, 1s @ 100 lesions (FR-026)

packages/ml-inference/tests/
├── unit/test_acr_section_builder.py
├── unit/test_acr_plaintext_renderer.py                                    # Python golden output parity with TS
├── unit/test_clipboard_export_event.py                                    # success-path shape
├── unit/test_clipboard_export_fhir_conformance.py                         # validates against FHIR R4 AuditEvent schema (fhir.resources lib)
├── unit/test_clipboard_export_failure_variants.py                         # all 5 failure_category values → correct outcome code + extension
├── integration/test_clipboard_export_idempotency.py                       # same client_action_id × N → one row, same audit_event_id returned
├── integration/test_clipboard_export_chain_continuity.py                  # leaf_hash chain math correct; tamper-detection trigger fires on UPDATE/DELETE attempts
├── integration/test_clipboard_export_view_only_role_captured.py           # FR-022 + spec scenario 9
├── integration/test_clipboard_export_tenant_violation.py                  # FR-022b + spec scenario 14
├── integration/test_clipboard_export_revoked_mid_session.py               # FR-022c + spec scenario 15
├── integration/test_acr_pdf_parity.py                                     # PDF section text vs Python renderer
├── integration/test_acr_renderer_cross_channel_parity.py                  # TS golden ↔ Python ↔ PDF byte-equivalence (THE test that backs Complexity Tracking row 1)
├── integration/test_pdf_timeout_audit.py                                  # FR-033 PDF timeout
├── integration/test_pdf_failure_audit_row.py                              # FR-020c — failed PDF gen → audit row
├── integration/test_audit_retention_attestation.py                        # FR-028 — DELETE blocked; attestation job correct; >10y survival
└── fixtures/acr_snapshots/                                                # NEW — shared golden snapshots (workspace symlinked from TS side)
    ├── complete.json
    ├── no_lesions.json
    ├── degraded_spleen.json
    ├── stale_finding.json
    └── partial_payload.json
```

### E2E test scenario coverage matrix

Every spec testing scenario MUST map to a named test inside the `__e2e__/acr-readout/` tree. Test names cite the scenario ID (e.g., `test('TS-04 locale-at-click captured', ...)`). CI fails if any scenario lacks a citation.

| Scenario | Test file | Test name |
|---|---|---|
| TS-01 six-section order | `test-scenarios-1-9.ts` | `TS-01 sections render in fixed order` |
| TS-02 plain text output | `test-scenarios-1-9.ts` | `TS-02 clipboard text is plain ASCII with RUO bookends` |
| TS-03 one audit event per click | `test-us4-compliance-audit.ts` | `TS-03 single click → single audit event` |
| TS-04 locale at click captured | `test-scenarios-1-9.ts` | `TS-04 locale-at-click recorded even after switch` |
| TS-05 unsupported-locale fallback | `test-scenarios-1-9.ts` | `TS-05 fr → en fallback recorded as en` |
| TS-06 degraded warning all channels | `test-us3-pdf-mirroring.ts` | `TS-06 warning preserved on screen+PDF+clipboard` |
| TS-07 partial-payload rendering | `test-scenarios-1-9.ts` | `TS-07 partial payload renders Not available markers` |
| TS-08 surgeon viewport scan | `test-us2-surgeon-scan.ts` | `TS-08 FLR + lesion + steatosis visible without scroll` |
| TS-09 view-only audit | `test-scenarios-14-15-permissions.ts` | `TS-09 view-only copy succeeds and audits with role` |
| TS-10 PDF order parity | `test-us3-pdf-mirroring.ts` | `TS-10 PDF section order matches screen` |
| TS-11 running empty state | `test-scenarios-10-13.ts` | `TS-11 running analysis shows six placeholders, Copy disabled` |
| TS-12 audit-failure warning | `test-scenarios-10-13.ts` | `TS-12 audit POST fails → warning toast + queued` |
| TS-12-retry FR-020b reload | `test-scenarios-12-audit-retry-across-reload.ts` | `TS-12-retry queued audit drains on next session with original timestamp` |
| TS-13 concurrent finalize | `test-scenarios-10-13.ts` | `TS-13 mid-view finalize blocks copy with refresh prompt` |
| TS-14 tenant boundary | `test-scenarios-14-15-permissions.ts` | `TS-14 cross-tenant fetch returns 403 + tenant_violation audit` |
| TS-15 revoked mid-session | `test-scenarios-14-15-permissions.ts` | `TS-15 revoked copy returns 401/403 + auth_denied audit` |
| TS-16 keyboard a11y | `test-scenarios-16-17-a11y-theme.ts` | `TS-16 Copy reachable via Tab + announced via aria-live` |
| TS-17 light/dark theme | `test-scenarios-16-17-a11y-theme.ts` | `TS-17 dark/light scheme switch preserves contrast` |
| TS-18 print stylesheet | `test-scenarios-18-print.ts` | `TS-18 print media suppresses chrome, keeps readout + RUO` |

### Error-handling test matrix

Maps each FR-033 / Edge Case to its test home:

| Error mode | Spec ref | Test file |
|---|---|---|
| Report-summary 5xx | FR-033 | `test-scenarios-1-9.ts → TS-error-fetch-5xx` |
| Report-summary malformed JSON | FR-033 | `test-scenarios-1-9.ts → TS-error-malformed` |
| Offline + last-loaded data | FR-033 | `test-scenarios-10-13.ts → TS-offline-stale-marker` |
| PDF timeout | FR-033 + FR-020c | `tests/integration/test_pdf_timeout_audit.py` |
| PDF failure → audit row | FR-020c | `tests/integration/test_pdf_failure_audit_row.py` |
| Clipboard API blocked (NotAllowedError) | FR-012 | `test-scenarios-1-9.ts → TS-clipboard-blocked-permission` |
| Partial-payload rendering | FR-009a | `test-scenarios-1-9.ts → TS-07-partial-payload` |
| Translation key missing → en fallback | FR-024 | `tests/i18n/acr-translation-fallback.spec.ts` |
| Long-open panel (≥5 min idle) | FR-023b | `test-scenarios-10-13.ts → TS-stale-panel-recheck` |

### Test-evidence release gate

For CE MDR Class IIb evidence (FR-038), release blocks until ALL of these pass in CI:

- All 18 testing-scenario E2E tests + 5 US tests pass on `chromium-desktop` + `chromium-mobile` projects.
- All unit, integration, snapshot, parity, i18n-key-parity, a11y, visual, and performance tests pass.
- `test_acr_renderer_cross_channel_parity.py` is in the **release-blocking** GitHub Actions job (NOT nightly).
- Theming-compliance grep returns empty.
- Production-build i18n check returns zero `__TODO_TRANSLATE__:` substrings.

## Operational Monitoring

For CE MDR post-market surveillance + silent-failure detection:

- **Sentry alert**: `report/clipboard-export POST 5xx rate > 1% over 5 minutes`.
- **PostHog dashboard tile**: `acr_clipboard_copy_succeeded` count vs server `audit_event_chain` row count for `subtype=readout-clipboard-export`. Discrepancy > 0.5% over 24h fires PagerDuty.
- **New telemetry property** on `acr_clipboard_copy_succeeded`: `pendingQueueDepth` (count from IndexedDB at copy time). Alert if 95th-percentile > 5 (suggests audit endpoint degraded fleet-wide).
- **CI gate**: `test_acr_renderer_cross_channel_parity` failure prevents merge to `main`. Other parity drift tests run in `nightly`.
- **Annual retention attestation**: `audit_retention_attestation.py` job (APScheduler) writes signed JSON per tenant per year to S3 retention bucket. Manual verification quarterly; automated alert if a year-over-year row-count drop exceeds 5% (suggests silent purge attempt).

## Re-Constitution Check (post-design)

| Principle | Status post-design | Notes |
|---|---|---|
| **I. Spec-Driven Development** | ✅ PASS | All four mandated artifacts (spec, plan, research, data-model+contracts) authored. |
| **II / III** | ✅ N/A | No ML changes. |
| **IV. FHIR-First** | ✅ PASS | `audit-event.md` contract uses canonical AuditEvent shape; extension URLs registered in `LIVERRA_EXTENSIONS`. |
| **V. Auditability** | ✅ PASS | Contract specifies all required AuditEvent fields; 10-year retention enforced by attestation job; chain integrity via SHA-256 of canonical JSON. |
| **VI. RUO** | ✅ PASS | Plaintext-renderer contract requires RUO first and last line; PDF section builder contract requires RUO line. |
| **VII. Security** | ✅ PASS | Endpoint inherits analysis-detail authorization; tenant boundary tested explicitly (TS-14). |
| **VIII. Type Safety** | ✅ PASS | Pydantic models for audit event; strict TS for renderer + clipboard service; `fake-indexeddb` typed in tests. |
| **IX. Design System** | ✅ PASS | Component-library bindings enumerated; theming grep gate; mobile-first authorship rule; flex-overflow rules; motion policy. UI deliverables tagged `[frontend-designer]`. |
| **X. i18n** | ✅ PASS | All four constitution-required locales registered; key-parity test; no-`__TODO_TRANSLATE__`-in-prod test. |

**Gate verdict (post-design)**: ✅ PASS — proceed to `/speckit.tasks`.

## Artifacts Generated

| Artifact | Status |
|---|---|
| `spec.md` (upgraded v2) | ✅ existed |
| `plan.md` (upgraded) | ✅ this file |
| `research.md` | ✅ generated |
| `data-model.md` | ✅ generated |
| `contracts/audit-event.md` | ✅ generated |
| `contracts/readout-api.md` | ✅ generated |
| `contracts/plaintext-renderer.md` | ✅ generated |
| `quickstart.md` | ✅ generated |
| Agent context (`CLAUDE.md`) | ✅ updated via script |

## Next Step

Run `/speckit.tasks` to produce dependency-ordered tasks.md. Then `/speckit.analyze` for cross-artifact consistency before `/speckit.implement`. Note: `tasks.md` generation should preserve the `[frontend-designer]` annotation on every `.tsx`/`.css` deliverable so coder-agent tasks don't accidentally pick them up.
