# test_results — captured cascade outputs

Visualizations from the end-to-end cascade run on the Todua-CT
(real 4-phase liver CT, 2,340 DICOMs, ~1.2 GB). Three runs are captured
side-by-side so the progression is obvious without re-running the system:

1. **Stub Triton** — every model is a contract-conformant TorchScript
   stub (`download_and_convert_models.py --mode stub`). Demonstrates the
   orchestration but the masks are wrong (mask covers spine + ribs).
2. **TotalSegmentator (whole-liver only)** — `real_cascade.py` early
   version. Liver mask is anatomically correct, but stage 4 is still a
   passthrough stub and stage 7 uses an axial-midpoint FLR heuristic.
3. **TotalSegmentator + Couinaud heuristic + segment-aware FLR** —
   current state. Anatomy-grounded 8-segment split + 6 standard
   resection patterns. The HPB surgeon's #1 pre-op question — *"for
   resection X, what FLR is left?"* — is now answerable end-to-end.

## Files

### Top-level review PNGs

| File | Captured from | Take-away |
|---|---|---|
| [`cascade_review_stub.png`](cascade_review_stub.png) | Stub Triton run | Mask covers spine + ribs + aorta. Demonstrates that the stub `sigmoid(0.25 × mean_HU)` model fires on bone, not liver. |
| [`cascade_review_totalseg.png`](cascade_review_totalseg.png) | Latest `real_cascade.py` run (right_hepatectomy) | Mask correctly covers right + left hepatic lobes. Title bar reads "✓ Real liver segmentation". Slice positions now come from the mask bounding box (the original axial-midpoint bug is fixed). |
| [`qc_review.png`](qc_review.png) | Multi-slice QC of the latest run | 18 axial slices through the liver bbox + 3 coronal + 3 sagittal + Z-voxel-count sparkline + tumor false-positive check. The artifact a clinician should look at before trusting any volume number. |

### `stage_report/` — per-stage breakdown (current Couinaud + FLR work)

Open [`stage_report/index.html`](stage_report/index.html) to walk through all
seven cascade stages with their visuals and numerical outputs.

| Stage | File | What it shows |
|---|---|---|
| 2 — Parenchyma | `stage2_parenchyma.png` | 6 axial + 2 coronal + 2 sagittal slices through the liver bbox, contour overlay |
| 3 — Vessels | `stage3_vessels.png` | Coronal MIP of the vessel tree inside the liver outline + 3 axial detail slices |
| 4 — **Couinaud (heuristic)** | `stage4_couinaud.png` | **8-color overlay** (tab10 palette) on 4 axial + 2 coronal + 2 sagittal slices, with per-segment volume table in the figure title |
| 5 — Lesions | `stage5_lesions.png` | Per-lesion 3-axis thumbnails (axial/coronal/sagittal centred on each lesion) with yellow tumor contour |
| 6 — Classification | `stage6_classification.png` | Stub-aware placeholder (LiLNet not yet wired) |
| 7 — **FLR (segment-aware)** | `stage7_flr.png` | Coronal + sagittal with **green = remnant, red = removed** — based on the Couinaud mask + selected resection pattern. Per-segment volumetry table on the right shows each segment's ml + remnant/removed flag. |

## Numbers from this run

The captured run used the **right_hepatectomy** pattern (V + VI + VII + VIII removed):

| Metric | Value | Interpretation |
|---|---|---|
| Total liver volume | 1,828.4 ml | typical adult range |
| Right lobe (V+VI+VII+VIII) | 1,309.9 ml (71.6 %) | right-dominant in this patient |
| Left lobe (II+III+IV) | 514.9 ml (28.2 %) | |
| Caudate (I) | 3.6 ml | small (heuristic limit on this scan) |
| **FLR for right hepatectomy** | **518.5 ml (28.4 %)** | **borderline — PVE indicated** |
| Lesion candidate (largest) | 151.3 ml | needs radiologist review |
| Cascade duration | ~117 s on cache | |

## Cross-pattern sanity check

Same scan, six standard hepatectomy patterns:

| Pattern | Segments removed | FLR % | Surgical interpretation |
|---|---|---|---|
| `right_hepatectomy` | V + VI + VII + VIII | 28.4 % | borderline; PVE indicated |
| `left_hepatectomy` | II + III + IV | 71.8 % | safe |
| `extended_right` | IV + V + VI + VII + VIII | 13.8 % | **contraindicated** |
| `extended_left` | II + III + IV + V + VIII | 31.0 % | borderline |
| `right_anterior_sectionectomy` | V + VIII | 59.2 % | easy |
| `left_lateral_sectionectomy` | II + III | 86.4 % | trivial |

These are clinically defensible interpretations across all six patterns.

## How these were generated

```bash
source ~/anaconda3/etc/profile.d/conda.sh && conda activate liverra-ml
export AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password
export AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1

# Run the full real-quality cascade with a chosen resection pattern:
python packages/ml-inference/scripts/real_cascade.py \
  --resection-pattern right_hepatectomy   # or any of the 6 patterns

# Render the per-stage HTML report:
python packages/ml-inference/scripts/stage_report.py
cp -r tmp/stage_report/* test_results/stage_report/

# Render the multi-slice QC view:
python packages/ml-inference/scripts/qc_review.py test_results/qc_review.png

# Render the 6-pane review PNG:
python packages/ml-inference/scripts/show_results.py test_results/cascade_review_totalseg.png
```

## License posture for these artifacts

- **Patient CT** — already de-identified Todua-CT fixture.
- **Liver / vessel / tumor masks** — from TotalSegmentator v2 weights
  (CC-BY-NC-SA-4.0). Internal demo / research only; **NOT** for
  commercial clinical use without a TotalSegmentator commercial license
  or replacement Apache-2.0 weights.
- **Couinaud heuristic + FLR** — pure-Python, Apache-2.0 (LiverRa code).

See `docs/plans/PHASE_3_GAPS.md` for the full license-posture audit and
the path to commercial-friendly weights.

## QC verdict for this run

- Whole-liver segmentation: **passes rough automated QC, not clinically
  validated.** Volume of 1,828 ml is plausible for an adult.
- Tumor channel: yellow contours appear to correctly delineate one real
  ~151 ml focal mass + 2 single-voxel false positives. Needs clinical
  review.
- **Couinaud (stage 4): heuristic, not validated** against radiologist
  annotations. Right lobe (V+VI+VII+VIII) at 72 % is right-lobe-dominant
  for this patient. Segment III is small (~6 ml) — known limitation; the
  patient's left lateral lobe is shallow on Z and the heuristic puts the
  superior/inferior split at the lobe's geometric Z midpoint.
- **FLR (stage 7): segment-aware, not validated**. The 28 % for right
  hepatectomy is in the borderline-but-plausible range and falls below
  the typical 30 % safety threshold — surgeon would consider portal vein
  embolization (PVE) before resection.

Open improvement ideas (queued for next session):

1. Per-lesion 4-phase enhancement curve (LiLNet input signature; ~1 h).
2. Connected-component cleanup on the liver mask (drop islands < 5 ml).
3. Segment III refinement using left-portal-vein anatomical landmark.
4. Real STU-Net Apache-2.0 weights to remove the TS license caveat.
5. Per-slice radiologist PDF.
6. Side-by-side 4-phase axial viewer.
7. 3D mesh render via plotly/vtk.
8. Dome / left-lobe completeness flags.
