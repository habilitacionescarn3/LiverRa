# Fixture: ct-005-partial-coverage

**Purpose**: Partial/truncated abdomen CT — liver is cropped at top or bottom of FOV. Validates the out-of-coverage detector (FR-007b) and upstream pre-check pipeline step (halts with actionable error instead of producing bad FLR).

**Used by stages**:
- Pre-check / coverage validation (expected: PIPELINE HALT)
- STU-Net parenchyma (only runs if pre-check passes — expected NOT to run for ct-005)

**Acquisition source**: De-identified CT intentionally truncated above dome or below inferior tip of liver. Can be synthesized by cropping a full-coverage fixture (record the source + crop plane in `provenance.json`).

**MBoM version binding**: `tests/regression/thresholds.yaml` · Mount via `LIVERRA_GOLDEN_FIXTURES_DIR`.

## Expected artifacts

| Artifact | Location | Format | Notes |
|---|---|---|---|
| CT volume | `ct.nii.gz` | NIfTI | Truncated so liver extends beyond FOV |
| Expected pre-check result | `expected_coverage.json` | JSON | `{"full_coverage": false, "crop_axis": "cranial", "missing_mm": 12.4}` |
| Expected pipeline outcome | `expected_outcome.json` | JSON | `{"analysis_status": "failed", "error_slug": "analysis-implausible-output", "halt_before_stage": "parenchyma"}` |
| Expected audit trail | `expected_audit.json` | JSON | One AuditEvent with `outcome: minor-failure`, `slug: analysis-implausible-output` |

## Thresholds satisfied

- Pre-check must detect missing coverage with ≥0.95 sensitivity.
- NO downstream regression thresholds (pipeline halts).
- Error envelope MUST match canonical RFC 7807 slug `analysis-implausible-output` (see error catalog).

## Rebuilding

1. Start from a validated full-coverage fixture (e.g. ct-001 or ct-002).
2. Crop 10-20 mm off cranial or caudal extent of liver.
3. Record crop plane + missing_mm in `provenance.json`.
4. Re-hash bundle and bind to MBoM version.
