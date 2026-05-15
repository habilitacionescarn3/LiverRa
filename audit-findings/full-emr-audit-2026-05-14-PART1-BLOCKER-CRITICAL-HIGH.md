# Full EMR Audit — 2026-05-14 — PART 1: BLOCKER / CRITICAL / HIGH

> **Pointers:** MEDIUM-severity findings live in [`full-emr-audit-2026-05-14-PART2-MEDIUM.md`](./full-emr-audit-2026-05-14-PART2-MEDIUM.md). LOW + TRIVIAL bulk counts live in [`full-emr-audit-2026-05-14-PART3-LOW-TRIVIAL.md`](./full-emr-audit-2026-05-14-PART3-LOW-TRIVIAL.md).

**Audit area:** full (whole monorepo)
**Agents:** 24 (Wave 0 × 2, Wave 1 × 12 per-area, Wave 2 × 4 specialists, Wave 2 × 6 mechanical sweeps)
**Date:** 2026-05-14
**Branch:** 002-acr-structured-readout
**Coverage note:** prior-diff agent not run (no prior audit exists); cross-audit consistency relies on this run alone.

**Dedup:** 488 raw findings → 352 unique (28% overlap — see "Cross-Cutting Themes" for the heavily-overlapping clusters).

---

## Grand Summary — counts per area

| Area | BLOCKER | CRITICAL | HIGH |
|------|--------:|---------:|-----:|
| Wave 0 — Dependencies | 0 | 1 | 3 |
| Wave 0 — Unit Tests | 0 | 8 | 9 |
| PACS | 4 | 5 | 7 |
| Cases | 0 | 2 | 7 |
| Cascade | 4 | 3 | 6 |
| Inference (ML client + GPU split) | 3 | 2 | 5 |
| Clinical Algorithms (Couinaud + FLR + LI-RADS) | 5 | 3 | 7 |
| ACR Readout | 2 | 2 | 7 |
| Refinement Tools | 3 | 4 | 5 |
| Audit & Compliance | 6 | 4 | 5 |
| Design System | 0 | 1 | 5 |
| i18n core | 0 | 0 | 2 |
| Auth & Settings | 4 | 4 | 6 |
| Schema (migrations) | 2 | 3 | 6 |
| Wave 2 — FHIR Validator | 0 | 4 | 28 |
| Wave 2 — Security (OWASP) | 2 | 6 | 6 |
| Wave 2 — i18n Quality | 0 | 0 | 7 |
| Wave 2 — UI/UX | 0 | 2 | 7 |
| Sweep — Catch Blocks | 0 | 6 | 11 |
| Sweep — Optimistic Locking | 0 | 3 | 6 |
| Sweep — Test Quality | 0 | 5 | 8 |
| Sweep — Type Safety | 0 | 0 | 1 |
| Sweep — React Hooks | 0 | 1 | 4 |
| Sweep — i18n Literals | 0 | 0 | 4 |
| Cross-Cutting Issues | (rolled below) | | |
| **TOTAL (raw, pre-dedup)** | **35** | **69** | **159** |
| **TOTAL (canonical, post-dedup)** | **18** | **38** | **104** |

## Per-Dimension Summary (BLOCKER + CRITICAL + HIGH only, canonical/deduped)

| Dimension | Findings |
|-----------|---------:|
| D1 Data Integrity | 24 |
| D2 Security & Authorization | 28 |
| D3 Business Logic | 14 |
| D4 Error Handling | 16 |
| D5 FHIR Compliance | 20 |
| D6 React & Performance | 8 |
| D7 UI/UX & Styling | 7 |
| D8 Internationalization | 8 |
| D9 Code Quality & Dead Code | 10 |
| D10 Clinical Safety & Compliance | 39 |
| D11 Code Scale & Cohesion | 6 |

---

## Executive Summary — Every BLOCKER + CRITICAL in one line

### BLOCKERs (18)

1. **[SEC1]** `LIVERRA_AUTH_BYPASS=true` has no production env guard — boots a superuser in prod if env-var slips through (`packages/ml-inference/src/middleware/auth_middleware.py:123`).
2. **[SEC3b]** `ANON_SIDECAR_BYPASS=true` has no production env guard — raw PHI flows into cascade + MinIO (`packages/ml-inference/src/tasks/anonymization.py:66`).
3. **[D10]** Dev anonymization sidecar returns `status="done"` with `orthanc://passthrough/...` on Orthanc failure — PHI proceeds downstream (`packages/ml-inference/anon_sidecar/main.py:132`).
4. **[D1/D6]** tus chunk upload buffers entire 5 GB body in RAM despite "streaming" comment — OOMs the FastAPI worker (`packages/ml-inference/src/api/ingest.py:507`).
5. **[D2]** DICOMweb client sends NO auth in production — `getAccessToken: () => null`, `configureDicomAuth(() => '')` (`packages/app/src/emr/hooks/useDicomWebClient.ts:37`).
6. **[D10]** Sidecar `_maybe_crypto_shred` swallows shred failures silently → partial uploads remain decrypted in S3 with no AuditEvent (`packages/ml-inference/anon_sidecar/main.py:418`).
7. **[D10]** Production cascade `real_cascade.py` writes 7+ clinical rows per analysis with **zero** AuditEvent / `audit_event_chain` emission (`packages/ml-inference/scripts/real_cascade.py:203-952`).
8. **[D10]** `cascade.set_audit_hooks()` is **never called** — every `cascade.run_stage` hook is a no-op base class (`packages/ml-inference/src/orchestrator/cascade.py:189`).
9. **[D10]** `analysis.model_versions` JSONB column never populated by any cascade path — provenance broken on every Analysis row (`packages/ml-inference/scripts/real_cascade.py` + `tasks/*.py`).
10. **[D1]** `run_real_cascade` returns int `1` from a `→ dict` function on missing liver mask; cascade stuck in `running` forever (`packages/ml-inference/scripts/real_cascade.py:268-271`).
11. **[D10/D3]** LR-M finding filter never matches because LI-RADS classifier emits tumor types ({hcc,icc,met,fnh,hemangioma,cyst}), not LI-RADS codes — every indeterminate-malignant lesion is silently dropped (`packages/ml-inference/src/services/post_processing/findings.py:425`).
12. **[D3]** Two divergent Couinaud implementations (`orchestrator/couinaud_heuristic.py` vs `services/couinaud_heuristic.py`) — different cascade paths produce different segment topologies on the same scan.
13. **[D10]** `tasks/flr_default.py` uses a hardcoded 2.3³ mm voxel size for FLR — wrong by 10–30× on 0.7 mm or 5 mm scans.
14. **[D10]** `_compute_default_plane` in `flr_default.py` slices the liver at the axial midpoint and labels it "FLR" — anatomically meaningless number ships as `flr_calculation` with `author='ai_default'`.
15. **[D10]** Clinical mutations (segmentation, lesion, flr_calculation) write without `audit_event_chain` co-write in the same transaction (`packages/ml-inference/scripts/real_cascade.py:440-844`).
16. **[D10]** Stale-finding marker computed in TS but never rendered on screen OR in the PDF — surgeons see fresh-looking values for stale findings (`packages/app/src/emr/services/report/acrAnatomicalMapping.ts:509` + 5 ACR section components + Python PDF builder).
17. **[D5]** Four new audit FHIR extensions (audit-locale, audit-tenant, audit-client-action-id, audit-failure-category) emitted from clipboard export but have **no published StructureDefinition** — strict R4 validators drop them (`packages/fhirtypes/src/liverra/extensions/`).
18. **[D1]** `lesion_classification_override` table referenced by `POST /reviews/{id}/classification-override` does **not exist** in any migration — every override 500s after step-up MFA (`packages/ml-inference/src/api/review.py:467`).
19. **[D10]** Classification-override audit row writes `analysis_id=00000000-0000-0000-0000-000000000000` — every override AuditEvent orphaned in the chain (`packages/ml-inference/src/api/review.py:493`).
20. **[D5/D3]** Frontend "Add lesion" sends `{ segment: 'V' }` but backend expects `{ analysis_id, voxel:[x,y,z] }` — every reprompt 422s under a success toast (`LesionsPanelView.tsx:274` vs `review.py:162`).
21. **[D10/D2]** `audit_event` and `audit_event_chain` tables have **NO** Row-Level Security — any tenant can read/write any other tenant's audit chain.
22. **[D1/D2]** `AuditChainWriter.write` first-row race per tenant: two concurrent writers see prev=GENESIS, both INSERT seq=1 → one crashes mid-transaction.
23. **[D2]** `@require_permission` returns 403 not 404 — FR-032a violated; cross-tenant resource existence is disclosed; RBAC red-team matrix 15/15 fails (`require_permission.py:93,298`).
24. **[D2]** Backend `LIVERRA_AUTH_BYPASS=true` has no production guard (duplicate of #1; preserved here because audit-settings agent flagged separately).
25. **[D2]** RBAC matrix drift: 12 permissions enforced in code do **not exist** in `matrix.yaml`; every JWT-authenticated user is rejected; only `LIVERRA_AUTH_BYPASS` superuser passes (`packages/ml-inference/src/api/`).
26. **[D2/D10]** Invite-accept JWT: dev-fallback secret `"dev-invite-secret-CHANGE-ME"` + no `iss` check + no JTI replay protection (`packages/ml-inference/src/services/admin/invite_service.py:100`).

(NOTE: the BLOCKER list above contains 26 items because area-counts include some that are independently flagged but conceptually overlap with one another; the dedup canonicalized them to 18 unique. The unique set is items 1–3, 5–8, 10–18, 20–22, 25–26 after merging duplicates of LIVERRA_AUTH_BYPASS, the cascade-audit cluster, and the cascade-write/audit-chain cluster.)

### CRITICALs (38 — one-line summary; full detail below)

**Wave 0:**
1. **happy-dom ≤ 20.8.8** critical VM-context-escape RCE — dev-only but easy fix (`packages/app/package.json:46`).
2. **5/6 ACR clipboard service tests fail** — every audit-event lineage path for FR-018 export is unproven (`acrClipboardService.spec.ts`).
3. **Frontend ACR plaintext renderer drift** — backend Python + frontend TS golden-text byte-equivalence broken; cross-channel parity gone.
4. **Backend role-crossing matrix** fails 15/15 (every named scenario) (`tests/rbac/test_role_crossing.py`).
5. **`@require_permission` decorator** returns wrong status codes + missing audit tag (`tests/security/test_require_permission_decorator.py`).
6. **PHI scrubber leaks header2** + fails open on regex crash (`tests/observability/test_phi_scrubber.py`).
7. **PACS push retry leaks PHI** in `last_error` column (`tests/integration/test_pacs_push_retry.py`).
8. **No unit tests** for Couinaud / FLR / LI-RADS / lesion-enhancement / Phase 1 findings / cascade orchestrator / audit emitter / erasure orchestrator / clipboard export — 9 critical clinical-safety files at zero coverage.

**PACS:**
9. PACS-push response body shows raw STOW failure strings to user → potential PHI leak (`PacsStudiesView.tsx:199`).
10. Frontend `auditService.ts` is fire-and-forget stub — every audit write is `console.warn`, not a persisted row (`packages/app/src/emr/services/pacs/auditService.ts:289`).
11. PHI sent to user-facing DICOM tag browser modal — no redaction toggle, no audit emission (`DicomTagBrowser.tsx:46`).
12. PACS C-ECHO admin endpoint accepts `use_tls` + `cert_fingerprint` but silently ignores both (`pacs_cecho.py:36`).
13. Hard-delete of FHIR `Basic` clinical resources (annotations, key images, hanging protocols, macros) — no soft-delete pattern.

**Cases:**
14. `_dispatch_cascade` opens a fresh sync connection that cannot see the uncommitted async INSERT — cascade silently never runs for `create_analysis` and `retry_analysis` (`packages/ml-inference/src/api/analysis.py:474`).
15. Surgical-planning numeric outputs (FLR %, volumes, lesion classification) ship without sanity bounds at the API boundary (`api/analysis.py:783` + `AnalysisDetailView.tsx:356`).

**Cascade:**
16. Heuristic outputs (FLR, Couinaud, classification) bypass all sanity bounds — `sanity.check_stage()` never called in real-mode (`scripts/real_cascade.py`).
17. Cascade retry double-writes segmentation/lesion rows (no `ON CONFLICT`) (`scripts/real_cascade.py:442-755`).
18. `ANON_SIDECAR_BYPASS` allows PHI to flow into inference with no anonymization (duplicate of BLOCKER 2; per-area flag).

**Inference (ML client + GPU split):**
19. `infer_total_and_vessels` is the default in `real_cascade.py` despite being empirically slower — CLAUDE.md "Open decision" not executed.
20. Inference client ZIP body extracted with `zf.extractall()` — classic ZIP-slip / path-traversal if GPU service compromised (`packages/ml-inference/src/services/inference_client.py:65`).

**Clinical Algorithms:**
21. `flr_pct` divisor inconsistent with stored `total_ml` — persisted row violates `flr_pct ≈ flr_ml/total_ml × 100`.
22. `extract_lesion_features` background HU pool includes OTHER lesions when multiple lesions present — biases LI-RADS rule classifier.
23. `compute_couinaud` voxel-orientation assumption unsafe under non-RAS NIfTI — inverts L/R lobe on cirrhotic or post-resection patients.

**ACR Readout:**
24. Three new locale bundles (ru, ka, de) for `reportAcr` are 100% `__TODO_TRANSLATE__`; PDF builder ignores locale bundle entirely; `RUO_WATERMARKS` lacks `ru` key.
25. Stale-data clipboard failure miscategorized as `audit_chain_unavailable` + fire-and-forget audit-POST drops the failure if the same network blip hits.

**Refinement:**
26. Mask refine does NOT trigger FLR recompute — refined masks ship to surgical-planning PDF with stale FLR % (`review.py:330` no recompute, `review.py:508` separate endpoint never auto-called).
27. Two-person control (dual authorization) NOT enforced — same user can refine AND finalize (no guard in `SeatManager.acquire` or finalize handler).
28. Undo enqueues an INVERSE edit AND dequeues the original — double-flip risk if original already synced (`RefinementUndoContext.tsx:118`).
29. Empty undo handler in keyboard path bypasses `isUndoing` guard — double-undo races (`RefinementView.tsx:287`).
30. Cleanup-on-unmount runs even when seat acquisition failed — fires release on a seat we never held (`RefinementView.tsx:167`).

**Audit & Compliance:**
31. Erasure audit rewriter targets the **wrong table** (`audit_event` instead of `audit_event_chain`) — GDPR Art. 17 residual-identifier scrub is a silent no-op (`audit_rewriter.py:137`).
32. Canonical-JSON LIKE pattern uses `": "` with space; canonicalizer emits `":"` with NO space — idempotency + attestation are permanent zero-matches.
33. `AuditChainWriter.from_request` and `.write_permission_check` do **not exist** — every permission-check audit silently swallowed by the bare `except Exception`.
34. AuditEventEmitter is never wired into the app — every direct `AuditChainWriter.write` call bypasses PHI scrubbing and Medplum mirror.

**Design System:**
35. Half-finished brand-token swap violates T464 gate — primary tokens swapped to warm-gray but ~74 references in theme.css still use old navy/blue.

**Auth & Settings:**
36. Frontend audit service is never initialized — `initAuditService()` is defined and never called; every PHI-touchpoint AuditEvent silently no-ops.
37. Direct `AuditChainWriter.write()` calls in 7+ task modules bypass PHI scrubbing — raw PHI written into chain canonical_json.
38. Erasure orchestrator silently swallows DELETE failures on the case-graph — partial-erasure outcomes are reported as success.

**Wave 2 — Security:**
39. Hardcoded fallback JWT signing secret `"dev-only-not-for-production-replace-with-32-byte-secret"` (`packages/ml-inference/src/api/auth.py:103`).
40. Hardcoded fallback demo password `"livercheck-demo"` + admin allowlist baked into source.
41. GPU inference microservice has zero authentication — Tailscale-ACL-only defense (`packages/ml-inference-gpu/main.py`).
42. CSRF on every state-changing POST in the frontend — `credentials: 'include'` without any CSRF token (21+ sites).
43. `python-jose` unmaintained with known CVEs CVE-2024-33663/33664 on the JWKS-validation path (mitigated today by RS256 enforcement; long-tail liability).

**Wave 2 — UI/UX (CRITICAL):**
44. `theme.css` has 74 raw old-brand-blue references (duplicate of #35 above).
45. EMRTable wrapper does not exist but CLAUDE.md mandates it — aspirational docs, real code uses raw Mantine.

**Wave 2 — FHIR (CRITICAL):**
46. AuditEvent missing required `type` and `source` fields across 14 emitters — strict R4 validators 422.

**Sweep — Catch Blocks (CRITICAL):**
47. Permission_check AuditEvent swallowed on chain-write failure (duplicate of #33; per-sweep flag).
48. GDPR Art. 17 crypto-shred audit AuditEvent silently dropped (`crypto_shred.py:145`).
49. Crypto-shred KMS scheduling failure swallowed, hard-delete proceeds anyway (`erasure/orchestrator.py:305`).
50. SSE `analysis-update` JSON.parse silent swallow on critical pipeline updates (`AnalysisContext.tsx:192`).

**Sweep — Test Quality (CRITICAL):**
51. Catastrophic coverage gap — ZERO direct unit tests on clinical-safety algorithms (duplicate of #8).
52. `test_audit_retention_attestation.py` — entire SC-010 audit-retention path skipped (4/4 tests).
53. `test_clipboard_export_tenant_violation.py` — entire cross-tenant breach test disabled (5/5 skipped).

**Sweep — React Hooks (CRITICAL):**
54. `ReviewSeatContext.tsx:122` — unstable `client` reference causes heartbeat re-creation on every render — review-seat collapse = lost edits.

---

## Cross-Cutting Themes — patterns appearing in ≥3 partials

### Theme A — Audit-chain emission gaps (cited by 6 agents)
**Agents:** cascade, audit-compliance, refinement, cases, auth-settings, sweep-catch-blocks.
**Pattern:** Multiple independent code paths write clinical/PHI mutations without the FHIR AuditEvent + chain-of-hashes co-write that FR-029b mandates. The systemic cause: the cascade orchestrator's `CascadeAuditHooks` is plumbed but never wired (`set_audit_hooks()` never called), the `AuditEventEmitter` (which is the only place PHI scrubbing runs before chain write) is never instantiated, the frontend `auditService.ts` is never initialized, and the per-task `AuditChainWriter.write()` calls bypass the emitter. The downstream consequence: zero audit rows for every cascade run; canonical_json columns carry raw PHI when audits ARE written; `permission_check` AuditEvents from middleware silently swallowed because the helper methods don't exist; and the chain has no verifier (`verify_chain` does not exist). Single coordinated fix: wire the emitter at app/worker startup, route all writes through it, add `verify_chain`, then make the rest fail-closed.

### Theme B — Backend env-var bypasses with no production guard (4 agents)
**Agents:** auth-settings, inference, cascade, security.
**Pattern:** `LIVERRA_AUTH_BYPASS`, `ANON_SIDECAR_BYPASS`, dev-fallback JWT secret, dev-fallback demo password — all gated only by environment-variable presence, none gated by `LIVERRA_ENV == "production"`. The frontend has the correct guard (`vite.config.ts:62`); the backend has none. Single 4-line fix per call-site.

### Theme C — Optimistic-locking is illusory across 4 refinement endpoints (4 agents)
**Agents:** refinement, audit-compliance, sweep-optimistic-locking, schema.
**Pattern:** All four `/reviews/...` endpoints (`mask_refine`, `lesion_prompt`, `classification_override`, `flr_update`) accept `client_version` in the request body, the frontend dispatches it, the server **never reads it**. Plus the TS `LiverRaFhirClient.updateResource()` signature has no `ifMatch` parameter, so 9 frontend call sites doing `{ ...res, meta: { versionId } }` are no-ops. Single coordinated fix: thread version into Python orchestrator + extend TS client signature.

### Theme D — Russian translation triad is 0.2% covered (3 agents)
**Agents:** i18n, wave2-i18n-quality, sweep-i18n-literals.
**Pattern:** Per CLAUDE.md the active triad is `en/ru/ka`. Reality: 23 of 30 namespace files are entirely missing for ru; the 7 that exist are 98% `__TODO_TRANSLATE__:<en>` markers. **Total real Russian coverage: 3 strings out of 1648 English keys.** Russian PDF templates render English content. Russian users hitting `failClosed` (kill-switch UI), `errors`, `ruo` regulatory disclaimer all see English fallback.

### Theme E — FHIR R4 conformance pervasively violated (3 agents)
**Agents:** wave2-fhir-validator, audit-compliance, acr-readout.
**Patterns:**
- `AuditEvent.category` field used in 14 emitters — R5-only, R4 rejects.
- 14 sites use invalid `liverra:foo` URL scheme on `Extension.url`; FHIR R4 requires absolute URI.
- 5 sites reference `Analysis/` / `Report/` / `ReportDelivery/` — none are FHIR R4 resource types.
- 6 declared extension URLs have no published `StructureDefinition` JSON.
- TS/Python extension registries disagree (`services/fhir/constants.py` missing 4 new audit-* additions vs `services/audit/fhir_extensions.py`).
- TS-side audit-subtype CodeSystem URL is singular; Python-side is plural.
- AuditEvent emitters omit required `type` and `source` fields.

### Theme F — Forbidden-blue brand-token drift (3 agents)
**Agents:** design-system, wave2-ui-ux, acr-readout.
**Pattern:** T464 brand-ramp swap was started without sign-off and stalled mid-flight. Top-level `--emr-primary` semantic tokens swapped to warm-gray; gradient definitions and 74 raw `#1a365d` / `#2b6cb0` / `#3182ce` references in `theme.css` left as old blues. Six feature files (`ReportInlineView.tsx`, `SegmentationPanel.tsx`, `UserMenuButton.tsx`, etc.) carry hardcoded blues that bypass the token system entirely. Active-clinical surfaces show brown text on blue gradient on the same page.

### Theme G — Sub-44px tap targets on clinical surfaces (3 agents)
**Agents:** design-system, wave2-ui-ux, refinement.
**Pattern:** `EMRIconButton` defaults to 36×36 (md) / 30×30 (sm); `EMRTabs` `min-height: 32px`; `EMRButton` xs=32 / sm=38; `EMRFAB` sm.miniSize=40; `MeasurementPanel.tsx` uses 4× `<ActionIcon size="xs">` (24×24) on a clinical viewer. All fail WCAG 2.5.5 (44×44 minimum).

### Theme H — Dark-mode rule violations in module CSS (3 agents)
**Agents:** design-system, wave2-ui-ux, cases.
**Pattern:** Per CLAUDE.md Dark Mode Architecture rule #5, `:root[data-mantine-color-scheme="dark"]` overrides must NEVER live in CSS modules. Found in `EMRAlert.css`, `emr-fields.css`, `LesionBadge.module.css`. Plus `var(--emr-*, hex-fallback)` antipattern (rule #2) in 30+ sites — including `theme.css:3801-3925` which uses dark-mode hex values as fallbacks.

### Theme I — `__TODO_TRANSLATE__` debt + plural-form gap (2 agents)
**Agents:** i18n, wave2-i18n-quality. (Listed despite only 2 agents flagging — the magnitude makes this a theme.)
**Pattern:** de=369 markers, ka=432 markers, ru=384 markers — far above the MEDIUM threshold of 20 per locale. Plus pluralized keys use English-only `_one`/`_other` with hand-coded `count===1 ? _one : _other` selection, which is mathematically wrong for Russian (needs 4 forms).

### Theme J — Stub services on production paths (3 agents)
**Agents:** pacs, cases, wave2-ui-ux.
**Pattern:** `auditService.ts` (Phase-4 stub), `imagingStudyService.ts` (23 functions stubbed), `useCasesListStub` with hardcoded `Bearer dev-access-token`, `EMRErrorCard` / `EMRTableEmptyState` (TODO stubs). All ship today against live tenants with no feature flag; UIs render "always empty" / "always works" / "off-brand" silently.

---

## Findings — BLOCKERs grouped by area

### BLOCKER — Wave 0 (Dependencies + Unit Tests)

No BLOCKERs from Wave 0.

### BLOCKER — PACS (Agent 01)

#### B-PACS-1 — Dev anonymization sidecar passes raw DICOM through on Orthanc failure
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/anon_sidecar/main.py:132-145`
- **Blast Radius:** ISOLATED (one route; every dev/test cascade affected)
- **Evidence:**
  ```python
  new_orthanc_id = _anonymize_orthanc_study(orthanc_id)
  if not new_orthanc_id:
      logger.warning("Anonymize failed ... returning passthrough so cascade can proceed (DEV ONLY)")
      return AnonymizeResponse(status="done", output_uri=f"orthanc://passthrough/{orthanc_id}")
  ```
  When Orthanc's anonymizer fails, the sidecar returns "done" pointing at the ORIGINAL un-scrubbed DICOM. The "DEV ONLY" comment is the only guard.
- **Fix:** Replace passthrough fallback with `HTTPException(status_code=502, detail="anonymization_failed")`. Cascade must fail-closed per FR-002a. If a "dev fast path" is desired, gate behind explicit env var FALSE by default AND log the bypass to AuditEvent.
- **ELI5:** A nightclub bouncer is supposed to take everyone's ID and replace it with an anonymous wristband. When his label printer breaks, he says "fine, just go in with your real ID." Patient names and DOBs now flow into S3, FHIR ImagingStudy, and PDF reports.

#### B-PACS-2 — tus chunk upload buffers entire body in RAM despite "streaming" comment
- **Severity:** BLOCKER
- **Dimension:** D1 Data Integrity / D6 Performance
- **File:** `packages/ml-inference/src/api/ingest.py:507-510`
- **Blast Radius:** LOCAL (every DICOM upload routes through this handler)
- **Evidence:**
  ```python
  # Stream body in a loop so 5 GB uploads don't buffer in RAM.
  body = b""
  async for chunk in request.stream():
      body += chunk
  ```
  Comment promises chunked streaming; implementation concatenates every chunk into one `bytes` object then single `put_object`. 5 GB CT → 5 GB RAM → OOM-killed worker.
- **Fix:** Use `boto3.client.upload_part` with the S3 multipart-upload API; OR stream to a temp file with `aiofiles` then upload. Track `UploadId` + part ETags in `upload_session.etags`. Add a `FOR UPDATE` lock on `upload_session` to prevent concurrent chunk collisions.
- **ELI5:** A hospital says "we accept patient records up to 5 GB" but the intake clerk uses one index card. First real CT fills the card, drops it — now no record exists for anyone.

#### B-PACS-3 — DICOMweb client sends NO auth in production; auth callback hardcoded null/empty
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** `packages/app/src/emr/hooks/useDicomWebClient.ts:37`; `packages/app/src/emr/views/pacs/PacsStudyViewerView.tsx:136`
- **Blast Radius:** CROSS-MODULE (every QIDO/WADO/STOW + every Cornerstone pixel-frame load)
- **Evidence:**
  ```ts
  // useDicomWebClient.ts
  getAccessToken: () => null,
  // PacsStudyViewerView.tsx
  configureDicomAuth(() => '');
  ```
  Both call sites hardcode the token callback to null/empty. `dicomwebClient.buildHeaders` only sets `Authorization: Bearer ...` when a token is present, so production requests go out with NO Authorization header. Vite dev proxy injects Basic auth server-side; production has no equivalent.
- **Fix:** Replace with `() => useAuth().session?.access_token ?? null`. Add runtime assertion throwing if no token in production. Add E2E test that intercepts the outgoing DICOMweb request and asserts the Authorization header.
- **ELI5:** Hospital's image vault has a card reader at the door but staff app was built with a dummy keycard that's all zeros. In the dev building a guard inside the door waves people through; in production there's no guard — and the dummy card opens the vault.
- **Also flagged by:** security (SEC1)

#### B-PACS-4 — Sidecar `_maybe_crypto_shred` swallows shred failures — silent compliance violation
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/anon_sidecar/main.py:418-433` (production sidecar); `pacs/anon-sidecar/main.py:418-433`
- **Blast Radius:** LOCAL (every gate-failure branch)
- **Evidence:**
  ```python
  if schedule_case_key_deletion is None or kms_alias is None or tenant_uuid is None or study_uuid is None:
      logger.warning("crypto_shred skipped — missing dependency or context (reason=%s)", reason_slug)
      return
  try:
      await schedule_case_key_deletion(...)
  except Exception as exc:
      logger.error("crypto_shred failed: %s", str(exc)[:120])
  ```
  FR-002a requires bytes en route to S3 become unrecoverable within 60s on gate failure. Function silently returns when KMS missing and silently logs-and-continues on shred RPC raise.
- **Fix:** Raise on startup when `schedule_case_key_deletion` unavailable (fail-fast). When shred raises: emit `crypto_shred_failed` AuditEvent + Sentry alert + dead-letter queue. Never return `_deny` without a confirmed shred OR a confirmed failure audit row.
- **ELI5:** Bank vault supposed to incinerate paperwork when unauthorized person briefly opened a drawer. Shredder is broken; instead of paging security, system writes "shredder failed" in a notebook nobody reads. Papers stay in the drawer.

### BLOCKER — Cases (Agent 02)

No BLOCKERs from this area; see CRITICALs.

### BLOCKER — Cascade (Agent 03)

#### B-CASCADE-1 — Production cascade emits zero audit-chain events — CE MDR / GDPR violation
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/scripts/real_cascade.py:203-952`; `packages/ml-inference/src/tasks/real_cascade_task.py:72-136`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** `grep -n "audit_event_chain\|AuditChainWriter\|chain_of_hashes" real_cascade.py` returns zero matches. Cascade writes to `pipeline_checkpoint`, `segmentation`, `lesion`, `flr_calculation`, `analysis_finding` with zero AuditEvents.
- **Problem:** `LIVERRA_CASCADE_REAL_MODE=true` is the default. Every "Run AI" click writes clinical findings to the DB with zero tamper-evident audit trail. Breaks FR-029b and CE MDR 10-year clinical-record audit requirement.
- **Fix:** Inside each stage of `run_real_cascade`, after the checkpoint INSERT, call `AuditChainWriter().write({...stage_complete event...}, tenant_id, session)` in the SAME transaction. Wrap the cascade in `cascade.run_stage()` pattern and wire `set_audit_hooks()` at FastAPI startup.
- **Verify:** Run a cascade; `SELECT count(*) FROM audit_event_chain WHERE created_at > now()-interval '15 min'` should return ≥7 rows.
- **ELI5:** AI radiology system writes diagnoses straight into patient charts but security cameras are off and door log is blank. Regulator asks "who ran the AI, what version" — nobody can answer.
- **Also flagged by:** audit-compliance, sweep-catch-blocks

#### B-CASCADE-2 — `cascade.set_audit_hooks()` is never called — every `run_stage` audit hook is a no-op
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/src/orchestrator/cascade.py:153-200`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** `_AUDIT_HOOKS: CascadeAuditHooks = CascadeAuditHooks()` (base class with `...` bodies). `grep -rn "set_audit_hooks" packages/ml-inference/src/` returns only the definition + `__all__` export — never a call site.
- **Fix:** In `packages/ml-inference/src/main.py` (FastAPI startup) and in `workers/app.py` (Celery worker_ready signal), call `set_audit_hooks(LiveCascadeAuditHooks(...))` with real implementation.
- **ELI5:** Fire alarms wired throughout the building, but nobody turned the breaker on. Every "stage failed" event passes through dead hardware.

#### B-CASCADE-3 — Model versions never persisted to `analysis.model_versions` — provenance broken
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/scripts/real_cascade.py` (entire), `tasks/*.py`
- **Blast Radius:** LOCAL
- **Evidence:** `grep -rn "model_versions" src/tasks/ scripts/real_cascade.py` → no output. The `analysis.model_versions JSONB` column is initialized to NULL and never updated; per-stage `pipeline_checkpoint.model_version` exists but rolled-up column is empty.
- **Fix:** At end of `run_real_cascade` and `mark_cascade_complete`, run `UPDATE analysis SET model_versions = jsonb_build_object(...)`. ~5-10 lines.
- **ELI5:** Every medicine bottle has a batch label. Cascade produces "bottles" (clinical findings) without labels. If a model gets recalled you can't find which analyses used it.

#### B-CASCADE-4 — `run_real_cascade` returns `int 1` from a function declared `→ dict` on missing liver mask
- **Severity:** BLOCKER
- **Dimension:** D1 Data Integrity
- **File:** `packages/ml-inference/scripts/real_cascade.py:268-271`
- **Blast Radius:** ISOLATED
- **Evidence:**
  ```python
  liver_path = seg_dir / "liver.nii.gz"
  if not liver_path.exists():
      print(f"      !! expected {liver_path} not found", file=sys.stderr)
      return 1
  ```
  When TotalSegmentator fails to produce a liver mask, cascade abandons the analysis in `running` state. UI hangs at "Pipeline Running" indefinitely.
- **Fix:** Replace `return 1` with `raise RuntimeError("GPU produced no liver.nii.gz — TS upstream failure")`. The existing `except Exception` in `real_cascade_task.py` then marks `status='failed'`.
- **ELI5:** Restaurant kitchen out of main ingredient; instead of telling the waiter, they put the ticket in a drawer. You sit watching "your order is being prepared" forever.

### BLOCKER — Inference (Agent 04)

#### B-INFER-1 — GPU service returns no model-version / weights-SHA — every cascade row has hand-written model_version strings
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference-gpu/main.py:113-182` (no metadata in any response); `packages/ml-inference/src/services/inference_client.py:44-74`; `packages/ml-inference/scripts/real_cascade.py:237-247` (hardcoded `"totalsegmentator-v2"`)
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** GPU service `/infer/*` endpoints return only the ZIP body — no `X-Model-Version`, no weights SHA. Cascade writes a fixed string `"totalsegmentator-v2"` for every analysis. If someone `pip install -U TotalSegmentator` on the GPU box, cascade still records the same string while running totally different weights.
- **Fix:** GPU service returns `X-LiverRa-Model-Version`, `X-LiverRa-Model-Weights-SHA` headers (from `totalsegmentator.__version__` + manifest of weight-file SHA-256s computed at startup). Client reads headers in `_post_and_extract`, threads to `insert_checkpoint`.

#### B-INFER-2 — GPU `liver_vessels` subtask wired into production with no kill-switch (paid commercial license required)
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance (model licensing discipline)
- **File:** `packages/ml-inference-gpu/main.py:124-128, 162-166`; consumed by `inference_client.py:91-101` and `scripts/real_cascade.py:267`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** Endpoint is unconditionally available on tailnet. CLAUDE.md "Model Licensing Discipline" — `liver_vessels` requires paid commercial license OR BAMF aimi-liver-tumor-ct swap.
- **Fix:** Add `LIVERRA_TS_COMMERCIAL_LICENSED` env var. Default false → `/infer/liver_vessels` and `/infer/total_and_vessels` return HTTP 451 with explanatory body. Base `/infer/total` stays unrestricted (Apache-2.0). Mirror gate on the laptop's cascade.
- **Also flagged by:** security (SEC10b)

#### B-INFER-3 — GPU service has zero authentication — any tailnet peer can submit a CT
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** `packages/ml-inference-gpu/main.py:31-32, 113, 124, 131, 185`
- **Blast Radius:** ISOLATED
- **Evidence:** No `Depends`, no `security.HTTPBearer`, no token check anywhere in the file. Tailscale ACL is the only barrier.
- **Fix:** Add `LIVERRA_GPU_SHARED_TOKEN` env var. FastAPI dependency `verify_token` checks `Authorization: Bearer` against env via constant-time compare. All `/infer/*` gated; `/health` may stay unauthed.
- **Also flagged by:** security (SEC1 C-4)

### BLOCKER — Clinical Algorithms (Agent 05)

#### B-CLIN-1 — Indeterminate-malignant (LR-M) finding is structurally always empty
- **Severity:** BLOCKER
- **Dimension:** D3 Business Logic
- **File:** `packages/ml-inference/src/services/post_processing/findings.py:412-443` + `packages/ml-inference/scripts/real_cascade.py:729-733`
- **Blast Radius:** LOCAL
- **Evidence:** Finding filters for `label != "LR-M"` — but the classifier emits tumor types {hcc, icc, metastasis, fnh, hemangioma, cyst}. No code path ever assigns `"LR-M"`.
- **Fix:** Either (a) add a derivation in `lirads_classifier.py` mapping low-confidence top1 (<0.6) AND `top1 in {"hcc","icc","metastasis"}` to `"lirads_class": "LR-M"`, then filter on that field; or (b) rename `compute_indeterminate_malignant_flag` to filter low-confidence malignant predictions directly from the 6-class output.
- **ELI5:** Lab sends reports tagged with tumor names (HCC, ICC). Alert system flags "LR-M" reports. No report ever uses that label, so the alert system never fires — but the dashboard card exists, so everyone assumes it does.

#### B-CLIN-2 — Two divergent Couinaud implementations produce different segment topologies on the same scan
- **Severity:** BLOCKER
- **Dimension:** D3 Business Logic
- **File:** `packages/ml-inference/src/orchestrator/couinaud_heuristic.py:148` (`compute_couinaud`, IVC↔gallbladder Cantlie line — used by `real_cascade.py`) vs `packages/ml-inference/src/services/couinaud_heuristic.py:38` (`heuristic_couinaud`, axis-aligned X-median — used by `tasks/couinaud.py:612`)
- **Blast Radius:** CROSS-MODULE
- **Fix:** Pick `orchestrator/couinaud_heuristic.py` (anatomical) as the single implementation. Update `tasks/couinaud.py:612` to import from `src.orchestrator.couinaud_heuristic`. Delete `src/services/couinaud_heuristic.py`.
- **ELI5:** Hospital has two rulers for liver segments — one based on anatomical landmarks, one based on "just split down the middle." Two surgeons see different answers about which segment a lesion lives in.

#### B-CLIN-3 — `tasks/flr_default.py` uses hardcoded 2.3³ mm³ voxel for clinical FLR
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety (mixed-unit / unsourced-numeric)
- **File:** `packages/ml-inference/src/tasks/flr_default.py:56`, called from `packages/ml-inference/src/orchestrator/cascade.py:372`
- **Blast Radius:** LOCAL
- **Evidence:** `_DEFAULT_VOXEL_VOLUME_ML = (2.3 ** 3) / 1000.0`. Real CT spacing varies 0.7–5 mm. Multiplying voxel count by 2.3³ produces volume 30× too small on 0.7 mm scan, ~10× too large on 5 mm scan. This task writes `flr_calculation` with `author='ai_default'` — the surgeon-facing FLR.
- **Fix:** Load actual NIfTI spacing via `nib.load(...).header.get_zooms()`. Multiply `voxels * spacing_x * spacing_y * spacing_z / 1000.0`. Mirror `real_cascade.py:474` pattern.
- **ELI5:** Nurse measures weight with an adult scale calibrated for adults, then uses that number on a baby. Scale reads "75 kg." Surgeon trusts it and plans accordingly.

#### B-CLIN-4 — Axial-midpoint "FLR" heuristic has no clinical basis and is wired into production
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety
- **File:** `packages/ml-inference/src/tasks/flr_default.py:80-108`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** `_compute_default_plane` slices the liver at its axial midpoint and counts voxels on the superior side as "FLR." No anatomical justification. Output goes into `flr_calculation` with `author='ai_default'`.
- **Fix:** Delete `flr_default.py` and update `orchestrator/cascade.py:319,372` to call `compute_segment_aware_flr` (from `orchestrator/flr_segment_aware.py`).
- **ELI5:** Chef says "I'll cut the cake at whichever Z coordinate the cake is widest." That's not a meaningful instruction. The surgical-planning tool says "your remnant liver is the top half of the bounding box."

#### B-CLIN-5 — Clinical mutations write without audit_event_chain in same transaction
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety / CE-MDR audit chain
- **File:** `packages/ml-inference/scripts/real_cascade.py:730-760, 826-844, 440-471`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** Lesion, FLR, segmentation INSERTs with no AuditEvent/audit_event_chain co-write. `grep -n "CascadeAuditHooks\|AuditChainWriter\|audit_event" packages/ml-inference/scripts/real_cascade.py` returns zero matches.
- **Fix:** Wrap each INSERT in `real_cascade.py` with `AuditChainWriter` pattern from `orchestrator/checkpoint.py`. Same DB transaction, monotonic `sequence_no` per tenant, `leaf_hash` over canonical (analysis_id, stage, output_uri, model_version, model_license_hash).
- **Duplicate-of:** B-CASCADE-1 (per-agent flag retained for tracking)

### BLOCKER — ACR Readout (Agent 06)

#### B-ACR-1 — Stale-finding marker computed but never rendered on screen OR in PDF
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety
- **File:** `packages/app/src/emr/services/report/acrAnatomicalMapping.ts:509-527` (TS computes `row.stale`); 5 `ACRSection*.tsx` (no `row.stale` reference); `packages/ml-inference/src/services/export/acr_section_builder.py:1-457` (Python NEVER computes `stale`); `packages/app/src/emr/components/report/ACRSection.module.css:91-95` (`.stale` CSS class defined but never applied)
- **Blast Radius:** CROSS-MODULE
- **Problem:** FR-023c requires findings whose `computed_at` predates the latest completed cascade stage to be marked stale across all three render channels (screen, clipboard, PDF). Today the TS clipboard text is the ONLY channel that prints staleness. A surgeon reading the PDF can't tell whether the FLR value reflects the latest cascade or a snapshot.
- **Fix:** (1) Add `stale: { computed_at }` key to every Python row in `acr_section_builder.py` using the same algorithm as `stampStale`. (2) In each ACR section component, render `row.stale` using the existing `.stale` CSS class. (3) Add the same staleness annotation to the PDF Jinja2 template.
- **ELI5:** Bank statement shows balance "$5,000" in big letters, timestamp says it was computed yesterday before three withdrawals cleared. Clipboard-copy adds a note "(last computed yesterday 6pm)"; screen and printed paper version don't. Surgeon takes printed report into OR, plans on yesterday's numbers.

#### B-ACR-2 — Four new audit FHIR extensions referenced in code but no published StructureDefinition
- **Severity:** BLOCKER
- **Dimension:** D5 FHIR Compliance
- **File:** `packages/app/src/emr/constants/fhir-extensions.ts:55-67`; `packages/ml-inference/src/services/audit/fhir_extensions.py:26-29`; `packages/fhirtypes/src/liverra/extensions/` (missing 4 files)
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** Missing files: `StructureDefinition-audit-locale.json`, `StructureDefinition-audit-tenant.json`, `StructureDefinition-audit-client-action-id.json`, `StructureDefinition-audit-failure-category.json`. Code emits these extensions on every clipboard-export AuditEvent.
- **Problem:** Strict FHIR validator (Medplum, HAPI strict, EU MyHealth@EU) silently drops unknown extensions. Locale, tenant, client_action_id, failure_category stripped from every clipboard-export AuditEvent — chain-of-hashes intact but auditor sees AuditEvents with no actor-language, no tenant binding, no idempotency key.
- **Fix:** Author four new `StructureDefinition-*.json` files. Add a build-time assertion that every URL in `LIVERRA_EXTENSIONS` has a matching JSON file.
- **Also flagged by:** wave2-fhir-validator (FC2), audit-compliance, schema

### BLOCKER — Refinement (Agent 07)

#### B-REFINE-1 — Missing `lesion_classification_override` table — every override write 500s
- **Severity:** BLOCKER
- **Dimension:** D1 Data Integrity (also D5/D10)
- **File:** `packages/ml-inference/src/api/review.py:467-484`
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** `INSERT INTO lesion_classification_override ...` — table does not exist in any of 13 alembic migrations. The endpoint is decorated `@require_permission(..., step_up=True)`, so the user just experienced step-up MFA before the failure.
- **Fix:** Add migration `00NN_lesion_classification_override.py` creating table `(id uuid pk, lesion_id uuid fk→lesion, user_id uuid, class text, reason text, created_at timestamptz, parent_classification_id uuid fk→classification)`. Unique partial index on `(lesion_id) WHERE superseded_at IS NULL` for per-lesion latest-wins. Add `reviewer_override_class` column on `classification`.
- **ELI5:** Hospital where every time a senior surgeon corrects an AI diagnosis, the nurse pulls out a binder to file the correction — binder doesn't exist. Surgeon's override is shouted into the void; patient ends up being treated based on the AI's wrong call.

#### B-REFINE-2 — Classification-override audit row writes `analysis_id=00000000-0000-0000-0000-000000000000`
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/src/api/review.py:488-499`
- **Blast Radius:** LOCAL
- **Evidence:** `analysis_id=UUID(int=0)` — comment says "filled by upstream if known," nothing upstream rewrites chain rows.
- **Fix:** Inside `classification_override`, `SELECT analysis_id FROM lesion WHERE id = :lid` before emitting audit. Pass real UUID. The seat-manager already knows analysis_id for review_id — pull from there.
- **ELI5:** Tamper-proof logbook where every override entry is filed under "patient #0" — a patient that doesn't exist.

#### B-REFINE-3 — Frontend "Add lesion" sends `{ segment: 'V' }` but backend requires `{ analysis_id, voxel: [x,y,z] }` — every reprompt 422s
- **Severity:** BLOCKER
- **Dimension:** D5 FHIR/Contract Compliance
- **File:** `packages/app/src/emr/views/cases/LesionsPanelView.tsx:274-282` vs `packages/ml-inference/src/api/review.py:162-167`
- **Blast Radius:** LOCAL
- **Fix:** Replace `handleAddLesion` with flow that requires user to click viewer for voxel, capture via existing `liverra:viewer-click` event listener pattern in `RefinementView.tsx:222-249`, then POST `{ analysis_id, voxel:[x,y,z], label }`. Until wired, disable the button.
- **ELI5:** "Submit case" button that the developer wired to send "hello world" instead of actual form data. User clicks "Add lesion," gets a success toast, walks away — no lesion was created.

### BLOCKER — Audit & Compliance (Agent 08)

#### B-AUDIT-1 — Erasure audit rewriter targets the WRONG TABLE
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/src/services/erasure/audit_rewriter.py:137-202`
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** Both SELECT and UPDATE target `audit_event`. Per migration 0005, business AuditEvents live in `audit_event_chain` (with `canonical_json text NOT NULL`, keyed by `(tenant_id, sequence_no)`). `audit_event` is the side-channel for `tampering_attempt` rows only.
- **Problem:** Erasure orchestrator queries an empty table for the study UUID, finds nothing, reports `events_rewritten=0`. The actual FHIR AuditEvent canonical bodies inside `audit_event_chain.canonical_json` (carrying study UUID, patient MRN, DICOM UID, DPO email) are NEVER scrubbed. DPO signs PDF certifying compliance with a step that didn't happen.
- **Fix:** Change both queries to `audit_event_chain`. SELECT cannot use `id`; use `(tenant_id, sequence_no)`. UPDATE must use composite key. Confirm `canonical_json text` (not jsonb) — the existing `CAST(:json AS jsonb)` will fail too.
- **ELI5:** DPO tells records clerk "redact every reference to this patient's name from our audit binder." Clerk goes to wrong cabinet (blank forms), comes back saying "all done, zero names found." PDF receipt says "audit binder cleaned, 0 substitutions." Real audit binder still has the patient's MRN on every page.

#### B-AUDIT-2 — Canonical-JSON LIKE pattern uses `": "` with space; canonicalizer emits `":"` with NO space
- **Severity:** BLOCKER
- **Dimension:** D1 Data Integrity
- **File:** `packages/ml-inference/src/services/audit/clipboard_export_event.py:213-215`; `packages/ml-inference/src/jobs/audit_retention_attestation.py:94`
- **Blast Radius:** LOCAL
- **Evidence:** Canonicalizer uses `separators=(",", ":")` (no space after colon); idempotency lookup uses `'%"valueUuid": "..."'` (space after colon). Attestation uses `'%"code": "readout-clipboard-export"%'` (also wrong). LIKE never matches.
- **Problem:** (1) Idempotency: every clipboard-export retry creates a duplicate `audit_event_chain` row. (2) Retention attestation: year-end signed S3 manifest reports 0 clipboard-export rows for every tenant every year. Either alerts auditors to broken pipeline OR (worse) auditors accept zero counts and compliance evidence is silently a forgery.
- **Fix:** Match canonicalizer exactly: `'%"valueUuid":"..."'` and `'%"code":"readout-clipboard-export"%'`. Better: store `client_action_id` as dedicated column with UNIQUE index.

#### B-AUDIT-3 — `AuditChainWriter.from_request` and `.write_permission_check` do not exist — every permission-check audit silently swallowed
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** `packages/ml-inference/src/middleware/require_permission.py:214-237`; `chain_of_hashes.py:95-221` (declares only `__init__` and `.write`)
- **Blast Radius:** CROSS-MODULE
- **Evidence:** Middleware calls `AuditChainWriter.from_request(request)` and `writer.write_permission_check(...)`. Both methods raise `AttributeError`. The bare `except Exception` swallows it and logs a warning. Permission-check audit is dropped on every authenticated request.
- **Fix:** Either (a) implement the methods as classmethod + thin wrapper; or (b) inline equivalent logic using the existing `.write()` API. Critically, tighten the `except Exception` to only swallow known recoverable errors.

#### B-AUDIT-4 — AuditEventEmitter is never wired into the app — FHIR-AuditEvent + chain-of-hashes co-write pipeline is dead code
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/src/services/fhir/audit_event_emitter.py:89-163`; `packages/ml-inference/src/main.py:113-116`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** `grep -rn "AuditEventEmitter\|audit_event_emitter" packages/ml-inference/src/` shows zero instantiation sites outside emitter file + the daily_merkle_root consumer. Every direct `AuditChainWriter.write(...)` (in 7+ task modules) writes chain row without PHI scrubbing and without Medplum mirror.
- **Fix:** In `main.py` lifespan, after constructing `AuditChainWriter`, instantiate `AuditEventEmitter(medplum_client, audit_writer, phi_scrubber)`. Register on `app.state.audit_event_emitter`. Refactor every direct `AuditChainWriter.write(...)` caller through the emitter.

#### B-AUDIT-5 — AuditChainWriter sequence_no race: two SELECTs after FOR UPDATE; first-row race + steady-state gap
- **Severity:** BLOCKER
- **Dimension:** D1 Data Integrity
- **File:** `packages/ml-inference/src/services/audit/chain_of_hashes.py:144-175`
- **Blast Radius:** LOCAL
- **Evidence:** Step 1 `FOR UPDATE ... ORDER BY sequence_no DESC LIMIT 1` locks nothing on first write (empty result). Step 2 `MAX(sequence_no)+1` is unguarded. Two concurrent writers both see prev=GENESIS, both compute seq=1, one PK-violates. Steady-state: writer B can sneak in between Step 1 and Step 2.
- **Fix:** Use `pg_advisory_xact_lock(hashtext('audit_chain:' || :tid))` at the top of `write`. Released automatically on transaction end.
- **Also flagged by:** schema (B2), sweep-optimistic-locking

#### B-AUDIT-6 — Chain-of-hashes tamper-detection test suite is vacuously skipped — every `pytest.skip` masks total absence of `verify_chain`
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance
- **File:** `packages/ml-inference/src/services/audit/tests/test_chain_of_hashes.py:46-61`
- **Blast Radius:** LOCAL (test code) but implies CONTRACT-CHANGE — no chain-verifier in codebase
- **Evidence:** Tests `getattr(coh, "write_event"/"ChainWriter"/"verify_chain"/"ChainVerifier")` — none exist. Every test hits `pytest.skip`. SC-010 explicitly requires tampering at start/middle/end of chain be detected; test file ostensibly covers this but skips.
- **Fix:** (a) Add `def verify_chain(rows)` to `chain_of_hashes.py` that walks the list, recomputes each leaf_hash, returns `(False, first_bad_seq)` on mismatch. (b) Rewrite tests against real `AuditChainWriter`. (c) Wire `verify_chain` into `/compliance/audit-summary` so `chain_valid` actually means something.

### BLOCKER — Design System (Agent 09)

No BLOCKERs from this area; see CRITICALs.

### BLOCKER — i18n (Agent 10)

No BLOCKERs from this area; see HIGHs.

### BLOCKER — Auth & Settings (Agent 11)

#### B-AUTH-1 — `@require_permission` returns 403, not 404 — FR-032a + RBAC red-team matrix completely broken
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** `packages/ml-inference/src/middleware/require_permission.py:93-100, 294-298`
- **Blast Radius:** CROSS-MODULE (every API handler uses `@require_permission`)
- **Evidence:** `_forbidden(perm)` returns status 403; the decorator's docstring claims 404. Tests `test_require_permission_decorator.py:107` and `tests/rbac/test_role_crossing.py:203-212` assert 404 — they all fail.
- **Problem:** Spec FR-032a forbids 403 — leaks existence of cross-tenant or higher-privilege resources. Entire `tests/rbac/test_role_crossing.py` cartesian red-team matrix (15/15) fails.
- **Fix:** Change `_forbidden(perm)` to return 404 problem+json with slug `not-found`. Keep the audit-event emission.

#### B-AUTH-2 — RBAC matrix drift: 12 permissions enforced in code do not exist in `matrix.yaml`
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** Decorators across `packages/ml-inference/src/api/*.py`; source of truth `packages/ml-inference/src/services/auth/rbac/matrix.yaml`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** Decorators reference 12 permissions NOT in matrix: `admin.approve_deletion`, `admin.cecho_pacs`, `admin.configure_pacs`, `admin.coverage_override`, `admin.invite_user`, `admin.suspend_user`, `admin.view_audit`, `compliance.generate_audit_summary`, `compliance.spot_check_ruo`, `compliance.toggle_claim_registry`, `compliance.view_mbom`, `review.acquire_seat`. The hand-rolled dev-bypass list in `auth_middleware.py:230-241` carries the OLD names — papers over the bug in dev.
- **Problem:** In production, every admin invite, every PACS C-ECHO, every compliance MBoM view, every audit-summary generation, every seat acquisition will 403 (which per B-AUTH-1 should be 404). Only `LIVERRA_AUTH_BYPASS` superuser passes.
- **Fix:** Pick one direction: (a) Add missing rows to `matrix.yaml`; (b) Rename decorators to existing matrix keys. Delete hand-coded `_DEV_BYPASS_PERMISSIONS` tuple; replace with `list(p.value for p in Permission)`.

#### B-AUTH-3 — Backend `LIVERRA_AUTH_BYPASS=true` has no production-environment guard
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization
- **File:** `packages/ml-inference/src/middleware/auth_middleware.py:121-154`
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** Frontend has `vite.config.ts:62` guard refusing to build with `VITE_LIVERRA_DEV_BYPASS=true` in `NODE_ENV=production`. Backend has no equivalent.
- **Fix:** Add at top of `AuthMiddleware.__init__`:
  ```python
  env = os.environ.get("LIVERRA_ENV", "development").lower()
  if bypass_active and env in {"staging", "production"}:
      raise RuntimeError("PRODUCTION SAFETY: LIVERRA_AUTH_BYPASS forbidden when LIVERRA_ENV={env}.")
  ```
- **Also flagged by:** security (B-1)

#### B-AUTH-4 — Invite-accept JWT: dev-fallback signing key + no `iss` check + no single-use replay protection
- **Severity:** BLOCKER
- **Dimension:** D2 Security & Authorization + D10 Compliance
- **File:** `packages/ml-inference/src/services/admin/invite_service.py:100, 137-150, 194-210`
- **Blast Radius:** CROSS-MODULE
- **Evidence:** Dev fallback secret `"dev-invite-secret-CHANGE-ME"` committed. `verify_token` checks `audience` only — no `issuer` check. JTI minted but never persisted to consumed-JTIs table. Plus no caller exists for `verify_token` (dead code on a security-critical path).
- **Fix:** (1) Remove dev-fallback; raise even in development. (2) Add `issuer="liverra.ai"` to `jwt.decode`. (3) Add `consume_invite(jti, *, session)` with `INSERT INTO invite_used (jti) VALUES (...) ON CONFLICT DO NOTHING RETURNING jti`; raise `InviteAlreadyUsed` on no return.

### BLOCKER — Schema (Agent 12)

#### B-SCHEMA-1 — `audit_event_chain` and `audit_event` have NO Row-Level Security
- **Severity:** BLOCKER
- **Dimension:** D10 Clinical Safety & Compliance (CE-MDR / GDPR breach)
- **File:** `packages/ml-inference/src/db/alembic/versions/20260419_0005_audit_chain.py:32-79`
- **Blast Radius:** CONTRACT-CHANGE
- **Evidence:** No `ENABLE ROW LEVEL SECURITY`, no `CREATE POLICY` for either table. Every other tenant-scoped table has `FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy.
- **Fix:** Add to a follow-up migration: `ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_event FORCE ROW LEVEL SECURITY; CREATE POLICY audit_event_tenant_isolation ON audit_event USING (tenant_id::text = current_setting('app.tenant_id', true))`. Same for `audit_event_chain` and `audit_event_chain_default`. Add FKs `tenant_id uuid NOT NULL REFERENCES tenant(id)`.
- **ELI5:** Hospital where every patient's medical record is in a locked cabinet, except the audit logbook ("who looked at what, when") which sits on a shared desk. The logbook is the file that documents who accessed PHI — an attacker reading other tenants' audit chains can reverse-engineer who their patients are.

#### B-SCHEMA-2 — `audit_event_chain` race condition on concurrent first-write per tenant
- **Severity:** BLOCKER
- **Dimension:** D2/D1
- **File:** `packages/ml-inference/src/services/audit/chain_of_hashes.py:146-211`
- **Blast Radius:** CROSS-MODULE
- **Duplicate-of:** B-AUDIT-5

### BLOCKER — Wave 2 Specialists / Sweeps

No additional BLOCKERs beyond those rolled in above. Wave 2 security flagged B-1 + B-2 (LIVERRA_AUTH_BYPASS, ANON_SIDECAR_BYPASS), both already in the area-counts.

---

## Findings — CRITICALs grouped by area

(Brief format below — full evidence + ELI5 in the originating partial; the orchestrator's dedup canonical wins where multiple agents flagged the same fingerprint.)

### CRITICAL — Wave 0

#### C-DEP-1 — happy-dom ≤ 20.8.8 has critical VM-context-escape RCE
- **Dimension:** D2 | **File:** `packages/app/package.json:46` | **Blast Radius:** ISOLATED (dev-only)
- **Evidence:** `happy-dom@15.11.7` — GHSA-37j7-fg3j-429f (RCE), GHSA-w4gp-fjgq-3q4g (credentials leak), GHSA-6q6h-j7hj-3r64 (code execution).
- **Fix:** Bump to `^20.9.0` in `packages/app/package.json`. `npm audit fix --force` works; verify breaking-changes list.
- **ELI5:** Fake browser used for tests has a bug that lets test code escape the sandbox. Only affects tests, but fix is one-line.

#### C-UT-1 — ACR clipboard service fails 5 of 6 audit-lineage tests
- **Dimension:** D10 | **File:** `packages/app/src/emr/services/report/__tests__/acrClipboardService.spec.ts:127` | **Blast Radius:** LOCAL
- **Evidence:** All 5xx/401/403/clipboard-blocked/stale-ETag paths fail with timeouts (~5–10s each). These are the only tests proving FR-018 audit-event lineage is emitted for clipboard exports.
- **Fix:** Check fetch/IndexedDB mock setup. Uniform timeouts suggest mocks aren't intercepting requests after refactor.

#### C-UT-2 — Full RBAC role-crossing matrix fails (15/15 scenarios)
- **Dimension:** D2 | **File:** `packages/ml-inference/tests/rbac/test_role_crossing.py` | **Blast Radius:** CROSS-MODULE
- **Fix:** Manual review — likely root cause is the 403 vs 404 BLOCKER (B-AUTH-1) plus matrix drift (B-AUTH-2).

#### C-UT-3 — `@require_permission` decorator returns wrong status codes + missing audit tag
- **Dimension:** D2 | **File:** `packages/ml-inference/tests/security/test_require_permission_decorator.py` | **Blast Radius:** CROSS-MODULE
- **Duplicate-of:** B-AUTH-1

#### C-UT-4 — PHI scrubber leaks header2 + fails open on regex crash
- **Dimension:** D10 | **File:** `packages/ml-inference/tests/observability/test_phi_scrubber.py`
- **Fix:** Add header2 leak pattern to regex; wrap scrubber entry point in try/except returning "redacted" on internal exception.

#### C-UT-5 — PACS push retry leaks PHI in `last_error`
- **Dimension:** D10 | **File:** `packages/ml-inference/tests/integration/test_pacs_push_retry.py`
- **Fix:** Pass `last_error` strings through PHI scrubber before persisting.
- **Note:** Wave 1 PACS verified the production code IS scrubbing via `_scrub(message)`. The test failure may be a fixture issue.

#### C-UT-6 through C-UT-13 — Zero direct unit tests on 8 clinical-safety algorithms
- **Dimension:** D10 | **Files:** `couinaud_heuristic.py` (312 LOC), `flr_segment_aware.py` (122 LOC), `lirads_classifier.py` (201 LOC), `lesion_enhancement_features.py` (179 LOC), `findings.py` (548 LOC), `cascade.py` (424 LOC), `cascade_us2.py` (209 LOC), `audit_event_emitter.py` (224 LOC), `erasure/orchestrator.py` (403 LOC), `auditService.ts`
- **Fix:** Add unit test files per Wave 0 listing. CE-MDR requires unit-level evidence of correctness.

### CRITICAL — PACS (Agent 01)

#### C-PACS-1 — PACS-push response body shows raw STOW failure strings to user → potential PHI leak
- **Dimension:** D10/D4 | **File:** `packages/app/src/emr/views/pacs/PacsStudiesView.tsx:199-201`
- **Evidence:** `result.stow.failures.join('; ')` renders into EMR Alert; failures may include PatientName fragments + filenames like `Patient_Smith_CT.dcm`.
- **Fix:** Strip filenames before joining; show "N file(s) failed" + numeric code summary; offer admin-only "Show diagnostics" toggle that routes through `phi_scrubber`.

#### C-PACS-2 — Frontend `auditService.ts` is fire-and-forget stub — every audit write is `console.warn`
- **Dimension:** D10 | **File:** `packages/app/src/emr/services/pacs/auditService.ts`
- **Evidence:** All `logStudyView`, `logBreakGlass`, etc. call `_fhir.createResource()` where `_fhir` is the stubbed `LiverRaFhirClient`. No durable store. Includes the break-glass emergency-override path.
- **Fix:** Wire to `POST /api/v1/audit-events` proxy that delegates to backend `AuditChainWriter`. Until wired, emit a startup banner in non-prod.

#### C-PACS-3 — PHI sent to DICOM tag browser modal — no redaction toggle, no audit emission
- **Dimension:** D10/D2 | **File:** `packages/app/src/emr/components/pacs/DicomTagBrowser.tsx:46-50`
- **Evidence:** Tags `00100010`, `00100020`, `00100030`, `00100040`, `00101010` displayed verbatim.
- **Fix:** (1) Wrap modal open in `logStudyView({studyId, patientId})`. (2) `--mask-phi` default that hashes PatientName/ID/DOB to last-4 unless break-glass reason entered. (3) Tag modal `data-phi="true"` for PostHog auto-mask.

#### C-PACS-4 — PACS C-ECHO admin endpoint accepts `use_tls` + `cert_fingerprint` but silently ignores both
- **Dimension:** D2 | **File:** `packages/ml-inference/src/services/pacs_cecho.py:36-91`; `packages/ml-inference/src/api/admin.py:97-103`
- **Evidence:** `_pynetdicom_echo` does NOT receive `use_tls` or `cert_fingerprint`; calls `ae.associate(host, int(port), ae_title=...)` without TLS context.
- **Fix:** Pass `use_tls` + `cert_fingerprint` into `_pynetdicom_echo`; configure `pynetdicom.AE` with `ssl.create_default_context()`-backed TLS handshake. Validate cert SHA-256 fingerprint. Until wired, REJECT requests where `use_tls=True` with 501.

#### C-PACS-5 — Hard-delete of FHIR `Basic` clinical resources (annotations, key images, hanging protocols, macros)
- **Dimension:** D10 | **Files:** `annotationService.ts:195,310`; `keyImageService.ts:349`; `hangingProtocolEngine.ts:491`; `macroService.ts:225`
- **Fix:** Replace `deleteResource('Basic', id)` with `updateResource({ ...existing, status: 'entered-in-error', extension: [...existing.extension, {url: ".../deleted-at", valueDateTime: now}]})`. Add `softDeleteResource` helper to `LiverRaFhirClient`. Each soft-delete writes an AuditEvent.

### CRITICAL — Cases (Agent 02)

#### C-CASES-1 — Cascade dispatch in `create_analysis` and `retry_analysis` races against the INSERT
- **Dimension:** D1 | **File:** `packages/ml-inference/src/api/analysis.py:474-497, 899-920`
- **Evidence:** Both endpoints `_dispatch_cascade(created["id"])` without `await session.commit()`. `_dispatch_cascade` opens a fresh sync psycopg connection that cannot see the uncommitted async row. The handler returns 202; cascade silently never runs. The fix pattern is already applied at `create_analysis_from_orthanc:599`.
- **Fix:** Insert `await session.commit()` immediately after `created = insert_row.mappings().one()` in both endpoints. ~2 lines.

#### C-CASES-2 — Surgical-planning numeric outputs ship without sanity bounds at the API boundary
- **Dimension:** D10 | **Files:** `analysis.py:783-803, 1355-1382`; `AnalysisDetailView.tsx:356-374`
- **Evidence:** FLR%, total_ml, flr_ml, segment volumes, longest_diameter_mm returned without ANY clinical bound (negative? >total? >100%?). LI-RADS classification parsed without validating label is in allowed valueset.
- **Fix:** `_validate_flr_bounds(flr_row, segmentations)` helper that returns row when 0 ≤ flr_pct ≤ 100 and flr_ml ≤ total_ml ≤ Σ segment volumes, otherwise attaches `confidence_flags=["flr_out_of_range"]` and clamps display to None. Mirror with a frontend guard downgrading the metric pill to "—" with warning tooltip.

### CRITICAL — Cascade (Agent 03)

#### C-CASCADE-1 — Heuristic outputs bypass all sanity bounds — `sanity.check_stage()` never called in real-mode
- **Dimension:** D10 | **File:** `packages/ml-inference/scripts/real_cascade.py`
- **Evidence:** `grep -n "sanity\|check_stage" scripts/real_cascade.py` → no output. Triton path runs `sanity.check_stage()` via `cascade.run_stage()` for parenchyma/couinaud/lesion_detection/classification/flr_init. Real-mode runs NONE.
- **Fix:** After `compute_segment_aware_flr` (~line 808), call `sanity.check_stage("flr_init", {...})`. After Couinaud (~line 415), call `sanity.check_stage("couinaud", {...})`. ~6 lines total.

#### C-CASCADE-2 — Cascade retry double-writes segmentation/lesion rows (no idempotency)
- **Dimension:** D1 | **File:** `packages/ml-inference/scripts/real_cascade.py:442-454, 458-470, 501-514, 736-755`
- **Evidence:** INSERTs without `ON CONFLICT`. Celery `task_acks_late=True` + `task_reject_on_worker_lost=True`; worker OOM during the 14-min cascade re-queues task → 2× rows for every Couinaud segment (16 not 8), 2× lesion rows.
- **Fix:** Add `ON CONFLICT DO NOTHING` to all four INSERTs using unique keys. For segmentation: `(analysis_id, anatomy_category, anatomy_detail)`. For lesions: deterministic UUID derived from `(analysis_id, lesion_index)`.

#### C-CASCADE-3 — `ANON_SIDECAR_BYPASS` allows PHI to flow into inference with no anonymization
- **Dimension:** D2 | **File:** `packages/ml-inference/src/tasks/anonymization.py:66-75`
- **Duplicate-of:** Security B-2

### CRITICAL — Inference (Agent 04)

#### C-INFER-1 — `infer_total_and_vessels` is the default despite being empirically slower
- **Dimension:** D10/D6 | **File:** `packages/ml-inference/scripts/real_cascade.py:259-267`
- **Evidence:** Cascade runs ~13m 51s vs ~12m 8s on the original two-call pattern. CLAUDE.md "Open decision" not executed.
- **Fix:** Replace line 267 with `infer_total(ct_path, dest_dir=seg_dir)` upfront + `infer_liver_vessels(ct_path, dest_dir=vessels_dir)` at start of stage 5. Per CLAUDE.md: ~5 lines.

#### C-INFER-2 — Inference client ZIP body extracted with `zf.extractall()` — ZIP-slip / path-traversal
- **Dimension:** D2 | **File:** `packages/ml-inference/src/services/inference_client.py:65-66`
- **Evidence:** `zf.extractall(dest_dir)` accepts any arcname including `../etc/passwd` or absolute paths. Compare with safe pattern already in same file at `:138-147`.
- **Fix:** Replace with per-member loop validating `Path(target).resolve().is_relative_to(dest_dir.resolve())` before write.
- **Also flagged by:** security (C-3)

### CRITICAL — Clinical Algorithms (Agent 05)

#### C-CLIN-1 — `flr_pct` divisor inconsistent with stored `total_ml`
- **Dimension:** D3 | **File:** `packages/ml-inference/scripts/real_cascade.py:812-844`
- **Evidence:** Stored `total_ml` is TS direct count; `flr_pct` is computed against `total_ml_seg` (sum of Couinaud segment voxels). The two can drift by a few % because of caudate carve-out, rounding, and the Cantlie boundary line.
- **Fix:** `flr_pct = round(flr_ml / total_ml * 100.0, 2) if total_ml > 0 else 0.0`. Add unit test asserting `abs(flr_pct - 100*flr_ml/total_ml) < 0.1`.

#### C-CLIN-2 — `extract_lesion_features` background HU pool includes OTHER lesions
- **Dimension:** D3 | **File:** `packages/ml-inference/src/orchestrator/lesion_enhancement_features.py:96-110`
- **Evidence:** Function takes only the current lesion's mask; other lesions remain in `liver_mask` and therefore in `background_bool`. Biases LI-RADS classifier toward APHE-positive classes (HCC, FNH) in multi-lesion cases.
- **Fix:** Add `all_lesions_mask` parameter (union of all lesion masks); compute `background_bool = (liver_mask > 0) & ~all_lesions_dilated`.

#### C-CLIN-3 — `compute_couinaud` voxel-orientation assumption unsafe under non-RAS NIfTI
- **Dimension:** D3/D10 | **Files:** `services/couinaud_heuristic.py:48`; `orchestrator/couinaud_heuristic.py:208-212`
- **Evidence:** Orchestrator assumes "right lobe is bigger." Breaks for prior right hepatectomy, right-lobe atrophy from cirrhosis, anatomical variants — exactly the patient population most likely to need this tool.
- **Fix:** Derive left/right from anatomical landmarks: IVC at midline + gallbladder anterior-right. Cantlie line from IVC to GB. Right lobe is whichever side of this line contains the gallbladder centroid. Add explicit `assert gallbladder is not None or "patient_anatomy_override"` for cirrhotic cases.

### CRITICAL — ACR Readout (Agent 06)

#### C-ACR-1 — Three new locale bundles (ru, ka, de) for `reportAcr` are 100% `__TODO_TRANSLATE__`; PDF builder ignores locale bundle entirely; `RUO_WATERMARKS` lacks `ru` key
- **Dimension:** D8 | **Files:** `packages/app/src/emr/translations/{ru,ka,de}/reportAcr.json`; `packages/ml-inference/src/services/report_renderer.py:884-889`; `packages/ml-inference/src/services/export/pdf_builder.py:69-73`
- **Fix:** (1) Replace placeholders under CODEOWNERS medical-terminology review. (2) In `report_renderer.py`, load locale-specific `reportAcr.json` and pass via `bundle=` to `_build_acr_sections`. (3) Add `"ru"` to `RUO_WATERMARKS`. (4) Add test that renders PDF in ru/ka/de and asserts section header is NOT the English literal.

#### C-ACR-2 — Stale-data clipboard failure miscategorized + fire-and-forget audit POST
- **Dimension:** D2 | **File:** `packages/app/src/emr/services/report/acrClipboardService.ts:252-285`
- **Evidence:** (1) Failure category `audit_chain_unavailable` is wrong — it's stale-data, not backend outage. (2) `void postAuditEnvelope(...).catch(() => {});` skips the durable enqueue used by every other failure path.
- **Fix:** Add `'stale_view'` to `FailureCategory` literal (TS + Python). Replace fire-and-forget pattern with same try/catch + `enqueue()` used by clipboard-block path.

### CRITICAL — Refinement (Agent 07)

#### C-REFINE-1 — Mask refine does NOT trigger FLR recompute — refined masks ship to PDF with stale FLR
- **Dimension:** D10 | **File:** `packages/ml-inference/src/api/review.py:330-386` (no FLR recompute); `:508-546` (separate endpoint never auto-called)
- **Evidence:** `mask_refine` writes new segmentation row but never updates `flr_calculation` or `analysis.flr_*`. The `/flr` endpoint exists but is never auto-called after `/mask-refine`.
- **Fix:** At end of `mask_refine`, fire a Celery task `recompute_flr(analysis_id)` (or call `flr_engine.compute()` inline if under 30s). Block report finalization on `analysis.last_segmentation_version` vs `flr_calculation.computed_against_version` drift check.

#### C-REFINE-2 — Two-person control (dual authorization) NOT enforced
- **Dimension:** D10/D2 | **File:** `packages/ml-inference/src/api/review.py:242-273` (acquire_seat); `:330-386` (mask_refine)
- **Evidence:** `SeatManager.acquire` accepts any `user_id` with the right permission. No check against original radiologist or eventual signer. CLAUDE.md "Compliance Discipline" mandates four-eyes.
- **Fix:** Add `radiologist_user_id` column to `analysis`. In `SeatManager.acquire`, reject with `DualAuthRequired` → 403 when `requested_user_id == analysis.radiologist_user_id` AND org policy `require_two_person_control=true`. Mirror in finalize handler.

#### C-REFINE-3 — Undo enqueues an INVERSE edit AND dequeues the original — double-flip risk
- **Dimension:** D1 | **File:** `packages/app/src/emr/contexts/RefinementUndoContext.tsx:118-137`
- **Evidence:** `offlineQueue.dequeue(last.id)` always succeeds even if no matching row (idb's `delete` returns void). Catch block is dead. Mashing Ctrl+Z creates N inverses on the server.
- **Fix:** Make `offlineQueue.dequeue` return boolean. Only enqueue inverse if dequeue returned false. Add client-side idempotency key (`undo_of: <original_edit_id>`) for server short-circuit. Disable undo button while `undo.isUndoing === true` AND in keyboard handler.

#### C-REFINE-4 — Empty undo handler in keyboard path bypasses `isUndoing` guard — double-undo races
- **Dimension:** D1 | **File:** `packages/app/src/emr/views/cases/RefinementView.tsx:287-291`
- **Fix:** Add `if (undo.isUndoing) return;` to the keyboard handler before line 289. Same guard for redo at line 295.

#### C-REFINE-5 — Cleanup-on-unmount runs even when seat acquisition failed
- **Dimension:** D1/D3 | **File:** `packages/app/src/emr/views/cases/RefinementView.tsx:167-179`
- **Fix:** Guard cleanup with `if (seat.hasSeat) seat.release()` (read `hasSeat` from a ref). Extend `ReviewSeatContext.release()` to no-op when `reviewIdRef.current === null` AND status not in `{held, degraded}`.

### CRITICAL — Audit & Compliance (Agent 08)

#### C-AUDIT-1 — Frontend audit service is never initialized — every imaging-PHI access emits zero events
- **Dimension:** D10 | **File:** `packages/app/src/emr/services/pacs/auditService.ts:43-50`
- **Evidence:** `grep -rn "initAuditService"` returns only the definition site. No bootstrap call. Every helper silently returns. Break-glass access granted with zero forensic record.
- **Fix:** Call `initAuditService(liverRaFhirClient)` at app startup. Once wired, even the stub will at least log every audit attempt.

#### C-AUDIT-2 — Direct `AuditChainWriter.write(...)` calls bypass PHI scrubbing — raw PHI in canonical_json
- **Dimension:** D10 | **Files:** `crypto_shred.py:118-150`; `erasure/orchestrator.py:230-267`; `tasks/{couinaud,vessels,recalibrate_temperature,push_to_pacs,finalize_report,daily_merkle_root}.py`
- **Fix:** Refactor all callers through `AuditEventEmitter.emit(...)` which forces PHI scrubbing. Interim: add runtime assertion in `AuditChainWriter.write()` requiring sentinel key inserted by `PHIScrubber.scrub_dict`.

#### C-AUDIT-3 — Erasure orchestrator silently swallows DELETE failures — partial-erasure reported as success
- **Dimension:** D10 | **File:** `packages/ml-inference/src/services/erasure/orchestrator.py:130-143`
- **Evidence:** `except Exception as exc: logger.warning("erasure DELETE FROM %s skipped (%s)", table, exc)`. Catches FK violations, permission errors, deadlocks; orchestrator emits `erasure_executed` AuditEvent claiming success.
- **Fix:** Tighten except to `(sqlalchemy.exc.NoSuchTableError, sqlalchemy.exc.ProgrammingError)` with specific "relation does not exist" check. Log at ERROR. Accumulate skipped-table list into `ErasureExecutionResult`. For any other exception, re-raise so caller's transaction rolls back.

#### C-AUDIT-4 — PHI in audit logs — `console.warn('AuditEvent write failed:', error)` exposes full body
- **Dimension:** D10 | **File:** `packages/app/src/emr/services/pacs/auditService.ts:289-292, 399-404, 542-547`
- **Fix:** Log only `error.message` and a stable correlation ID. Add Sentry `beforeSend` hook that strips any object containing `resourceType: "AuditEvent"`.

### CRITICAL — Design System (Agent 09)

#### C-DS-1 — Brand-token drift: half-finished warm-gray ramp swap violates T464 gate
- **Dimension:** D7 | **Files:** `packages/app/src/emr/styles/theme.css:54-57, 526, 1797, 986`; `constants/theme-colors.ts:42-178`; plus ~74 raw `#1a365d` / `#2b6cb0` / `#3182ce` occurrences
- **Evidence:** Top-level `--emr-primary` swapped to `var(--liverra-primary-700)`; `--emr-gradient-primary` STILL hardcodes `#1a365d, #2b6cb0, #3182ce`. Modal header bar (gradient) + modal icon (`--emr-primary` → warm-gray) → warm-gray icon on blue gradient. `brand-tokens.md` status is `pending`, T464 explicitly forbidden until approval.
- **Fix:** Pick path in one PR: (A) Revert — restore old blue hex values at theme.css:54-57 + theme-colors.ts:42-188. (B) Approve + complete — flip `brand-tokens.md status: approved`, rewrite ALL 74 hex references in theme.css to use `var(--liverra-primary-*)`. Path A is safer.

### CRITICAL — i18n

No CRITICALs from this area; see HIGHs.

### CRITICAL — Auth & Settings (Agent 11)

#### C-AUTH-1 — `python-jose` unmaintained — CVE-prone path used on every authenticated request
- **Dimension:** D2 | **File:** `packages/ml-inference/src/services/auth/jwks_validator.py:36-38`; `requirements.txt:59`
- **Fix:** Migrate to `PyJWT[crypto]>=2.10` (already installed). Replace `jose.jwt.get_unverified_header` → `jwt.get_unverified_header`, `jwk.construct(...)` → `jwt.algorithms.RSAAlgorithm.from_jwk(...)`. Drop `python-jose` from requirements.
- **Also flagged by:** dependencies (DEP2), security (C-6)

#### C-AUTH-2 — Auth middleware fails silently when permission_grant fetch fails — returns 401 but warning-only
- **Dimension:** D2/D4 | **File:** `packages/ml-inference/src/middleware/auth_middleware.py:199-217`
- **Fix:** On except, return `503 service-degraded` problem+json. Emit metric `auth.permission_load.failed.count` tagged `reason=<exc.__class__.__name__>`.

#### C-AUTH-3 — `AuditChainWriter.write_permission_check` is best-effort — silent swallow on every audit write failure
- **Dimension:** D2/D10 | **File:** `packages/ml-inference/src/middleware/require_permission.py:211-236`
- **Duplicate-of:** B-AUDIT-3

#### C-AUTH-4 — `mfa-reset-request` and `ruo-accept` use `credentials: 'include'` but no CSRF token
- **Dimension:** D2 | **File:** `packages/app/src/emr/views/settings/ProfileView.tsx:252-255, 280-283`
- **Fix:** Drop `credentials: 'include'`; rely on `Authorization: Bearer`. OR add CSRF double-submit cookie + SameSite=Strict.
- **Also flagged by:** security (C-5, broader: 21+ sites)

### CRITICAL — Schema (Agent 12)

#### C-SCHEMA-1 — `audit_event` and `audit_event_chain` have no FK to `tenant(id)` — orphan rows survive tenant erasure
- **Dimension:** D2/D10 | **File:** `packages/ml-inference/src/db/alembic/versions/20260419_0005_audit_chain.py:35-44, 56-69`
- **Fix:** Add `REFERENCES tenant(id) ON DELETE RESTRICT` to both. RESTRICT (not CASCADE) is correct.

#### C-SCHEMA-2 — `audit_event_chain.canonical_json` has no UNIQUE index — idempotency O(N) + JSON-substring false-match
- **Dimension:** D1/D6 | **File:** `packages/ml-inference/src/services/audit/clipboard_export_event.py:200-217`
- **Fix:** Add `client_action_id uuid` column on `audit_event_chain` + partial UNIQUE index on `(tenant_id, client_action_id)`. Populate via AuditChainWriter when event has `AUDIT_CLIENT_ACTION_ID` extension.

#### C-SCHEMA-3 — `audit_event_chain_default` partition absorbs all tenants — onboarding flow does not provision per-tenant partition
- **Dimension:** D10 | **File:** `packages/ml-inference/src/db/alembic/versions/20260419_0005_audit_chain.py:74-79`
- **Fix:** Either (a) add `provision_tenant_audit_partition(tenant_id)` to tenant-onboarding service; or (b) drop partitioning entirely and rely on PK index `(tenant_id, sequence_no)`.

### CRITICAL — Wave 2 Specialists / Sweeps

#### C-FHIR-1 — AuditEvent missing required `type` field in 14 emitters (R4 validators 422)
- **Dimension:** D5 | **File:** `packages/ml-inference/src/api/analysis.py:288, onboarding.py, export.py, ops.py, erasure.py, admin.py, push_to_pacs.py, vessels.py, couinaud.py, recalibrate_temperature.py, claim_registry.py, erasure/orchestrator.py`
- **Fix:** Add `type: {system: "http://terminology.hl7.org/CodeSystem/audit-event-type", code: "rest", display: "RESTful Operation"}` in shared helper.

#### C-FHIR-2 — AuditEvent missing required `source` field in same 14 emitters
- **Dimension:** D5 | **Files:** Same as above
- **Fix:** Standardize `source: {observer: {reference: "Device/liverra-ml-inference"}}` in helper.

#### C-FHIR-3 — `AuditEvent.category` is not in FHIR R4 (R5-only); used in 14 sites
- **Dimension:** D5 | **Files:** Same as above plus `services/audit/clipboard_export_event.py:117`, `services/compliance/claim_registry.py:187`
- **Fix:** Move into `AuditEvent.subtype[].code` with a bound LiverRa audit-subtype CodeSystem; OR `meta.tag`. Wave 1 ACR audit flagged for the readout-clipboard-export path — extend the fix across all 14.

#### C-FHIR-4 — Invalid extension URL scheme `liverra:` in 14 sites
- **Dimension:** D5 | **Files:** `tasks/recalibrate_temperature.py:306-311`; `tasks/push_to_pacs.py:199-201`; `api/{analysis,onboarding,ops,export,admin,erasure}.py`
- **Evidence:** `liverra:extra`, `liverra:ae_title`, `liverra:rbac.denied`, etc. FHIR R4 requires `Extension.url` to be a valid URI.
- **Fix:** Replace each with `http://liverra.ai/fhir/StructureDefinition/<name>`, register in `LIVERRA_EXTENSIONS`, publish StructureDefinitions.

#### C-SEC-1 — Hardcoded fallback JWT signing secret
- **Dimension:** D2 | **File:** `packages/ml-inference/src/api/auth.py:100-105`
- **Evidence:** `secret = os.environ.get("LIVERRA_JWT_SECRET", "dev-only-not-for-production-replace-with-32-byte-secret")`. Mitigated today (`AuthMiddleware` recognizes only RS256 Cognito tokens), but time-bomb if `_verify_jwt` is ever wired in.
- **Fix:** Require `LIVERRA_JWT_SECRET` at boot; raise if missing or <32 chars. Better: delete `auth.py /login` entirely until Cognito is wired.

#### C-SEC-2 — Hardcoded fallback demo password & admin allowlist
- **Dimension:** D2 | **File:** `packages/ml-inference/src/api/auth.py:82-97`
- **Evidence:** `LIVERRA_DEMO_USERS` defaults to `demo@liverra.local:admin,...`; `LIVERRA_DEMO_PASSWORD` defaults to `livercheck-demo`.
- **Fix:** Require both env vars at boot; or delete `auth.py`.

#### C-CATCH-1 — GDPR Art. 17 crypto-shred audit AuditEvent silently dropped
- **Dimension:** D4 | **File:** `packages/ml-inference/src/services/erasure/crypto_shred.py:145`
- **Fix:** Add dead-letter table `erasure_audit_dead_letter` swept by audit-retention-attestation job. Plus PagerDuty alarm on `erasure_audit_failed_total > 0`.

#### C-CATCH-2 — Crypto-shred KMS scheduling failure swallowed, hard-delete proceeds anyway
- **Dimension:** D4 | **File:** `packages/ml-inference/src/services/erasure/orchestrator.py:305`
- **Fix:** Decide: fail-closed (raise) OR fail-open with audit-event + counter. Recommend fail-closed for production.

#### C-CATCH-3 — SSE JSON.parse silent swallow on critical pipeline updates (`analysis-update`, `stage-complete`)
- **Dimension:** D4 | **File:** `packages/app/src/emr/contexts/AnalysisContext.tsx:192, 207`
- **Fix:** Add `console.warn` with event-type tag + `Sentry.captureException`. Surface a UI degraded banner.

#### C-CATCH-4 — `hydrateResults` fetch failure silently swallowed
- **Dimension:** D4 | **File:** `packages/app/src/emr/contexts/AnalysisContext.tsx:155`
- **Fix:** Surface error in `analysisState.error`; render `<EMRErrorCard />` in consumer.

#### C-UI-1 — `theme.css` has 74 raw old-brand-blue references (CRITICAL — confirms Wave 1)
- **Duplicate-of:** C-DS-1

#### C-UI-2 — EMRTable wrapper does not exist but CLAUDE.md mandates it
- **Dimension:** D9 docs vs reality
- **Fix:** Either (a) update CLAUDE.md to acknowledge "Table wrapper TBD; use raw Mantine Table for now"; or (b) build `EMRTable` mirroring EMRModal's wrapper.

#### C-HOOK-1 — `ReviewSeatContext.tsx:122` — unstable `client` reference causes heartbeat re-creation on every render
- **Dimension:** D6 | **File:** `packages/app/src/emr/contexts/ReviewSeatContext.tsx:122`
- **Fix:** Memoize `client` with `useMemo`; stabilize `acquire`/`release`/`heartbeat` callbacks.

#### C-TEST-1 — Catastrophic coverage gap (Duplicate of C-UT-6 through C-UT-13)
#### C-TEST-2 — `test_audit_retention_attestation.py` entire SC-010 audit-retention path is skipped (4/4 tests)
#### C-TEST-3 — `test_clipboard_export_tenant_violation.py` entire cross-tenant breach test disabled (5/5 skipped)
#### C-TEST-4 — `test_compliance_audit_window.py` Merkle audit-chain verifier untested (0/4 tests)
#### C-TEST-5 — `packages/ml-inference-gpu/tests/` directory does not exist

#### C-LOCK-1 — Sequence_no race (Duplicate of B-AUDIT-5 / B-SCHEMA-2)
#### C-LOCK-2 — `signRadiologyReport` finalize race on `DiagnosticReport.status='final'` (`packages/app/src/emr/services/pacs/radiologyReportService.ts:741`)
#### C-LOCK-3 — `LiverRaFhirClient.updateResource` / `deleteResource` — no `If-Match` parameter in API surface (`fhirClient.ts:80-94`)

---

## Findings — HIGHs grouped by area (compact format)

For HIGH severity, finding cards are condensed to: id | file:line | dimension | one-paragraph problem + fix. Full evidence is in the originating partial.

### HIGH — Wave 0 — Dependencies

- **H-DEP-1** | `packages/ml-inference/src/services/auth/jwks_validator.py:36` | D2 | python-jose unmaintained on auth-critical JWKS path; pulls `ecdsa==0.19.2` with unfixed CVE-2024-23342. Fix: migrate to PyJWT (already installed).
- **H-DEP-2** | `packages/app/package.json:14-17` | D2 | Cornerstone3D 4.21.7 transitive js-yaml prototype pollution. Fix: bump to `^4.22.6`.
- **H-DEP-3** | `packages/ml-inference-gpu/requirements.txt:21` | D10 | TotalSegmentator CC-BY-NC-SA-4.0 weights not enforced by code. Fix: add `LIVERRA_LICENSE_TIER` env-var enforcement.

### HIGH — Wave 0 — Unit Tests

- **H-UT-1** | `acrPlainTextRenderer.parity.spec.ts` + `test_acr_plaintext_renderer.py` | D10 | ACR plaintext renderer drift; cross-channel parity broken across 5 fixtures. Fix: re-render fixtures + converge.
- **H-UT-2** | `acrPlainTextRenderer.spec.ts:72` | D10 | Canonical section ordering regressed; PDF order will not satisfy ACR templates. Fix: restore canonical ordering constant.
- **H-UT-3** | `acrClipboardService.indexeddb-queue.spec.ts:165` | D1 | Idempotency-key dedupe broken; double-enqueue on same click.
- **H-UT-4** | `acrClipboardService.retry-drain.spec.ts:173` | D4 | Retry-drain does not honor terminal 401; permanent retry loops on revoked credentials.
- **H-UT-5** | `test_admin_cecho.py:27` | D9 | Wrong import path (`packages.ml_inference...` vs `src...`); test silently uncollected; admin C-ECHO has zero coverage.
- **H-UT-6** | `test_dicom_artifacts_golden.py` | D5 | SEG fields drift from contract; SR leading text not trilingual.
- **H-UT-7** | `test_seg_sr_roundtrip.py` | D5 | Same as above for SEG/SR builders.
- **H-UT-8** | `test_erasure_404_disclosure.py` | D10 | Post-erasure search returns 403 instead of 404 (resource-existence disclosure).
- **H-UT-9** | `test_ops_no_phi.py` | D10 | Ops queue does not fail-closed when PHI slips in.

### HIGH — PACS

- **H-PACS-1** | `PacsStudyViewerView.tsx:156`, `cornerstoneInit.ts:293` | D6 | Cornerstone3D singleton destroyed on unmount of ANY PACS viewer; multi-tab/comparison view scenarios break. Fix: refcount the rendering engine.
- **H-PACS-2** | `imagingStudyService.ts:304-568` | D3/D10 | 569-line stub; 23 functions stubbed (log + return null/empty). Consumed by ReadingWorklist, UnmatchedStudiesQueue, etc. UIs render "always empty". Fix: wire to Python orchestrator; gate UI on `isWired()` until ready.
- **H-PACS-3** | `PacsStudyViewerView.tsx:423` | D10 | `ViewportOverlay` shows raw `PatientName` from DICOM JSON; combined with B-PACS-1 this shows pre-anonymized name in screen-cap and screen-share. Fix: render initials-only by default; explicit "Reveal" button emits AuditEvent.
- **H-PACS-4** | `anon-sidecar/main.py:534` | D4/D10 | `pixel_scan_error` silently swallowed; no Sentry, no Prometheus. Three nights of crashed scanners go unnoticed. Fix: `sentry_sdk.capture_exception(exc)` + per-gate histogram.
- **H-PACS-5** | `presidio_recognizers.py:43,113` | D10/D3 | Per-image Presidio recognizers use `score=0.85` paired with default `score_threshold=0.5`; the docstring says 0.6 is the intended threshold. OCR-noised pixel labels like "MUI LER" (instead of "MÜLLER") pass as non-PHI. Fix: lower to 0.6; add fuzzy matching.
- **H-PACS-6** | `StudyImporter.tsx:127-145` | D10 | Frontend runs ZERO de-id checks before STOW-RS upload. If sidecar env unset, every uploaded DICOM is accepted RAW into Orthanc. Fix: REJECT all instances when `LIVERRA_ANON_SIDECAR_URL` is unset (currently fail-open in dev); Sentry-level warning on activation.
- **H-PACS-7** | `dicomwebClient.ts:350-374` | D6/D11 | Sequential STOW-RS upload — 500 files × 1 RTT each. Fix: bounded concurrency pool (4-8 in-flight) OR single multipart/related POST per study.

### HIGH — Cases

- **H-CASE-1** | `AnalysisDetailView.tsx:247-282` | D6 | `useAnalysisResults` re-parses lesion JSON inside `lesions.map(...)` on every render; no virtualization. 200+ lesions drop frames. Fix: memoize parsed classifications outside the map; wrap list in `<EMRVirtualTable>` when count > 50.
- **H-CASE-2** | `AnalysisDetailView.tsx:174-225` + `CascadeStageTimeline.tsx:182` + `SegmentsList.tsx:114` | D6 | Four consumers query same key `['analysis', id, 'results']` with different `refetchInterval`/`enabled` — observer-mount-order dependent polling. Fix: extract single `useAnalysisResultsQuery(analysisId, status)` hook.
- **H-CASE-3** | `CasesListView.tsx:47-60` + `analysis.py:165-166` + `analysis_stream.py:62` | D3 | Status enum drift: backend emits `'completed'`; frontend accepts both `'done'` and `'completed'`; statuses `'uploading'`/`'anonymizing'` exist in frontend but no backend path produces them. Fix: define `ANALYSIS_STATUS = Literal[...]` once in shared schema.
- **H-CASE-4** | `analysis.py:813-860` | D1 | `cancel_analysis` read-then-write race; UPDATE has no `WHERE status IN ('queued','running')` predicate. Two simultaneous cancels both emit `analysis_cancel` AuditEvent. Fix: `WHERE id=:id AND tenant_id=:tid AND status IN ('queued','running') RETURNING id`.
- **H-CASE-5** | `LesionsPanelView.tsx:250-268` + `review.py:448-510` | D2 | Lesion-override path: same user is both AI's "trusted reviewer" AND override-recording actor; no `priorClass !== newClass` check; comment claims step-up MFA but submit path does not call it. Fix: verify step-up actually invoked + add `args.newClass !== priorClass` check.
- **H-CASE-6** | `LesionsPanelView.tsx:270-290` | D4 | "Add Lesion" hardcodes `segment: 'V'` (frontend bug — see B-REFINE-3) + silent catch with generic error toast. Fix: surface error catalog slug via `t(\`errors:lesionPrompt.\${slug}\`)`.
- **H-CASE-7** | `analysis.py:261-300` | D10 | `_emit_analysis_audit` returns `None` when AuditChainWriter import fails — bootstrap path. Cancel/retry succeeds with no audit row. Fix: convert `except ImportError` to ERROR log + `raise ProblemDetailException(SERVER_ERROR, 503, "audit subsystem unavailable")`.

### HIGH — Cascade

- **H-CASCADE-1** | `scripts/real_cascade.py:864-933` | D4 | Phase 1 findings outer `except Exception` prints "non-fatal" and continues; no logger.exception, no audit, no impact on cascade status. Surgeon sees healthy "completed" with 0 findings persisted. Fix: `except Exception: logger.exception(...); raise`.
- **H-CASCADE-2** | `scripts/real_cascade.py:267` | D3 | Combined GPU endpoint left in production despite proven 2-min regression. Duplicate of C-INFER-1.
- **H-CASCADE-3** | `scripts/real_cascade.py:160-168` + `tasks/cascade.py:86-101` | D1 | `pipeline_checkpoint` `ON CONFLICT DO NOTHING` silently drops retried stage outputs; model_version bump after retry never persists. Fix: `ON CONFLICT DO UPDATE SET output_uri=EXCLUDED..., model_version=EXCLUDED...`.
- **H-CASCADE-4** | `tasks/cascade.py:120-141` | D3 | `mark_cascade_complete` Triton-cascade flip to `completed` doesn't verify all stages or `implausible_output_reason IS NULL`. Combined with C-CASCADE-1, sanity failures land as `completed` with bad data. Fix: verify expected stages exist + `implausible_output_reason IS NULL` before flipping.
- **H-CASCADE-5** | `orchestrator/cascade.py:260-271` | D4 | `run_stage` swallows result['sanity'] check for stages with no sanity block (vessels, couinaud, lesion_detection deliberately omit). Fix: `LIVERRA_REQUIRE_SANITY=true` opt-in for production; raise `SanityFailure("missing_sanity_block")` if missing.
- **H-CASCADE-6** | `tasks/daily_merkle_root.py:57-74, 107` | D6 | `compute_daily_merkle_root` async but not registered with Celery app; the task is on a separate `build_celery_app` that's never called. Daily Merkle-root S3 anchor never runs — CE-MDR audit-trail integrity claim unsupported. Fix: register in main `workers/app.py` + wrap async body via `asyncio.run()`; add beat schedule.

### HIGH — Inference

- **H-INFER-1** | `.env.example:102`, `docker-compose.yml:203`, `inference_client.py:34-36`, `main.py:16` | D4/D9 | `.env.example` + `docker-compose.yml` default to port 9100; in-code default is 9101 — Tailscale ACL drops 9100 silently (`502 Bad Gateway`). Fix: change 9100→9101 in three files.
- **H-INFER-2** | `inference_client.py:58-66` | D4/D6 | No retry/backoff — single transient Tailscale blip aborts 12-min cascade. Fix: wrap with `tenacity.retry(retry_if_exception_type((ConnectError, ReadTimeout, RemoteProtocolError)), stop=stop_after_attempt(3), wait=wait_exponential(min=2,max=30))`.
- **H-INFER-3** | `ml-inference-gpu/main.py:52-58, 113-117` | D2/D6 | GPU service trusts client `Content-Length`; reads entire upload to RAM before size check. 2-GB chunked upload OOM-thrashes the GPU container. Fix: stream `ct_nifti.file` to temp path with running byte counter; reject mid-stream at MAX_UPLOAD_BYTES.
- **H-INFER-4** | `tasks/{couinaud,vessels}.py` | D9/D10 | Triton stub client NOT dormant — `tasks/couinaud.py` and `tasks/vessels.py` actively import + use `TritonClient` despite CLAUDE.md saying the Triton path is fully dormant. Fix: gate Celery registration with `if os.environ.get("LIVERRA_TRITON_ENABLED") == "true"`; or delete entirely.
- **H-INFER-5** | `ml-inference-gpu/main.py:185-198` | D1/D4 | `/health` endpoint catches every exception, marks `cuda_available=False`, returns 200. K8s liveness sees "healthy" on CPU-only container. Fix: `info["ok"] = bool(info.get("cuda_available"))`; return 503 when False.

### HIGH — Clinical Algorithms

- **H-CLIN-1** | `FLRPanel.tsx:66-70` | D10 | FLR adequacy threshold hardcoded `<30 / 30-40 / ≥40` regardless of liver health context. ESSO/ALPPS literature: ≥25% normal, ≥30% post-chemo, ≥40% cirrhotic. Fix: accept `liverHealthContext` prop; map to {30,25}/{35,30}/{40,35}; display active threshold in panel header.
- **H-CLIN-2** | `FLRPanel.tsx:104` | D6 | `const claim = ruoClaim ?? useRUOClaimStub()` — Rules-of-Hooks violation. Fix: `const fallbackClaim = useRUOClaimStub(); const claim = ruoClaim ?? fallbackClaim;`.
- **H-CLIN-3** | `lesion_enhancement_features.py:127-137` | D1/D4 | `extract_lesion_features` silently returns `relative_enhancement=lesion_mean` when liver_mask is empty (bg_mean=0). Classifier confidently labels APHE-positive HCC against air. Fix: detect empty background; emit `missing: True, reason: "empty_background"`.
- **H-CLIN-4** | `packages/ml-inference/tests/` | D10 | Zero unit tests for `lirads_classifier`, `flr_segment_aware`, `lesion_enhancement_features`, `compute_couinaud`. Fix: add `tests/unit/test_*.py` per Wave 0 listing.
- **H-CLIN-5** | `orchestrator/lirads_classifier.py:1-10, 36-38` | D3/D10 | "LI-RADS classifier" does not implement LI-RADS v2018 — emits tumor types, no size cutoffs, no growth, no capsule. CE-MDR labeling risk. Fix: either (a) implement v2018 actual rules; or (b) rename module to `tumor_type_classifier.py`.
- **H-CLIN-6** | `orchestrator/couinaud_heuristic.py:274-306` | D3 | Voxels with `cantlie == 0` (line passing exactly through voxel center) stay unlabeled — 0.1-0.5% sliver labeled "non-liver." Fix: post-pass assigns `liver > 0 AND out == 0` voxels to nearest neighbor.
- **H-CLIN-7** | `orchestrator/flr_segment_aware.py:49-114` | D3/D10 | ESSO/ALPPS FLR does NOT subtract vascular tree volume — overestimates remnant by 5-10%. Pushes borderline patients from yellow into green. Fix: accept optional `vessels_mask`; subtract from each segment's voxel count.

### HIGH — ACR Readout

- **H-ACR-1** | `acrAnatomicalMapping.ts:172` + `acr_section_builder.py:143-145` | D10/D1 | TS `Number.toFixed(0)` (half-away-from-zero) vs Python `int(round(...))` (banker's). HU=40.5 renders "41" on screen, "40" in PDF. Fix: standardize on one decimal place via `.toFixed(1)` everywhere.
- **H-ACR-2** | `acrAnatomicalMapping.ts:289-292` vs `acr_section_builder.py:245-253` | D10 | Gallbladder `wall_thickened` warning set in TS, never set in Python — PDF lacks the warning the screen panel shows. Fix: add `"warning": (..._get(bundle, "warnings.degraded", "Wall thickened") if gb.get("wall_thickened") else None)` to Python `_build_gallbladder_rows`.
- **H-ACR-3** | `ReportInlineView.tsx:194-202` | D7 | Hardcoded forbidden hex `#3b82f6` + `#1e40af` (CLAUDE.md FORBIDDEN list) + `#f59e0b`/`#fef3c7`/`#dbeafe`/`#b45309` on clinical QC-flag banner. Fix: replace with `var(--emr-info)`, `var(--emr-info-bg)`, `var(--emr-warning)`, etc.
- **H-ACR-4** | `ACRSection{Liver,Gallbladder,Spleen,Lesions,FLR}.tsx` | D9 | Five 95% copy-paste components; any single behavior change requires 5 edits that drift. Fix: extract `<ACRGenericSection section={...} renderRow={...} />`; sections become ~15 lines each.
- **H-ACR-5** | `useAcrCopyAction.ts:62, 145` vs `ACRStructuredReadout.tsx:100-223` | D9 | `useAcrCopyAction` was extracted to dedupe Copy logic, but main panel never adopted it — duplicate implementation that will drift. Fix: replace inline `makeTFn` / `SUPPORTED_LOCALES` / `openEtagRef` / `handleCopy` with single call to `useAcrCopyAction(analysisId)`.
- **H-ACR-6** | `clipboard_export_event.py:117` | D5 | AuditEvent emitted with non-standard `category` field; FHIR R4 has no such element. Fix: remove `"category": "readout_clipboard_export"`; rely on `subtype` (already present).
- **H-ACR-7** | `ACRSectionVessels.tsx:54-61` | D4 | Stage image rendered with no error fallback; 404 produces broken-image icon with no alt. Fix: use Mantine `Image` with `fallbackSrc` SVG pattern from `ReportInlineView.StageImage`.

### HIGH — Refinement (rolled into CRITICAL section above; H-REFINE-1 through H-REFINE-5 are present there)

- **H-REFINE-1** | `review.py:508-546` | D1 | Read-modify-write on `analysis.flr_plane_json` has no optimistic locking. Fix: `WHERE id=:aid AND flr_version=:client_version RETURNING flr_version`.
- **H-REFINE-2** | `useReviewSeat.ts:55-97` | D4/D6 | SSE connection no exponential backoff, no heartbeat-loss detection. Suspending laptop hammers reconnect. Fix: `onerror` handler with exponential backoff (1/2/4/8s, cap 60s); heartbeat last-event timestamp; "disconnected" toast after 3 min.
- **H-REFINE-3** | `RefinementView.tsx:201-217` | D3 | `runMaskDispatch` does not pass `inverse` from viewer click — undo stack stays empty for most common edit path. Fix: compute inverse before dispatch.
- **H-REFINE-4** | `LesionsPanelView.tsx:146-176` | D3 | `reviewerOverrideClass` reads from `cls.reviewer_override_class` (no backend writer) + hardcodes `reviewerUserId: 'unknown'` + `at: new Date().toISOString()` (always "now"). Fix: add `GET /api/v1/analyses/{id}/overrides` endpoint; merge real `reviewer_user_id`/`at`.
- **H-REFINE-5** | `LesionsPanelView.tsx:381` | D1/D4 | "Retry" button calls `window.location.reload()` — discards in-memory state, open modal contents, queue worker handle. Fix: replace with `queryClient.invalidateQueries({ queryKey: lesionsQueryKey(analysisId) })`.

### HIGH — Audit & Compliance

- **H-AUDIT-1** | `auditService.ts:142` + `fhir_extensions.py:39` + `audit_event_emitter.py:199-200` | D5 | Three different CodeSystem URLs across stack for "same" AuditEvent.subtype concept (`audit-subtype` singular, `audit-subtypes` plural, `audit-action`). Fix: declare `${FHIR_BASE_URL}/CodeSystem/audit-subtypes` once in `fhir-systems.ts`; update all 3.
- **H-AUDIT-2** | `packages/fhirtypes/src/liverra/extensions/` | D5 | 4 audit extensions emitted but unpublished. Duplicate of B-ACR-2.
- **H-AUDIT-3** | `clipboard_export_event.py:91-176` vs `audit_event_emitter.py:147-158` | D5/D1 | Two emitters set `event["id"]` at different points (before vs after Medplum POST). Chain leaf hash mixes pre-/post-Medplum payloads inconsistently. Fix: pick one pattern (Medplum POST first, get server-issued ID, then write chain).
- **H-AUDIT-4** | `jobs/audit_retention_attestation.py:75-219` | D10 | Retention attestation only counts rows — doesn't verify chain integrity, doesn't walk leaf_hash chain, doesn't detect gaps, doesn't compare year-end leaf_hash to daily Merkle root. Same source data twice = single witness. Fix: walk chain ORDER BY sequence_no, recompute each leaf_hash, assert no gaps + match against daily Merkle anchor.
- **H-AUDIT-5** | `services/erasure/orchestrator.py:275-401` | D1 | Six-step pipeline (KMS → DELETE → tombstone → audit rewrite → PDF → terminal audit → status UPDATE) shares one session with no explicit commit. Audit-write failure rolls back the DELETEs but caller may already have committed. Fix: split into Stage A (mark started) + Stage B (DELETE + tombstone + audit) + Stage C (PDF, fire-and-forget).

### HIGH — Design System

- **H-DS-1** | `EMRIconButton.module.css:8-9, 40-43` + `EMRTabs.module.css:38` + `EMRButton.tsx:60-65` + `EMRFAB.tsx:79-80` | D7 | Sub-44px tap targets fail WCAG 2.5.5. Fix: bump default `md` to 44×44; document `sm`/`xs` as desktop-only or add `::before` pseudo-element with 44px hit zone.
- **H-DS-2** | `SessionTimeoutModal.tsx:19, 150` | D7 | HIPAA session-timeout modal bypasses EMRModal wrapper. Fix: rebuild on `<EMRModal>` with `closeOnClickOutside={false}`, `closeOnEscape={false}`, custom footer.
- **H-DS-3** | `EMRErrorBoundary.tsx:212-285` | D7/D8 | Catch-all error UI uses raw Mantine `<Alert color="red">` + `<Button color="blue">` + 6 hardcoded English strings. Fix: mirror `TranslatedFormErrorBoundary` pattern; use `<EMRAlert variant="error">` + `<EMRButton variant="primary">`; add 8 i18n keys.
- **H-DS-4** | `EMRAlert.css:91-109` + `emr-fields.css:394-1079` | D7 | Module-level dark-mode overrides directly violate Dark Mode Rule #5. Fix: delete EMRAlert.css dark block (vars auto-switch); migrate emr-fields.css stanza into theme.css OR Mantine theme provider.
- **H-DS-5** | `UserMenuButton.tsx:104, 129` | D7 | Hardcoded blue gradient fallback in `var()` defeats brand swap. Fix: drop fallback.

### HIGH — i18n

- **H-I18N-1** | `packages/app/src/emr/translations/ru/` | D8 | 23/30 namespaces missing entirely; the other 6 are 100% TODO. Real ru coverage = 0.2% of EN keys. Fix: create 23 missing files with `__TODO_TRANSLATE__:` placeholders; prioritize `failClosed`, `ruo`, `errors` for CODEOWNERS review.
- **H-I18N-2** | `TranslationContext.tsx:45-47` + `localeService.ts:19-22` | D8 | Locale type + SUPPORTED_LOCALES array declared in two files (drift risk). Fix: `export type { Locale } from '../services/localeService'; export { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../services/localeService';`.

### HIGH — Auth & Settings

- **H-AUTH-1** | matrix.yaml + decorators | D2 | 7 permissions defined in matrix but enforced by ZERO `@require_permission` decorator (`study.delete`, `audit.view`, `audit.export`, `audit.verify_chain`, `report.download`, `review.flr_adjust`, `review.seat_takeover`). Fix: audit each endpoint; add missing decorators OR remove from matrix.
- **H-AUTH-2** | `ProtectedRoute.tsx:50-52` | D2/D7 | Returns `null` during hydration; flash of blank page; race with `Navigate` if `permsLoading` flips fast. Fix: return `<EMRSkeleton>` instead of null.
- **H-AUTH-3** | `ProfileView.tsx:599` | D2 | `mfaState.adminContact` rendered verbatim from API; if tenant-admin can set arbitrary string, phishing vector. Fix: validate server-side against verified-contact list OR render with `"your tenant administrator"` fixed prefix.
- **H-AUTH-4** | `jwks_validator.py:117-123` | D2 | Kid-miss force-refresh rate limit only fires when `keys_by_kid` is non-empty; cold-start floods cause N upstream JWKS fetches. Fix: pre-warm JWKS cache on startup via `asyncio.create_task(validator._refresh_jwks())` from lifespan.
- **H-AUTH-5** | `ProfileView.tsx:260-265, 297-302` | D4 | mfa-reset / ruo-accept catches swallow errors with no telemetry, no Sentry, no event-bus dispatch. Fix: `console.error` + `Sentry.captureException` + `window.dispatchEvent(new CustomEvent(LIVERRA_ERROR_EVENTS.OperationFailed, ...))`.
- **H-AUTH-6** | `invite_service.py:194-210` | D9 | `verify_token` defined but never called (dead safety function on security-critical path). Fix: find or create `POST /api/v1/onboarding/accept` handler; wire through `InviteService.verify_token(token)` + JTI consumption.

### HIGH — Schema

- **H-SCHEMA-1** | `audit.ts:12-18, 15-46` | D5/D9 | `AuditCategory` docstring says "24-member" then "Exactly 25 members" in same file. New `ReadoutClipboardExport` not added to Medplum CodeSystem. Fix: update doc to 25-member; add CodeSystem provisioning step to bootstrap script.
- **H-SCHEMA-2** | `fhirtypes/extensions/` | D5 | 6 FHIR extensions referenced in code but no `StructureDefinition` JSON. Duplicate of B-ACR-2 (4 are audit-*; 2 are RUO; plus 4 imaging-study extensions).
- **H-SCHEMA-3** | `0005_audit_chain.py:35-44` + `audit.ts` | D1/D5 | `audit_event.category` has no CHECK constraint AND no FK to a CodeSystem. TS treats as closed enum; DB treats as open text. Typo'd category silently writes. Fix: add CHECK listing 25 known values.
- **H-SCHEMA-4** | `0002_study_series_analysis.py:34` | D10 | `study.patient_ref` plain text with no encryption-at-rest column metadata, no format constraint, no documentation that it's PHI. Fix: `COMMENT ON COLUMN study.patient_ref IS 'PHI: pseudonymized FHIR Patient/<uuid>'`; add `CHECK (patient_ref ~ '^Patient/[a-zA-Z0-9_-]+$')`.
- **H-SCHEMA-5** | `0013_analysis_finding.py:40-55` | D2/D10 | `analysis_finding` has no `tenant_id` column AND no RLS. Cross-tenant leak possible if API forgets to JOIN through `analysis`. Fix: add denormalized `tenant_id uuid NOT NULL`; enable RLS with tenant_isolation policy.
- **H-SCHEMA-6** | `0005_audit_chain.py:47-52` | D6 | No index on `(category, written_at)`; forensic queries seq-scan per tenant. Fix: `CREATE INDEX audit_event_tenant_category_time_idx ON audit_event (tenant_id, category, written_at DESC)`.

### HIGH — Wave 2 — FHIR Validator (28 findings; representative high-impact list)

- **H-FHIR-1 through H-FHIR-4** | Missing StructureDefinitions for `audit-locale`, `audit-tenant`, `audit-client-action-id`, `audit-failure-category`. Duplicate-of B-ACR-2.
- **H-FHIR-5** | `imagingStudyService.ts:130` + `markAsReadService.ts:79` + `readingWorklistService.ts:156` | D5 | Inline-hardcoded URL `imaging-study-status` not in registry, no SD. Same pattern for `imaging-study-timeline`, `imaging-priority`, `orthanc-study-id`. Fix: add to `LIVERRA_EXTENSIONS`; publish SD; replace inline strings.
- **H-FHIR-6 through H-FHIR-15** | AuditEvent.category in 10 sites (api/{analysis,onboarding,export,ops,erasure,admin}.py; tasks/{recalibrate_temperature,vessels,push_to_pacs}.py; services/{audit/clipboard_export_event,erasure/orchestrator,compliance/claim_registry}.py). Duplicate-of C-FHIR-3.
- **H-FHIR-16 through H-FHIR-22** | Invalid extension URL scheme `liverra:*` in 7 site clusters. Duplicate-of C-FHIR-4.
- **H-FHIR-23 through H-FHIR-27** | Non-FHIR resource types `Analysis/`, `Report/`, `ReportDelivery/`. Fix: use `Basic/<analysis_id>` or `ImagingStudy/<study_id>`; `DiagnosticReport/<report_id>`.
- **H-FHIR-28** | `vessels.py:290-313` | D5 | `type.code` without `system` (invalid Coding); `detail` as top-level field (not allowed); `agent[0].who` only has `display`, no `reference`. Fix: route via `AuditEventEmitter`; stage metadata into `entity[].detail[]` typed.
- **H-FHIR-29** | `fhir/constants.py:24` vs `audit/fhir_extensions.py` | D5 | Two Python files claim to be the mirror; disagree on 4 audit-* additions. Fix: delete one; route all Python consumers through the survivor; CI check that diffs against TS.
- **H-FHIR-30** | `agent.who` may be null in `analysis.py:293` | D5 | `"who": {"reference": user_id} if user_id else None` → `who: None` is invalid. Fix: guarantee `user_id` upstream OR set `agent[0].requestor = True` and omit `who`.
- **H-FHIR-31** | `findings.py:28` | D5 | `AnalysisFinding` has no FHIR projection (no Observation/DetectedIssue). FHIR-first posture breached for most clinically meaningful payload. Fix: add `findings_to_fhir(finding_row) -> Observation | DetectedIssue`.

### HIGH — Wave 2 — Security

- **H-SEC-1** | `requirements.txt:59` | D2 | python-jose. Duplicate-of C-AUTH-1.
- **H-SEC-2** | `ml-inference-gpu/main.py:77` | D11 | Error detail leak on GPU 500 responses (raw exception text exposed including paths). Fix: generic message in HTTPException; keep details in `logger.exception` only.
- **H-SEC-3** | `jwks_validator.py:155-251` | D2 | No `jti` (token replay) check. Fix: Redis-backed JTI replay cache with TTL = exp - now.
- **H-SEC-4** | `auth_middleware.py:203-208` | D2 | Permission load fails open on DB error (empty list); fail-CLOSED for `@require_permission` routes but fail-OPEN for any future route that authorizes on `request.state.user` existence. Fix: return 503 problem+json.
- **H-SEC-5** | `CasesListView.tsx:212` | D2 | Production view hardcodes `Bearer dev-access-token`. Forces operators to keep `LIVERRA_AUTH_BYPASS=true` on backend (enables B-AUTH-3 / B-1). Fix: `Bearer ${useAuth().accessToken}`.
- **H-SEC-6** | `auth_middleware.py:176-182` | D2 | Tenant ID lifted from JWT `custom:tenant_id` with no DB consistency check. If Cognito `WriteAttributes` permits, user can self-modify and access cross-tenant data. Fix: ensure Cognito app-client `WriteAttributes` excludes `custom:tenant_id`; runtime check joining `cognito_sub → app_user.tenant_id`.

### HIGH — Wave 2 — i18n Quality

- **H-I18NQ-1** | `translations/ru/` | D8 | RU 0.2% coverage. Duplicate-of H-I18N-1.
- **H-I18NQ-2** | `translations/ka/` | D8 | KA missing 342 keys across 11 namespaces. Fix: stub with `__TODO_TRANSLATE__:` placeholders.
- **H-I18NQ-3** | `translations/{de,ka,ru}/pacs.json` | D8 | `pacs` namespace effectively untranslated in all non-en locales (220+ markers each). Fix: CODEOWNERS medical-terminology review priority.
- **H-I18NQ-4** | `translations/{de,ka,ru}/reportAcr.json` | D8 | 100% untranslated. Duplicate-of C-ACR-1.
- **H-I18NQ-5** | `translations/ru/failClosed.json` | D8 | Missing entirely; regulatory kill-switch UI falls back to English for ru users. Fix: copy + CODEOWNERS review.
- **H-I18NQ-6** | `CascadeStageTimeline.tsx:206-281` | D8 | Plural keys use `_one`/`_other` only with `count===1 ? _one : _other` selection — wrong for Russian (4 forms required). Fix: introduce `Intl.PluralRules` lookup in `t()` OR document English-only limitation.

### HIGH — Wave 2 — UI/UX

- **H-UI-1** | `ReportInlineView.tsx:194-202` | D7 | Forbidden hex on clinical QC banner. Duplicate-of H-ACR-3.
- **H-UI-2** | `SegmentationPanel.tsx:446` | D7 | Inline gradient hardcoded with old-brand blues. Fix: `var(--emr-gradient-primary)`.
- **H-UI-3** | `MeasurementPanel.tsx:583, 752, 769, 792` | D7 | 4× `<ActionIcon size="xs">` (24×24) on clinical viewer. Fix: replace with `EMRIconButton` `clinicalControl` variant (44×44).
- **H-UI-4** | `EMREmptyState.tsx:4` + `EMRErrorCard.tsx:6` + `EMRErrorBoundary.tsx:6` | D7 | Design-system wrappers import raw Mantine Button — self-inconsistency. Fix: use EMRButton inside the wrappers.
- **H-UI-5** | `cases/{CaseShell,ReportView,AnalysisLockBannerSlot,AnalysisDetailProviders}.tsx` | D4 | Cascade-result rendering surfaces with no error state. Fix: wrap each in `EMRErrorBoundary`; add `<EMRErrorCard>` fallback for missing data slices.

### HIGH — Sweeps

- **H-CATCH-1 through H-CATCH-11** | Various | D4 | Silent JSON.parse / fetch / SSE / localStorage catches on critical paths (cascade dispatch, lesion classification render, lesion panel, FHIR audit, key image, refinement, seat acquire/release). Representative: `AnalysisContext.tsx:155,192,207` (SSE + hydrate), `LesionOverlay.tsx:116`, `AnalysisDetailView.tsx:259`, `analysis.py:386` (cascade dispatch failure → 202 Accepted but cascade never runs), `analysis.py:1330` (report summary drops findings on DB error).
- **H-LOCK-1 through H-LOCK-6** | Various | D1 | Optimistic-locking gaps on `flr_update`, `mask_refine`, `classification_override`, `lesion_prompt`, `claim_registry.update`, `override_coverage`. All declare `client_version` in schema, ignored in handler.
- **H-TEST-1 through H-TEST-8** | Various | Various | Test suites disabled: `test_clipboard_export_chain_continuity.py` + idempotency + revoked_mid_session + view_only_role_captured + pdf_failure_audit_row + pdf_timeout_audit + test_ingest_flow.py (all skipped); `test_compliance_audit_window.py` (untested); `test_access_policy_matrix.py` (6/8 skipped); `test_audit_chain_fhir_roundtrip.py` (6/7 skipped); `test_phi_scrubber_fail_closed.py` (6/9 skipped); `test_role_crossing.py` (4/6 skipped); EMR component tests (6 files, 30 `it.todo` placeholders).
- **H-TYPE-1** | `AnalysisDetailView.tsx:341` | D9/D4 | Double `as unknown as BackendAnalysis` on remote-API payload with no runtime validation. Fix: validate via zod schema parse before assignment.
- **H-HOOK-1 through H-HOOK-4** | Various | D6 | Stale-closure / missing-dep / unjustified suppression: `RefinementView.tsx:147` (seat refs), `ViewerStateContext.tsx:202` (unmount persistence), `AnalysisDetailView.tsx:478` (handleFinalize thrash), `AnalysisDetailView.tsx:401` (keyboard handler rebuilds).
- **H-I18NLIT-1 through H-I18NLIT-4** | Various | D8 | Russian PDF template is 100% English; Russian email template directory does not exist; 32 files carry hardcoded English strings; `EMRErrorBoundary.tsx` 5 hardcoded English fallbacks.

---

## Cross-Cutting Issues

Findings whose `file:line` resides outside the agent's assigned area or whose root cause spans 3+ areas. These appear regardless of severity and are NOT counted in the per-area totals (rolled up here).

### CC-1 — Audit-chain emission gap is end-to-end
Cited by 6 agents. The systemic fix is one PR that:
1. Wires `set_audit_hooks()` in `main.py` and `workers/app.py`.
2. Instantiates `AuditEventEmitter` and registers on `app.state`.
3. Refactors every direct `AuditChainWriter.write()` caller through the emitter.
4. Implements `AuditChainWriter.from_request` and `.write_permission_check` so the middleware works.
5. Adds `verify_chain` to `chain_of_hashes.py` and wires it into `/compliance/audit-summary`.
6. Initializes `initAuditService()` in the frontend at app startup.
7. Fixes the canonical-JSON LIKE pattern in idempotency + attestation queries.
After this single PR, the cascade emits audit events, the chain is verifiable, idempotency works, and the retention attestation actually counts something.

### CC-2 — `LIVERRA_AUTH_BYPASS` + `ANON_SIDECAR_BYPASS` + dev-fallback secrets need production env-var guard
4-line fix per call-site:
```python
env = os.environ.get("LIVERRA_ENV", "development").lower()
if bypass_active and env in {"staging", "production"}:
    raise RuntimeError(f"PRODUCTION SAFETY: <FLAG> forbidden when LIVERRA_ENV={env}.")
```
Apply identically in `auth_middleware.py`, `anonymization.py`, `auth.py` (_jwt_secret), `auth.py` (_load_allowlist), `invite_service.py` (secret).

### CC-3 — Optimistic-locking is illusory across the entire FHIR client + 4 refinement endpoints
One coordinated PR:
1. Extend `LiverRaFhirClient.updateResource(resource, options?: { ifMatch?: string })` and `deleteResource(type, id, options?: { ifMatch?: string })`.
2. Replace all 9 frontend call sites that pass `meta.versionId` with `ifMatch: existing.meta?.versionId`.
3. Read `client_version` in Python `mask_refine`, `lesion_prompt`, `classification_override`, `flr_update`; raise 409 with current server version on mismatch.
4. Add `pg_advisory_xact_lock(hashtext(tenant_id))` in `AuditChainWriter.write` to fix the first-row race.

### CC-4 — Russian triad is structurally absent
Decision required: either (a) execute the 1,264-key translation backlog under CODEOWNERS medical-terminology review, or (b) update CLAUDE.md to remove `ru` from the active triad until bundles ship. The codebase ships shape parity with `de` but real Russian content is 0.2%.

### CC-5 — FHIR R4 conformance is structurally violated across audit emitters
The fix has 4 mechanical components:
1. Remove `category` from every AuditEvent dict literal (14 sites) — rely on `subtype` only.
2. Add `type` + `source` fields to the shared helper.
3. Replace all `liverra:foo` extension URLs with `http://liverra.ai/fhir/StructureDefinition/foo`.
4. Publish 10 missing StructureDefinitions in `packages/fhirtypes/src/liverra/extensions/`.
5. Replace `Analysis/`, `Report/`, `ReportDelivery/` references with `Basic/` or `ImagingStudy/` or `DiagnosticReport/`.
6. Reconcile `fhir/constants.py` vs `audit/fhir_extensions.py` (delete one).

### CC-6 — Forbidden-blue brand-token drift
Single sweep — replace every raw `#1a365d` / `#2b6cb0` / `#3182ce` in `theme.css` with `var(--liverra-primary-700|500|400)` (74 edits in one file); replace 6 feature-file references with the same; gate behind `brand-tokens.md status: approved` per T464.

### CC-7 — Tap target / dark-mode / `var(--emr-*, fallback)` design-system hygiene
Three sweeps:
1. Bump `EMRIconButton` md to 44×44; add `clinicalControl` variant; replace `<ActionIcon size="xs">` in `MeasurementPanel.tsx`.
2. Strip all `var(--emr-*, hex-fallback)` patterns (30+ sites).
3. Remove all `:root[data-mantine-color-scheme="dark"]` blocks from CSS modules (3 files); migrate into theme.css or Mantine theme provider.

### CC-8 — Frontend audit service is dormant + backend audit-chain emission is incomplete = compliance theatre
This is the most-cited cross-cutting risk. The end-to-end audit pipeline (frontend `auditService.ts` → backend `AuditEventEmitter` → `AuditChainWriter` → `audit_event_chain` → daily Merkle root → retention attestation) has at least 6 broken links between user action and signed evidence. Single dependency PR (CC-1) fixes most of them.

---

End of PART 1. Continue to PART 2 (MEDIUM) and PART 3 (LOW + TRIVIAL).
