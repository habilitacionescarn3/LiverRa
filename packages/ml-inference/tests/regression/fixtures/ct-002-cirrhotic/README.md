# Fixture: ct-002-cirrhotic

**Purpose**: Cirrhotic liver with HCC lesion(s) — exercises classification + VISTA3D refinement.

**Used by stages**:
- STU-Net parenchyma (altered shape, nodular surface)
- STU-Net lesions (≥1 lesion present)
- Pictorial Couinaud (distorted segmental anatomy)
- LiLNet classification (HCC primary)
- VISTA3D refinement (Δ-Dice test — see ct-002 binding in `thresholds.yaml`)

**Acquisition source**: De-identified HCC case sourced from hospital DPA pipeline or permissively-licensed HCC-TACE-Seg fixture (research-only for **evaluation** — never for training commercial weights). DPA ID recorded in `provenance.json`.

**MBoM version binding**: See `tests/regression/thresholds.yaml`. Data not checked in; mount from `LIVERRA_GOLDEN_FIXTURES_DIR`.

## Expected artifacts

| Artifact | Location | Format | Notes |
|---|---|---|---|
| CT volume | `ct.nii.gz` | NIfTI | 4-phase (non-contrast + arterial + portal + delayed); arterial hyper-enhancement required for HCC pattern |
| Parenchyma GT | `mask_parenchyma.nii.gz` | uint8 | Irregular nodular surface |
| Lesion GT | `mask_lesions.nii.gz` | uint8 | `N` for lesion index; ≥1 lesion |
| Couinaud GT | `mask_couinaud.nii.gz` | uint8 | Values 1..8 |
| Classification GT | `labels_lilnet.json` | JSON | `[{"lesion_id": 1, "class": "HCC"}, ...]` |
| Expected FLR | `expected_flr.json` | JSON | `{"total_liver_ml": 1120.0}` — atrophic from cirrhosis |
| VISTA3D baseline/3-click | `vista3d_oracle.json` | JSON | `{"dice_0_clicks": 0.71, "dice_3_clicks_expected": 0.78}` — Δ ≥ 0.05 |

## Thresholds satisfied

- `stunet_parenchyma.dice ≥ 0.92`
- `stunet_lesions.dice ≥ 0.65`, `sensitivity_10mm ≥ 0.78`
- `couinaud.mean_iou ≥ 0.70`
- `lilnet.top1_acc ≥ 0.82`
- `vista3d.delta_dice_3clicks ≥ 0.05`

## Rebuilding

Same process as ct-001 + HCC arterial/washout confirmation by HPB surgeon before commit.
