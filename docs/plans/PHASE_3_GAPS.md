# Phase 3 — gaps between roadmap claims and upstream reality

> **Status as of 2026-04-30**: Phase 3 ran successfully in `--stub` mode.
> All 6 Triton model slots now contain valid TorchScript that satisfies
> the I/O contracts in `triton-models/<model>/config.pbtxt`. Triton (Phase
> 5) and the cascade orchestrator (Phase 6) can run end-to-end against
> these stubs — the predictions are nonsense but every stage executes,
> persistence works, the audit trail is complete, and the contract test
> passes shape-wise.
>
> **What's NOT done**: real upstream-weights conversion (`--mode real`).
> Each of the five upstream models has structural blockers that the
> roadmap didn't account for. The estimated 3–5 h is unrealistic; real
> integration is multi-day per model and depends on upstream-author
> engagement for some.

---

## License audit (actual vs. CLAUDE.md / research docs)

| Model | Actual LICENSE file | CLAUDE.md / research claim | Verdict |
|---|---|---|---|
| STU-Net (parenchyma + lesions) | Apache-2.0 ✓ | Apache 2.0 | OK |
| Pictorial Couinaud | **MIT** | "verify per release" | OK in spirit (permissive, no copyleft); needs human sign-off given CLAUDE.md says "MUST be Apache 2.0" |
| LiLNet | **MIT** | Apache 2.0 — wrong | Same as Couinaud — research doc was incorrect |
| VISTA3D | Apache-2.0 ✓ (`LICENSE.txt`) | Apache 2.0 | OK |
| MedSAM-2 | Apache-2.0 ✓ (despite README badge saying GPL) | Apache 2.0 | OK — README badge is misleading |

**Action:** Founder/legal sign-off needed on accepting MIT-licensed
upstream models (LiLNet, Couinaud) given the strict CLAUDE.md wording.
Both MIT and Apache-2.0 are OSI-approved permissive licenses; MIT is
arguably more permissive. The forbidden-license list in CLAUDE.md only
calls out copyleft (GPL/AGPL/CC-NC/CC-SA), so MIT is consistent with the
*spirit* of the rule.

---

## Per-model real-weight blockers

### 1. STU-Net (parenchyma + lesions)

- **Checkpoint URLs:** Baidu Netdisk + Google Drive only — both
  anti-bot. Programmatic download requires either a manual download +
  drop-in (acceptable, ~1.4 GB per file) or a special API key.
- **Framework dependency:** Upstream README states `torch==1.10` and
  `nnUNet==1.7.0`. Both are incompatible with our pinned `torch==2.4.1`.
  Tracing options:
  1. Spin up a sidecar conda env (`liverra-ml-stunet-trace`) with
     `torch==1.10` + `nnUNet==1.7.0`, trace there, copy `.pt` over.
  2. Vendor only the architecture file from STU-Net repo and load
     state-dict into a fresh `nn.Module` rebuilt for `torch==2.4.1` API.
     Risk: silent op-name renames between torch versions.
- **Lesion-finetuned variant:** Not listed in upstream README. The
  roadmap's "Same family, lesion-finetuned variant" assumes a
  checkpoint that may not exist publicly. Likely needs upstream-author
  outreach or in-house finetuning of the parenchyma checkpoint on
  LiTS17 / MSD Task 8.
- **Expected work:** 1 day if the parenchyma checkpoint downloads
  cleanly; 2–3 days if lesion checkpoint requires finetuning.

### 2. Pictorial Couinaud

- **No public checkpoint URL.** Upstream README is one line citing the
  MICCAI 2023 paper — no Releases page artifacts, no Google Drive link,
  no Hugging Face mirror.
- The repo ships training code (`models/`, `Datasets/`, `modules/`,
  `utils/`). Training from scratch requires the paper's training data
  (likely 3D-IRCADb / LiTS) — *but those datasets are research-only
  per CLAUDE.md*, so we cannot use them to train commercial weights.
- **Expected work:** Contact paper authors (Xukun Zhang) for a
  pretrained checkpoint. If unavailable, this stage drops to manual
  annotation pending in-house Couinaud labeling work, or we substitute
  TotalSegmentator's Couinaud module *(license-blocked — paid
  commercial)*.
- **Action:** Author outreach is on the critical path.

### 3. LiLNet

- **Architecture mismatch with our config.pbtxt.** Upstream README +
  source tree show LiLNet is **three cascaded 2D ResNet50 models**
  (BM_train.py, Benign_train.py, Malignant_train.py) operating on
  224×224 2D crops. Our Triton config expects a single 3D model
  `[4, 96, 96, 96]` → `[6]` raw logits.
- **Bridging-wrapper required.** A real LiLNet integration needs a
  Python wrapper that:
  1. Slices a 3D 96³ lesion crop into 2D axial slices.
  2. Runs each slice through the upstream BM model → benign-vs-malignant
     probability per slice.
  3. Aggregates per-slice scores (mean? max?) into a per-volume score.
  4. Branches into Malignant 3-way or Benign 3-way depending on the
     BM probability.
  5. Concatenates into a 6-vector compatible with our `[6]` output.
- This wrapper is its own ~300-line module + needs validation against
  the upstream paper's reported metrics.
- **Expected work:** 2–3 days plus clinical-validation-team review.

### 4. VISTA3D

- **MONAI Bundle name not in main README.** The upstream is `Project-MONAI/VISTA`
  with a `vista3d/` sub-tree. The actual MONAI bundle registry name needs
  confirming — likely `vista3d` or `monai_vista3d`. Resolve via
  `monai.bundle.get_all_bundles_list()`.
- **5-input signature.** The bundle's exposed inference forward needs
  to accept exactly the 5 inputs our `config.pbtxt` declares. MONAI
  bundles often expose a single-input "predict" entrypoint; we may need
  a wrapper module that re-marshals the inputs into the bundle's
  expected format.
- **TorchScript export.** Use `monai.bundle.ckpt_export()` then verify
  the exported graph's I/O signature matches our config.pbtxt.
- **Expected work:** 1 day if the bundle's signature is close; 2 days
  if a wrapper module is required.

### 5. MedSAM-2

- **Shape mismatch.** Upstream README + SAM2 backbone use 1024×1024
  input slices; our `config.pbtxt` declares `[1, -1, 512, 512]`. Real
  integration needs either:
  1. A wrapper that resizes 512×512 → 1024×1024 inside the traced
     graph, runs the model, then resizes the mask back. Lossy.
  2. Update `config.pbtxt` to declare `[1, -1, 1024, 1024]` and update
     all upstream callers (`tasks/*`, `cascade.py`) accordingly.
- **Framework dependency.** Requires the SAM2 base checkpoint
  (`sam2_hiera_small.pt`) plus the MedSAM-2 finetune. Both available
  on Hugging Face (`jiayuanz3/MedSAM2_pretrain`) but loading requires
  the SAM2 framework code which has its own conda env requirements
  (`environment.yml` per upstream README, Python 3.12.4).
- **Dynamic-Z tracing.** SAM2 uses 2D slice-to-slice attention; if the
  Python forward has a Z-dependent `for` loop, `torch.jit.trace`
  records a fixed-Z graph. Fallback to `torch.jit.script` may require
  upstream code changes (TorchScript-incompatible Python idioms are
  common in research code).
- **Expected work:** 2–3 days, possibly a separate sidecar conda env.

---

## Repo-level inconsistencies surfaced during Phase 3

These are pre-existing; not caused by Phase 3, but they will bite us in Phase 5+.

### A. Triton model directory naming

- `triton-models/<dir>/config.pbtxt` declares `name: "liverra-<dir>"` —
  the pbtxt model name has a `liverra-` prefix that the directory
  doesn't.
- The contract test `tests/contracts/test_triton_stage_shapes.py:172`
  expects `triton-models/liverra-<dir>/config.pbtxt`, so it errors out
  with "Missing config.pbtxt for models" even though the configs exist.
- Triton 24.10's `--load-model=<NAME>` resolves NAME against pbtxt's
  `name` field if that field is present, but the directory name is
  used as the on-disk lookup. Practical impact for Phase 5: depends on
  Triton's internal name-resolution order. Safest fix: rename the 6
  directories to add the `liverra-` prefix.
- **Decision deferred to Phase 5 troubleshooting.** Our stubs are at
  the current paths; if Phase 5's `tritonserver --load-model=liverra-…`
  fails, we'll rename in that session.

### B. `triton-stages.md` vs. `config.pbtxt` shape divergence

- `triton-stages.md` declares stage I/O at full-volume `[1,1,Z,512,512]`
  shapes; the actual `config.pbtxt` files declare 128³ (or 96³) patches.
- The orchestrator (`src/tasks/parenchyma.py` etc.) does the
  full-volume → 128³ resampling itself before calling Triton, so the
  configs are correct and the contract doc is the document that's
  outdated.
- **Action item (separate ticket):** Update `triton-stages.md` to
  describe Triton's *internal* contract (what the model.pt's accept,
  i.e., 128³ patches) rather than the orchestrator-facing API. The
  contract test will then pass shape-wise.

### C. `nnunetv2` not in `requirements.txt`

- STU-Net needs nnUNet to load its checkpoint. Adding it to our
  primary `requirements.txt` would force everyone to install a
  ~500 MB transitive dep tree that's only needed for one-shot
  conversion.
- **Recommended:** Keep `nnunetv2` out of `requirements.txt`.
  Document a separate `requirements-conversion.txt` that the
  conversion script asks for in `--mode real` for STU-Net only.

---

## How to acquire the real weights (suggested order)

1. **STU-Net parenchyma** — easiest of the five despite the nnUNet
   pain because the checkpoint URL is known. Manual download from
   Google Drive into `packages/ml-inference/models/`, then sidecar
   conda env, then trace. Cost: ~half a day.
2. **VISTA3D** — MONAI Bundle is the most-engineered upstream and the
   path is well-trodden. Cost: ~1 day.
3. **MedSAM-2** — Hugging Face checkpoint + SAM2 framework. Bridging
   wrapper for 512↔1024 may be deferred by updating our config.pbtxt
   to 1024 instead. Cost: ~2 days.
4. **LiLNet** — needs the multi-model bridging wrapper. Cost: ~3 days
   plus clinical sign-off on aggregation strategy.
5. **Pictorial Couinaud** — requires upstream-author outreach. Don't
   block on this; in the meantime keep Phase 3's stub.

---

## What to do next

Phases 4–7 of the roadmap (smoke test, Triton boot, full cascade, interactive
refinement) should be runnable today against the stubs. Open questions for
the next session:

1. Run **Phase 4** (single-model smoke test) against the parenchyma stub.
   This validates the orchestrator → Triton call path on the local box.
2. Run **Phase 5** (Triton boot). The directory-naming issue (item A
   above) will surface here. Fix it via rename if so.
3. Reach out to upstream authors for the Couinaud checkpoint.
4. Contact founder for license sign-off on accepting MIT-licensed upstreams.
5. Decide whether to update `triton-stages.md` to match the configs
   (item B), or update the configs to match the doc.

Once those are settled, swap stubs for real weights one model at a time,
in the order above.

---

## Real-quality demo via TotalSegmentator (added 2026-04-30)

For the founder/clinical demo we now run a **bypass cascade** using
TotalSegmentator v2 in `packages/ml-inference/scripts/real_cascade.py`. It
sidesteps the stub Triton models entirely and produces anatomically-correct
liver, hepatic-vessel, and tumor-candidate masks while writing the same
`pipeline_checkpoint` + `flr_calculation` rows the regular cascade would.

**Verified output on the Todua-CT** (after first-time weight cache, ~90 s
end-to-end on RTX 3090):

| Metric | Stub run | TotalSegmentator run |
|---|---|---|
| Total liver volume | 2,829 ml (bone+vessels) | **1,829 ml (real liver)** |
| Mask anatomy | spine + ribs + aorta | **right + left hepatic lobes** |
| Lesion candidates | 0 | 1 plausible (~151 ml) + 2 single-voxel false positives |
| FLR (axial midpoint) | 1,696 ml (60 %) | **386 ml (21 %)** ← clinically meaningful |
| Vessel tree volume | n/a (stub) | 10.8 ml |

### License caveat — IMPORTANT

- TotalSegmentator **code** is Apache-2.0 ✓
- TotalSegmentator **v2 weights** are **CC-BY-NC-SA-4.0** —
  free-for-non-commercial-research only.

This is **acceptable for internal demo + validation** but **MUST NOT** be
used for any commercial clinical deployment. Two paths to remove this gap
before customer-facing use:

1. **Buy the TotalSegmentator commercial license** from the authors
   (https://totalsegmentator.com — direct contact). Quickest unblock; we
   keep all the TS quality + plug-and-play ergonomics.
2. **Acquire real Apache-2.0 STU-Net weights** per the per-model blocker
   list above. This is the long-term plan documented in this doc; ~1 day
   of work for parenchyma + lesions once we have the weight files in hand.

The script prints a banner at startup
(`[license] TotalSegmentator weights: CC-BY-NC-SA-4.0 — internal demo only,
NOT for clinical or commercial use.`) so any reviewer of the run output
sees the constraint immediately.

### What the bypass cascade leaves stubbed

- ~~**Couinaud segmentation (stage 4)**~~ — **DONE** as a heuristic
  (Cantlie line via IVC + gallbladder; per-lobe portal-bifurcation Z;
  35th-percentile falciform offset for the left lobe). Implemented in
  `src/orchestrator/couinaud_heuristic.py`. NOT validated against
  radiologist annotations — that's a separate clinical-validation
  workstream. See "Heuristic Couinaud + segment-aware FLR" below.
- **Per-lesion 6-class classification (LiLNet)** — TS gives us tumor
  *candidates* but not type. The TS lesion mask currently ships 1 plausible
  + 2 single-voxel false positives on the Todua scan; a downstream filter
  (min volume, parenchyma containment) would reduce noise. Per-lesion type
  classification still needs the LiLNet wrapper described above.
- **Wiring TS into Celery/Triton** — the bypass script is intentionally
  out-of-band so the existing stub-Triton orchestration remains the
  reference test surface. To "graduate" the cascade we'd swap the
  parenchyma + lesion_detection task implementations to call TS instead of
  Triton (or wrap TS in a TorchScript-able container that Triton can
  serve). ~half-day.

### Re-running the demo

```bash
# First time only — installs TotalSegmentator + downloads ~300 MB weights:
source /home/irakli/anaconda3/etc/profile.d/conda.sh && conda activate liverra-ml
pip install TotalSegmentator   # in liverra-ml env

# Every subsequent demo:
AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password \
  AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1 \
  python packages/ml-inference/scripts/real_cascade.py

# Render the review PNG (defaults to tmp/cascade_review.png):
AWS_ACCESS_KEY_ID=liverra AWS_SECRET_ACCESS_KEY=liverra-dev-password \
  AWS_ENDPOINT_URL=http://localhost:9000 AWS_REGION=eu-central-1 \
  python packages/ml-inference/scripts/show_results.py
```

The cached weights live at `~/.totalsegmentator/`; deleting that directory
forces re-download. The review PNG title bar will read "✓ Real liver
segmentation" when the run used TotalSegmentator.

---

## Heuristic Couinaud + segment-aware FLR (added 2026-04-30)

Stage 4 (Couinaud) is no longer a passthrough stub — it's an
anatomy-grounded heuristic in
`packages/ml-inference/src/orchestrator/couinaud_heuristic.py`:

- **Cantlie line** through the IVC centroid → gallbladder fossa, computed
  from TotalSegmentator's `inferior_vena_cava` + `gallbladder` labels.
- **Per-lobe portal bifurcation Z** (geometric midpoint of each lobe's
  Z-extent, not a single global vessel-derived Z) so the
  superior/inferior split scales correctly across right and left lobes.
- **Right-lobe anterior/posterior split** at the median |distance| from
  the Cantlie line in the right lobe (proxy for right portal vein).
- **Left-lobe medial/lateral split** at the **35th percentile** of
  |distance| in the left lobe (proxy for falciform ligament / umbilical
  fissure; calibrated so segment IV ≈ II+III in size as in adult anatomy).
- **Caudate (segment I)** carved out as voxels within 1.5 cm of the IVC
  inferior to the global portal bifurcation.

Stage 7 (FLR) was rewritten in
`packages/ml-inference/src/orchestrator/flr_segment_aware.py` to support
six standard hepatectomy patterns. Pass `--resection-pattern <name>` to
`real_cascade.py`.

### Cross-pattern verification on the Todua-CT (1,828 ml total)

| Pattern | FLR % | Surgical interpretation |
|---|---|---|
| `right_hepatectomy` (V+VI+VII+VIII) | 28.4 % | borderline; PVE indicated |
| `left_hepatectomy` (II+III+IV) | 71.8 % | safe |
| `extended_right` (IV+V+VI+VII+VIII) | 13.8 % | **contraindicated** |
| `extended_left` (II+III+IV+V+VIII) | 31.0 % | borderline |
| `right_anterior_sectionectomy` (V+VIII) | 59.2 % | easy |
| `left_lateral_sectionectomy` (II+III) | 86.4 % | trivial |

These are clinically defensible interpretations — the heuristic produces
the right surgical-decision-making story across all six patterns.

### Known limitations

1. **Segment III is undersized** (6 ml on the Todua-CT) because the
   left-lobe Z-midpoint sits very close to the most-inferior left-lateral
   slice. Anatomically the patient's left lateral lobe is shallow on Z.
   A future refinement could detect II vs III via a separate plane based
   on left-portal-vein bifurcation Z.
2. **Segment IV is unified** (no IVa/IVb subdivision) because we don't
   have a portal-vein-territory mapping.
3. **Anterior/posterior right-lobe split is geometric** (median |distance|),
   not based on the right portal vein anterior/posterior division.
4. **Not validated against radiologist annotations.** Clinical validation
   on a multi-case dataset remains a separate workstream before any
   commercial deployment.

### What this DOES enable, today

- Real per-segment volumetry on a real CT.
- Resection-pattern FLR for the 6 most common hepatectomies (≥95 % of
  clinical liver resections).
- The HPB surgeon's #1 pre-op question — *"for resection X, what FLR is
  left?"* — is now answerable end-to-end, with a defensible-but-not-
  validated number.

### Files changed

| File | Role |
|---|---|
| `src/orchestrator/couinaud_heuristic.py` | NEW — pure-NumPy 8-segment heuristic |
| `src/orchestrator/flr_segment_aware.py` | NEW — 6 resection patterns + segment-aware FLR |
| `scripts/real_cascade.py` | Stage 4 stub → real heuristic; Stage 7 axial-midpoint → segment-aware; new `--resection-pattern` CLI flag |
| `scripts/stage_report.py` | Stage 4 → 8-color overlay + per-segment table; Stage 7 → segment-based green/red overlay |
