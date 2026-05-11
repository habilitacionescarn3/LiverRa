# Plan: Production-Grade Implementation of 7 TODO-Stub Views

**Status:** Draft — awaiting approval
**Author:** Claude (Opus 4.7)
**Date:** 2026-04-20
**Estimated scope:** ~15–22 files created/modified; ~1,500–2,500 LOC; no new deps.

---

## 1. Context (the why)

Seven route-reachable views in the app currently render `<div>TODO: {ViewName}</div>`. They are intentional scaffolds per `CLAUDE.md` §"Intentional TODO Stub Views", but now block full UI coverage. We want production-grade implementations — meaning **real data, real mutations, i18n, a11y, mobile, tests** — not visual mockups.

The **good news** from research: *every substantial building block already exists*. These views are composition + layout + wiring, not from-scratch UI. Specifically:

| Concern | Already-built asset we'll compose |
|---|---|
| Lesion rendering | `LesionList`, `LesionBadge`, `LesionDetailPanel`, `LesionLayer` |
| Lesion mutations | `ClassificationOverride`, `useRefinementDispatch` |
| Refinement tools | `RefineTools`, `LiverViewer3D`, `TakeoverRequestToast`, `ConflictResolutionModal` |
| Seat lifecycle | `ReviewSeatContext`, `useReviewSeat` |
| Undo system | `RefinementUndoContext` |
| Finalize flow | one-click button on `AnalysisDetailView`, `PDFPreview`, `PACSPushPanel`, `RetractModal`, `useFinalize` |
| Watermark & RUO | `RUODisclaimer`, `RUODisclaimerClaimAware`, `RUOClaimRegistryContext` |
| Forms / cards / alerts | 20+ `EMR*` primitives in `components/common/index.ts` |
| i18n | All 27 namespaces exist (`help.json`, `glossary.json`, `notifications.json`, `refine.json`, etc.) |
| Auth / permissions | `useAuth`, `PermissionButton`, `StepUpAuthModal`, `RequirePermission` |

**What doesn't exist yet:** the composition views themselves, plus a handful of mutation endpoints in `dev-mocks.ts`, plus (in a few spots) translation key subtrees.

---

## 2. Guiding principles

1. **Reuse ruthlessly.** No new primitives. If a compose-level view needs a widget not in `components/common` or `components/liver`, question whether we really need it.
2. **One view = one commit = one test file.** Each view ships with its own `.test.tsx`. No stealth dependencies between views.
3. **Mock parity.** Every endpoint a view calls must resolve in dev-mocks.ts with a realistic payload. When real backend comes up, flip the env flag — nothing in the view changes.
4. **Fail closed.** Loading → skeleton. Error → `EMRAlert` + retry. Empty → `EMREmptyState`. Permission denied → `PermissionButton` disabled with tooltip, or redirect to `/404` via `RequirePermission` (per FR-032a).
5. **Mobile-first.** Every view tests at 375px first, then desktop. Use `useMediaQuery('(max-width: 767px)')` to swap table ↔ card lists.
6. **i18n discipline.** Zero hard-coded user-visible English. Every string routes through `t('namespace:key')`. Keys missing from translation files are added in the same commit.
7. **Permission discipline.** Every mutation button is a `PermissionButton`. Step-up-required mutations (`report.finalize`, `report.retract`, `review.override_classification`) carry `stepUp={true}`.
8. **No client-side audit calls.** Audit is server-side only. The sole exception is `RUODisclaimer`'s existing `liverra:audit` dismiss-attempt event.
9. **Per CLAUDE.md:** UI work is delegated to the `frontend-designer` agent. This plan is the spec that agent will execute from.

---

## 3. Per-view specification

Each view below has:
- **Purpose** (plain English)
- **Route + guard**
- **Data sources** (hooks / endpoints)
- **Components composed**
- **Key interactions**
- **States to render** (loading/error/empty/happy/denied)
- **Tests** to write
- **Acceptance criteria**

### 3.1 `GlossaryView` — *simplest, start here*

- **Route:** `/help/glossary` — no permission beyond auth.
- **Purpose:** A-Z clinical term reference: 8 Couinaud segments (I–VIII), portal + hepatic veins, 6 lesion classes (HCC, ICC, metastasis, FNH, hemangioma, cyst), 4 phase names, key abbreviations (FLR, ALPPS, RUO, MRN, SOP UID).
- **Data:** 100% static — consumes `glossary.json` translation namespace (already populated for Couinaud + vessels; we append lesions + abbreviations + phases in the same commit).
- **Components:** `EMRPageHeader` + `EMRCard` per category + accordion sections (`Mantine Accordion`) + locale-aware search input (`EMRTextInput`).
- **Interactions:** Type-ahead filter across term + Latin name + description. Category toggle (Segments / Vessels / Lesions / Abbreviations). Deep-link anchors (`#couinaud-III`).
- **States:** loading (N/A — static); empty (filter matches nothing → `EMRTableEmptyState` with clear-filter CTA).
- **Tests:** (a) renders all 8 Couinaud entries, (b) filter narrows to matches, (c) deep-link anchor scrolls to term, (d) German + Georgian locales render correct Latin names per CODEOWNERS gate.
- **Acceptance:** Mobile + desktop; a11y keyboard nav through accordion; 200–400 LOC including CSS module.
- **i18n to add:** `glossary:lesions.{hcc,icc,met,fnh,hem,cyst}`, `glossary:phases.{native,arterial,portal,venous,delayed}`, `glossary:abbreviations.{flr,alpps,ruo,mrn,sop_uid}`, `glossary:filter.*`, `glossary:categories.*`.

### 3.2 `HelpIndexView` — *simple static hub*

- **Route:** `/help` — auth only.
- **Purpose:** Central help landing. Six cards: (1) Sample case → `/demo-case`, (2) Glossary → `/help/glossary`, (3) Keyboard shortcuts modal, (4) RUO policy explainer modal, (5) Video tutorials (external links, if present in env config), (6) Contact support (`mailto:`). Plus role-aware "For your role:" strip highlighting 2-3 most relevant items.
- **Data:** Reads `useAuth().user.role` to pick the role-aware strip. No API calls in v1.
- **Components:** `EMRPageHeader` + `SimpleGrid` of `EMRCard` tiles + two `EMRModal` instances (keyboard + RUO) + footer (version, CE MDR stamp, GDPR, support email).
- **Interactions:** Click card → navigate or open modal.
- **States:** single happy path; no fetches.
- **Tests:** (a) all 6 tiles render, (b) role=surgeon shows "Finalize & sign off" in role strip, (c) role=dpo shows "Erasure walkthrough", (d) keyboard-shortcuts modal opens/closes with focus trap, (e) RUO policy modal shows correct claim-aware copy if `RUOClaimRegistryContext` has cleared claims.
- **Acceptance:** 150–250 LOC. Zero dependencies on backend beyond `useAuth`.
- **i18n to add:** `help:landing.tiles.*`, `help:modals.keyboard.*`, `help:modals.ruo.*`, `help:role.{surgeon,radiologist,admin,ops,compliance,dpo}`.

### 3.3 `ProfileView` — *CRUD form*

- **Route:** `/profile` — auth only.
- **Purpose:** User reads + edits own profile. Read: email (read-only), role (read-only), MFA enrolled_at, RUO accepted_at, last active. Edit: display_name, locale_preference (en/de/ka), theme_preference (light/dark/system). Actions: re-enroll MFA (reuses existing `StepUpAuthModal` flow), re-accept RUO terms (if required by compliance).
- **Data:** `useAuth()` for read. New endpoints `PUT /auth/me` (profile update), `POST /auth/me/mfa-enrol`, `POST /auth/me/mfa-verify`, `POST /auth/me/ruo-accept` — all added to dev-mocks.
- **Components:** `EMRPageHeader` + two `EMRCard`s (Account Info, Security) + `EMRTextInput`, `EMRSelect`, `EMRButton`, `EMRConfirmationModal`.
- **Interactions:** Inline edit with optimistic UI. "Cancel" reverts; "Save" triggers mutation + toast + re-fetch `useAuth().refresh()`.
- **States:** loading auth (skeleton form); error (inline field error or top `EMRAlert`); success (toast + field flash); step-up-required (modal pre-mounted at shell catches event).
- **Tests:** (a) renders current values, (b) locale change posts PUT + refetches, (c) MFA re-enrol triggers `POST /auth/me/mfa-enrol` and shows QR + backup codes flow (mocked), (d) RUO re-accept requires step-up, (e) form validates display_name non-empty.
- **Acceptance:** 250–400 LOC. Tests cover every field + every action. No navigation after save — user stays on page.
- **i18n to add:** `settings:profile.*` — 25–30 keys covering headings, labels, actions, errors.

### 3.4 `NotificationPreferencesView` — *toggle matrix*

- **Route:** `/settings/notifications` — auth only.
- **Purpose:** Per-user opt-out for 9 event types (analysis_complete, analysis_failed, queued_long, pacs_failed, mfa_reset, invite_accepted, erasure_confirmed, phi_incident, maintenance_window). Each event toggleable; language selector (email language) routes to profile.
- **Data:** New `useNotificationPreferences()` hook (add). `GET /auth/me/notification-preferences` and `PUT ...` — added to dev-mocks.
- **Components:** `EMRPageHeader` + grouped `EMRCard`s (Clinical events, Operational events, Security events) + Mantine `Switch` + `EMRAlert` explaining PHI-incident is mandatory (cannot be opted out per compliance).
- **Interactions:** Toggle → optimistic update → `PUT` → toast. Error → revert + `EMRAlert`.
- **States:** loading (skeleton grid); error (alert + retry); saving (switch disabled briefly).
- **Tests:** (a) all 9 event types render, (b) PHI-incident is disabled + explanatory tooltip, (c) toggling analysis_complete sends `PUT` with expected payload, (d) server error reverts toggle.
- **Acceptance:** 200–300 LOC. Hook + view + test file.
- **i18n to add:** `notifications:events.{event_type}.{label,description}` × 9, `notifications:groups.{clinical,operational,security}`, `notifications:phiLocked.*`.

### 3.5 `LesionsPanelView` — *data-bound list with reviewer actions*

- **Route:** `/cases/:id/lesions` — requires `study.view`.
- **Purpose:** Right-drawer-width panel listing every lesion on the current analysis. For each: Couinaud segment, diameter, volume, detection source (AI vs reviewer), classification badge (with abstention UI per FR-011), confidence bar. Clicking a row centres the 3D viewer on the lesion (posts to `ViewerStateContext`). Reviewer actions: override classification (requires `review.override_classification` + step-up), prompt new lesion via MedSAM-2 (requires `review.reprompt_lesion`).
- **Data:** `useLesions(analysisId)` (exists). Mutations via `useRefinementDispatch.dispatchClassificationOverride(...)` (exists) and new `POST /reviews/:id/lesion-prompt`.
- **Components:** `EMRPageHeader` (icon `IconTarget`) + `LesionList` (virtualized, already built) + `LesionDetailPanel` (already built) + `ClassificationOverride` (already built) + `RUODisclaimerClaimAware claim="lesion_classification"`.
- **Interactions:** Row click → detail panel slides in + viewer focuses. Override → confirms + step-up modal → dispatch. New-lesion prompt → click-to-place in viewer → MedSAM-2 mock returns lesion → optimistically appended to list.
- **States:** Loading (`EMRListSkeleton rows={6}`); error (`EMRAlert` + retry); empty ("No lesions detected" + "Add manually" CTA if permitted); partial (some lesions abstained → `EMRAlert info` explaining abstention).
- **Tests:** (a) renders 4 mock lesions, (b) abstained lesion shows "Uncertain" badge, (c) row click fires `ViewerStateContext` focus action (spy), (d) override without `review.override_classification` shows disabled button with tooltip, (e) override with permission triggers step-up → dispatch → list refetches, (f) empty state with permission shows "Add manually" CTA.
- **Acceptance:** 300–500 LOC. Compose existing components; minimal net new code. Tests cover abstention + override + permission paths.
- **Mock endpoints:** `POST /reviews/:id/lesion-prompt` → `{lesion_id, confidence: 0.82, predicted_class: 'metastasis'}`. Already-mocked `POST /reviews/:id/classification-override` accepts `{lesion_id, new_class, reason}` → `{ok:true}`.
- **i18n:** `lesions.json` already complete; verify `lesions:actions.override`, `lesions:actions.addManual` exist, else append.

### 3.6 `FinalizeWizardView` — *REMOVED 2026-05-11*

The 5-step wizard was deleted in favor of a one-click finalize button on
`AnalysisDetailView` (`packages/app/src/emr/views/cases/AnalysisDetailView.tsx`)
that calls `useReviewSeat().acquire()` → `useFinalize().mutateAsync()` →
`navigate('/reports/:report_id')` in a single chained handler. The RUO
attestation step is dropped during dev/demo phase (RUO watermark still bakes
into the PDF itself); slated for re-add as a confirm modal + AuditEvent
before commercial launch.

### 3.7 `RefinementView` — *most complex; Cornerstone3D + seat + undo + AI refinement*

- **Route:** `/cases/:id/refine` — requires `review.refine_mask`.
- **Purpose:** The mask-editing workbench. Full-viewport `LiverViewer3D` (already built) + `RefineTools` palette (already built, bound to Cornerstone3D tool modes) + floating undo/redo HUD + seat status pill + `TakeoverRequestToast`. Supports: click-to-refine (VISTA3D, ≤30s), MedSAM-2 lesion append, classification override. All edits are durable: `useRefinementDispatch` writes to `offlineQueue` before calling the server, so connectivity loss never drops an edit. Undo stack lives in `RefinementUndoContext` (mirrored to localStorage + IndexedDB).
- **Data:**
  - `useAnalysis(analysisId)` for the base mask.
  - `useReviewSeat()` — **acquire on mount**, release on unmount, heartbeat every 15s. If `hasSeat === false`, view is read-only (banner + tools disabled).
  - `useRefinementDispatch()` for all mutations.
  - `RefinementUndoContext` for undo stack.
  - `SyncContext` for online/offline indicator.
- **Components:** `LiverViewer3D` + `RefineTools` + `ReviewTools` + `CouinaudLegend` + `LayerToggle` + `TakeoverRequestToast` + `ConflictResolutionModal` (on 409) + `RUODisclaimer` persistent + `RecordLockBanner` (when seat lost) + keyboard shortcuts hint modal.
- **Interactions:** Tool select (keyboard shortcuts: V=VISTA3D add, B=VISTA3D subtract, L=lesion prompt, U=undo, Ctrl-Z/Y). Click in viewer → dispatch refinement → optimistic mask layer update → server call → replace optimistic with server-returned mask. Classification override → `ClassificationOverride` modal. Takeover request from another user → toast with 15s countdown to release or deny.
- **States:** Seat acquiring (full-page spinner "Acquiring review seat…"); seat acquired (happy path); seat degraded (banner "Heartbeat failed, retrying…"); seat lost (`RecordLockBanner` + read-only mode); 409 conflict (`ConflictResolutionModal`); offline (`SyncIndicator` pill + queued writes indicator + warning "Changes queued"); refinement in-flight (per-tool spinner on viewer + "Refining…" overlay).
- **Tests:** (a) seat acquire on mount fires POST, (b) seat release on unmount fires DELETE, (c) VISTA3D click dispatches mask-refine + pushes to undo stack, (d) undo pops stack + dispatches inverse, (e) takeover event shows toast + countdown triggers release, (f) offline mode shows banner + queues dispatches, (g) 409 on dispatch opens conflict modal, (h) permission denied shows `/404`.
- **Acceptance:** 600–900 LOC including keyboard shortcut handler + layout + state orchestration. Tests cover every state transition.
- **Mock endpoints:** `POST /reviews` → `{review_id, analysis_id, seat_held_until: iso(+60s)}`; `POST /reviews/:id/heartbeat` → 204; `DELETE /reviews/:id` → 204; `POST /reviews/:id/mask-refine` → `{segmentation_id: 'seg-xxx', status: 'complete'}`; `POST /reviews/:id/classification-override` → `{classification_id, status: 'complete'}`; `POST /reviews/:id/lesion-prompt` → `{lesion_id, predicted_class, confidence}`. SSE `GET /reviews/:id/takeover-events` is **mocked as empty stream** (dev can fire synthetic events via window console for manual testing).

---

## 4. Mock backend additions (dev-mocks.ts)

All additions are in the existing file — no new file. Roughly **12 new endpoints**:

```
POST   /api/v1/reviews                                → seat acquire
POST   /api/v1/reviews/:id/heartbeat                  → 204
DELETE /api/v1/reviews/:id                            → 204
POST   /api/v1/reviews/:id/mask-refine                → new segmentation
POST   /api/v1/reviews/:id/classification-override    → {ok, classification_id}
POST   /api/v1/reviews/:id/lesion-prompt              → new lesion
POST   /api/v1/reviews/:id/finalize                   → {report_id, status}
GET    /api/v1/reports/:id                            → full report
POST   /api/v1/reports/:id/pacs-push                  → delivery queued
POST   /api/v1/reports/:id/pacs-push/:did/retry       → re-queued
POST   /api/v1/reports/:id/retract                    → 204
GET    /api/v1/auth/me/notification-preferences       → prefs list
PUT    /api/v1/auth/me/notification-preferences       → updated prefs
PUT    /api/v1/auth/me                                → updated user
POST   /api/v1/auth/me/mfa-enrol                      → {secret, qr_code_uri}
POST   /api/v1/auth/me/mfa-verify                     → {backup_codes[]}
POST   /api/v1/auth/me/ruo-accept                     → {accepted_at}
```

Each mutation returns realistic shapes matching `data-model.md`. Failure paths simulated via query param `?simulate_fail=409` etc., toggled from dev console. **~150 LOC added to dev-mocks.ts.**

---

## 5. i18n additions

Namespaces already exist. Keys to append (per-view count):

| Namespace file | Keys to add | Est. |
|---|---|---|
| `glossary.json` | lesion classes, phases, abbreviations, filter chrome | ~35 |
| `help.json` | landing tiles, role strip, modals | ~25 |
| `settings.json` (new per-ns split: `profile.json`, `notifications.json`) | profile sections, MFA flow, event toggles | ~60 |
| `refine.json` | keyboard hints, seat-lost banner, undo toasts | ~15 (verify) |
| `report.json` | finalize step labels, C-ECHO result chrome | ~10 (verify) |

All three locales (en/de/ka) must be added. Medical terms in de/ka require CODEOWNERS review (per T206) — we use placeholder `__TODO_TRANSLATE__` markers plus an `i18n-check.ts` script run to flag gaps.

---

## 6. Testing strategy

**Per view:** one `.test.tsx` co-located in `__tests__/` next to the view.

**Framework:** Vitest (existing) + `@testing-library/react` (existing) + `happy-dom` env (existing `vite.config.ts:test` block).

**Patterns adopted** (mirroring `useReviewSeat.test.tsx`):
- Wrap with all required context providers (helper `renderWithProviders()` — **reuse existing** if present, else add one minimal helper under `src/test-utils.tsx`).
- Mock fetches via `vi.spyOn(global, 'fetch')` returning fixture payloads matching dev-mocks.
- Assert DOM via `screen.getByRole('...')` + `data-testid` queries for stable selectors.
- Mutation tests assert: request was made, correct payload, UI updates optimistically, error recovers.

**Coverage targets:**
- Every `canNext` gate in wizards.
- Every permission branch (permitted + denied).
- Every state transition (loading → happy, loading → error, happy → mutating → error revert).
- Offline queue behavior for RefinementView (verify dispatch writes to `offlineQueue`).

**Manual verification checklist** (after each view ships):
1. Visit route at `http://localhost:5173`.
2. Tab-navigate through entire view — every interactive element reachable, focus visible.
3. VoiceOver / NVDA reads page title + section landmarks.
4. Resize to 375px — layout holds, no horizontal scroll.
5. Switch locale en → de → ka via profile — no English leakage.
6. Toggle dark mode — colors remain semantically correct.
7. Trigger every error state via mock failure query params.

**Not in scope here:** Playwright E2E (those live in `packages/app/src/emr/views/__e2e__/` and are addressed by separate speckit tasks T192/T210/etc.). We do *not* regress those.

---

## 7. Execution order & parallelization

Dependency-ordered waves. Each wave's views are mutually independent and can be built in parallel by separate `frontend-designer` agent invocations.

**Wave 0 — Foundations** (blocking; all sequential):
- **0a.** Append missing i18n keys to all namespaces (single commit touching ~6 JSON files per locale).
- **0b.** Extend `dev-mocks.ts` with all 17 new endpoints.
- **0c.** Add `test-utils.tsx` wrapper if not present (small helper, ~60 LOC).

**Wave 1 — Simple, parallel-safe** (4 agents in parallel):
- **1a.** `GlossaryView`
- **1b.** `HelpIndexView`
- **1c.** `ProfileView`
- **1d.** `NotificationPreferencesView`

**Wave 2 — Data-bound** (1 agent):
- **2a.** `LesionsPanelView` — depends on Wave 0 mock for lesion-prompt; uses already-wired `useLesions` + `useRefinementDispatch`.

**Wave 3 — Complex workflows** (1 agent — `FinalizeWizardView` was removed 2026-05-11 in favor of a one-click button on `AnalysisDetailView`):
- **3b.** `RefinementView`

**Total ≈ 6 agent invocations** (not counting Wave 0 which is direct edit). Estimated calendar time: ~1 session with attentive review.

---

## 8. Files created/modified

| # | Path | Change |
|---|---|---|
| 1 | `packages/app/dev-mocks.ts` | +150 LOC (new endpoints) |
| 2 | `packages/app/src/emr/translations/{en,de,ka}/glossary.json` | +35 keys × 3 |
| 3 | `packages/app/src/emr/translations/{en,de,ka}/help.json` | +25 keys × 3 |
| 4 | `packages/app/src/emr/translations/{en,de,ka}/profile.json` | new file (or append `common.json`) |
| 5 | `packages/app/src/emr/translations/{en,de,ka}/notifications.json` | +30 keys × 3 |
| 6 | `packages/app/src/test-utils.tsx` | new, ~60 LOC (providers wrapper) — only if not already existing |
| 7 | `packages/app/src/emr/hooks/useNotificationPreferences.ts` | new, ~60 LOC |
| 8 | `packages/app/src/emr/hooks/useProfileUpdate.ts` | new, ~80 LOC |
| 9 | `packages/app/src/emr/hooks/useReport.ts` | **verify** exists per T272; add if missing |
| 10 | `packages/app/src/emr/hooks/usePacsDelivery.ts` | **verify** exists per T273; add if missing |
| 11 | `packages/app/src/emr/views/help/GlossaryView.tsx` | **rewrite** stub → prod, ~200 LOC |
| 12 | `packages/app/src/emr/views/help/HelpIndexView.tsx` | **rewrite** stub → prod, ~180 LOC |
| 13 | `packages/app/src/emr/views/settings/ProfileView.tsx` | **rewrite** stub → prod, ~300 LOC |
| 14 | `packages/app/src/emr/views/settings/NotificationPreferencesView.tsx` | **rewrite** stub → prod, ~220 LOC |
| 15 | `packages/app/src/emr/views/cases/LesionsPanelView.tsx` | **rewrite** stub → prod, ~350 LOC |
| 16 | `packages/app/src/emr/views/cases/FinalizeWizardView.tsx` | **DELETED 2026-05-11** — replaced by one-click button in `AnalysisDetailView` |
| 17 | `packages/app/src/emr/views/cases/RefinementView.tsx` | **rewrite** stub → prod, ~700 LOC |
| 18–24 | Co-located `__tests__/{ViewName}.test.tsx` × 7 | new, ~150–250 LOC each |
| 25 | `CLAUDE.md` §"Intentional TODO Stub Views" | **delete** that section once views are live |

**Net:** ~20 files created, ~10 modified, zero deleted, zero deps added.

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | `RefinementView` requires real Cornerstone3D tool wiring to be meaningfully testable. Without VISTA3D hooked up, refinement calls will return mocked mask URIs that don't visually change the mask layer. | Accept that mock calls complete successfully but visible pixel changes require ML backend. Tests assert dispatch correctness, not pixel diff. Add a dev-only synthetic-mask overlay (toggle via `?devMockMask=1`) to visualize "edit happened" so UX can be validated without real ML. |
| R2 | Step-up auth modal is mounted at the app shell; we must verify it's actually wired before trusting `stepUp={true}` on buttons. | Wave 0 task: grep for `StepUpAuthModal` in `EMRPage.tsx` and confirm it listens to `liverra:step-up-required`. If not, plan grows by ~30 LOC. |
| R3 | `useReport` and `usePacsDelivery` hooks may not exist (research flagged "needs implementation"). | Wave 0 confirms; if missing, add minimal versions (~100 LOC combined). Both are simple TanStack Query wrappers around `GET /reports/:id` and `GET /reports/:id/pacs-push`. |
| R4 | Translation CODEOWNERS gate on German/Georgian medical terms — I can't write those terms authoritatively. | Use `__TODO_TRANSLATE__:en-term` placeholder, ship PR that triggers CODEOWNERS review. Avoids me inventing incorrect medical terminology. |
| R5 | `frontend-designer` agent may diverge from this plan on visual choices. | Each Wave's agent prompt cites: (a) this plan file, (b) 2 "canonical" reference views already in prod (`MBoMView`, `ClaimRegistryView`, `ErasureWizardView`). Reduces drift. |
| R6 | Large concurrent file writes could hit the CLAUDE.md "no bulk edits >3 files" rule. | Each wave keeps under 3 files per agent invocation by scoping agents to one view at a time (plus its test + i18n). |

---

## 10. Open questions (need approval before Wave 0)

1. **Translation placeholders** — OK to ship English in de/ka slots behind `__TODO_TRANSLATE__` markers, pending medical-CODEOWNERS review? Or block on those first?
2. **MFA re-enrol flow in `ProfileView`** — full TOTP + backup codes flow, or just a "Contact admin to reset" CTA in v1? Full flow is ~150 extra LOC.
3. **`RefinementView` without real ML** — accept that edits are mocked and visible mask pixel changes won't occur, or add the synthetic-mask dev overlay from R1?
4. **Delete CLAUDE.md §"Intentional TODO Stub Views"** after shipping — confirm this is desired cleanup.
5. **Spec coverage** — do we update `specs/001-zero-training-mvp/tasks.md` to mark the relevant T-tasks (T221–T229 Lesions, T237–T256 Refine, T268–T278 Finalize, etc.) as "implemented in view layer"?

---

## 11. Verification plan (end-to-end)

After all 7 views ship, run:

1. `npm run lint` (existing).
2. `cd packages/app && npx vitest run` — all new test files green.
3. `cd packages/app && npx vite --port 5173` — visit each route manually:
   - `/help` → click every tile
   - `/help/glossary` → filter for "couinaud", pick segment III, see definition
   - `/profile` → change locale to de, refresh, see German
   - `/settings/notifications` → toggle analysis_complete, reload, see persisted state (mock returns toggled state)
   - `/cases/case-2026-0412/lesions` → see 4 lesions, click abstained lesion, see "Uncertain" explanation
   - `/cases/case-2026-0407` → click "Finalize & generate report" button (one-click flow; wizard removed 2026-05-11). Should land on `/reports/:id` within ~2s.
   - `/cases/case-2026-0412/refine` → acquire seat, click refine tool, verify dispatch + undo
4. Lighthouse (optional): score ≥ 90 on Accessibility, Best Practices for each route.
5. `scripts/i18n-check.ts` — zero missing keys across all three locales (excluding `__TODO_TRANSLATE__` markers which are expected).

Sign-off criteria: all 7 routes render production UI, all tests pass, all 17 new mock endpoints respond, i18n lints clean, no regressions in existing routes (/cases, /admin/*, /compliance/*, /ops/queue, /erasure).

---

## 12. Out of scope

- Real Cornerstone3D segmentation-tool binding for refinement (requires ML backend).
- Real VISTA3D / MedSAM-2 inference (requires Triton server).
- Playwright E2E for new views (separate speckit task).
- CSP / frame-ancestors enforcement for `PDFPreview` in production (infra concern, not view).
- Backend FastAPI endpoint implementations matching the new dev-mocks shapes (separate track).
- Performance budget verification (initial bundle ≤ 350 KB gzip) — covered by existing Turbo pipeline; we add no new deps so budget risk is nil.
