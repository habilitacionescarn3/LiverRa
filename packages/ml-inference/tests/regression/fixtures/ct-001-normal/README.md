# Fixture: ct-001-normal

**Purpose**: Baseline normal liver CT for regression gate (no lesions, no cirrhosis, no prior resection).

**Used by stages**:
- STU-Net parenchyma (required)
- STU-Net lesions (negative case — assert 0 lesions)
- Pictorial Couinaud (required)

**Acquisition source**: De-identified adult abdominal CT (portal venous phase) licensed from a research-use-only dataset with permissive redistribution (e.g. AMOS22 CC BY 4.0). Hospital DPA NOT required since the source is publicly redistributable.

**MBoM version binding**: See `tests/regression/thresholds.yaml` — must match `mbom_version` declared there. Real fixture data is NOT checked in. At test time the runner mounts the bundle from `LIVERRA_GOLDEN_FIXTURES_DIR` (see `packages/ml-inference/tests/regression/conftest.py`).

## Expected artifacts

| Artifact | Location (inside mounted fixture dir) | Format | Notes |
|---|---|---|---|
| CT volume | `ct.nii.gz` | NIfTI, 1.5 mm iso, RAS+ | HU values; portal venous phase; 1 × 1 × Z × 512 × 512 |
| Parenchyma GT mask | `mask_parenchyma.nii.gz` | uint8 NIfTI | `1 = liver`, `0 = background` |
| Couinaud GT mask | `mask_couinaud.nii.gz` | uint8 NIfTI | Values `1..8` per Couinaud segment |
| Lesion GT mask | `mask_lesions.nii.gz` | uint8 NIfTI | Empty (all zeros) by design for ct-001 |
| Expected FLR | `expected_flr.json` | JSON | `{"total_liver_ml": 1450.0, "flr_ml": null, "flr_pct": null}` — no resection on normal |
| Expected derived metrics | `expected_metrics.json` | JSON | `{"lesion_count": 0, "phase": "portal_venous", "voxel_spacing_mm": [1.5, 1.5, 1.5]}` |

## Thresholds satisfied (from `thresholds.yaml`)

- `stunet_parenchyma.dice_liver_vs_gt ≥ 0.92`
- `stunet_lesions.lesion_count == 0` (exact match for negative case)
- `couinaud.mean_iou_per_segment ≥ 0.70`

## Rebuilding this fixture

1. Download source CT from approved dataset (AMOS22 preferred).
2. Resample to 1.5 mm isotropic, crop to 512×512 in-plane, reorient to RAS+.
3. Generate GT masks via consensus of two attending radiologists (recorded in `provenance.json`).
4. Commit SHA-256 hash of bundle to `thresholds.yaml` under `fixtures.ct-001-normal.sha256`.
5. Re-bind to new `mbom_version` via `/speckit.implement` gate.
