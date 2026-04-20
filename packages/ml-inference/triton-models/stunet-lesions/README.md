# STU-Net Lesions (Stage 2)

**Triton model name**: `liverra-stunet-lesions`
**Tier**: B (lazy-loaded — research §C.1)
**License**: Apache 2.0
**Upstream**: https://github.com/uni-medical/STU-Net (STU-Net family, 1.4B params; refactored head for focal-lesion segmentation)

## Purpose

Binary liver-lesion segmentation inside the parenchyma mask (FR-010).
Second detection stage of the v1 cascade; runs per-analysis after
Stage 1 (parenchyma) has produced the liver outline. Output labels
each connected lesion component as `1..L` so the task layer can emit
per-lesion bboxes and masks that drive Stage 4 (LiLNet classification).

Contract: `specs/001-zero-training-mvp/contracts/triton-stages.md §Stage 2`.

## Current state of `1/model.pt`

The checked-in `1/model.pt` is a **16-byte placeholder stub** (`LIVERRA_STUB`).
It exists so the Triton model repository layout is valid in local dev
and CI; real inference requires the real TorchScript export and is
**not** exercised by any committed test.

**TODO (before first staging deployment)**: replace the stub with the
real TorchScript export. See "Export command" below. Pinned commit SHA
is a placeholder until the integration task lands.

## Export command

```bash
# From a machine with GPU + PyTorch 2.3 installed.
git clone https://github.com/uni-medical/STU-Net.git
cd STU-Net
git checkout abc1234   # <-- placeholder; to be replaced by real pinned SHA
python export.py \
  --task lesion \
  --checkpoint_path ./checkpoints/stunet_lesion.pth \
  --output model.pt
# Result: a single `model.pt` TorchScript file ~5–6 GB.
mv model.pt packages/ml-inference/triton-models/stunet-lesions/1/model.pt
```

After export, re-run `scripts/model-bom.sh` (T135) so `MBoM.json`
picks up the refreshed `pinned_commit_sha` + `license_text_hash`.

## Model Bill of Materials (MBoM) entry shape

```json
{
  "name": "stu-net-lesions",
  "family": "segmentation",
  "source_url": "https://github.com/uni-medical/STU-Net",
  "pinned_commit_sha": "abc1234",
  "license_text_hash": "<sha256 of LICENSE file>",
  "integration_date": "2026-04-19",
  "approver": "Levan Gogichaishvili"
}
```

This is what `scripts/model-bom.sh` ingests and what §X.4 of the
research doc binds to every AuditEvent via `detail.model.version`.

See sibling `model.info` for the plaintext key/value form.
