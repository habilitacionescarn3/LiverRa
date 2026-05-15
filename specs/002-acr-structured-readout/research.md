# Phase 0 Research — Structured ACR-Style Radiologic Readout

**Feature**: 002-acr-structured-readout
**Date**: 2026-05-13

This document resolves the design decisions raised by the upgraded spec. Each section is a single decision with rationale and rejected alternatives.

---

## D1 — Clipboard write API

**Decision**: Use `navigator.clipboard.writeText()` as the primary path. Feature-detect at runtime; if unavailable, fall back to a temporary `<textarea>` + `document.execCommand('copy')` shim wrapped in a Mantine portal so it never disturbs the DOM.

**Rationale**:
- All required browsers (Chrome 100+, Edge 100+, Firefox 100+, Safari 15.4+) support the async Clipboard API.
- iPad Safari 16.4+ supports `writeText` in user-gesture handlers; the `execCommand` fallback covers older field iPads still seen in MDT rooms.
- The async API gives us a Promise we can chain with the audit-emit step (FR-020a) without monkey-patching the DOM.

**Alternatives rejected**:
- `react-copy-to-clipboard` library — adds 3kb for a one-line wrapper we don't need.
- `ClipboardItem` (rich text + HTML) — over-engineered; the requirement is plain text only (FR-010), and rich clipboard items are blocked in some hospital browsers by policy.

---

## D2 — Audit-emission ordering and failure handling

**Decision**: Optimistic ordering — write to clipboard first, then POST the audit event, then show the success toast only after the audit POST acknowledges. On audit-POST failure (network drop, 5xx, timeout > 5s), show a yellow warning toast ("Text copied; export audit pending retry") and enqueue the audit envelope to IndexedDB under a `pendingAuditEvents` store keyed by `{analysisId, clickTimestamp}`. On next session start, drain the store with retries against the same endpoint.

**Rationale**:
- Clipboard write is the user-perceived primary action; failing it because the audit chain hiccuped is worse UX than the inverse.
- IndexedDB persists across tab close and browser restart; localStorage doesn't survive private mode and has 5MB caps that bite on long retry queues.
- Preserving the original `clickTimestamp` in the queued envelope satisfies FR-020a — the audit event reflects when the user acted, not when retry succeeded.

**Alternatives rejected**:
- POST first, then clipboard, then toast — if the network is slow, the user clicks Copy and sees nothing for seconds. They click again. Now we have two clipboard writes and two audit events; the second one is spurious. FR-017 demands one-event-per-click; serializing this way invites accidental duplicate clicks.
- Synchronous audit-then-clipboard with no offline retry — fails the offline-mode requirement (FR-033) and the durable-retry requirement (FR-020b).

---

## D3 — Plain-text format conventions

**Decision**:
- First line: `--- RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE ---` (localized).
- One blank line after RUO.
- Section header in ALL-CAPS in `en` (e.g., `LIVER`); locale-appropriate emphasis in `ru` (cyrillic uppercase) and `ka` (Georgian uppercase or bracketed convention TBD by medical-term reviewer).
- Field rows: two-space indent + label + colon + space + value with units (e.g., `  Volume: 1,828 mL`).
- Per-item lists (e.g., calcified lesions): two-space indent + `- ` + label (e.g., `  - L1 (segment VIII): max 310 HU`).
- Blank line between sections.
- Last line: same RUO line as first.
- Unicode normalization: NFC at the renderer boundary, before clipboard write.

**Rationale**:
- ALL-CAPS section headers match standard PACS dictation templates (Powerscribe, Fluency, Nuance Dragon Medical).
- Two-space indent reads cleanly in monospaced PACS dictation fields without being confused for a quoted block.
- NFC normalization is required for Georgian combining diacritics to paste identically across destination systems (FR-013a).

**Alternatives rejected**:
- Markdown headers (`## LIVER`) — FR-010 explicitly forbids markdown characters surfacing as literal asterisks.
- HTML-encoded rich text — FR-010 plain-text only.
- Tab-separated columns — fails in proportional fonts which some PACS systems still default to.

---

## D4 — PDF parity strategy

**Decision**: Server-side pre-grouping. Add `acr_section_builder.py` that reads the same `analysis_finding` rows as the screen, runs them through the canonical `findingTypeToAnatomicalSection()` mapping, and emits an `acr_sections` dict of shape `{ liver: [...], lesions: [...], vessels: [...], gallbladder: [...], spleen: [...], flrAssessment: {...} }` for Jinja2 binding. Templates (`en/report.html`, `ru/report.html`, `ka/report.html`) render this dict in fixed order; the heuristic-findings section becomes a fixed 6-block layout matching the screen.

**Rationale**:
- The PDF render path is already server-side; doing the grouping client-side and POSTing it just to render server-side adds a network round-trip and a payload-validation surface for no benefit.
- The Jinja2 contract (`acr_sections` dict) is small, stable, and testable end-to-end via the integration parity test.

**Alternatives rejected**:
- Generate a single HTML snippet client-side and embed it in the PDF — couples PDF correctness to the frontend bundle version; breaks if PDF is generated headlessly during a cron job that doesn't load the frontend.
- Per-locale Jinja2 macros with no Python-side mapping — duplicates the anatomical-section logic across three templates.

---

## D5 — Concurrency detection and freshness gate

**Decision**: Compare a per-analysis change token at copy time. Preferred token: `ETag` from the `GET /report/summary` response (already supported on the existing endpoint per backend conventions). Fallback if ETag is absent: compare `analysis.updated_at` from the open-time fetch against a fresh `HEAD /report/summary` issued before the clipboard write. If the token differs, block the copy and surface a Mantine notification: "Analysis updated by another reviewer — refresh to copy" with a refresh button.

**Rationale**:
- ETag is the canonical HTTP concurrency primitive and the existing summary endpoint either already emits it or trivially can.
- HEAD request is cheap and avoids re-fetching the entire payload to check freshness on every copy.
- The freshness gate runs inside the same click handler as the clipboard write, before the actual write — so we never put pre-mutation text on the clipboard.

**Alternatives rejected**:
- WebSocket-based realtime invalidation — overkill for this feature's 1Hz event rate; adds infra (Redis pub/sub) for one use case.
- Polling every N seconds — burns network for no benefit; the user notices state change only at copy time anyway.

---

## D6 — Translation namespace placement

**Decision**: New top-level namespace `reportAcr` registered in `TranslationContext.TRANSLATION_NAMESPACES`. Bundle files: `packages/app/src/emr/translations/{en,ru,ka,de}/reportAcr.json`. The `de` bundle is added with English fallbacks marked `__TODO_TRANSLATE__:` for completeness even though `de` is legacy.

**Rationale**:
- Nesting under existing `report.*` would force a bundle reload of every report-related string when this feature's strings change; the lazy-load model assumes per-namespace separation.
- A dedicated namespace makes the medical-terminology code-owner review surface a single file diff per locale.

**Alternatives rejected**:
- Reuse `analysis.json` — would mix ACR section labels with lesion-class labels and confuse the i18n review.

---

## D7 — Audit category and FHIR AuditEvent type

**Decision**: Add `ReadoutClipboardExport` to `AuditCategory` enum in `packages/core/src/types/audit.ts`. FHIR AuditEvent representation:
- `type.code`: `rest`
- `type.system`: `http://terminology.hl7.org/CodeSystem/audit-event-type`
- `subtype[0].code`: `readout-clipboard-export`
- `subtype[0].system`: `http://liverra.ai/fhir/CodeSystem/audit-subtypes`
- `action`: `R` (read/view — this is an export of viewable data, not a write)
- `outcome`: `0` (success) or `4` (minor failure) or `8` (serious failure) per FHIR audit-event-outcome value set
- `agent[0]`: actor reference + role-at-action-time in `agent[0].role.coding[0]`
- `entity[0]`: reference to Analysis (`type.code=4` "other"; `role.code=4` "domain resource")
- Extension `http://liverra.ai/fhir/StructureDefinition/audit-locale` with `valueCode` = the locale actually used (en/ru/ka)
- Extension `http://liverra.ai/fhir/StructureDefinition/audit-failure-category` (optional, only on failure events) with `valueCode` from a small enum (`network`, `clipboard_blocked`, `audit_chain_unavailable`, `auth_denied`, `tenant_violation`)

**Rationale**:
- `R` (read) is the most accurate FHIR action code — the user is reading their own viewable data through a different channel (clipboard).
- `outcome` codes 0/4/8 match the FHIR value set exactly.
- Extension URLs follow the constitution's `http://liverra.ai/fhir/StructureDefinition/` pattern.

**Alternatives rejected**:
- `action=C` (create) — semantically wrong; nothing new is created server-side, only a metadata audit row.
- Inventing a new `type.code` outside the HL7 system — breaks FHIR conformance and CapabilityStatement.

---

## D8 — Disposition of the existing FindingsCard

**Decision**: Replace and delete in the same PR series. `FindingsCard.tsx` is removed; `ReportInlineView.tsx` and `AnalysisDetailView.tsx` switch their imports to `ACRStructuredReadout`. No feature flag — the rendering change is non-functional for downstream consumers, and a feature flag would invite drift between the two implementations during the toggle window.

**Rationale**:
- Spec Assumptions explicitly states "The old flat layout is removed in the same release to prevent drift."
- CE MDR audit reviewers prefer a single rendering surface for a given clinical artifact.
- The codebase grep for `FindingsCard` shows two import sites, so the migration is mechanically simple.

**Alternatives rejected**:
- Coexist behind a feature flag — fails the Assumption.
- Wrap the old card inside the new component — surfaces the same data twice in different layouts; clinically confusing.

---

## D9 — Permission gate: where does FR-022 (permit-but-audit) live?

**Decision**: Authorization is enforced server-side at the existing `/api/v1/analyses/{id}/report/summary` boundary. The new `POST /api/v1/analyses/{id}/audit/clipboard-export` endpoint accepts requests from any authenticated user with read access to the analysis (i.e., any user who could fetch the summary in the first place). Tenant boundary is inherited automatically from the analysis-access policy. Failed-auth attempts hit the existing AuthZ middleware and emit a `denied` AuditEvent with `outcome=4` (minor failure) and the user's then-current role.

**Rationale**:
- Reusing the existing AuthZ boundary is constitutional (Principle VII) and zero-effort.
- A permit-but-audit model means we never need a separate "copy permission" — if you can view, you can export, and every export leaves a trail.

**Alternatives rejected**:
- Separate `copy_clipboard` permission stored in a new RBAC table — would require migration + admin UI to manage; outside scope and fails the Assumptions of "no new tables."

---

## D10 — Telemetry channel for product-analytics events

**Decision**: Use PostHog (already in the stack per CLAUDE.md) for non-PHI events from `acrTelemetry.ts`. Event names: `acr_readout_viewed`, `acr_clipboard_copy_succeeded`, `acr_clipboard_copy_failed`, `acr_pdf_section_rendered`. Properties include `analysisId` (hashed if PostHog auto-collects user identity), `locale`, `lesionCount` (bucketed: 0, 1, 2-5, 6-10, 11-20, 21-50, 50+), `durationMs`. PostHog identity is set to the platform's existing anonymous user-id (not the email).

**Rationale**:
- PostHog is already integrated; no new infra.
- Separating telemetry from the audit chain keeps the forensic record clean (audit) versus the funnel data (analytics) — and survives the constitution's "no PHI in logs" rule (Principle V) cleanly because PostHog never receives patient identifiers.

**Alternatives rejected**:
- Use the audit chain for analytics — wrong tool: audit is per-event-immutable, analytics is aggregable-and-mutable. Conflating them breaks both.

---

## NEEDS CLARIFICATION resolutions

The Technical Context section of `plan.md` contains no `NEEDS CLARIFICATION` markers. All technical unknowns were resolved by reading the constitution, the upgraded spec, and CLAUDE.md.

---

## Open questions for `/speckit.clarify` (NOT blocking implementation)

1. **Stale interval threshold (FR-023b)** — what counts as a "clinically meaningful interval"? Recommend 5 minutes; defer to clinical-lead sign-off.
2. **Role taxonomy for residents / MDT coordinators (US5)** — does the existing role system already distinguish these, or do we map them all to `view-only` for now? Defer to admin-platform owner.
3. **De-locale handling** — leave as English fallback (current spec stance), or commission `de` translations alongside `ru`/`ka` for DACH legacy continuity? Defer to product.

None of these block the implementation tasks; defaults are stated in the plan/contracts.
