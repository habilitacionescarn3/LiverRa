# test_results — captured cascade outputs

Visualizations from the end-to-end cascade run on the Todua-CT
(real 4-phase liver CT, 2,340 DICOMs, ~1.2 GB). Both the **stub-Triton**
and **TotalSegmentator real-quality** paths are captured side-by-side so
the difference is obvious without re-running the system.

## Files

### Top-level review PNGs

| File | What it is | Take-away |
|---|---|---|
| [`cascade_review_stub.png`](cascade_review_stub.png) | 6-pane CT + mask overlay from the stub Triton run (`download_and_convert_models.py --mode stub` outputs serving on Triton) | Mask covers spine + ribs + aorta. Demonstrates that the stub `sigmoid(0.25 × mean_HU)` model fires on bone, not liver — exactly why we need real weights. |
| [`cascade_review_totalseg.png`](cascade_review_totalseg.png) | Same 6-pane view but using the bypass cascade (`real_cascade.py`) which routes through TotalSegmentator v2 | Mask now correctly covers the right + left hepatic lobes. Title bar reads "✓ Real liver segmentation". Note the axial pane is the volume midpoint (a known weakness — see `qc_review.png`). |
| [`qc_review.png`](qc_review.png) | Multi-slice QC: 18 axial slices through the liver bbox + 3 coronal + 3 sagittal + Z-voxel-count sparkline | This is the QC artifact a clinician should look at before trusting any volume number. Slice positions are computed from the mask bounding box, not the volume midpoint. |

### `stage_report/` — per-stage breakdown

Open [`stage_report/index.html`](stage_report/index.html) to walk through all
seven cascade stages with their visuals and numerical outputs.

| Stage | File | What it shows |
|---|---|---|
| 2 — Parenchyma | `stage2_parenchyma.png` | 6 axial + 2 coronal + 2 sagittal slices through the liver bbox, contour overlay |
| 3 — Vessels | `stage3_vessels.png` | Coronal MIP of the vessel tree inside the liver outline + 3 axial detail slices |
| 4 — Couinaud | `stage4_couinaud.png` | Stub-aware placeholder (no real Couinaud yet) |
| 5 — Lesions | `stage5_lesions.png` | Per-lesion 3-axis thumbnails (axial/coronal/sagittal centred on each lesion) with yellow tumor contour |
| 6 — Classification | `stage6_classification.png` | Stub-aware placeholder (LiLNet not yet wired) |
| 7 — FLR | `stage7_flr.png` | Coronal + sagittal with the resection plane drawn as a dashed line; FLR (green) above plane, remnant (red) below. Includes the "(heuristic — NOT validated)" caveat. |

## How these were generated

```bash
source ~/anaconda3/etc/profile.d/conda.sh && conda activate liverra-ml
export AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password
export AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1

# 1. Stub run (Triton serving stub TorchScripts) — see prior commit
#    triggered via curl POST /api/v1/analyses, then:
python packages/ml-inference/scripts/show_results.py test_results/cascade_review_stub.png

# 2. Real run (TotalSegmentator bypass) — produces realistic volumes
python packages/ml-inference/scripts/real_cascade.py
python packages/ml-inference/scripts/show_results.py test_results/cascade_review_totalseg.png

# 3. Multi-slice QC view (uses the run still cached in /tmp/real_cascade/)
python packages/ml-inference/scripts/qc_review.py test_results/qc_review.png

# 4. Per-stage HTML report
python packages/ml-inference/scripts/stage_report.py
# (writes into tmp/stage_report/; copy into test_results/stage_report/)
```

## Numbers from this run (real-quality path)

| Metric | Value |
|---|---|
| Total liver volume | 1,829.10 ml |
| Vessel tree (liver-contained) | ~5 ml |
| Lesion candidates | 1 plausible (~151 ml) + 2 single-voxel noise |
| FLR (axial midpoint, heuristic) | 385.58 ml (21.08 %) |
| Cascade duration | ~90 s on cache (~7 min including weight download on cold start) |

## License posture for these artifacts

The CT data shown is the patient's actual clinical CT (Todua-CT fixture),
already de-identified. The masks were produced by **TotalSegmentator v2**
whose **weights are CC-BY-NC-SA-4.0** — fine for internal demo / research,
**NOT for commercial clinical use**. See `docs/plans/PHASE_3_GAPS.md` for
the path to commercial-friendly replacement (real STU-Net Apache-2.0
weights, or a TotalSegmentator commercial license).

## QC verdict for this run

Per the most recent radiologist review:

- Whole-liver segmentation: **passes rough automated QC, not clinically
  validated.** Volume of 1,829 ml is plausible for an adult.
- Tumor channel: yellow contours appear to correctly delineate real
  focal mass(es) within the liver — needs clinical review.
- Couinaud (stage 4): still stubbed.
- FLR (stage 7): mathematically consistent but uses an axial midpoint
  heuristic; not anatomically meaningful until Couinaud is real.

Open improvement ideas (queued for next session):

1. Connected-component cleanup on the liver mask (drop islands < 5 ml).
2. Heuristic Couinaud using TS's IVC + portal-vein outputs.
3. Per-lesion 4-phase enhancement curve (LiLNet input signature).
4. Per-slice radiologist PDF.
5. Side-by-side 4-phase axial viewer.
6. 3D mesh render via plotly/vtk.
7. Dome / left-lobe completeness flags.
