# Fixture: ct-004-tumor-replacement

**Purpose**: High-burden metastatic disease — tumor replaces a large fraction of parenchyma. Stress-tests parenchyma boundary detection when lesion-to-liver contrast is poor and lesion containment sanity check (FR-007a).

**Used by stages**:
- STU-Net parenchyma (difficult boundary)
- STU-Net lesions (large multi-focal lesion mask)
- LiLNet classification (CRLM — colorectal metastasis — primary)

**Acquisition source**: Hospital DPA channel (CRLM cases) or CRLM-CT-Seg Zenodo dataset (April 2026 release, license permitting evaluation use only — verify at bind-time).

**MBoM version binding**: `tests/regression/thresholds.yaml` · Mount via `LIVERRA_GOLDEN_FIXTURES_DIR`.

## Expected artifacts

| Artifact | Location | Format | Notes |
|---|---|---|---|
| CT volume | `ct.nii.gz` | NIfTI | Portal venous preferred; confirm multi-focal lesion distribution |
| Parenchyma GT | `mask_parenchyma.nii.gz` | uint8 | Includes lesion voxels as parenchyma (tumor-inclusive) |
| Lesion GT | `mask_lesions.nii.gz` | uint8 | `N=1..L` per lesion; ≥5 lesions expected |
| Classification GT | `labels_lilnet.json` | JSON | `[{"lesion_id": k, "class": "CRLM"}]` |
| Expected FLR (planned resection) | `expected_flr.json` | JSON | `{"total_ml": 1580.0, "target_resection_ml": 920.0, "flr_pct": 41.7}` |

## Thresholds satisfied

- `stunet_parenchyma.dice ≥ 0.92` (even with poor contrast)
- `stunet_lesions.dice ≥ 0.65`, `sensitivity_10mm ≥ 0.78`
- `lilnet.top1_acc ≥ 0.82`
- Lesion-containment sanity check (FR-007a): ≥95% of lesion voxels inside parenchyma mask

## Rebuilding

Two attending consensus required for multi-focal lesion labeling; record inter-rater kappa in `provenance.json`.
