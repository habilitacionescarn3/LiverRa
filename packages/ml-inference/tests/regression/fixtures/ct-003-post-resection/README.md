# Fixture: ct-003-post-resection

**Purpose**: Post-hepatectomy follow-up CT — tests segmentation robustness after right hepatectomy + remnant FLR computation + MedSAM-2 slice-to-slice tracking.

**Used by stages**:
- STU-Net parenchyma (altered contour, surgical clips, atrophy/hypertrophy)
- Pictorial Couinaud (missing right segments 5-8 by design)
- MedSAM-2 tracking (one-shot prompt on a remnant lesion — required)

**Acquisition source**: De-identified follow-up scan 6-12 months post resection, hospital DPA channel. Provenance recorded.

**MBoM version binding**: `tests/regression/thresholds.yaml` · Mount via `LIVERRA_GOLDEN_FIXTURES_DIR`.

## Expected artifacts

| Artifact | Location | Format | Notes |
|---|---|---|---|
| CT volume | `ct.nii.gz` | NIfTI | Portal venous; may contain surgical clip artifact |
| Parenchyma GT | `mask_parenchyma.nii.gz` | uint8 | Only segments 1-4 expected to be non-empty |
| Lesion GT | `mask_lesions.nii.gz` | uint8 | 1 remnant lesion in segment II or III |
| Couinaud GT | `mask_couinaud.nii.gz` | uint8 | Values in `{1, 2, 3, 4}` only; `5..8 = 0` (resected) |
| MedSAM-2 prompt | `medsam2_prompt.json` | JSON | `{"slice_index": 42, "point": [256, 300], "object_id": 1}` |
| MedSAM-2 expected track IoU | `medsam2_expected.json` | JSON | `{"mean_slice_iou": 0.85, "min_slice_iou": 0.75}` |
| Expected FLR | `expected_flr.json` | JSON | `{"pre_op_total_ml": 1500.0, "remnant_ml": 610.0, "flr_pct_of_preop": 40.7}` |

## Thresholds satisfied

- `stunet_parenchyma.dice ≥ 0.92` (restricted to present segments)
- `couinaud.iou` per segment: assert 0 for resected, ≥ 0.70 for remaining
- `medsam2.slice_iou ≥ 0.85`

## Rebuilding

Obtain paired pre-op + post-op studies for FLR delta. Post-op mask GT labeled by attending.
