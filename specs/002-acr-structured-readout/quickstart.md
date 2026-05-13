# Quickstart — Structured ACR-Style Radiologic Readout

**Feature**: 002-acr-structured-readout
**Audience**: developers implementing the feature locally + QA validating release readiness.

This quickstart assumes the Option-B-split dev environment from `CLAUDE.md` is already configured (laptop runs Vite + FastAPI + Celery + Postgres + Redis + MinIO; Irakli's box runs the GPU inference service on `:9101`).

---

## 1. Bring up the local stack

```bash
docker compose -f deploy/local/docker-compose.yml up -d postgres redis minio orthanc

# Apply migrations (no new migrations needed for this feature; reuses 0005 + 0013)
DATABASE_URL="postgresql+asyncpg://liverra:liverra@localhost:5432/liverra" \
  packages/ml-inference/.venv/bin/alembic upgrade head

# FastAPI orchestrator
cd packages/ml-inference && .venv/bin/uvicorn src.main:app --host 127.0.0.1 --port 8090 --reload

# Celery worker (separate terminal — same env vars as CLAUDE.md "To start dev")
# ...

# Vite (separate terminal)
cd packages/app && VITE_LIVERRA_DEV_BYPASS=true VITE_LIVERRA_MOCK_API=false \
  npx vite --port 5173
```

Sanity probe: `curl http://100.124.94.29:9101/health` → `{"ok": true, "cuda_available": true, ...}`.

---

## 2. Produce a real analysis to render against

```bash
./scripts/fetch-sample-dicom.sh && ./scripts/seed-orthanc.sh
# Then in the UI at http://localhost:5173/pacs/studies select the Todua-CT
# and trigger a cascade. Wait ~13 minutes for the cascade to complete.
```

The Todua-CT produces ~5 of 7 Phase 1 findings (per CLAUDE.md state-of-the-world). This is the canonical readout-target.

---

## 3. Verify the on-screen readout

1. Navigate to the completed analysis's detail page.
2. Confirm the ACR structured readout panel is visible without scrolling on a 1280×800 viewport.
3. Confirm section headers appear in this order: **LIVER → LESIONS → VESSELS → GALLBLADDER → SPLEEN → FLR ASSESSMENT**.
4. Confirm the Vessels section renders its empty-container state (no vessel findings exist in v1).
5. Confirm any degraded-quality warnings are visible inline (Todua-CT typically degrades the spleen — look for the "TotalSegmentator returned only N voxels" warning).
6. Confirm the Research Use Only banner appears at the top of the panel.

If any of these fail → the screen renderer regressed; check `ACRStructuredReadout.tsx` + `acrAnatomicalMapping.ts`.

---

## 4. Verify the clipboard copy

1. Click **Copy to Clipboard**.
2. A success toast should appear within 200ms ("Readout copied to clipboard").
3. Paste into a text editor (TextEdit, VS Code) — confirm:
   - First line is the localized RUO disclaimer.
   - Six section headers in fixed order.
   - No HTML, no markdown asterisks/backticks, no JSON braces.
   - Last line is the localized RUO disclaimer.
4. Open the audit chain inspector (e.g., `SELECT * FROM audit_event_chain WHERE subtype='readout-clipboard-export' ORDER BY sequence_no DESC LIMIT 1;`) → confirm exactly one new row with the actor, analysis, locale, and timestamp matching your click.

---

## 5. Verify the PDF parity

1. From the analysis detail view, click **Download PDF report**.
2. Open the PDF and scroll to the Heuristic Findings section.
3. Confirm the same six anatomical subsections appear in the same order as the screen.
4. Confirm the RUO disclaimer is present in the heuristic-findings section footer.
5. Extract the text (PDF → text via `pdfplumber` or Preview's Copy All Text):
   ```bash
   pdftotext ~/Downloads/liverra-report-*.pdf -
   ```
6. The heuristic-findings section text should be byte-equivalent to the clipboard text from Step 4 (modulo line wrapping). The cross-channel parity test verifies this rigorously; manual eyeball is sufficient for the quickstart.

---

## 6. Verify locale switching

1. Switch the UI language to Russian (`ru`).
2. Re-render the analysis detail view — confirm section headers render in Cyrillic (or `__TODO_TRANSLATE__:` markers if medical-term review is still pending).
3. Click Copy — clipboard text first/last lines are the Russian RUO disclaimer.
4. Audit-event row for this copy has `locale = "ru"`.
5. Switch back to English and confirm scroll position is preserved.
6. Switch to an unsupported locale (`fr`) — the panel falls back to English; the audit-event records `locale = "en"`.

---

## 7. Verify the freshness gate

1. Open the readout panel. Note the time.
2. In a separate terminal, simulate a re-run cascade or update analysis state (e.g., `UPDATE analysis SET updated_at = NOW() WHERE id = '...'`).
3. Click Copy.
4. Confirm the copy is BLOCKED and the user sees "Analysis updated by another reviewer — refresh to copy" notification.
5. Refresh, then click Copy again — the copy succeeds and the audit event records the post-mutation state.

---

## 8. Verify the durable retry

1. Kill the FastAPI server (`Ctrl-C` the uvicorn process).
2. From the still-open browser, click Copy.
3. The clipboard write succeeds; a yellow "audit will retry" toast appears.
4. Check the browser DevTools → Application → IndexedDB → `pendingAcrAuditEvents` — confirm one entry with the click's `client_action_id`.
5. Restart FastAPI (`uvicorn ... --reload`).
6. Reload the page (or wait for the next foreground refresh).
7. The IndexedDB entry should drain; the audit chain should now contain the entry with the ORIGINAL click timestamp (not the retry timestamp).

---

## 9. Verify accessibility

1. Tab through the analysis detail view using keyboard only.
2. Confirm the Copy button is reachable via keyboard and triggers on Enter/Space.
3. With a screen reader active (VoiceOver / NVDA), click Copy — confirm the live-region announcement says "Readout copied to clipboard" (or the active-locale equivalent).
4. Switch to dark mode (`data-mantine-color-scheme="dark"` on `<html>`).
5. Confirm degraded-warning callouts remain legible and the section headers retain contrast.

---

## 10. Run automated tests

```bash
# Frontend unit tests
cd packages/app && npx vitest run src/emr/services/report

# Frontend E2E tests (18 scenarios from spec §Testing Scenarios)
cd packages/app && npx playwright test e2e/cases/acr-readout.spec.ts

# Python unit tests (PDF section builder, plain-text renderer parity)
cd packages/ml-inference && .venv/bin/pytest tests/unit/test_acr_section_builder.py tests/unit/test_acr_plaintext_renderer.py

# Cross-channel parity integration test
cd packages/ml-inference && .venv/bin/pytest tests/integration/test_acr_pdf_parity.py
```

All test layers must pass before the feature is shippable. The release gate per FR-038 is:
- Locale snapshots for all six sections × three locales = 18 snapshot tests
- One audit-event integration test (1 click → 1 event)
- One keyboard-accessibility test
- One cross-channel parity test (TS renderer output == Python renderer output == PDF section text)

---

## Common failure modes

| Symptom | Likely cause |
|---|---|
| Clipboard write silent failure on iPad Safari | `navigator.clipboard.writeText` not available; check the `execCommand` fallback path |
| Audit event missing actor_role | role not resolved at action time — check the auth context hook is reading from the freshest session |
| PDF section order differs from screen | `acr_section_builder.py` mapping out of sync with `acrAnatomicalMapping.ts` — run the cross-channel parity test |
| Russian / Georgian headers showing `__TODO_TRANSLATE__:` | medical CODEOWNERS review still pending — expected during development, must clear before release |
| Two audit events for one click | `client_action_id` not being generated stably — confirm UUID is produced once per click, not once per render |
| `acr_readout_viewed` event missing in PostHog | telemetry channel not wired to the panel mount hook |
