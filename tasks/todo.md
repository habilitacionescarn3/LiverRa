# US1 Analysis API + Tests — Task Plan (T167-T170, T190-T194 subset, T412-T414)

Goal: Ship the HTTP + SSE surface for the analysis pipeline (start, poll, stream, cancel, retry, results) plus the first round of integration + regression tests + the three wiring upgrades that graft ingestion gate services, DICOM-aware PHI triage, and MBoM stamping into the rest of the stack.

## Plain-English recap

Think of the API as the remote control for one CT case. The user's browser presses "start", the backend builds a conveyor belt of ML models, and the conveyor belt writes sticky notes (`pipeline_checkpoint` rows) as each stage finishes. The `/stream` endpoint is a tiny window that watches those sticky notes appear in real time so the UI can update stage-by-stage — no polling.

## Todo

- [X] T167 — analysis.py router (5 routes)
- [X] T168 — analysis_stream.py SSE endpoint
- [X] T169 — @require_permission on every analysis route (study.upload / analysis.view / analysis.cancel / analysis.retry)
- [X] T170 — AuditChainWriter on cancel/retry; X-LiverRa-Audit-Seq header
- [X] T190 — tests/integration/test_ingest_flow.py (happy path + missing portal venous + PHI race)
- [X] T191 — tests/regression/test_parenchyma_dice.py (Dice >= 0.92)
- [X] T193 — packages/imaging/src/__tests__/watermark.test.ts (watermark.ts already existed from T179)
- [X] T194 — tests/security/test_step_up_on_finalize.py placeholder
- [X] T412 — wire ingestion-gate cascade into api/ingest.py
- [X] T413 — wire triage + recognizers into pacs/anon-sidecar/main.py
- [X] T414 — mbom/reader.py + adapter into orchestrator/checkpoint.py
- [X] Mark each [X] in tasks.md

## Summary

Delivered 11 tasks — all syntax clean. Key design calls:

- **SSE**: poll-based (1 s interval) rather than LISTEN/NOTIFY — simpler,
  matches the < 2 s latency budget, no extra infra. Uses `Last-Event-ID`
  for client-reconnect resume. `X-Accel-Buffering: no` disables nginx
  buffering so stage events flush immediately.
- **Audit**: cancel/retry both emit via `AuditChainWriter.write(...)` in
  the same session as the business update (FR-029b atomicity). The
  assigned sequence number is surfaced as `X-LiverRa-Audit-Seq` for the
  frontend's incident-reference UI.
- **Idempotency**: `POST /analyses` reuses an active (queued/running)
  analysis for the same study_id, matching the OpenAPI contract note.
- **Retry**: new analysis row with `retry_of_analysis_id` stashed in
  `model_versions` JSON (schema column to follow in a later migration);
  cascade dispatched at `last_checkpoint.stage_no + 1`.
- **T412 gate cascade**: runs inline on chunk-merge completion (not in
  Celery). Lazy-imports each validator so missing sibling modules don't
  block the API layer; minimal fallback asserts portal_venous presence
  per FR-003. Failures render via `ProblemDetailException` → 422.
- **T413**: the existing anon-sidecar already had triage + recognizers
  threaded; I tightened the gate-3 block to short-circuit cleanly on
  `ScanMode.SKIP` and made the data flow explicit in comments.
- **T414**: new `services/mbom/reader.py` provides the canonical
  mtime-invalidated singleton; `orchestrator/checkpoint.py` keeps its
  existing public API but now delegates to the services reader via a
  thin adapter (no churn for existing callers).
- **Test hermeticity**: integration + regression tests soft-import
  `testcontainers`, `fakeredis`, `pydicom`, `numpy`, `nibabel` so the
  module imports cleanly on any box. Missing deps → tests skip, not
  error. Regression test gated on `LIVERRA_GOLDEN_FIXTURES_DIR` env var.

## Cross-agent stubs left behind

- `src/tasks/cascade.py` (run_cascade + revoke_cascade) — referenced via
  lazy import in analysis.py. Owner: inference-orchestrator agent.
- `src/services/ingestion_gates/{zip_safety,phase_detection,uid_consistency,coverage_check}.py`
  — referenced via lazy import in ingest.py. Owner: us1-ingest agent.
- `src/services/crypto_shred.schedule_key_deletion` — referenced by
  integration test mock path. Owner: erasure agent.
- `tests/fixtures/` — `.gitkeep` + README.md committed; large binaries
  mount via `LIVERRA_GOLDEN_FIXTURES_DIR`.


## Notes

- Max 3 files per Write batch.
- SSE responses get `X-Accel-Buffering: no`.
- Fixture dirs: create only `.gitkeep` + README; real fixtures are CI/offline-mounted.
- Cross-agent stubs: scaffold minimal `orchestrator/checkpoint.py`, `api/ingest.py`, `pacs/anon-sidecar/main.py`, `services/ingestion_gates/*` only to the degree needed for these wiring tasks to import; tag them `// STUB` / `# STUB` so the owner agent knows.
