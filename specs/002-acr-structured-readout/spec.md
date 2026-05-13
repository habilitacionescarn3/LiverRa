# Feature Specification: Structured ACR-Style Radiologic Readout

<!-- UPGRADED -->

**Feature Branch**: `002-acr-structured-readout`
**Created**: 2026-05-13
**Status**: Draft (Upgraded)
**Input**: User description: "Structured ACR-style radiologic readout — re-group the seven existing Phase 1 findings (hu_stats, steatosis, spleen, gallbladder, calcified_lesions, simple_biliary_cysts, indeterminate_malignant) into six anatomical sections (Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment) matching ACR and RSNA dictation templates. Provide a copy-to-clipboard plain-text rendering that drops cleanly into a radiologist PACS dictation system. Mirror the same anatomical grouping in the PDF report. Audit-log clipboard copy events for compliance traceability."

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Radiologist drops the AI readout into their PACS dictation (Priority: P1)

A board-certified abdominal radiologist finishes reviewing a LiverRa analysis on a CT abdomen with contrast. Instead of mentally rearranging the AI's scattered findings into the anatomical structure their dictation template expects, they see a single panel already organized into ACR/RSNA sections: **Liver → Lesions → Vessels → Gallbladder → Spleen → FLR Assessment**. Each section reads like a draft of their own report. They click "Copy to Clipboard," paste into their PACS dictation field, edit two sentences, and sign the report.

**Why this priority**: This is the single highest-leverage workflow change. Radiologists copy-paste dozens of reports per day. If the AI output drops cleanly into their existing dictation workflow, they evangelize the platform internally; if not, they bypass it. Without this story, none of the other features matter because nobody opens the platform a second time.

**Independent Test**: Open any finalized analysis with at least one lesion. The structured readout panel renders with all six sections in the correct anatomical order. The "Copy to Clipboard" action produces plain text that, when pasted into a text editor, reads as a coherent radiology report (no UI chrome, no JSON artifacts, no HTML tags). Delivers full value standalone — the radiologist can use the platform purely as a structured-report generator.

**Acceptance Scenarios**:

1. **Given** a finalized analysis with all seven Phase 1 findings computed, **When** the radiologist opens the analysis detail view, **Then** the structured readout panel renders six anatomical sections in fixed order (Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment) regardless of the order findings were computed in.
2. **Given** the structured readout panel is visible, **When** the radiologist clicks "Copy to Clipboard," **Then** plain-text content matching the on-screen structure (with hierarchical headers, no markup) is placed on the system clipboard within 200ms and a transient confirmation toast appears.
3. **Given** a finding has a degraded-quality warning (e.g., spleen voxel count below threshold), **When** that finding renders inside its anatomical section, **Then** the warning text is visible inline AND included in the copied plain-text output so the radiologist cannot accidentally dictate a degraded measurement as if it were reliable.
4. **Given** an analysis is missing one or more findings (e.g., the cascade ran but `calcified_lesions` returned no candidates), **When** the readout renders, **Then** the corresponding anatomical section either omits that line gracefully or shows a neutral "no findings" placeholder — never a broken row or empty bracket.
5. **Given** an analysis is in queued or running status (cascade not yet complete), **When** the radiologist opens the analysis detail view, **Then** the readout panel renders all six section headers with a "computing — results will appear when the cascade completes" status line per section, and the Copy to Clipboard action is not available.

---

### User Story 2 — HPB surgeon scans the readout for the three numbers that drive surgical decisions (Priority: P1)

A hepatobiliary surgeon preparing for an MDT (multidisciplinary tumor board) opens the analysis. They do not read line-by-line — they scan for three numbers: **FLR percentage**, **lesion size + LI-RADS interpretation**, and **steatosis grade**. The structured readout puts these in fixed, predictable positions so the surgeon's eye finds them in under five seconds without scrolling.

**Why this priority**: Surgical decision-making is fundamentally different from radiology reading. Surgeons want a one-page summary, not a narrative. Putting the three highest-stakes data points in anatomically logical positions is what makes the platform usable in a live MDT discussion.

**Independent Test**: A surgeon (or proxy stakeholder) reviews three different finalized analyses. For each one, they locate FLR %, primary lesion size + class, and steatosis grade within 5 seconds without scrolling on a standard 13" laptop screen. Delivers value standalone — even without copy-to-clipboard, the surgeon gets a structured at-a-glance view.

**Acceptance Scenarios**:

1. **Given** an analysis with one or more lesions and an FLR plan, **When** a surgeon views the readout on a standard 13" laptop screen, **Then** FLR percentage with its safety-classification (low/borderline/adequate), primary lesion size and class, and steatosis grade are all visible in the initial viewport without scrolling.
2. **Given** the readout, **When** the surgeon scans the Lesions section, **Then** each lesion's anatomical segment (Couinaud I–VIII), size in mm, and classifier interpretation render on a single line that reads as a coherent clinical phrase.
3. **Given** an analysis with an FLR plan but zero lesions (e.g., pre-donor evaluation), **When** the surgeon opens the readout, **Then** the Lesions section renders with a "No lesions detected" neutral line and the FLR Assessment section renders normally; the same content appears identically in the clipboard text.

---

### User Story 3 — PDF export mirrors the on-screen structure (Priority: P2)

A surgeon needs to forward the analysis to an external referrer who does not have LiverRa access. They generate the PDF report. The PDF organizes findings using the same anatomical sections in the same order as the on-screen readout, so the recipient does not need a key to interpret it.

**Why this priority**: PDF is the universal interchange format for clinical communication today. Without PDF mirroring, the on-screen and offline experiences diverge, which erodes trust and forces the team to maintain two mental models.

**Independent Test**: Generate a PDF from a finalized analysis. Compare the heuristic-findings section of the PDF against the on-screen readout. Both must use the same six anatomical sections in the same order, with the same field labels and the same handling of degraded-quality warnings.

**Acceptance Scenarios**:

1. **Given** a finalized analysis, **When** the PDF report is rendered, **Then** the heuristic-findings section uses the same six anatomical sections in the same order as the on-screen readout.
2. **Given** a finding has a degraded-quality warning, **When** the PDF renders that finding, **Then** the warning appears with visual emphasis (e.g., a styled callout) in the PDF — not silently omitted.
3. **Given** the user prints the analysis detail view directly from the browser, **When** the print preview renders, **Then** only the structured readout in its six-section anatomical order appears, with case identifiers at the top and the Research Use Only disclaimer at the bottom; viewer chrome, rails, navigation, and imaging canvas are suppressed in print media.

---

### User Story 4 — Compliance officer audits every clipboard export (Priority: P2)

A compliance officer preparing for a CE MDR audit needs to demonstrate that every export of AI-generated clinical text from the platform is traceable to a specific user, analysis, and timestamp. They open the audit trail and see one entry per copy-to-clipboard event, with the same tamper-evident chain that already protects analysis-level events.

**Why this priority**: CE MDR Class IIb compliance requires auditability of clinical-decision-relevant data flows. Copying AI-generated text into a hospital's authoritative record system is exactly such a flow. Without this audit trail, the feature is non-shippable in regulated markets even if the UX is perfect.

**Independent Test**: Trigger five copy-to-clipboard events from three different analyses across two user accounts. Query the audit trail and confirm five distinct entries appear, each with correct user, analysis, and timestamp, and each linked to the existing tamper-evident chain.

**Acceptance Scenarios**:

1. **Given** an authenticated user clicks "Copy to Clipboard," **When** the copy succeeds, **Then** an audit event is recorded with the user identity, the user's role on the analysis as resolved at the moment of the action, analysis identifier, locale of the copied text, and timestamp, and the event participates in the existing tamper-evident chain.
2. **Given** a user with view-only access clicks Copy, **When** the action is invoked, **Then** the copy still completes and is audit-logged with the actor's view-only role captured at action time — the platform deliberately prefers traceability of every export over preventing exports a determined user could perform via text selection anyway.
3. **Given** a clipboard write succeeds but the audit-event server acknowledgement fails or times out, **When** the failure is detected, **Then** the user sees a clear warning that the text is on their clipboard but the export was not auditable, the audit event is queued for durable retry preserving the original action timestamp, and the copy-success toast is withheld until either acknowledgement arrives or the warning is shown.

---

### User Story 5 — Resident, MDT coordinator, and referring physician export the readout (Priority: P2)

A radiology resident drafts a report under attending supervision; an MDT coordinator populates a tumor-board slide deck; a referring physician with read-only share-link access prepares a phone briefing for the patient. All three roles need the structured readout as plain text, and the audit trail must distinguish their exports from attending exports during compliance reconciliation.

**Why this priority**: These roles drive day-to-day clinical adoption volume. Limiting copy to attending radiologists alone would underutilize the platform and force these users to either screenshot the panel (no audit trail) or transcribe by hand (introduces errors). The regulatory preference is traceability of every export over preventing exports.

**Independent Test**: Three users — one resident, one MDT coordinator, one referring physician — each open the same completed analysis and click Copy. Three distinct audit events appear, each carrying the actor's role-at-action-time, and each clipboard text is byte-identical (same locale).

**Acceptance Scenarios**:

1. **Given** an authenticated resident, MDT coordinator, or referring physician viewing an analysis they have legitimate access to, **When** they click Copy, **Then** the copy completes and an audit event is recorded carrying their role exactly as it existed at the moment of the click.
2. **Given** a compliance officer running a date-ranged audit export, **When** they review the records, **Then** every export action by every role is present in the export, distinguishable by the role field, with zero missing or merged records.

---

### Edge Cases

- **No lesions detected**: Lesions section renders a single line "No lesions detected" rather than an empty section with awkward whitespace. Copy-to-clipboard output includes the same explicit statement.
- **Spleen mask too small (<500 voxels)**: Spleen section renders the volume value AND a visible warning that this measurement is degraded. Both surface in screen, PDF, and clipboard text.
- **All findings missing for a section** (e.g., gallbladder seg failed entirely): Section renders with a single neutral "Not assessed" line; section header still appears so the reader knows the structure was attempted.
- **All seven findings absent or cascade not yet run**: All six section headers render in the fixed order, each followed by an explicit cause-naming status line — "Awaiting analysis," "No findings detected," or "Computation unavailable." Copy remains enabled in this state and emits the same neutral status lines verbatim. PDF behaves identically. The audit event is recorded normally.
- **Stale findings** (any finding's compute time predates the most recent successful cascade run for the same analysis): A visible "Last computed [time]" marker is shown on screen, in the PDF, and in the clipboard text. Locale-aware. No stale finding may render without its marker on any surface.
- **Partial finding payload** (a finding has its `warning` string but no `volume_ml`; a finding has measurements but no per-item list; a per-lesion entry has identifiers but no metrics): Every field that is present renders together with any warning text; each missing field renders as an explicit "Not available" marker rather than being omitted. The same partial-payload rendering appears identically on screen, in PDF, and in clipboard text. No measurement value renders without its associated warning; no warning renders without an identifying field label.
- **Locale switch mid-view**: The panel re-renders in the new locale without losing scroll position; a subsequent clipboard copy uses the new locale. Locale at the moment of the Copy click — not at the moment the audit event persists — is what the audit records.
- **Unsupported locale (e.g., a French user agent)**: The platform falls back to English for rendering and records "en" (the fallback locale actually used) in the audit event, never the unsupported requested locale.
- **Translation gap**: If a section header or field label is missing in the active locale, fall back to English silently rather than rendering a raw translation key or breaking layout.
- **Concurrent finalize** (another user finalizes mid-view): The panel visibly indicates newer data is available and requires an explicit user refresh before the next Copy is enabled. A Copy that succeeded before the concurrent-finalize signal is recorded as-is. A copy attempt that races with a concurrent finalize must resolve to the post-mutation state or be blocked; it must not silently emit pre-mutation text.
- **Long-open panel** (user opens the readout, leaves the tab idle for ≥30 minutes, then copies): The system verifies the analysis state against the authoritative source before emitting clipboard text. If the state has changed since panel open, the copy is blocked until the user explicitly refreshes, with a message naming what changed.
- **Authorization revoked mid-session**: A copy attempt after revocation fails server-side, produces an audit event recording the denied attempt with the user's then-current (revoked) role, and surfaces a non-technical "please refresh" error message.
- **Clipboard API blocked by browser permission**: The user sees a recoverable, locale-aware error message and a retry affordance. No silent failure.
- **Report-summary fetch fails or returns malformed data**: The panel surfaces a clearly worded error state in the active locale, naming the failure category at a clinician-appropriate level, and offers a retry. Copy is disabled; disabled-state clicks emit no audit events. Section headers are never rendered with no underlying data fetch attempted.
- **PDF generation timeout or failure**: User sees a clear error in the active locale, retry is offered, and no partial/empty PDF is served. The failed attempt is itself audit-logged in the same chain as a failed export so attempted-but-failed clinical-data exports remain traceable.
- **Very long lesion lists (>20)**: The clipboard text contains every lesion regardless of count, with no implicit cap and no silent truncation. The 200ms copy budget may relax beyond 20 lesions but must complete within a clinically acceptable interval. On-screen list remains scannable through a scrollable or progressively expandable affordance.
- **Unicode and Georgian combining diacritics in clinical labels**: Clipboard text is emitted in a normalized unicode form so Georgian diacritics, accented segment labels, and other non-ASCII content paste identically into downstream systems. Segment labels render as authored — no character substitution or stripping.
- **Single-segment liver or fewer than eight Couinaud segments**: FLR Assessment section names the segments actually used in the calculation rather than implying a standard eight-segment topology.

## Requirements *(mandatory)*

### Functional Requirements

#### Section structure and ordering

- **FR-001**: The system MUST present heuristic findings on the analysis detail view in six fixed anatomical sections in this exact order: Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment.
- **FR-002**: The system MUST place each existing Phase 1 finding into the correct anatomical section: `hu_stats` and `steatosis` under Liver; `calcified_lesions`, `simple_biliary_cysts`, and `indeterminate_malignant` under Lesions; `gallbladder` under Gallbladder; `spleen` under Spleen; FLR results under FLR Assessment. The Vessels section MUST exist in the layout even when no vessel-level findings are computed yet, so future vessel findings have a stable home.
- **FR-003**: The system MUST render the readout in the same six-section order regardless of which findings actually exist or the order in which they were persisted.
- **FR-004**: When a section has no available findings, the system MUST render the section header with a neutral status line (e.g., "No findings to report" or "Not assessed"), never a broken row, raw null value, or empty bracket.

#### Field-level rendering

- **FR-005**: Each rendered finding MUST display field labels in clinical language (e.g., "Volume," "Wall thickness," "Attenuation"), not the raw payload key names.
- **FR-006**: Each rendered finding MUST display values with units (e.g., "1,828 mL," "0.7 mm," "48 HU") consistent across screen, PDF, and clipboard outputs.
- **FR-007**: When a finding payload includes a `warning` string or equivalent degraded-quality marker, the system MUST render that warning visibly adjacent to the affected value AND include it in the clipboard text — never hide it.
- **FR-008**: When a finding includes a per-item list (e.g., per-lesion calcification rows), the system MUST render the count plus each item's identifying label on its own line in both the screen view and the clipboard output.
- **FR-009a**: When a finding payload is structurally partial (missing one or more expected fields for its anatomical section), the system MUST render every field that is present together with any warning text, MUST replace each missing field with an explicit "Not available" marker rather than omitting the field or omitting the row, and MUST never render a measurement value without its associated warning or a warning without an identifying field label.

#### Copy-to-clipboard behavior

- **FR-009**: The structured readout panel MUST provide a "Copy to Clipboard" action visible without scrolling on a standard 13" laptop screen.
- **FR-010**: The copied content MUST be plain text (no HTML, no markdown formatting characters surfacing as literal asterisks or backticks, no UI chrome) and MUST preserve the same six-section structure and ordering as the on-screen view.
- **FR-011**: The copied content MUST be ready to paste into a typical PACS dictation field — section headers as ALL-CAPS or distinct lines, indented sub-items, blank-line separation between sections.
- **FR-012**: The system MUST surface a transient on-screen confirmation when the copy succeeds and a recoverable error message when the browser blocks clipboard access.
- **FR-013**: The clipboard text MUST be rendered in the locale that was active at the moment the user clicked Copy — not at the moment the audit event persists or the moment the toast renders. If the active locale at click time is missing a translation for a field, the system MUST fall back to English for that field silently rather than render a raw key.
- **FR-013a**: Clipboard text MUST be emitted in a normalized unicode form so Georgian combining diacritics, accented characters in segment labels, and other non-ASCII content paste identically into downstream systems. The clipboard text MUST NEVER silently truncate, regardless of lesion count or total length.

#### PDF mirroring

- **FR-014**: The PDF report MUST organize heuristic findings into the same six anatomical sections in the same order as the on-screen readout.
- **FR-015**: The PDF MUST preserve every degraded-quality warning visibly within its section, using visual emphasis appropriate for a clinical document.
- **FR-016**: When a section has no findings, the PDF MUST behave the same way as the on-screen view — section header present with a neutral status line.

#### Audit logging

- **FR-017**: Every successful copy-to-clipboard action MUST record an audit event containing: actor identity, actor's role on the analysis as resolved at the moment of the action, analysis identifier, the locale of the copied text, and an event timestamp. The role MUST be captured at action time; subsequent role changes MUST NOT alter the recorded role on prior events. If role cannot be resolved at action time, an explicit "role unresolved" marker MUST be recorded rather than the event being suppressed.
- **FR-018**: The audit event MUST participate in the existing tamper-evident audit chain used for other analysis-level events, with the same append-only and integrity guarantees.
- **FR-019**: The audit event MUST be queryable through the same operator-facing audit surface as other clinical-export events, so a compliance officer can produce a full history of AI-text exports for a given analysis or a given user over a given time range.
- **FR-020**: The system MUST NOT record the copied text content itself in the audit event payload — only the metadata listed in FR-017 — to keep the audit log free of patient-data duplication while preserving traceability of the action.
- **FR-020a**: The system MUST treat the audit-event emission as an integral part of the copy action. If audit emission fails or its acknowledgement does not arrive within a bounded interval, the system MUST surface a clearly worded warning that the text is on the clipboard but the export was not auditable, and MUST queue the audit event for durable retry preserving the original action timestamp. The success toast MUST be withheld until either acknowledgement arrives or the warning is shown.
- **FR-020b**: If the user navigates away or closes the tab before an audit event reaches the server, the client MUST retry the audit emission opportunistically on the next session. An unrecorded copy MUST surface as a reconciliation discrepancy rather than be silently lost.
- **FR-020c**: A failed PDF generation attempt MUST itself be audit-logged in the same chain as a failed export, with the same actor/analysis/locale/timestamp metadata, so attempted-but-failed clinical-data exports remain traceable.

#### Authorization

- **FR-021**: Any authenticated user who can view the analysis detail page MUST be able to see the structured readout panel.
- **FR-022**: The "Copy to Clipboard" action MUST be available to every authenticated user who can view the analysis detail page, regardless of finalize or review permission, including residents, MDT coordinators, and referring physicians. The platform's design choice favors complete traceability of every export over preventing exports a determined user could perform via DOM text selection. Every invocation MUST be audit-logged with the actor's role as captured at action time.
- **FR-022a**: Unauthenticated or session-expired copy attempts MUST fail closed at the authorization boundary and the denied attempt MUST itself be audit-logged.
- **FR-022b**: The structured readout panel and its copy action MUST inherit the tenant authorization boundary of the underlying analysis. Cross-tenant access attempts MUST fail closed and MUST be audit-logged as a security event.
- **FR-022c**: If a user's authorization to view the analysis is revoked between the analysis detail view loading and a copy attempt, the next copy attempt MUST fail server-side, MUST produce an audit event recording the denied attempt with the user's then-current (revoked) role, and MUST surface a non-technical "please refresh" message.

#### Concurrency and freshness

- **FR-023a**: The clipboard text MUST reflect the analysis state as of the moment the copy action is invoked, not the moment the panel was opened. If the system has detected a server-side change since the panel was rendered, the copy action MUST be blocked until the user explicitly refreshes, and the blocking message MUST name what changed.
- **FR-023b**: If the readout panel has been open without interaction for longer than a clinically meaningful interval, the next copy action MUST verify the analysis state against the authoritative source before emitting clipboard text. If state has changed, the copy MUST be blocked pending explicit refresh.
- **FR-023c**: Stale findings (a finding's compute time predating the most recent successful cascade run for the same analysis) MUST display a visible, locale-aware "Last computed [time]" marker on screen, in the PDF, and in the clipboard text.

#### Cross-channel parity

- **FR-024a**: For any given analysis state and any given locale, the section headers, field labels, value formatting (number separators, units), neutral-status lines, and degraded-quality warnings MUST be textually identical across the on-screen readout, the PDF report, and the clipboard plain-text output. A change in the active translation set MUST propagate to all three surfaces before any of them next renders; under no circumstance may the PDF render with a stale translation while the screen reflects a newer one.
- **FR-024b**: Anatomical-section grouping is a single canonical mapping defined once and shared between the screen renderer, the PDF renderer, and the clipboard plain-text renderer. Adding a new finding type in the future MUST require changing one place to assign its anatomical section, with all three output channels picking up the change automatically.

#### Research Use Only disclaimer

- **FR-027**: Every rendered surface of the structured readout — on-screen panel, clipboard plain-text output, and PDF section — MUST include a clearly visible "Research Use Only — not for primary diagnostic decision-making" disclaimer in the active locale. In the clipboard output the disclaimer MUST appear as the first line AND again as the last line so that any partial paste still carries it. The disclaimer MUST remain in place until the platform receives CE MDR clearance, at which point removal requires a constitution-level amendment.

#### Internationalization

- **FR-023**: All section headers, field labels, units, neutral-status lines, warnings, and the Research Use Only disclaimer MUST be available in English, Russian, and Georgian. Russian and Georgian medical terminology MUST be authored in pending-translation form and MUST NOT ship to production until reviewed and approved by the medical-terminology code owners. English is the source of truth; missing translations MUST fall back to English silently. The German locale is retained for legacy DACH bundles but is not required for this feature's first release; if added later it follows the same medical-review gate.
- **FR-023d**: All ACR readout strings (section headers, field labels, units, neutral-status lines, the Copy button label, the success toast, the error toast, the per-section "computing" placeholder) MUST live under a single new translation namespace dedicated to this feature, registered as supported in en, ru, and ka. When the user changes locale, the panel MUST re-render in the new locale immediately, without page reload, and MUST preserve current scroll position.
- **FR-024**: The system MUST never render a raw translation key on screen, in PDF, or in clipboard text under any locale condition.

#### PHI scope

- **FR-034**: The clipboard text and the PDF readout section MUST contain only clinical findings, units, warnings, and the Research Use Only disclaimer. They MUST NOT contain direct patient identifiers (name, MRN, date of birth, address). Identifying context belongs to the surrounding PACS record or the PDF header rendered by the existing patient-banner component, not to the findings section produced by this feature.

#### Pre-completion behavior

- **FR-040**: While an analysis is queued or running, the structured readout MUST render its six section headers with a "computing — results will appear when the cascade completes" status line per section in the active locale, and MUST NOT expose the Copy to Clipboard action. When the cascade transitions to completed or partial, the panel MUST swap to live content without a full page reload.

#### Failure-mode behavior

- **FR-033**: When the report summary fails to load or is malformed, the readout panel MUST surface a non-blocking, locale-aware error state with a retry affordance and MUST NOT render partial sections that could be mistaken for "no findings." When the user is offline, the Copy action MUST remain functional against the last-loaded data AND MUST mark that data as potentially stale in the clipboard output. When PDF generation exceeds a reasonable rendering budget, the system MUST show an in-progress state with the option to cancel; failed PDF generation MUST surface a clear error and MUST NOT silently produce a partial document.

### Non-Functional Requirements

#### Performance and reliability

- **FR-025**: The structured readout MUST render within 500 milliseconds of the analysis detail data being available on a typical clinician laptop.
- **FR-026**: The copy-to-clipboard action MUST complete within 200 milliseconds for analyses with up to twenty lesions and within 1 second for analyses with up to one hundred lesions. The clipboard output MUST never silently truncate, regardless of lesion count. On-screen, lesion lists exceeding twenty entries MUST remain scannable through a scrollable or progressively expandable affordance without losing the section's overall scroll anchor.

#### Accessibility

- **FR-031**: The structured readout MUST meet WCAG 2.1 AA accessibility criteria. Specifically: the Copy action MUST be reachable and operable by keyboard alone; copy success and failure MUST be announced to assistive technologies via a polite live region; degraded-quality warnings MUST convey their warning state through both color AND a non-color indicator (icon or textual label); section headers MUST form a logical heading hierarchy nested under the analysis page heading; all interactive targets MUST meet minimum 44×44 px hit area on touch devices; text contrast on warning callouts MUST meet AA contrast ratios in both light and dark themes.

#### Theming and design-system compliance

- **FR-032**: The structured readout MUST render correctly in both light and dark color schemes with no loss of legibility for warnings, section headers, or values. The feature MUST use only the project's semantic color variables and the standard EMR component library (modal, button, card primitives); ad-hoc hex colors, ad-hoc button styling, and ad-hoc modals are forbidden. Degraded-quality warning visual emphasis MUST remain clearly perceptible in both color schemes.

#### Mobile and tablet responsiveness

- **FR-035**: The structured readout MUST render legibly and remain fully interactive across the platform's standard responsive breakpoints, including tablet widths. On viewports below the tablet breakpoint, the readout MUST be reachable via a single-tap action from the analysis detail view (e.g., a workspace-rail bottom-sheet entry) with the same six-section structure and the same Copy action. Clipboard write MUST function on iOS and iPadOS browsers within the same 200ms target. Touch targets MUST meet minimum 44×44 px on touch devices.

#### FHIR audit shape

- **FR-030**: The clipboard-export audit event MUST be representable as a FHIR R4 AuditEvent resource with type "export," a project-defined subtype identifying it as a structured-readout clipboard export, an agent reference to the actor, an entity reference to the analysis, and an extension carrying the active locale. Extension URLs MUST follow the project's established `http://liverra.ai/fhir/StructureDefinition/` convention.

#### Audit retention

- **FR-028**: Clipboard-export audit events MUST be retained for a minimum of ten years from the date of recording, consistent with CE MDR Class IIb post-market surveillance obligations, and MUST NOT be deletable through any user-facing or operator-facing path. The audit surface MUST support exporting a date-ranged subset of events in a structured, machine-readable format suitable for delivery to an external auditor.

#### Telemetry

- **FR-036**: The system MUST emit non-PHI product-analytics events for: readout panel viewed, copy-to-clipboard succeeded, copy-to-clipboard failed (with failure category), and PDF readout-section rendered. Events MUST NOT include user identifiers, patient identifiers, or copied content; they MUST include analysis identifier, locale, and timing data sufficient to evaluate the spec's measurable success criteria.

#### Discoverability

- **FR-041**: On the first time a given user opens any completed analysis after this feature ships, the structured readout panel MUST be visually prominent (default-expanded, not behind a collapsed rail, with a transient one-time tooltip indicating Copy to Clipboard) so a radiologist discovers the workflow without training. The tooltip MUST be dismissible and MUST NOT reappear on subsequent visits for that user.

#### Test evidence

- **FR-038**: Release of the structured readout MUST be backed by automated test evidence covering: (a) locale-snapshot tests for all six sections across English, Russian, and Georgian; (b) an integration test proving every successful clipboard copy produces exactly one audit event with correct metadata; (c) an accessibility test exercising keyboard-only operation of the Copy action and live-region announcement; (d) a cross-channel parity test asserting that the on-screen readout, clipboard text, and PDF section share identical section ordering and identical handling of degraded-quality warnings.

### Key Entities *(include if feature involves data)*

- **Anatomical Section**: A fixed UI grouping (one of six: Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment) that contains zero or more findings. Stable order. Not persisted — it is a rendering concept, not a data record.
- **Anatomical-Section Mapping**: A single canonical mapping from finding type to anatomical section, shared across the screen renderer, PDF renderer, and clipboard plain-text renderer. Adding a new finding type later requires changing this one mapping; all three output channels propagate automatically.
- **Finding (existing)**: A persisted analysis-level computation result keyed by an analysis identifier and a finding-type label. This feature adds no new finding types; it only re-groups existing ones for display.
- **Clipboard Export Event**: A new kind of audit event recording that a user copied the structured readout from a specific analysis at a specific time in a specific locale, carrying the actor's role at action time. Representable as a FHIR R4 AuditEvent resource. Participates in the existing tamper-evident audit chain. Retained for at least ten years.
- **Readout Plain-Text Renderer**: A pure transformation function (no side effects beyond clipboard write and audit emission) that maps a finding-set plus locale to a plain-text string. Same transformation is used by the on-screen copy action and is the conceptual contract for the PDF section's structure.

## UI Integration

- **Placement on the analysis detail view**: The structured readout MUST appear in two surfaces: (a) on the analysis detail view, as a dedicated panel reachable in one click from the case workspace without entering theater mode; (b) on the inline report view, as the heuristic-findings section. On the analysis detail view the panel MUST be visible by default for completed analyses and MUST NOT be hidden when theater mode toggles other rails, because copy-to-clipboard is a primary radiologist action.
- **Disposition of the existing flat findings card**: The new structured readout REPLACES the existing flat heuristic-findings card on both the analysis detail view and the inline report view. After this feature ships, only one rendering of Phase 1 findings exists in the product, and it is the six-section ACR-grouped form. The old flat layout is removed in the same release to prevent drift.
- **Locale re-render trigger**: When the user changes locale, the readout MUST re-render in the new locale without a page reload and MUST preserve current scroll position.
- **Print stylesheet**: When the analysis detail view is printed directly from the browser, the printed output MUST present only the structured readout in its six-section anatomical order with case identifiers at the top and the RUO disclaimer at the bottom; viewer chrome, rails, navigation, and DICOM canvas MUST be suppressed in print media.

## Testing Scenarios

These scenarios formalize the user-story acceptance criteria into discrete tests a QA engineer or automation agent can execute.

1. **Six-section order**: Given a completed analysis with all seven findings, when the user opens the detail view, the readout MUST present sections in this exact DOM order: Liver, Lesions, Vessels, Gallbladder, Spleen, FLR Assessment — verified by reading the section headers in document order.
2. **Copy produces clean plain text**: Given the panel rendered, when the user clicks Copy, the clipboard MUST contain plain text starting with the localized RUO disclaimer line, MUST NOT contain `<`, `>`, `{`, `}`, `*`, or backtick characters, MUST contain blank-line separators between sections, and MUST end with the RUO disclaimer line.
3. **Copy fires exactly one audit event per click**: Given the panel rendered, when the user clicks Copy once, the backend MUST receive exactly one audit event referencing this analysis, this user, and this user's role-at-click within five seconds; clicking Copy three times MUST produce three audit events.
4. **Locale-at-click is captured**: Given the panel rendered in English, when the user clicks Copy then immediately switches to Russian, the audit event for that copy MUST record locale = "en"; the clipboard text MUST also be in English.
5. **Unsupported-locale fallback recorded as `en`**: Given a user-agent claiming an unsupported locale (e.g., `fr`), when the user clicks Copy, the audit event MUST record locale = "en" (the fallback actually used), never the unsupported requested locale.
6. **Degraded warning is preserved across all three channels**: Given a finding has a degraded-quality warning (e.g., spleen mask <500 voxels), the screen panel, the PDF, and the clipboard text MUST each contain the warning text — verified by string match on all three outputs.
7. **Partial-payload rendering preserves anchor**: Given a finding payload missing one expected field while another is present, all three surfaces MUST render the present field with its value, render the missing field as "Not available," and render any warning text with an identifying label.
8. **Surgeon viewport scan**: Given a completed analysis with at least one lesion and an FLR plan on a 1280×800 viewport, when the user opens the detail view and reaches the readout, FLR %, primary lesion size, and steatosis grade MUST all be visible without scrolling — verified by element-visible-in-viewport assertions.
9. **View-only user copy is still audited**: Given a user with only view permission, when they click Copy, the action MUST succeed and an audit event MUST be recorded carrying their view-only role.
10. **PDF section order matches screen**: Given a finalized analysis, when the PDF is rendered, the six section titles MUST appear in the same order as the screen panel — verified by PDF text extraction.
11. **Running-analysis empty state**: Given an analysis in queued or running status, the readout panel MUST render six section headers each with a "computing" status line and MUST NOT expose the Copy action.
12. **Audit-emission failure surfaces a warning**: Given a network failure on the audit emission path while the clipboard write succeeds, the user MUST see a warning that the text is on the clipboard but the export was not auditable, and the audit event MUST be retried on the next session.
13. **Concurrent finalize blocks pre-mutation copy**: Given another user finalizes the same analysis while the panel is open, the next Copy attempt MUST be blocked until the user explicitly refreshes, with a message naming what changed.
14. **Tenant boundary enforcement**: Given a cross-tenant analysis URL accessed with a valid session for a different tenant, the readout fetch MUST fail closed AND emit a security audit event.
15. **Authorization revoked mid-session**: Given an admin revokes a user's access while the readout panel is open, the next Copy attempt MUST fail server-side, audit-log the denial with the revoked role, and surface a refresh message.
16. **Keyboard-only operability**: The Copy action MUST be reachable and operable using keyboard alone; success and failure MUST be announced via a polite live region.
17. **Light/dark theme legibility**: Switching between light and dark schemes MUST preserve legibility of warnings, headers, and values; degraded-warning visual emphasis MUST remain perceptible in both schemes.
18. **Print stylesheet**: Browser print of the analysis detail view MUST output only the structured readout with case identifiers and RUO disclaimer, suppressing all other view chrome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A radiologist can copy the structured readout into their PACS dictation system and finalize a report in under 90 seconds from analysis-detail open, measured across at least ten cases.
- **SC-002**: At least 80% of pasted readouts require fewer than three sentences of manual editing before sign-off, measured on a sample of at least twenty radiologist sessions.
- **SC-003**: A surgeon can locate the three high-stakes data points (FLR %, primary lesion size + class, steatosis grade) within five seconds without scrolling on a standard 13" laptop, measured on at least five distinct analyses.
- **SC-004**: 100% of finalized analyses produce an on-screen readout and a PDF readout with structurally identical section ordering AND textually identical section headers, field labels, units, neutral-status lines, and degraded-quality warnings for the same locale and analysis state (any divergence is a test failure).
- **SC-005**: 100% of copy-to-clipboard actions produce a corresponding audit event in the tamper-evident chain, with zero unmatched copies and zero phantom events, measured by reconciling client-side action counts (including those queued for durable retry) with server-side audit entries over a representative period.
- **SC-006**: 0% of rendered analyses display a raw translation key, a JSON artifact, or a broken row in any of the three supported locales, measured by automated locale-coverage testing across all seven finding types.
- **SC-007**: All degraded-quality warnings present in the underlying findings appear in 100% of corresponding renderings across screen, PDF, and clipboard outputs, measured by automated cross-channel comparison on a representative analysis set.
- **SC-008**: 100% of clipboard outputs and PDF readout sections contain the Research Use Only disclaimer in the active locale at the documented positions (first and last line of clipboard text; designated location in PDF), measured by automated output inspection.
- **SC-009**: 100% of clipboard-export audit events carry the actor's role as it existed at the moment of the action (captured-at-click), verified by an automated test that changes the actor's role between click and audit persistence and asserts the recorded role is the pre-change value.
- **SC-010**: Zero cross-tenant exports occur over a representative period, measured by reconciling audit-event tenant references against the analyses they reference.

## Assumptions

- The seven Phase 1 findings are already computed and persisted by the cascade. This feature does not change the cascade, does not add new finding types, and does not modify finding payloads — it only re-groups them for display.
- An existing tamper-evident audit chain exists at the analysis-event level and can accept a new event category for clipboard exports without architectural change. This is a rendering and audit-emission feature, not an audit-infrastructure feature.
- Translation review for new strings will happen through the project's existing medical-terminology review process under the project's CODEOWNERS lock for `ru` and `ka` medical terminology. This feature's release timing assumes that review can complete within the same iteration; if not, English-only release is acceptable while `ru`/`ka` strings remain in pending-translation state with English fallback.
- Vessel-level heuristic findings do not exist today. The Vessels section is deliberately laid out as a stable empty container so a later feature that adds vessel findings (e.g., tumor-to-vessel proximity) has a permanent rendering home and does not require a layout migration.
- Clinical conventions for ACR/RSNA structured-report ordering are stable and well-established; the six-section ordering chosen above follows those conventions and is treated as a fixed contract rather than a configurable one.
- The new structured readout REPLACES the existing flat heuristic-findings card on both the analysis detail view and the inline report view; the old flat layout is removed in the same release.
- All UI implementation for this feature is delegated to the `frontend-designer` agent per the project's mandatory UI-work rule; this specification and the subsequent implementation plan describe behavior and acceptance, while the agent produces the components, styles, and view integration.
- Patient-identifying context (name, MRN, DOB) is rendered by the existing patient-banner component on the surrounding analysis page and the PDF header; this feature's findings section deliberately contains no patient identifiers.

## Out of Scope

- Adding any new finding type or changing any existing finding payload.
- Vessel segmentation, decomposition, or vessel-level findings of any kind.
- Lesion-to-vessel proximity computation.
- Interactive resection planning, FLR recomputation, or any surgical-plan editing.
- Differential-diagnosis ranking, classifier reasoning chains, or "disagree" feedback flows (covered by a separate feature).
- 3D volume rendering or any new viewer modes.
- Multi-phase synced viewing or hover-based HU sampling.
- Configurability of section ordering or per-tenant section customization.
- Any change to the cascade, model versions, or ML inference flow.
- Logging the copied text content (only metadata is audit-logged, per FR-020).
- Side-by-side comparison of structured readouts from two or more analyses (e.g., baseline vs. follow-up CT). This feature renders one analysis at a time; comparison workflows are tracked separately.
- German (`de`) locale support for new readout strings in this release. `de` is retained for legacy DACH bundles; if added later it follows the same medical-review gate as `ru` and `ka`.
