# LiLNet Classification (Stage 4)

**Triton model name**: `liverra-lilnet-classify`
**Tier**: B (lazy-loaded — research §C.1)
**License**: Apache 2.0
**Upstream**: https://github.com/yangmeiyi/Liver

## Purpose

Per-lesion 6-class liver-tumor classification (FR-010, FR-011). The
six classes, in fixed order, are:

```
[hcc, icc, metastasis, fnh, hemangioma, cyst]
```

Called **once per lesion** detected by Stage 2 (STU-Net lesions). The
task layer (`src/tasks/classification.py`) applies per-tenant
temperature scaling (research §C.7) to the raw logits before softmax,
and fires the abstention flag when `max(probs) <
tenant.abstention_threshold` (default 0.65) — writing
`Classification.suggested_class='abstained'` per FR-011.

Contract: `specs/001-zero-training-mvp/contracts/triton-stages.md §Stage 4`.

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
git clone https://github.com/yangmeiyi/Liver.git
cd Liver
git checkout def5678   # <-- placeholder; to be replaced by real pinned SHA
python export_torchscript.py \
  --checkpoint ./weights/lilnet_6class.pth \
  --output model.pt
mv model.pt packages/ml-inference/triton-models/lilnet-classify/1/model.pt
```

After export, re-run `scripts/model-bom.sh` (T135) so `MBoM.json`
picks up the refreshed `pinned_commit_sha` + `license_text_hash`.

## Model Bill of Materials (MBoM) entry shape

```json
{
  "name": "lilnet-classify",
  "family": "classification",
  "source_url": "https://github.com/yangmeiyi/Liver",
  "pinned_commit_sha": "def5678",
  "license_text_hash": "<sha256 of LICENSE file>",
  "integration_date": "2026-04-19",
  "approver": "Levan Gogichaishvili"
}
```

See sibling `model.info` for the plaintext key/value form.
