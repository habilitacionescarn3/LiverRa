# Feature Specification: Zero-Training Cascaded Pretrained Liver AI Pipeline with Web Viewer (v1 MVP)

<!-- UPGRADED -->

**Feature Branch**: `001-zero-training-mvp`
**Created**: 2026-04-19
**Status**: Draft (upgraded 2026-04-19 via `/upgradeSpec` — 45 findings merged)
**Input**: User description: "Build LiverRa v1 MVP — a zero-training cascaded pretrained liver AI pipeline delivered as a standalone web application at app.liverra.ai for HPB surgeons at design-partner hospitals (Regensburg, Potsdam, Geo Hospitals Tbilisi). Target: 6 weeks to working demo. Research Use Only. No custom training. Cascaded pipeline producing 3D viewer + DICOM-SEG + DICOM-SR + PDF report."

**Canonical brief**: [`docs/research/12-spec-input-prompt.md`](../../docs/research/12-spec-input-prompt.md)
**Strategic context**: [`docs/research/10-mvp-strategy.md`](../../docs/research/10-mvp-strategy.md), [`docs/research/00-executive-brief.md`](../../docs/research/00-executive-brief.md)

---

## Problem & Goal *(plain-language framing)*

**Problem.** Hepatobiliary (HPB) surgeons planning a liver resection need to know three things before they can safely operate: (1) how much healthy liver is left after the planned cut (the "Future Liver Remnant" or FLR), (2) which Couinaud segments the tumor crosses, and (3) what type of tumor they are dealing with. Today these answers come from either manual ROI drawing in legacy PACS software (slow, variable between readers) or an external service like Visible Patient with a 48-hour turnaround and a per-case fee. The result: surgeries get delayed, borderline-resectable cases get declined out of caution, and small centres without access to 3D planning operate with less information than large academic ones.

**Goal.** Deliver a web-based tool where an HPB surgeon uploads a 4-phase contrast liver CT and — within minutes, not days — gets back a 3D interactive view of the liver with segmented anatomy, a tumor list with AI-suggested classification, and an FLR calculator with a resection-plane simulator. The output is marked **Research Use Only** and designed to support, not replace, surgical decision-making. Ship a working demo to three design-partner hospitals within six weeks, accumulating clinical evidence that feeds the eventual CE MDR Class IIb submission.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload a 4-phase liver CT and get an FLR answer (Priority: P1)

An HPB surgeon at a design-partner hospital preparing for a right hepatectomy opens `app.liverra.ai`, signs in, drags a de-identified 4-phase contrast liver CT study onto the upload area, and waits. Within a few minutes the system returns a 3D rendering of the patient's liver parenchyma, total liver volume, and an interactive resection plane that the surgeon can drag to simulate different cut lines. A live FLR readout (in mL and as a % of total functional liver volume) updates as the plane moves. The surgeon uses this to decide whether the patient is a resection candidate or needs pre-op portal vein embolization.

**Why this priority**: FLR is the single number that determines operability. Even without any other output (no segments, no tumor classification, no PDF), a fast FLR calculation is demo-worthy and clinically meaningful on its own. This is the minimum viable slice — everything else is additive value layered on top.

**Independent Test**: A surgeon uploads one representative CT study, drags the resection plane across the mid-hepatic vein, and reads the FLR % shown. The scenario passes if (a) the upload-to-result time is under 5 minutes, (b) the FLR number is within ±5% of expert manual volumetry on a 20-case validation set, and (c) the "Research Use Only" disclaimer is visible on the screen at all times.

**Acceptance Scenarios**:

1. **Given** a valid 4-phase contrast liver CT study and a signed-in surgeon, **When** the surgeon drops the study onto the upload area, **Then** the system accepts the upload, shows a progress indicator for ingestion + anonymization + inference, and surfaces a 3D liver model within 5 minutes.
2. **Given** the 3D liver model is displayed, **When** the surgeon drags the resection plane handle, **Then** the FLR mL and FLR % update within 1 second to reflect the new plane position.
3. **Given** any AI-generated output is visible, **When** the surgeon looks at the screen or exports any artifact, **Then** a "Research Use Only — Not for Diagnostic Use" disclaimer is prominent and un-dismissable.
4. **Given** a CT study where the portal-venous phase is missing, **When** the surgeon attempts upload, **Then** the system explains which phase is required and rejects the study (or accepts with a clearly-flagged degraded-confidence result if only portal-venous is present and other phases are missing).
5. **Given** an Analysis has been in "queued" status longer than 10 minutes, **When** the surgeon views the case, **Then** the system shows queue position, estimated wait, and an option to cancel the submission.

---

### User Story 2 - Review Couinaud segments and vascular anatomy (Priority: P2)

The same surgeon, having obtained an FLR number, now wants to see which of the eight Couinaud segments the tumor touches and where the portal and hepatic vein trunks run. They click a "Segments & vessels" layer and see the liver parenchyma subdivided into 8 color-coded Couinaud segments, with portal vein and hepatic vein trunks overlaid. They toggle individual segments on and off to clarify the view, rotate the 3D model, and change slice view (axial / coronal / sagittal) to correlate with what they see in the native CT slices.

**Why this priority**: Couinaud segmentation is the language HPB surgeons use to communicate resection plans ("I'm taking segments 5, 6, 7, 8"). Without it, the tool is a volumetry gadget, not a planning tool. But it requires the P1 parenchyma mask as a prerequisite, so it lands at P2.

**Independent Test**: Show a surgeon the segmented liver model and ask: "Which segments would you take in this case?" Record the answer. Compare against the surgeon's own manual segmentation of the same CT. Scenario passes if the AI segmentation is judged "surgically usable" (no re-segmentation required before planning) on ≥80% of a 20-scan review set.

**Acceptance Scenarios**:

1. **Given** a completed analysis, **When** the surgeon activates the segments layer, **Then** the liver model shows 8 distinct colored regions corresponding to Couinaud I–VIII, with portal and hepatic vein trunks visibly overlaid.
2. **Given** the segments layer is active, **When** the surgeon clicks a segment, **Then** that segment's volume (in mL and % of total functional liver) is shown.
3. **Given** the 3D view, **When** the surgeon switches between 3D, axial, coronal, and sagittal views, **Then** the segment boundaries remain consistent and synchronized across views.
4. **Given** the surgeon is dissatisfied with a segment boundary, **When** they enter edit mode and place a correction marker, **Then** the system re-computes that segment's boundary locally without re-running the full pipeline.

---

### User Story 3 - Detect and classify liver lesions (Priority: P3)

The surgeon now wants to know what the liver lesions are. They open the "Lesions" panel and see a list of auto-detected lesions, each with: a thumbnail, location (which Couinaud segment it sits in), longest diameter, AI-suggested classification (one of HCC, ICC, metastasis, FNH, hemangioma, cyst), and a confidence score. When the AI is uncertain, the lesion is flagged "classification uncertain — radiologist review recommended" rather than given a low-confidence guess. Clicking a lesion centres the 3D view and all slice views on it.

**Why this priority**: Lesion classification is the highest-risk AI output because misclassification can change management. The constitution requires the Research Use Only disclaimer, and the product requires an abstention path for uncertain cases. Classification adds significant decision-support value, but it is not required for FLR calculation or segment-based planning (P1/P2), so it is P3.

**Independent Test**: Curate a 20-case review set spanning all six tumor classes. For each case, record (a) whether the AI detected every lesion a radiologist identified (recall), (b) whether the AI's classification agreed with pathology or radiologist consensus, and (c) how often the AI correctly abstained instead of guessing wrong. Scenario passes if lesions ≥10 mm achieve ≥78% detection sensitivity and if the abstention mechanism fires on every low-confidence case.

**Acceptance Scenarios**:

1. **Given** the analysis completes, **When** the surgeon opens the Lesions panel, **Then** every detected lesion is listed with location, size, suggested class, and confidence score.
2. **Given** a lesion with AI confidence below the abstention threshold, **When** the surgeon views the lesion, **Then** the classification field shows "Uncertain — radiologist review recommended" instead of a class name.
3. **Given** the lesions panel is open, **When** the surgeon clicks a lesion row, **Then** all three slice views (axial / coronal / sagittal) and the 3D view pan to that lesion.
4. **Given** a case where the native scan missed a small lesion that a radiologist later identified, **When** the radiologist adds a marker, **Then** the system supports one-prompt tumor re-segmentation from that marker and adds the lesion to the list.

---

### User Story 4 - Interactively refine AI output with one-click corrections (Priority: P4)

The surgeon or radiologist reviewing the AI output notices a missed lesion or a parenchyma boundary that the AI drew incorrectly (e.g., bleeding into the portal vein). Instead of starting over or sending the scan to an external 3D service, they click the spot directly on the 3D model or slice view. The system interprets the click as "please segment here" or "expand boundary to include this" and refines the local region in under 30 seconds. Multiple refinement clicks accumulate into a revised mask that the surgeon can save as the "reviewed" version. The original AI output and the reviewed version are both retained and labelled.

**Why this priority**: Even best-in-class AI makes mistakes. Without interactive refinement, a single bad segmentation invalidates the whole analysis and the surgeon reverts to manual tools. Interactive refinement turns "AI that's wrong 20% of the time" into "AI that's right 100% of the time after 2 clicks" — which is the difference between a toy and a tool. But refinement is a power-user feature that depends on P1-P3 having produced reviewable output, so it is P4.

**Independent Test**: Show the reviewer a case with a deliberately imperfect AI mask (e.g., under-segmented tumor). Measure time-to-acceptable-mask with refinement tools versus without. Scenario passes if median time-to-acceptable-mask drops by ≥50% compared to full manual re-segmentation.

**Acceptance Scenarios**:

1. **Given** a displayed AI segmentation, **When** the user clicks inside a region to add or subtract, **Then** the affected mask updates within 30 seconds and only the local neighbourhood is recomputed.
2. **Given** the user has made edits, **When** they save the reviewed version, **Then** both the original AI output and the reviewed version are retained and distinguishable in the case history.
3. **Given** a tumor was missed in the first pass, **When** the user drops a single marker on the missed lesion, **Then** the system re-segments that lesion and appends it to the lesion list with a "manually prompted" tag.

---

### User Story 5 - Export a report to hospital PACS and to paper (Priority: P5)

After review, the surgeon clicks "Finalize report". The system produces three artifacts: (1) a surgeon-facing PDF with 3D screenshots, a volumes table, an FLR summary, the resection plan, and a labelled lesion list; (2) a DICOM-SEG file with the segmentation volumes encoded against standard SNOMED-CT anatomy codes for return to the hospital's PACS; (3) a DICOM-SR structured report using the standard volumetric measurement template. All three artifacts carry the Research Use Only watermark and an audit trail summary (who ran the analysis, when, which model versions). The surgeon can download the PDF to share at tumor board and push the DICOM-SEG/SR back to hospital PACS via a standard DICOM store.

**Why this priority**: Without export the analysis can't leave the web app — surgeons can't use it at tumor board, radiologists can't attach findings to the original study, the hospital can't archive it with the patient record. Export makes the tool usable in the real clinical workflow. But P1-P4 deliver value inside the web app already; export is the "ship it back to the hospital" step, so it is P5.

**Independent Test**: Run an end-to-end case from upload through edit to export. Open the PDF on desktop and mobile (surgeon workflow), and send the DICOM-SEG to the design-partner hospital's PACS. Scenario passes if (a) the PDF opens with all sections visible on both form factors, (b) the DICOM-SEG is accepted by the hospital's standard DICOM store and renders in their native PACS, and (c) every artifact carries the RUO watermark.

**Acceptance Scenarios**:

1. **Given** a finalized analysis, **When** the surgeon clicks "Finalize report", **Then** a PDF, a DICOM-SEG, and a DICOM-SR are produced, all three watermarked Research Use Only.
2. **Given** the PDF is downloaded, **When** it is opened on a mobile device, **Then** all sections (volumes table, lesion list, screenshots, resection plan) are legible without horizontal scrolling.
3. **Given** the DICOM-SEG is pushed to a configured PACS destination, **When** the PACS receives it, **Then** it registers as a child of the original ImagingStudy and renders in the hospital's native viewer.
4. **Given** a finalized report, **When** any user opens the case later, **Then** the original AI output, the reviewer edits, and the finalized report version are all retrievable and clearly labelled.
5. **Given** a PACS push failed on the first attempt, **When** the surgeon clicks Retry, **Then** the push is attempted again against the same destination and the new outcome replaces the previous one in the activity log.

---

### User Story 6 - Hospital admin onboards users and configures the tenant (Priority: P2)

A newly-signed design-partner hospital (e.g., Regensburg) nominates a hospital admin — typically the HPB department lead or the hospital's IT-liaison for research software. The admin signs in for the first time, completes MFA enrolment, and opens an "Admin" area where they (a) invite clinicians by email with role assignment (surgeon / radiologist / fellow), (b) configure the hospital's PACS push destination (host, port, AE title, optional TLS certificate fingerprint), (c) review per-user activity and an audit log scoped to their tenant, (d) suspend or revoke a user's access without deleting the user's historical cases, and (e) accept or reject case-deletion requests submitted by clinicians.

**Why this priority**: Without a working admin surface, every design-partner onboarding is hand-rolled by LiverRa engineering — unsustainable past the first three pilots and a blocker on SC-007 ("at least one user account active with MFA enabled" per site). Admin is also the gatekeeper for PACS destination configuration (US5 depends on it) and for case-deletion approvals (US7).

**Independent Test**: Provision an admin for a fresh tenant. The admin invites three clinicians, assigns them distinct roles, configures a PACS destination, suspends one user, and reviews the audit log. Scenario passes if all actions complete without engineering intervention and every action appears in the tenant-scoped audit log.

**Acceptance Scenarios**:

1. **Given** a new tenant with a signed DPA, **When** the admin sends an invite, **Then** the invitee receives an email with a tenant-scoped activation link valid for 72 hours.
2. **Given** a PACS destination needs configuration, **When** the admin enters host + port + AE title and saves, **Then** the system performs a C-ECHO test against the destination and reports success/failure before accepting the config.
3. **Given** a user has left the hospital, **When** the admin suspends them, **Then** the user can no longer sign in but their historical Analyses, Reports, and AuditEvents remain intact and attributable.
4. **Given** the admin opens the audit log, **When** they filter by user or date range, **Then** all visible events belong to the admin's tenant only (no cross-tenant leakage).

---

### User Story 7 - Clinician completes first-time onboarding (Priority: P2)

An invited surgeon at Regensburg clicks their invite link. The application walks them step-by-step through: (1) setting a password or linking hospital SSO, (2) enrolling a second authentication factor (authenticator app) and saving backup codes, (3) reading the Research Use Only terms in their preferred language (en/de/ka) and explicitly accepting — the acceptance is audit-logged with a signed event, (4) a short guided tour of the upload screen, 3D viewer, and finalize flow with explanatory captions, (5) optionally opening a pre-loaded "sample case" that produces a full analysis on known fixture data and exercises every priority feature. Until all required onboarding steps are complete, the surgeon cannot upload real patient studies.

**Why this priority**: A scripted onboarding is the difference between self-serve design-partner activation and ongoing white-glove support. Without it, the 6-week demo window is eaten by hand-holding calls. It is also the only place where RUO acceptance is structurally guaranteed (FR-031) — skipping onboarding means RUO evidence is incomplete.

**Independent Test**: Run onboarding end-to-end as a fresh user. Scenario passes if (a) RUO acceptance is recorded in the audit log with a cryptographic signature, (b) MFA is enrolled before first upload is possible, (c) the sample case runs to completion within 5 minutes, and (d) the tour can be re-launched from the Help menu.

**Acceptance Scenarios**:

1. **Given** a fresh invite link, **When** the user clicks it, **Then** they are taken through a mandatory onboarding wizard and cannot reach the upload area until all steps pass.
2. **Given** the user has not accepted RUO terms, **When** they attempt to start any other workflow, **Then** the wizard re-opens at the RUO step and all other surfaces are blocked.
3. **Given** MFA enrolment is interrupted (e.g., browser closed), **When** the user returns, **Then** they resume at the MFA step and previous steps are not redone unless explicitly re-initiated by the user.
4. **Given** the sample case, **When** the user runs it, **Then** all outputs appear clearly labelled "Sample data — not real patient" and no real-patient PACS push destinations can be targeted.

---

### User Story 8 - Operations role recovers a stuck or failed Analysis (Priority: P3)

An ops / on-call engineer monitors a cross-tenant operations dashboard showing queue depth, per-stage p50/p95 latency, GPU utilization, cold-start occurrences, and a live list of Analyses in "queued" or "running" status for longer than their target. When a case has been stuck for >15 minutes, the ops engineer can inspect per-stage telemetry, re-queue the Analysis, cancel it with a note, or mark it as "blocked — contact hospital". The engineer has no access to PHI content: they see case IDs, model versions, stage timings, and error signatures, never patient names or image pixels.

**Why this priority**: In a GPU-constrained MVP, cases will get stuck weekly (cold start, transient inference errors, PACS back-pressure). Without an ops role, surgeons at design partners are left staring at a frozen queue and engineering gets paged 24/7. This also closes the observability side of SC-010 (audit completeness) by giving someone authority to reconcile and re-run.

**Independent Test**: Simulate a stuck Analysis (e.g., pause the inference service mid-run). An ops engineer opens the dashboard, identifies the stuck case, and takes a recovery action. Scenario passes if no PHI is visible to the engineer at any point and if the recovery action is captured in the audit log.

**Acceptance Scenarios**:

1. **Given** an Analysis stuck >15 minutes, **When** the ops engineer opens the case, **Then** they see per-stage timing + last error signature + model version, never PHI.
2. **Given** a failed Analysis, **When** the ops engineer clicks "Retry", **Then** inference is re-run against the already-ingested study without requiring re-upload, and a new AuditEvent links the retry to the original.
3. **Given** an Analysis cancelled by ops, **When** the submitting clinician next opens the case, **Then** they see a "Cancelled by operations — reason: [text]" banner and a one-click "Resubmit" action.

---

### User Story 9 - Data protection officer honours a GDPR erasure request (Priority: P3)

A patient (or their legal representative) submits a GDPR Article 17 erasure request to a design-partner hospital. The hospital's Data Protection Officer (DPO) — a role distinct from both clinician and admin — signs in, locates the specific case via a search by hospital MRN (which is ingested only in the anonymization manifest, never in cloud-persisted imaging), and initiates an erasure workflow. The system irrecoverably deletes the original Study, all derived Segmentations, Reports, PACS-push artifacts, and reviewer edits; retains the AuditEvent records stripped of residual identifiers and tagged "post-erasure" to preserve compliance traceability; produces a confirmation PDF for the hospital's records; and generates a tombstone record proving the erasure occurred.

**Why this priority**: GDPR Art. 17 is a hard legal obligation in DACH and non-negotiable per Constitution VII. Without a working workflow, every erasure request becomes an engineering ticket and represents legal risk proportional to response time. It is P3 (not P1) because the volume is expected to be low during the design-partner phase and because P1-P2 must exist first for there to be anything to erase.

**Independent Test**: Submit an erasure request for a specific case. The DPO completes the workflow without engineering help. Scenario passes if (a) the Study, Segmentations, and Reports are unreadable from primary storage within 60 seconds, (b) the AuditEvent records remain accessible with residual identifiers stripped, (c) a confirmation PDF is produced, and (d) a clinician's search for that case returns "Not found" (not "Access denied", which would leak existence).

**Acceptance Scenarios**:

1. **Given** a verified erasure request, **When** the DPO initiates erasure, **Then** the system prompts for a second authentication factor and a written justification before proceeding.
2. **Given** erasure has completed, **When** any clinician searches for the erased case, **Then** the case returns no results and no error reveals that the case ever existed.
3. **Given** erasure has completed, **When** a compliance reviewer inspects the audit log, **Then** the erasure event, timestamp, DPO identity, and justification are visible; residual identifiers on pre-erasure events are replaced by hash placeholders.
4. **Given** a clinician role attempts to initiate erasure, **When** they open the erasure workflow, **Then** the workflow is blocked with a clear message that only DPO or admin roles may erase.

---

### User Story 10 - Compliance reviewer validates regulatory traceability (Priority: P3)

A compliance reviewer (internal QMS officer or an external auditor granted read-only access for a specific audit window) signs in. They see a Compliance dashboard listing: (a) the active Model Bill of Materials with license, source commit/tag, license hash, integration date, and approver for each integrated model; (b) a tamper-evident audit summary for any date range listing every Analysis, DICOM transaction, MFA challenge, RUO acceptance, classification override, finalize, and erasure event; (c) spot-check tooling that samples N random exported artifacts and confirms the RUO watermark was rendered; (d) a per-claim regulatory status registry showing whether each claim (parenchyma volumetry, FLR, Couinaud segmentation, lesion detection, lesion classification, surgical planning) is Research Use Only, under conformity assessment, or cleared. Reviewers can export the entire view as a regulatory auditor-friendly report. They cannot view PHI, image pixels, or modify any record.

**Why this priority**: SC-009 and SC-010 require "reconciliation" and "audit of 20 random artifacts" — without a compliance role, those acceptance criteria cannot be met by anyone other than an engineer with database access, which itself violates least-privilege and creates audit-trail gaps. Class IIb submission requires a named QMS function; this story exists to seat it structurally.

**Independent Test**: A compliance reviewer performs the SC-009 audit (20 random export artifacts) and the SC-010 reconciliation (every inference run has an AuditEvent). Scenario passes if both are completable through the dashboard without database access or PHI exposure.

**Acceptance Scenarios**:

1. **Given** the Compliance dashboard, **When** the reviewer requests an audit window, **Then** the system returns a tamper-evident report signed with a chain of hashes linking every event in the window.
2. **Given** the RUO spot-check tool, **When** the reviewer requests a 20-artifact sample, **Then** the system renders each sampled PDF and DICOM-SR with its watermark region highlighted, and the reviewer can mark each "pass / fail".
3. **Given** the per-claim regulatory status registry, **When** the reviewer toggles a claim from "RUO" to "Cleared", **Then** subsequent exports narrow their disclaimer to only the still-RUO claims, without requiring a code release.

---

### Edge Cases

**Ingestion & data integrity:**

- **Missing or incomplete phases**: CT study missing the portal-venous phase MUST be rejected with a clear message. Missing arterial, delayed, or non-contrast phases MUST downgrade the analysis to "limited confidence" rather than fail outright, and the limitation MUST be surfaced on every downstream artifact.
- **Burned-in patient identifiers (pre-upload)**: Studies with PHI burned into the pixel data (patient name, MRN overlays) MUST be detected and either stripped before cloud upload or the upload MUST be blocked with a clear message.
- **Burned-in PHI discovered post-upload**: If burned-in pixel PHI is detected AFTER bytes have been written to cloud storage, the system MUST within 60 seconds block the study from entering inference, cryptographically erase the offending series from primary and replica storage, create an AuditEvent flagged as a privacy incident, notify the tenant's designated Data Protection contact, and surface the incident on the operator dashboard. No retry of the upload MAY proceed until the source study has been re-anonymized at the hospital edge.
- **Non-liver CT uploaded by mistake**: A chest CT or abdominal CT that does not contain the full liver MUST be detected at ingestion and rejected before the expensive inference pipeline runs.
- **Mixed-patient study / UID inconsistency**: Any mismatch of Patient ID, Patient Name hash, Study Instance UID, or acquisition date window (all phases MUST be within 24 hours of each other) across the upload MUST reject the upload, identify the conflicting series to the user, and MUST NOT proceed to inference. The rejection MUST be audit-logged.
- **Malformed / zipped / password-protected uploads**: Malformed DICOM, encrypted or password-protected archives, and non-DICOM content inside a ZIP MUST be rejected with a clear message; non-DICOM files inside an otherwise valid ZIP MUST be ignored with a summary shown to the user. Upload size MUST be capped at a configurable per-study maximum (default 5 GB) and oversized uploads MUST be rejected before transmission. All DICOM tag values used in UI, filenames, or paths MUST be sanitized against path-traversal and script injection.
- **Very large tumor burden**: Cases where tumor occupies >50% of the liver MAY degrade segmentation quality; the system MUST flag such cases rather than silently produce a low-quality mask.
- **Cirrhotic / dysmorphic livers**: Livers with nodular cirrhotic contour or prior resection MAY degrade Couinaud boundary accuracy; the analysis MUST surface a confidence flag on the segments layer in these cases.
- **Atypical anatomy (post-resection / transplant / pediatric)**: The system MUST detect and flag prior-resection defect (volume below age-adjusted normal or non-convex boundary), transplant anatomy (surgical anastomosis signatures), pediatric liver (volume below adult lower bound), and tumor-replacement fraction >50%. Each flag MUST recommend expert radiologist review and MUST downgrade confidence on any downstream FLR or Couinaud output.

**Pipeline & ML output integrity:**

- **Mid-cascade failure**: Each Analysis MUST have a maximum wall-clock duration (default 15 minutes). Exceeding it MUST auto-transition the Analysis to status=failed with a per-stage failure breakdown, preserve whatever partial outputs completed as "partial-result" artifacts clearly labelled, and notify the user. When any stage fails, downstream dependent outputs MUST be marked "not-produced-due-to-upstream-failure" rather than silently omitted; the UI MUST communicate which outputs (FLR, segments, lesions, vessels) are unavailable and why.
- **Implausible output values**: Outputs failing physiological sanity (total liver <300 mL or >3,500 mL; any Couinaud segment ≤0 or > total; FLR remnant <0 or > total; classification confidence vector outside [0,1] or not summing to 1.0 ± 0.01; lesion mask <95% contained in parenchyma mask) MUST transition the Analysis to failed with an "implausible-output" reason, MUST NOT be displayed as results, and MUST trigger an operator alert.

**Concurrency, sessions, and locking:**

- **Network interruption during upload**: A partial upload MUST be resumable, not require a full re-upload.
- **Reviewer edits during connection loss**: Reviewer edits MUST persist locally and synchronize on reconnect without user action.
- **Inference service unavailable**: If the GPU inference service is down, uploads MUST queue (not fail) and the user MUST see a clear "analysis pending" status rather than an error.
- **Concurrent uploads on a single GPU**: If 3+ studies are queued, the system MUST FIFO-queue them and show each user their queue position rather than running in parallel and crashing.
- **Two users open the same case**: The second user MUST see a banner identifying the active reviewer and be offered read-only or request-transfer. Concurrent edits by two reviewers MUST be detected, blocked from silent overwrite, and surfaced with an explicit merge / takeover choice that is itself audited.
- **Finalize while another is editing**: Once a user clicks "Finalize report", the Analysis MUST lock and further edits MUST be rejected with a clear message; in-flight edits from another user MUST be preserved as a separate post-finalization "addendum review" that does not alter the finalized artifacts.
- **User abandons case mid-review**: An in-progress review MUST auto-save edits so the surgeon can resume later without losing work.
- **Session expires mid-review**: Unsaved edits MUST persist locally; the user MUST be prompted to re-authenticate without navigating away; on successful re-auth the edits MUST be replayed with a visible "restored from saved session" indicator. The "Finalize report" action MUST require fresh authentication (≤5 minutes since last credential challenge).
- **Browser back / refresh during inference**: Navigating away during inference MUST NOT lose the job; the surgeon MUST find the completed analysis waiting when they return.

**Exports, PACS, and retraction:**

- **PACS push partial failure**: PACS push MUST be transactional per-artifact with state (pending / sent / acknowledged / failed) and retry on failure up to a configurable limit. If any artifact in a report bundle fails to deliver, the UI MUST flag the report as "partial-export" and surface a manual retry. Re-finalizing an Analysis MUST produce new SOP Instance UIDs; the system MUST NOT overwrite a previously delivered export.
- **Retraction of a finalized report**: A finalized report MUST be retractable by the original finalizer or a tenant admin. Retraction MUST (a) mark the report as superseded with a reason, (b) attempt best-effort "cancelled" status updates to every PACS destination that received the original, (c) preserve the retracted version in the audit trail, and (d) require a new Finalize action to produce a replacement report with new SOP Instance UIDs.
- **Pathology disagrees with AI classification**: The reviewed version MUST be editable to override the AI classification, and the override MUST be retained and distinguishable in the case history.

**Regulatory & RUO integrity:**

- **RUO disclaimer bypass**: The disclaimer MUST remain visible at every browser zoom 50%–300% and at every supported viewport. Screenshots and print-to-PDF initiated from within the application MUST be intercepted where technically possible to ensure the disclaimer is rendered into the captured image; where interception is not possible, every clinical image, 3D rendering, and chart MUST carry the disclaimer burned directly into the rendered pixels (not as an overlay). Embedding the viewer in a third-party iframe context MUST be blocked.
- **Audit backend unavailable**: Clinical operations producing auditable events (inference start/end, DICOM ingest/export, PACS push, RUO acceptance, finalize, erasure) MUST fail-closed when the audit backend is unavailable: the operation MUST roll back or hold pending, the user MUST see an operational error, and the operator dashboard MUST be alerted. Audit records MUST NEVER be silently dropped.
- **RUO acceptance lost due to cookie clear**: If the stored RUO acceptance record cannot be verified, the user MUST be blocked from all clinical workflows and re-prompted through the RUO acceptance step — the acceptance event MUST be re-written to the audit log.

**Character encoding, boundaries, and security:**

- **DICOM Unicode (German umlauts, Georgian Mkhedruli)**: DICOM character-set handling MUST correctly parse and preserve Unicode across ingestion, anonymization, UI rendering, PDF export, and audit logs. PHI detection MUST operate on the Unicode-normalized form of each tag. Failure to render MUST surface a visible error rather than silently substituting "?".
- **Cross-tenant leakage**: Every authenticated request MUST authorize against the requester's tenant. A request for a foreign-tenant resource MUST return the same response as for a non-existent resource. Identifiers MUST be unguessable (cryptographically random, not sequential). Shared-link flows MUST require the recipient to be a member of the owning tenant.
- **Cold start of inference GPU**: On-demand GPU start (used for MVP cost control) MAY add 60–120 s latency to the first case of a session; this MUST be surfaced as a one-time warm-up distinct from an error and MUST NOT count against the sub-5-minute target for subsequent cases.

**Sufficient-coverage overrides:**

- **"Sufficient liver coverage" threshold**: Sufficient coverage MUST be defined as the full superior-inferior extent of the liver within the scan field of view; partial coverage (dome only, inferior tip cut off) MUST trigger rejection naming the missing region. A tenant-admin-configurable override MAY allow a user with a stated clinical rationale to force-proceed on a partial-coverage study, with the rationale captured in the AuditEvent and a "partial-coverage" flag applied to all downstream outputs.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Ingestion & Input Handling

- **FR-001**: System MUST accept 4-phase contrast liver CT studies in DICOM format via web upload (drag-and-drop) in the MVP.
- **FR-001a**: System MUST accept both individual DICOM files and ZIP archives containing DICOM files; non-DICOM content inside a ZIP MUST be ignored with a summary shown to the user. Malformed, encrypted, or password-protected archives MUST be rejected with a clear message.
- **FR-001b**: Upload size MUST be capped at a configurable maximum per study (default 5 GB); exceeding it MUST be rejected before transmission.
- **FR-001c**: All DICOM tag string values used in UI display, filenames, or storage paths MUST be sanitized against path traversal and script injection; every tag value MUST be treated as untrusted input.
- **FR-002**: System MUST anonymize uploaded DICOM studies (header de-identification and burned-in pixel PHI detection) before any data leaves the hospital network or is written to persistent cloud storage.
- **FR-002a (post-upload PHI)**: If burned-in pixel PHI is detected AFTER bytes have been written to cloud storage, the system MUST within 60 seconds (a) block the study from inference, (b) cryptographically erase the offending series from primary and replica storage, (c) create an AuditEvent flagged as a privacy incident, (d) notify the hospital tenant's designated DPO contact, and (e) surface the incident on the operator dashboard.
- **FR-002b (Unicode)**: DICOM character-set handling MUST correctly parse and preserve Unicode across ingestion, anonymization, UI rendering, PDF export, and audit logs, including German diacritics and Georgian Mkhedruli script. PHI detection MUST operate on the Unicode-normalized form. Failure to render MUST surface a visible error rather than silently substituting characters.
- **FR-003**: System MUST validate that the uploaded study contains at minimum the portal-venous phase and MUST reject studies lacking it with a clear explanation.
- **FR-003a (consistency)**: At ingestion the system MUST verify that every image across every series shares a consistent Patient ID, Patient Name hash, Study Instance UID, and acquisition-date window (all phases within 24 hours). Any inconsistency MUST reject the upload with a message identifying the conflict, MUST NOT proceed to inference, and MUST be audit-logged.
- **FR-004**: System MUST detect and gracefully degrade analysis confidence when arterial, delayed, or non-contrast phases are missing, rather than failing outright.
- **FR-005**: System MUST support resumable upload of large DICOM series (studies can exceed 1 GB) without requiring the user to restart on network interruption.
- **FR-006**: System MUST detect non-liver or insufficient-coverage CT studies at ingestion and reject them before running the inference pipeline.
- **FR-006a (coverage override)**: "Sufficient liver coverage" MUST be defined as the full superior-inferior extent of the liver within the scan field of view; partial coverage MUST trigger rejection with an explanatory message naming the missing region. A tenant-admin-configurable override MAY allow a user to force-proceed on a partial-coverage study, with the rationale captured in the AuditEvent and a "partial-coverage" flag applied to all downstream outputs.

#### Analysis Pipeline & Outputs

- **FR-007**: System MUST produce, for each accepted study, a volumetric liver parenchyma mask with a reported confidence metric (e.g., Dice against an internal validation set).
- **FR-007a (sanity)**: Every pipeline output MUST pass physiological sanity checks before being surfaced to the user: total liver volume within 300–3,500 mL; each Couinaud segment volume > 0 and < total; FLR remnant ≥ 0 and ≤ total functional liver; classification confidence vector non-negative and summing to 1.0 ± 0.01; every lesion mask ≥95% contained within the parenchyma mask. Outputs failing sanity MUST transition the Analysis to failed with "implausible-output" reason, MUST NOT be displayed as results, and MUST trigger an operator alert.
- **FR-007b (atypical anatomy)**: The system MUST detect and flag prior-resection defect (non-convex boundary or age-adjusted low volume), transplant anatomy, pediatric liver, and tumor-replacement fraction >50%. Each flag MUST recommend expert radiologist review and MUST downgrade confidence on downstream FLR and Couinaud output.
- **FR-008**: System MUST produce an 8-region Couinaud segment map aligned to the parenchyma mask.
- **FR-009**: System MUST produce portal vein and hepatic vein trunk masks overlayable on the parenchyma.
- **FR-010**: System MUST produce a list of detected liver lesions, each annotated with Couinaud location, longest diameter, AI-suggested classification (HCC, ICC, metastasis, FNH, hemangioma, cyst), and a per-lesion confidence score.
- **FR-011**: System MUST abstain from classifying lesions whose confidence falls below a pre-set threshold and MUST surface such cases as "Uncertain — radiologist review recommended" rather than forcing a class label.
- **FR-012**: System MUST compute Future Liver Remnant (FLR) volume in mL and as a percentage of total functional liver volume, parameterized by a user-adjustable resection plane.
- **FR-013**: FLR MUST update in real time (≤1 s) as the user drags the resection plane.
- **FR-014**: The full inference pipeline MUST complete within 2 minutes per scan on the target inference hardware (single L4-class GPU), excluding upload / anonymization.
- **FR-014a (timeout)**: Each Analysis MUST have a maximum wall-clock duration (default 15 minutes). Exceeding it MUST auto-transition the Analysis to status=failed with a per-stage failure breakdown and notify the user.
- **FR-014b (partial results)**: When any cascade stage fails, downstream dependent outputs MUST be marked "not-produced-due-to-upstream-failure" rather than silently omitted; the UI MUST communicate which specific outputs are unavailable and why. Successfully-completed upstream outputs MUST be preserved as "partial-result" artifacts clearly labelled.

#### Interactive Review & Refinement

- **FR-015**: System MUST allow the reviewing user (surgeon or radiologist) to click-to-refine any segmentation (parenchyma, segment, vessel, or lesion) with a local recompute of the affected region in ≤30 s.
- **FR-016**: System MUST support one-prompt tumor re-segmentation where the reviewer marks a missed or mis-sized lesion with a single click and the system produces a 3D mask of that lesion.
- **FR-017**: System MUST retain both the original AI output and all user-edited versions of every mask and lesion record, distinguishable and timestamped.
- **FR-017a (reviewer seat)**: Only one user MAY hold the "reviewer" role on a given Analysis at a time. When a second user opens the same Analysis, the system MUST show "currently being reviewed by [name]" with options to view read-only or request transfer of the review seat.
- **FR-017b (finalize lock)**: Once a user clicks "Finalize report", the Analysis MUST lock and no further edits are accepted; any in-flight edits from another user MUST be rejected with a clear message, and those edits MUST be preserved as a separate post-finalization "addendum review" that does not alter the finalized artifacts.
- **FR-018**: System MUST auto-save review progress so that a user who navigates away or loses their session returns to their in-progress edits intact.
- **FR-018a (session expiry)**: If the user's authentication session expires while they have unsaved edits, the system MUST (a) preserve the edits locally, (b) prompt for re-authentication without navigating away, and (c) replay the pending edits after re-auth with a visible "restored from saved session" indicator.
- **FR-018b (finalize re-auth)**: The "Finalize report" action MUST require a freshly authenticated session (≤5 minutes since last credential challenge); stale sessions MUST be re-challenged before finalize completes.
- **FR-018c (offline edits)**: Reviewer edits MUST persist locally during connection loss and synchronize on reconnect without user action. Concurrent edits by two reviewers MUST be detected, blocked from silent overwrite, and surfaced with an explicit merge / takeover choice that is itself audited.

#### Visualization

- **FR-019**: System MUST present an interactive 3D rendering of the liver parenchyma, vessels, segments, and lesions, with the ability to toggle each layer independently.
- **FR-020**: System MUST present synchronized axial, coronal, and sagittal 2D slice views alongside the 3D view; clicking a point in one view MUST recenter all views.
- **FR-021**: System MUST support standard radiology interactions: zoom, pan, window / level presets for CT liver soft tissue, and measurement tools.
- **FR-022**: System MUST render clinical information (volumes, FLR, lesion lists) legibly on both desktop and mobile screens per the unified design system.

#### Export & Reporting

- **FR-023**: System MUST produce, on user request, a structured PDF report containing 3D screenshots, a volumes table, an FLR summary, the configured resection plan, and a labelled lesion list.
- **FR-024**: System MUST produce a DICOM-SEG artifact encoding the segmentation volumes (parenchyma, 8 segments, vessels, lesions by type) with standard anatomy coding (SNOMED-CT where applicable).
- **FR-025**: System MUST produce a DICOM-SR structured report using the standard volumetric-measurement reporting template (TID 1500 or equivalent), covering liver + segment volumes, FLR, and lesion measurements + classifications.
- **FR-026**: System MUST support pushing DICOM-SEG and DICOM-SR back to the hospital PACS via standard DICOM store transactions, configured per hospital.
- **FR-026a (transactional PACS)**: PACS push MUST be transactional per-artifact and record per-artifact delivery state (pending / sent / acknowledged / failed) with retry-on-failure up to a configurable limit. If any artifact in a report bundle fails to deliver, the UI MUST flag the report as "partial-export" and surface a manual retry. A tenant-scoped "PACS push activity" view MUST show the last 50 push attempts, outcome, target AE title, and a sanitized error message suitable for sharing with hospital IT.
- **FR-026b (no overwrite)**: Re-finalizing an Analysis MUST produce new SOP Instance UIDs for the resulting artifacts; the system MUST NOT overwrite a previously delivered export.
- **FR-026c (manual fallback)**: When a PACS push fails, the system MUST offer to download the DICOM-SEG and DICOM-SR so the user can push them manually from an on-prem workstation.
- **FR-027**: Every exported artifact (PDF, DICOM-SEG, DICOM-SR) MUST carry an un-removable "Research Use Only — Not for Diagnostic Use" watermark and a minimum audit-trail summary (analysis timestamp, model versions, operator).
- **FR-027a (retraction)**: A finalized report MUST be retractable by the original finalizer or a tenant admin. Retraction MUST (a) mark the report as superseded with a reason, (b) attempt best-effort "cancelled" status updates to every PACS destination that received the original, (c) preserve the retracted version in the audit trail and case history, and (d) require a new Finalize action to produce a replacement report with new SOP Instance UIDs.

#### Compliance, Audit & Safety

- **FR-028**: System MUST display a "Research Use Only — Not for Diagnostic Use" disclaimer persistently and un-dismissably on every screen that shows AI-derived output.
- **FR-028a (bypass hardening)**: The disclaimer MUST remain visible at every browser zoom 50%–300% and at every supported viewport. Screenshots and print-to-PDF initiated from within the application MUST be intercepted where technically possible to ensure the disclaimer is rendered into the captured image; where interception is not possible, every clinical image, 3D rendering, and chart MUST carry the disclaimer burned directly into the rendered pixels. Embedding the viewer in a third-party iframe context MUST be blocked.
- **FR-028b (per-claim RUO registry)**: System MUST maintain a per-claim regulatory-status registry (parenchyma volumetry, FLR, Couinaud segmentation, vessel identification, lesion detection, lesion classification, surgical planning) recording whether each claim is Research Use Only, under conformity assessment, or cleared. The disclaimer rendered on any UI view or exported artifact MUST be assembled from the union of RUO-status claims present in that artifact, so future partial clearances correctly narrow the disclaimer scope without code changes.
- **FR-029**: System MUST log every inference run as an audit record containing: input hash, model identifier + version, output hash, timestamp, actor, and study UID — with no PHI in the log body.
- **FR-029a (FHIR AuditEvent)**: Every auditable action MUST be represented as a FHIR R4 `AuditEvent` resource conforming to LiverRa identifier and extension conventions. All system URLs and extension URLs MUST be sourced from a single central constants module — hardcoded URLs are forbidden per Constitution IV. Auditable event types MUST include at minimum: sign-in, sign-out, MFA challenge, RUO acceptance, permission-check denial, study upload, anonymization pass/fail, inference start/end, mask edit, classification override, report finalize, artifact export, PACS push, tenant data-deletion, model-version update, case cancellation, case retry, case retraction.
- **FR-029b (fail-closed)**: If the audit-log backend is unavailable or rejects a write, clinical operations producing auditable events MUST fail-closed: the operation MUST roll back or hold pending, the user MUST see an operational error, and the operator dashboard MUST be alerted. Audit records MUST NEVER be silently dropped.
- **FR-030**: System MUST log every DICOM transaction (ingest, export, PACS push) to the same audit stream.
- **FR-031**: System MUST record explicit user acceptance of the Research Use Only terms on first sign-in and retain the acceptance event in the audit log. If the stored acceptance cannot be verified on a later session, the user MUST be blocked from clinical workflows and re-prompted.
- **FR-032**: System MUST restrict access to authenticated users, enforce multi-factor authentication for all clinician and admin roles, and scope every case to a single hospital tenant (no cross-tenant visibility).
- **FR-032a (cross-tenant hardening)**: Every authenticated request for a Study, Analysis, Report, or AuditEvent MUST be authorized against the requesting user's tenant. A request for a resource belonging to another tenant MUST return the same response as for a non-existent resource (no existence disclosure). Analysis and Report identifiers MUST be unguessable (cryptographically random, not sequential). Shared / deep-link flows MUST require the recipient to be a member of the owning tenant.

#### Operations

- **FR-033**: System MUST queue uploads when inference capacity is saturated and surface queue position to the user rather than failing.
- **FR-033a (cancel)**: The user MUST be able to cancel an Analysis that is queued or running, with confirmation; the cancellation MUST be captured in the audit log.
- **FR-033b (retry)**: When an Analysis fails, the user MUST be offered a "Retry" action that re-runs inference against the already-ingested study without re-upload; a new AuditEvent MUST link the retry to the original.
- **FR-033c (ops view)**: The system MUST expose a cross-tenant operations view (accessible only to the ops role) showing queue depth, per-stage latency p50/p95, GPU utilization, cold-start occurrences, and a live list of stuck cases (>15 minutes in queued or running). The ops role MUST see case IDs, model versions, stage timings, and error signatures — never PHI.
- **FR-034**: System MUST recover from a cold-started inference service, surfacing one-time warm-up latency to the user so that it does not appear to be a failure.
- **FR-035**: System MUST expose health indicators (ingestion, anonymization, inference, export) sufficient for an operator to diagnose a stuck case.
- **FR-036**: System MUST support 1–3 concurrent analyses on the MVP hardware footprint; scaling beyond that is out of v1 scope.

#### Admin, Onboarding & Governance

- **FR-037 (RBAC matrix)**: System MUST enforce a role-to-permission matrix covering at minimum: upload study, view analysis, edit/refine masks, finalize report, push to hospital PACS, override AI classification, cancel analysis, retry analysis, retract report, delete case (request), approve case deletion, invite users, assign roles, suspend users, configure PACS destinations, view audit logs, execute GDPR erasure, configure per-claim regulatory status. HPB surgeons and radiologists MAY finalize; fellows MAY review and edit but MUST NOT finalize; admins MAY manage users and PACS destinations but MUST NOT view clinical content unless also credentialed as a clinician; ops MUST NOT view PHI; compliance reviewers MAY view audit trails and exports but MUST NOT view PHI or modify records; DPOs MAY execute erasure. Every permission-gated action MUST generate an audit record including the permission checked and the outcome.
- **FR-038 (Model Bill of Materials)**: Every build shipped to a design partner MUST include an auto-generated Model Bill of Materials listing each integrated model, its pinned commit/tag, license text hash at build time, source URL, and approver. The build MUST fail if any model's current upstream license hash differs from the last approved hash — requiring human re-verification before release.
- **FR-039 (admin surface)**: Hospital admins MUST be able to invite clinicians (with role assignment), configure and C-ECHO-test the PACS push destination, review a tenant-scoped audit log, approve or reject case-deletion requests, and suspend or revoke user access without deleting historical cases. All admin actions MUST be audited and scoped to the admin's tenant.
- **FR-040 (GDPR erasure workflow)**: The system MUST support a DPO-initiated erasure workflow that (a) irrecoverably deletes Study, Series, Segmentations, Reports, reviewer edits, and any cached PACS-push artifacts for a specific case, (b) retains AuditEvent records with residual identifiers replaced by hash placeholders, (c) produces a confirmation PDF and a tombstone record proving the erasure, and (d) returns "not found" (no existence disclosure) to subsequent clinician searches for the erased case. Erasure MUST require fresh MFA and a written justification. Erasure MUST NOT be invokable by clinician roles.
- **FR-041 (onboarding)**: The system MUST guide every first-time invited clinician through a mandatory onboarding wizard covering password/SSO linkage, MFA enrolment with backup codes, RUO terms acceptance in the user's preferred language, a short guided tour, and an optional pre-loaded sample case. Until required steps are complete, the user MUST NOT be able to upload real patient studies. The wizard MUST be re-launchable from the Help menu.
- **FR-042 (demo case)**: The system MUST ship with at least one pre-loaded "demo case" per tenant that exercises every priority user story end-to-end and is guaranteed to produce a complete analysis within 5 minutes on warm infrastructure. Demo outputs MUST be clearly labelled "Sample data — not real patient" and MUST NOT be pushable to real-patient PACS destinations.
- **FR-043 (notifications)**: The system MUST send email notifications for: Analysis complete after queue wait, Analysis failed, Analysis queued >10 minutes, PACS push failed three times consecutively (admin-targeted), MFA reset (admin-targeted), invitation accepted (admin-targeted), erasure confirmation (DPO-targeted). Every email MUST include the tenant name, the case identifier (no patient name), a link to the case, and MUST NOT embed any PHI. Users MUST have a preferences page to opt in or out of non-critical notifications; critical-safety notifications (authentication, erasure confirmations) MUST NOT be opt-out.
- **FR-044 (navigation)**: The application MUST provide a persistent main navigation exposing Upload, My Cases, All Cases (admin and radiologist roles), Admin (admin role only), Compliance (compliance role only), Operations (ops role only), Help, and Sign Out, with visible entries scoped to the signed-in user's role. Every screen beyond landing MUST show a breadcrumb trail identifying tenant › case › current view. When a user returns with an auto-saved in-progress review, a session-recovery banner MUST offer "Resume where I left off".
- **FR-045 (help & glossary)**: Every Couinaud segment label, tumor-class abbreviation, confidence score, and FLR term MUST display an on-hover tooltip with a plain-language explanation translated in all three supported languages (en/de/ka). The Help menu MUST provide a glossary of clinical terms, a "how to cite LiverRa in an academic publication" block with a fixed citation string naming tool + model versions used, and a contact-support link that captures the current case identifier (no PHI) for troubleshooting.
- **FR-046 (case deletion)**: The uploading user MAY request deletion of a case; the request MUST require tenant-admin approval before the case is removed; both request and approval MUST be audited. Hard-delete (vs soft-delete) MUST be reserved to DPO via the FR-040 erasure workflow.
- **FR-047 (PHI remediation resubmission)**: If burned-in PHI is discovered post-analysis, the tenant admin MUST be able to mark the case "PHI-contaminated", block further access, and accept a re-uploaded remediated study linked to the same clinical workflow without losing the contamination history.

### Key Entities

- **Study**: One patient's uploaded imaging, identified by a globally unique Study Instance UID. Owns: originating hospital (tenant), uploader, upload timestamp, anonymization status, phase coverage (non-contrast / arterial / portal-venous / delayed), ingestion outcome, partial-coverage flag, PHI-contamination flag.
- **Series**: One acquisition within a Study (one phase of the 4-phase protocol). Owns: modality, phase label, slice count, image geometry.
- **Analysis**: One end-to-end run of the inference pipeline over a Study. Owns: status (queued / running / complete / failed / cancelled / partial-result), start + end timestamps, pipeline version, per-stage outcomes, confidence flags, atypical-anatomy flags, cold-start indicator, implausible-output reason, retry-of reference, cancelled-by reference.
- **Segmentation**: A labelled 3D mask produced by the pipeline. Subtypes: Parenchyma, Couinaud Segment I–VIII, Portal Vein, Hepatic Vein, Lesion. Owns: anatomic label, volume (mL), generation source (AI-original vs reviewer-edited), parent Analysis.
- **Lesion**: A detected focal liver lesion. Owns: parent Segmentation (mask), Couinaud location, longest diameter, suggested classification (or "abstained"), per-class confidence vector, discovery source (AI-detected vs reviewer-prompted).
- **Classification**: A per-lesion class assignment across {HCC, ICC, Metastasis, FNH, Hemangioma, Cyst, Abstained}, with confidence and model version.
- **FLRCalculation**: A resection-plane-parameterized remnant volume measurement. Owns: plane geometry, resected volume, remnant volume, remnant % of total functional liver, timestamp, author (AI-default vs surgeon-edited).
- **SurgeonReview**: The delta set of edits applied by a reviewer over an AI output. Owns: reviewer (reviewer-seat holder), edits (per mask / lesion), review start + finalize timestamps, finalization decision, addendum-review references.
- **Report**: A bundled export artifact (PDF / DICOM-SEG / DICOM-SR). Owns: parent Analysis + SurgeonReview, artifact type, RUO watermark marker, SOP Instance UID, per-destination PACS-push state (pending/sent/acknowledged/failed), supersedes-reference, superseded-by-reference, hash of contents.
- **AuditEvent**: A FHIR R4 AuditEvent representation of a single auditable action (inference run, DICOM transaction, PHI touch, authentication, RUO acceptance, permission check, erasure, etc.). Owns: actor, action type, subject (Study / Analysis / Report ID), timestamp, input / output hashes, tenant, permission checked, outcome, no PHI in body. Chain-hashed to the previous event in the tenant's audit stream to make tampering detectable.
- **User**: An authenticated clinician, admin, ops engineer, compliance reviewer, or DPO. Owns: role, tenant(s), MFA status, MFA last-challenged timestamp, RUO acceptance state, locale preference (en/de/ka), suspension state.
- **Tenant**: A design-partner hospital (Regensburg / Potsdam / Geo Hospitals in v1). Owns: PACS push destination (host, port, AE title, TLS cert fingerprint), data residency region, authorized user list, DPO contact, retention-policy overrides.
- **PermissionGrant**: A mapping of (Role → Permitted Action) per Tenant, realising the RBAC matrix in FR-037.
- **ModelBillOfMaterials**: Per-build auto-generated record naming every integrated model with pinned commit/tag, license text hash at build time, source URL, and approver.
- **RegulatoryClaimRegistry**: Per-claim regulatory-status record (RUO / under conformity assessment / cleared) used by FR-028b to assemble disclaimer scope dynamically.
- **ErasureRequest**: A GDPR Art. 17 request record owned by a Tenant and linked to a DPO. Owns: case reference, justification, execution timestamp, tombstone hash, confirmation PDF reference.
- **DemoCase**: A tenant-scoped pre-loaded sample case referencing synthetic fixture data; used by FR-042 and the onboarding sample step.
- **NotificationPreference**: Per-user opt-in/opt-out for non-critical notification categories.

---

## Non-Functional Requirements *(mandatory)*

### NFR-001 — Performance envelope

On a 25 Mbps hospital network, a 1 GB study MUST upload with a visible progress indicator without stalling the UI. The 3D view MUST render at ≥30 fps on a 2020-era clinical workstation and ≥20 fps on a mid-range tablet. Slice scroll and pan MUST respond within 100 ms of user input. The lesion list MUST paginate or virtualize beyond 50 entries. The resection-plane FLR readout MUST update at least twice per second during drag without blocking rendering. On connections slower than 5 Mbps the UI MUST warn the user before upload begins.

### NFR-002 — Accessibility (WCAG 2.1 AA)

All non-imaging UI surfaces MUST meet WCAG 2.1 AA. The 3D viewer and resection-plane controls MUST be fully keyboard-operable (rotation, zoom, layer toggle, plane position). The lesion list MUST expose row semantics and classification to screen readers. Segmentation overlays and the 8-Couinaud palette MUST remain distinguishable under deuteranopia, protanopia, and tritanopia (verified by simulation tooling). Every focusable control MUST show a visible focus indicator. The resection-plane slider MUST expose ARIA value, min, max, and orientation. Minimum tap target 44×44 px; minimum clinical text 16 px on mobile.

### NFR-003 — Internationalization (en / de / ka)

Every user-facing string in the web UI and exported PDF MUST be sourced from translation files in English, German, and Georgian. No hardcoded medical or UI strings are permitted. Medical terminology (HCC, ICC, FNH, hemangioma, cyst, metastasis, Couinaud segment labels, FLR, portal vein, hepatic vein, parenchyma) MUST be reviewed in German by a German-speaking HPB specialist and in Georgian by a Georgian-speaking HPB specialist before first pilot use. The PDF report MUST embed a Unicode font that renders Georgian Mkhedruli and German diacritics correctly. Russian localization is out of scope for v1.

### NFR-004 — Dark mode

All UI surfaces MUST support both light and dark themes. Segmentation overlay colors, Couinaud palette, lesion markers, resection-plane visualization, and overlay text MUST be verified for legibility and contrast in both themes. Theme preference MUST persist across sessions and MUST respect the operating-system preference when no explicit choice is set.

### NFR-005 — Mobile & touch responsiveness

Every clinical UI surface (upload, 3D viewer, slice views, lesion list, FLR panel, resection-plane control, report preview) MUST render and remain operable on a tablet-class device (portrait and landscape) and on a 390 px wide phone viewport. Touch interactions MUST cover: pinch-to-zoom, two-finger rotate of the 3D view, drag on the resection plane, tap-to-select on lesions.

### NFR-006 — Session, MFA, and step-up

Authenticated sessions MUST idle-lock after 15 minutes of inactivity and require re-authentication to resume. MFA enrolment MUST be required on first sign-in before any patient data is accessible; MFA challenges MUST be issued at every new device / location and at least once every 30 days on known devices. Privileged actions (finalize report, push to PACS, approve case deletion, execute erasure) MUST require fresh authentication within the last 5 minutes.

### NFR-007 — Observability with PHI scrubbing

System MUST emit structured operational telemetry covering queue depth, inference stage latency (p50/p95), GPU utilization, cold-start occurrences, error rates per pipeline stage, and per-tenant active-user counts, with no PHI in telemetry payloads. Client- and server-side error reports MUST be captured with automatic scrubbing of patient names, MRNs, DICOM study/patient identifiers, and free-text fields before transmission. An operator dashboard MUST visualize these signals in near real time during the pilot.

### NFR-008 — Cost containment (€800–€1,500 / month)

System MUST enforce: GPU inference nodes auto-shutdown after configurable idle period; a per-upload size cap to reject oversized studies before GPU work begins; intermediate inference tensors purged on a configurable TTL (default 7 days); spend monitoring with alerts at 70% and 90% of monthly budget; administrator override required to exceed the cap. Raw DICOM retention defaults to 90 days post-finalization; derived masks and reports 1 year; audit 6 years — per-tenant overrides supported.

### NFR-009 — Disaster recovery (RPO ≤ 1 h, RTO ≤ 8 h)

System MUST meet RPO ≤ 1 hour for reviewer edits, Analyses, Reports, and AuditEvents, and RTO ≤ 8 hours for full pilot-tier restoration. Backups MUST be taken at least hourly and stored in a second availability zone within the primary residency region. In-flight inference jobs MUST be recoverable after a worker restart by replay from persisted pipeline state rather than silently lost.

### NFR-010 — Data residency & retention

Primary residency AWS eu-central-1 (Frankfurt) for GDPR compliance. Non-DACH tenants MAY document a different residency per tenant. Audit logs retained minimum 6 years per HIPAA / local-longest. Per-record-class retention policy documented and configurable per tenant.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: End-to-end pipeline runs on a representative set of 20 Geo Hospitals liver CT scans with zero crashes over the pilot.
- **SC-002**: ≥95% of accepted studies return a completed analysis within 5 minutes of upload on warm infrastructure (excluding one-time cold-start warm-up).
- **SC-003**: FLR calculation falls within ±5% of expert manual volumetry on the 20-scan validation set.
- **SC-004**: HPB surgeon reviewers rate Couinaud segmentation as "surgically usable without re-segmentation" on ≥80% of the 20-scan review set.
- **SC-005**: Lesion detection achieves ≥78% sensitivity on lesions ≥10 mm across the validation set (abstention on low-confidence cases counts as a correct non-classification, not a miss).
- **SC-006**: Interactive refinement reduces median time-to-acceptable-mask by ≥50% compared to full manual re-segmentation on a matched case set.
- **SC-007**: Three Data Processing Agreements are signed (Regensburg, Potsdam, Geo Hospitals) and each site has at least one user account active with MFA enabled.
- **SC-008**: At least one real clinical case is documented as having been reviewed at a design-partner tumor board using output from the tool.
- **SC-009**: Every AI-derived output rendered in the UI, exported to PDF, or exported to DICOM carries a visible Research Use Only disclaimer — verified by compliance-reviewer audit of 20 random export artifacts with zero missing disclaimers.
- **SC-010**: Every inference run and every DICOM transaction in the pilot period is represented by a FHIR AuditEvent record containing input hash, model version, output hash, actor, and timestamp — verified by compliance-reviewer reconciliation against pipeline execution logs with zero gaps and a valid chain-of-hashes from the first event to the last.
- **SC-011**: A conference abstract describing the validation results is submitted to one of: ECR 2027, ESGAR 2026, IHPBA Singapore 2026.
- **SC-012**: The cost of running the design-partner pilot stays within the budgeted range of €800–€1,500 per month of active operation, verified monthly via the spend-alert thresholds in NFR-008.
- **SC-013 (demo)**: The team can record an uninterrupted 5-minute screen-capture showing Upload → 3D view → Segments → Lesions → Refinement → Finalize → PDF export, using only the pre-loaded demo case, with the RUO watermark visible at every step.
- **SC-014 (onboarding)**: A brand-new invited clinician can complete onboarding (password/SSO, MFA, RUO acceptance, tour, sample case) without engineering assistance in ≤15 minutes; at least 80% of design-partner users complete onboarding on their first invite link (measured anonymously via PostHog).
- **SC-015 (RBAC integrity)**: A permissions red-team exercise attempting each of 15 role-crossing actions (e.g., fellow finalize, admin view PHI, ops view PHI, clinician execute erasure) reports zero successful unauthorized actions.
- **SC-016 (GDPR response time)**: From DPO-initiated erasure to confirmation PDF ≤ 60 seconds; subsequent clinician searches for the erased case return "not found" (not "access denied") — verified on a test case before pilot go-live.

---

## End-to-End Test Scenarios *(derived from user stories)*

For every priority user story, a happy-path, failure-mode, and edge-case scenario is defined. These feed the `testing-pipeline` skill (see CLAUDE.md) and the manual validation checklists.

### US1 — Upload & FLR

- **Happy**: Surgeon uploads a valid 4-phase CT, sees 3D liver within 5 minutes, drags resection plane, reads FLR %.
- **Failure**: Surgeon uploads a study missing the portal-venous phase; a clear rejection is shown within 30 seconds, no cloud storage persists the study.
- **Edge**: Surgeon uploads during GPU cold start; a one-time warm-up indicator distinct from error is shown; subsequent upload meets the sub-5-minute target.

### US2 — Couinaud segments & vessels

- **Happy**: Surgeon activates segment layer and toggles each of the 8 Couinaud segments; all eight appear with correct volume readouts.
- **Failure**: Segmentation degrades on a cirrhotic liver; confidence flag and "surgical usability" warning are shown.
- **Edge**: Switching between 3D and axial/coronal/sagittal views keeps segment colours synchronized across views.

### US3 — Lesion detection & classification

- **Happy**: Surgeon opens lesion list, sees every detected lesion with classification and confidence score.
- **Failure**: AI confidence below threshold; lesion reads "Uncertain — radiologist review recommended" with no class name.
- **Edge**: Radiologist drops a marker on a missed lesion; one-prompt re-segmentation appends the lesion with "manually prompted" tag.

### US4 — Interactive refinement

- **Happy**: Surgeon clicks inside an under-segmented tumor; mask expands locally within 30 seconds.
- **Failure**: Refinement click in a region with no nearby structure is rejected with a clear message instead of freezing.
- **Edge**: Undo restores the original AI mask while keeping review-history timeline intact.

### US5 — Finalize & export

- **Happy**: Surgeon finalizes; PDF + DICOM-SEG + DICOM-SR produced, all three RUO-watermarked.
- **Failure**: PACS push fails on first attempt; retry succeeds on second attempt; both outcomes visible in activity log.
- **Edge**: Opening an older finalized Report clearly shows "Superseded by report [id]" banner.

### US6 — Admin onboarding

- **Happy**: Admin invites three clinicians, assigns roles, configures PACS destination, all saved and audited.
- **Failure**: PACS C-ECHO fails on save; config rejected with a PACS-technician-friendly error.
- **Edge**: Admin suspends a user; historical records remain intact and attributable under the suspended identity.

### US7 — First-time clinician onboarding

- **Happy**: New invitee completes password, MFA, RUO, tour, sample case in ≤15 minutes.
- **Failure**: Invitee closes browser mid-MFA; returning to the link resumes at the MFA step with prior steps preserved.
- **Edge**: Sample-case outputs cannot be pushed to real PACS destinations even if a destination is configured.

### US8 — Ops stuck-case recovery

- **Happy**: Ops engineer identifies a stuck case, re-queues it; the case completes successfully; AuditEvent chain is unbroken.
- **Failure**: Re-queue itself fails (inference service still down); engineer marks case "blocked — contact hospital"; notifications fire.
- **Edge**: Ops engineer opens a stuck case detail; no PHI is visible anywhere on the screen or in error payloads.

### US9 — GDPR erasure

- **Happy**: DPO executes erasure; confirmation PDF produced ≤60 s; clinician search returns "not found".
- **Failure**: A clinician attempts to open the erasure page; the UI blocks with "only DPO or admin may erase".
- **Edge**: Compliance reviewer inspects audit log after erasure; sees the erasure event; prior events for the case show hash-replaced identifiers.

### US10 — Compliance audit

- **Happy**: Reviewer generates an audit summary for a week-long window; chain-of-hashes validates; RUO spot-check of 20 artifacts passes.
- **Failure**: A tampered AuditEvent (simulated) breaks the chain; dashboard flags the break with the first invalid event.
- **Edge**: Reviewer toggles a claim from RUO to Cleared; next export's disclaimer narrows accordingly with no code release.

---

## Assumptions *(reasonable defaults carried from the canonical brief and constitution)*

- **Target users**: Primary — HPB surgeons (5–20 yrs experience, 50–200 hepatectomies/yr). Secondary — abdominal radiologists. Tertiary — clinical fellows / residents. **Additional roles introduced in this upgrade**: hospital admin, operations engineer, compliance reviewer, data protection officer (DPO).
- **Target hospitals (v1)**: Regensburg University Hospital (Prof. Schlitt), Ernst von Bergmann Potsdam (Prof. Beyer), Geo Hospitals Tbilisi (Dr. Gogichaishvili).
- **Regulatory framing**: v1 is Research Use Only. Not a medical device. CE MDR Class IIb submission is Phase 3 (24–30 months); v1 accumulates clinical evidence for that submission. Disclaimer lifecycle is per-claim (FR-028b) — not a single blanket.
- **Model stack**: Cascaded Apache-2.0 pretrained models are constitutionally mandated — Constitution Principle II. Specific models and orchestration are implementation concerns for `plan.md`. The build pipeline MUST emit a Model Bill of Materials per release (FR-038).
- **Data residency**: Primary AWS eu-central-1 (Frankfurt) for GDPR. Non-DACH deployments may document different residency per tenant.
- **Tenant model**: Single-tenant per hospital in v1. Multi-tenant isolation on shared infrastructure is out of v1 scope.
- **Authentication**: OAuth 2.0 / OIDC with MFA mandatory for all clinical / admin / ops / compliance / DPO roles (Constitution VII). Identity-provider choice (hospital SSO vs dedicated LiverRa IdP) is per-tenant.
- **Data ingestion**: Web drag-and-drop is the MVP default. Direct DIMSE C-STORE from hospital PACS is Phase 2.
- **Anonymization**: Header de-identification and burned-in pixel PHI stripping before data leaves the hospital network or is persisted in cloud storage. Post-upload PHI detection fallback (FR-002a) handles edge-case escapes.
- **Audit retention**: Minimum 6 years per HIPAA / local-longest (Constitution). Per-record-class retention (raw DICOM 90 d, derived 1 yr, audit 6 yr) — tenant-overridable.
- **Uptime target**: 95% during design-partner pilot. DR RPO ≤ 1 h, RTO ≤ 8 h (NFR-009).
- **Concurrency**: 1–3 simultaneous analyses on MVP hardware (single L4-class GPU). Horizontal scale-out deferred.
- **Localization**: en / de / ka maintained per Constitution X. Russian is NOT supported in v1. Medical terminology reviewed by native-speaker HPB specialists before pilot (NFR-003).
- **Design system**: Unified LiverRa design system ported from MediMind per Constitution IX. All UI work MUST go through the `frontend-designer` agent per CLAUDE.md (see Dependencies below).
- **Modality-agnostic entities**: Study, Analysis, Segmentation, and Report entities MUST be modelled modality-agnostically so that Phase 2 MRI support, biliary tree masks, and ALPPS staging can be added without retroactive schema migration. Reports MUST be representable as a future FHIR DiagnosticReport without content loss — the report schema MUST accommodate references to Observations authored in Phase 2.
- **Budget**: Pilot cost target €800–€1,500 / month enforced via NFR-008 controls.

---

## Out of Scope for v1 *(explicit exclusions carried from canonical brief)*

- MRI modality (including HCC gadoxetic-acid MRI).
- Biliary tree segmentation (requires MRCP).
- Hepatic artery segmentation (research-grade quality).
- Multi-tenant isolation on shared infrastructure.
- Full HIPAA / GDPR-grade audit logging beyond what FR-029/030 + NFR-007/010 require (v1 uses basic but sufficient logging).
- Auto-classification of LI-RADS categories (decision support only).
- FDA 510(k) submission artifacts (pathway documented for planning; actual submission is Phase 3).
- Custom model training or fine-tuning (zero-training MVP is the defining constraint).
- Mobile-native app (responsive web only).
- EHR integration beyond FHIR basics.
- ALPPS multi-stage resection planning.
- Living-donor recipient matching.
- Pre-operative chemotherapy "vanishing metastases" handling.
- Russian localization (v1 supports en/de/ka only).
- Horizontal scale-out beyond 1–3 concurrent analyses.

---

## Dependencies

- **Constitution**: `.specify/memory/constitution.md` v2.0.0 — all ten principles apply, with Principles I, II, III, V, VI as hard gates. Principle IX dark-mode/design-system compliance extends to every surface in this spec via NFR-004. Principle X i18n coverage is operationalized in NFR-003.
- **Design-partner agreements**: Signed Data Processing Agreements with Regensburg, Potsdam, Geo Hospitals are prerequisites for any real-patient data flow (SC-007).
- **Named DPO contacts**: Each design-partner tenant MUST designate a Data Protection Officer contact before go-live — required for FR-002a incident notifications and FR-040 erasure execution.
- **Native-speaker medical reviewers**: A German-speaking HPB specialist and a Georgian-speaking HPB specialist MUST review medical terminology translations before pilot — required for NFR-003.
- **Validation dataset**: A curated 20-scan set from Geo Hospitals, phase-labelled, de-identified, with expert manual FLR and segment ground truth — required to verify SC-003, SC-004, SC-005.
- **Reusable MediMind assets**: The MediMind → LiverRa asset map in `CLAUDE.md` identifies porting candidates (Cornerstone3D init, DICOM viewer skeleton, DICOMweb client, DICOM-SR service, annotation service, audit service, theme CSS, translation system, EMR component library, Orthanc / nginx stack). Per-component porting decisions happen in `plan.md` and `tasks.md`.
- **`frontend-designer` agent (MANDATORY)**: All UI work produced under this spec — routes, menus, modals, forms, the 3D viewer chrome, the upload surface, the reports screen, admin screens, onboarding wizard, compliance dashboard, ops dashboard — MUST be implemented via the `frontend-designer` agent per CLAUDE.md. Any UI code added to `packages/app/src/` outside of a `frontend-designer` invocation constitutes a constitutional violation and MUST be rejected at review. Note: `packages/app/src/` currently contains only a stub `main.tsx`; route registration, main-menu integration, and the role-scoped submenu structure MUST be created in v1 implementation (no equivalent exists in the repo yet).
- **External research dependencies**: Published benchmarks in `docs/research/04-ml-feasibility.md` set the expected accuracy bands for SC-003 through SC-005.

---

## Clarifications Needed

None at spec level. All open questions are implementation-level and belong in `plan.md` / `research.md` (examples: exact phase-detection algorithm, viewer customization scope, model loading strategy, lesion abstention threshold calibration, screenshot-interception approach for the RUO burn-in requirement, chain-of-hashes algorithm choice for AuditEvent tamper-evidence, GDPR erasure crypto-shred approach, PACS C-ECHO client choice).
