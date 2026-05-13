# Quickstart validation — 2026-05-13 (initial implementation)

Spec ref: 002-acr-structured-readout T109.

This log records the result of running the full Quickstart against a
real Todua-CT analysis. It is a snapshot — re-run before each release
candidate.

## Environment

- Branch: `002-acr-structured-readout`
- Commit: TBD (post-implementation merge SHA goes here)
- Local stack: Option-B split per CLAUDE.md (laptop FastAPI + GPU service
  on `100.124.94.29:9101`).

## Quickstart step status

| Step | Result | Notes |
|---|---|---|
| 1. Local stack up | ⏳ pending | Run `docker compose -f deploy/local/docker-compose.yml up -d postgres redis minio orthanc` |
| 2. Cascade against Todua-CT | ⏳ pending | Expect ~13 min, ~5/7 Phase 1 findings |
| 3. On-screen readout | ⏳ pending | Six sections in fixed order, Copy button visible above-the-fold @ 1280×800 |
| 4. Click Copy + verify clipboard | ⏳ pending | Plain text with RUO bookends, no markdown chars |
| 5. PDF parity (automated) | ⏳ pending | `pytest packages/ml-inference/tests/integration/test_acr_renderer_cross_channel_parity.py -v` |
| 6. Locale switching | ⏳ pending | Switch UI to `ru` — section headers render in Cyrillic OR `__TODO_TRANSLATE__:` markers (medical CODEOWNERS review pending) |
| 7. Audit chain row | ⏳ pending | `SELECT * FROM audit_event_chain WHERE canonical_json LIKE '%readout-clipboard-export%'` returns the click row |
| 8. Print preview | ⏳ pending | `Cmd+P` shows readout + RUO, hides viewer chrome |
| 9. Mobile bottom-sheet trigger | ⏳ pending | Viewport <768px — third sheet trigger visible adjacent to workspace + FLR |
| 10. Theming compliance grep | ✅ passed | `git grep -nE '#([0-9a-fA-F]{3,8})\b' packages/app/src/emr/components/report/ACR` returns empty (verified 2026-05-13). |

## Test-evidence release gate (FR-038)

Run these in CI before merging to `main`:

```bash
# Frontend
cd packages/app && npx vitest run --no-coverage \
  src/emr/services/report/__tests__/

cd packages/app && npx playwright test src/emr/views/__e2e__/acr-readout

# Python
cd packages/ml-inference && pytest \
  tests/unit/test_acr_section_builder.py \
  tests/unit/test_acr_plaintext_renderer.py \
  tests/unit/test_clipboard_export_event.py \
  tests/unit/test_clipboard_export_failure_variants.py \
  tests/integration/test_clipboard_export_idempotency.py \
  tests/integration/test_clipboard_export_chain_continuity.py \
  tests/integration/test_acr_renderer_cross_channel_parity.py
```

## Open issues / follow-ups

- `__TODO_TRANSLATE__:` placeholders in `de/ka/ru/reportAcr.json` and the
  new ACR section of `de/ka/ru/report.html` need medical CODEOWNERS
  sign-off before prod-i18n-strict mode is enabled.
- PDF subset render hook in `pdf_builder.py` is NOT yet exposed for the
  per-scenario PDF-text extraction test (T076). The cross-channel parity
  test (T077) is the load-bearing assertion for now.
- APScheduler retention job (T091/T092) lands only when APScheduler is
  installed in the runtime image; falls back to a no-op until then.
