# LiverRa E2E Journey Maps

LiverRa's primary user-facing flows. Use ALL four when the target area touches imaging, analysis, refinement, or compliance. The generic operation methodology in `qa-e2e-browser-tester.md` always applies on top — discover and test ALL operations a page offers, not only what's listed here.

**Dev environment baseline:**
- Frontend: `http://localhost:5173` with `VITE_LIVERRA_DEV_BYPASS=true`
- FastAPI orchestrator: `http://127.0.0.1:8090`
- GPU service: `http://100.124.94.29:9101` (Tailscale)
- Existing E2E specs: `packages/app/src/emr/views/__e2e__/` (read these for reusable selectors + fixtures)

---

## Journey 1 — DICOM Upload & Study List

**Goal:** Verify a CT zip uploads cleanly into Orthanc, anonymization strips PHI, and the study appears in the study list.

**Prerequisite state:**
- Orthanc container running (`docker compose -f deploy/local/docker-compose.yml up -d orthanc`)
- FastAPI + Celery + Vite running
- A small fixture DICOM zip (see `packages/app/src/emr/views/__e2e__/pacs/fixtures/` if present, else use the Todua-CT sample)

**Golden-path steps:**
1. Navigate to `/pacs/studies`
2. Click "Upload DICOM" → modal opens
3. Attach `tests/fixtures/<small-ct>.zip`
4. Submit; wait for Orthanc ingest indicator
5. Verify study row appears in the list with the expected modality (CT) and study description
6. Click into the study → DICOM viewer loads, instances render

**Expected audit events (FHIR AuditEvent):**
- `type=110106` (upload), `subtype=upload-dicom`
- `entity.what` → `ImagingStudy/<id>`
- `extension` includes `audit-chain-leaf-hash` + `audit-chain-sequence-no`

**Critical checks:**
- DICOM `(0010,xxxx)` PHI tags are zero/strip in the persisted study (verify via QIDO query if available)
- Audit event emitted for upload action
- Link to study works after refresh (deep-link resilient)
- Locale switch (`ru`, `ka`) on this page leaves no English page header or column header

**Common failure modes:**
- Orthanc not running → upload returns 502 — surface a clear error toast, don't crash
- Large zip times out → progress indicator stalls; flag as performance issue
- Anonymizer skipped → PHI leaks to the persisted study (CRITICAL)

**Files involved:**
- `packages/app/src/emr/views/pacs/StudyListView.tsx` (or similar)
- `packages/app/src/emr/components/pacs/UploadModal.tsx`
- `packages/ml-inference/src/api/upload.py` (or PACS bridge)
- `pacs/orthanc/` configuration

---

## Journey 2 — Cascade Run + Report

**Goal:** Trigger the full multi-phase ML cascade on an uploaded study, wait for terminal state, view inline report (FLR + Couinaud + LI-RADS + ACR structured readout), finalize, and export PDF.

**Prerequisite state:**
- Journey 1 completed (an `ImagingStudy` exists)
- GPU service reachable: `curl http://100.124.94.29:9101/health` → `{"ok": true}`
- `LIVERRA_CASCADE_REAL_MODE=true` (default)

**Golden-path steps:**
1. From the study list, click "Analyze" on the uploaded study
2. Confirm analysis-detail view opens with phase progress indicators
3. Poll progress (~13–14 min on Tailscale; faster on same-LAN setups)
4. Verify each phase reaches `complete`: convert, deid, parenchyma, vessels, Couinaud, lesions, LI-RADS, FLR, findings
5. Inline report renders with: FLR mL + %, Couinaud segment table, lesion list with LI-RADS class + confidence, ACR structured readout sections (liver, lesions, vessels, FLR, gallbladder, spleen)
6. Click "Finalize" → analysis status flips to `final`, audit-chain row written
7. Click "Export PDF" → PDF downloads, render in viewer or save to disk

**Expected audit events:**
- One AuditEvent per phase transition (with `audit-model-version` extension for inference phases)
- One AuditEvent for finalize (`audit-permission-checked` extension)
- One AuditEvent for PDF export (entity = `DocumentReference/<pdf-id>`)

**Critical checks:**
- All cascade phases show green; no phase stuck in `running` past timeout
- FLR within plausible range (15–60% for healthy livers; outliers surface `implausible-output-reason` extension)
- `model_version` recorded on every inference output
- Audit-chain `sequence_no` strictly monotonic per tenant; no skips
- Couinaud segment % shares sum within tolerance of 100% (allow small rounding)
- Report inline view + exported PDF show the same values

**Common failure modes:**
- GPU service unreachable → cascade fails at stage 2; user-facing error must explain (Tailscale down? GPU offline?)
- Spleen mask <500 voxels → degraded finding with warning surfaces (don't silently omit; ref CLAUDE.md commit `a6e42b3`)
- Phase orphan: stage X writes mask to MinIO, DB row commit fails — analysis stuck; should be detected by integration tests
- PDF render path missing model_version on a section — regulatory traceability gap (HIGH)

**Files involved:**
- `packages/app/src/emr/views/cases/AnalysisDetailView.tsx`
- `packages/app/src/emr/components/report/ACRStructuredReadout.tsx` + section files
- `packages/app/src/emr/components/liver/FLRPanel.tsx`
- `packages/ml-inference/src/api/analysis.py`
- `packages/ml-inference/scripts/real_cascade.py`
- `packages/ml-inference/src/services/post_processing/` (Couinaud, LI-RADS, FLR, findings)

---

## Journey 3 — Lesion / Couinaud Refinement

**Goal:** Open a finalized analysis, switch to refinement view, manually edit a lesion mask (or Couinaud segment), re-run dependent phases, verify report updates with a new immutable snapshot.

**Prerequisite state:**
- Journey 2 completed (a `final` analysis exists with at least one lesion)

**Golden-path steps:**
1. Open analysis detail for a finalized analysis
2. Switch to refinement mode (button or tab — see `RefineTools.tsx`)
3. Select a lesion mask; edit boundary
4. Save edit; system creates a refinement version
5. Verify dependent phases auto-re-run: LI-RADS (always), FLR (if topology changed)
6. Confirm the original analysis is preserved as an immutable snapshot (read-only access still works)
7. Open the refined version; report shows new values

**Expected audit events:**
- AuditEvent for refinement save (entity = analysis + version, actor = refiner)
- AuditEvent for each re-computed phase (with new `audit-model-version` digest if applicable)
- Reason for refinement recorded (free-text or selection from controlled list)

**Critical checks:**
- Original analysis remains read-only after refinement (no overwrite)
- Refinement creates a NEW analysis version, not mutates the prior
- Audit chain reflects the actor + reason
- ReviewTools + RefineTools components honor light/dark mode + en/ru/ka

**Common failure modes:**
- Edited mask saved to MinIO but DB version row not created → silent data loss
- LI-RADS re-run skipped → stale classification persists
- Permission gate missing on refinement (a viewer can edit) → access control bug

**Files involved:**
- `packages/app/src/emr/components/liver/RefineTools.tsx`
- `packages/app/src/emr/components/liver/ReviewTools.tsx`
- `packages/app/src/emr/views/cases/RefinementView.tsx` (currently a stub — see CLAUDE.md "View Implementation Tracker")
- backend refinement endpoint in `packages/ml-inference/src/api/`

---

## Journey 4 — Audit Chain Verification & Compliance View

**Goal:** Open the compliance/audit-summary view, confirm chain integrity status, run chain verification, and exercise tamper-detection + retention attestation + erasure flows.

**Prerequisite state:**
- Multiple analyses exist from Journeys 1–3 (enough chain entries to verify)
- Access to `packages/ml-inference/scripts/verify-audit-chain.py` (or equivalent UI button)

**Golden-path steps:**
1. Navigate to `/compliance/audit-summary`
2. Verify chain integrity badge shows PASS
3. Click "Verify chain" (or run `scripts/verify-audit-chain.py` directly) — confirm SHA-256 leaf hashes link correctly back to the genesis row
4. Confirm `sequence_no` is strictly monotonic per tenant
5. **Tamper test (only in dev DB):** manually update one body field of an `audit_event_chain` row → re-run verification → verify it reports the break and points to the offending row
6. Revert the tamper test
7. Trigger or wait for the retention attestation job → confirm it emits an AuditEvent and updates retention status
8. Run the GDPR erasure flow on a `[TEST]` patient → verify the chain is **rewritten with redacted body** (not deleted — chain integrity must hold)

**Expected audit events:**
- Verification action emits a meta-AuditEvent (`type=verify-chain`)
- Retention attestation emits AuditEvent per artifact
- Erasure emits AuditEvent with `audit-permission-checked` extension, redacts PHI in body but preserves hash linkage

**Critical checks:**
- Verification correctly detects the tampered row
- Erasure does NOT break chain integrity (re-verify after erasure → PASS)
- Retention TTL job runs on schedule and writes attestation
- All compliance UI strings translated in `ru` + `ka`
- Permission gates: only auditor/admin roles can run verify/erase

**Common failure modes:**
- Verification script doesn't actually re-hash (silent PASS) — verify by running tamper test
- Erasure deletes the chain row (breaks integrity) instead of redacting body
- Retention job AuditEvent missing `audit-chain-leaf-hash` extension → regulatory gap
- Compliance view uses raw Mantine components instead of EMR* wrappers → UI12 finding

**Files involved:**
- `packages/app/src/emr/views/compliance/AuditSummaryView.tsx`
- `packages/ml-inference/src/services/audit/chain_of_hashes.py`
- `packages/ml-inference/src/services/fhir/audit_event_emitter.py`
- `packages/ml-inference/scripts/verify-audit-chain.py` (if present)
- Retention attestation job in `packages/ml-inference/src/workers/`
- Erasure handler in `packages/ml-inference/src/api/`

---

## Cross-Journey Locale Switch Verification (always run last)

After completing the 4 journeys in English, switch to `ru`, revisit the key pages from each journey, screenshot. Then switch to `ka`, repeat. See `qa-e2e-browser-tester.md` Phase 3D for the exact commands. Reset to `en` before finishing.

`__TODO_TRANSLATE__:<en-value>` markers in `ru`/`ka` are informational, NOT findings (pending CODEOWNERS medical-terminology review).
