# VISTA3D Refine (Stage 5)

**Triton model name**: `liverra-vista3d-refine`
**Tier**: B (lazy-loaded — research §C.1)
**License**: Apache 2.0
**Upstream**: https://github.com/Project-MONAI/VISTA (VISTA3D; 127-class volumetric foundation model)

## Purpose

Click-to-refine any segmentation (parenchyma, Couinaud segment, vessel
trunk, or lesion) within a single review session (FR-015). Runs
out-of-band from the main cascade — the main pipeline never waits on
VISTA3D, and VISTA3D never re-enters the cascade. Invoked by
`POST /api/v1/reviews/{review_id}/mask-refine`.

Contract: `specs/001-zero-training-mvp/contracts/triton-stages.md §Stage 5`.

## Current state of `1/model.pt`

The checked-in `1/model.pt` is a **16-byte placeholder stub**
(`LIVERRA_STUB`). It exists so the Triton model repository layout is
valid in local dev and CI; real inference requires the real TorchScript
export and is **not** exercised by any committed test.

**TODO (before first staging deployment)**: replace the stub with the
real TorchScript export. See "Export command" below. Pinned commit SHA
is a placeholder until the integration task lands.

## Export command

```bash
# From a machine with GPU + PyTorch 2.3 + MONAI 1.4 installed.
git clone https://github.com/Project-MONAI/VISTA.git
cd VISTA
git checkout abc1234   # <-- placeholder; to be replaced by real pinned SHA
python export_vista3d_torchscript.py \
  --checkpoint_path ./weights/vista3d_model.pt \
  --crop_size 128 \
  --output model.pt
# Result: a single `model.pt` TorchScript file ~1.2 GB.
mv model.pt packages/ml-inference/triton-models/vista3d-refine/1/model.pt
```

After export, re-run `scripts/model-bom.sh` (T135) so `MBoM.json`
picks up the refreshed `pinned_commit_sha` + `license_text_hash`.

## Compositing back into the full-resolution mask

VISTA3D sees only a 128³ crop of the volume + mask around the click
point; its refined crop is composited back into the parent full-
resolution `Segmentation.mask_uri` by
`packages/ml-inference/src/services/review/refinement_local_recompute.py`
(T234). A new Segmentation row is always written with
`generation_source='reviewer_edited'` and
`parent_segmentation_id=<previous>` — we never mutate the AI mask in
place (FR-017a + research §C.6 audit invariants).

## Model Bill of Materials (MBoM) entry shape

```json
{
  "name": "vista3d-refine",
  "family": "refinement",
  "source_url": "https://github.com/Project-MONAI/VISTA",
  "pinned_commit_sha": "abc1234",
  "license_text_hash": "<sha256 of LICENSE file>",
  "integration_date": "2026-04-19",
  "approver": "Levan Gogichaishvili"
}
```

See sibling `model.info` for the plaintext key/value form.
