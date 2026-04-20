# MedSAM-2 One-Prompt Tracking (Stage 6)

**Triton model name**: `liverra-medsam2-track`
**Tier**: B (lazy-loaded — research §C.1)
**License**: Apache 2.0
**Upstream**: https://github.com/MedicineToken/Medical-SAM2 (SAM2-tiny medical derivative)

## Purpose

One-prompt 3D tumor segmentation / tracking (FR-016). The reviewer
drops a single marker on a missed or mis-sized lesion; MedSAM-2
produces a full 3D binary mask of that lesion by slice-to-slice
tracking from the prompt. Runs out-of-band from the main cascade —
invoked by `POST /api/v1/reviews/{review_id}/lesion-prompt`.

Contract: `specs/001-zero-training-mvp/contracts/triton-stages.md §Stage 6`.

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
# From a machine with GPU + PyTorch 2.3 installed.
git clone https://github.com/MedicineToken/Medical-SAM2.git
cd Medical-SAM2
git checkout abc1234   # <-- placeholder; to be replaced by real pinned SHA
python export_medsam2_torchscript.py \
  --checkpoint_path ./weights/medsam2_tiny.pt \
  --output model.pt
# Result: a single `model.pt` TorchScript file ~350 MB.
mv model.pt packages/ml-inference/triton-models/medsam2-track/1/model.pt
```

After export, re-run `scripts/model-bom.sh` (T135) so `MBoM.json`
picks up the refreshed `pinned_commit_sha` + `license_text_hash`.

## Post-processing

The new `lesion_mask` from MedSAM-2 is fed through Stage 4 (LiLNet)
for classification, and a new Lesion row is appended with
`discovery_source='reviewer_prompted'` (spec contracts §Stage 6 +
FR-016). No mutation of existing Lesion rows — every reviewer prompt
is an append, so the audit chain remains linear.

## Model Bill of Materials (MBoM) entry shape

```json
{
  "name": "medsam2-track",
  "family": "tracking",
  "source_url": "https://github.com/MedicineToken/Medical-SAM2",
  "pinned_commit_sha": "abc1234",
  "license_text_hash": "<sha256 of LICENSE file>",
  "integration_date": "2026-04-19",
  "approver": "Levan Gogichaishvili"
}
```

See sibling `model.info` for the plaintext key/value form.
