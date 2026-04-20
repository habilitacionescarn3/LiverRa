# Pictorial Couinaud (Stage 3)

**Triton model name**: `liverra-couinaud-segments`
**Tier**: A (always loaded — research §C.1)
**License**: Apache 2.0
**Upstream**: https://github.com/xukun-zhang/Couinaud-Segmentation
**Covers**: FR-008 (8-segment Couinaud parsing), FR-009 (portal + hepatic vein trunks)

## Purpose

Joint 8-region Couinaud segmentation + portal / hepatic vein trunk
extraction (FR-008, FR-009). Third stage of the v1 cascade; consumes
the binary parenchyma mask from Stage 1 (STU-Net) and emits two output
tensors:

- an 8-channel softmax volume (one channel per Couinaud region I..VIII)
- a 2-channel binary volume (portal + hepatic vein trunks)

The cascade pulls one Triton request for both `segment_couinaud` and
`segment_vessels` — see `src/tasks/couinaud.py` + `src/tasks/vessels.py`.

Contract: `specs/001-zero-training-mvp/contracts/triton-stages.md §Stage 3`.

## Current state of `1/model.pt`

The checked-in `1/model.pt` is a **16-byte placeholder stub** (`LIVERRA_STUB`).
It exists so the Triton model repository layout is valid in local dev and
CI; real inference requires the real TorchScript export and is **not**
exercised by any committed test.

**TODO (before first staging deployment)**: replace the stub with the real
TorchScript export from the upstream repo. See "Export command" below.
Pinned commit SHA is a placeholder until the integration task lands.

## Export command

```bash
# From a machine with GPU + PyTorch 2.3 installed.
git clone https://github.com/xukun-zhang/Couinaud-Segmentation.git
cd Couinaud-Segmentation
git checkout def5678   # <-- placeholder; to be replaced by real pinned SHA
python export_torchscript.py \
  --config configs/pictorial_couinaud.yaml \
  --checkpoint ./checkpoints/pictorial_couinaud_final.pth \
  --output model.pt
# Result: a single `model.pt` TorchScript file ~300 MB.
mv model.pt packages/ml-inference/triton-models/couinaud-segments/1/model.pt
```

After export, re-run `scripts/model-bom.sh` (T135) so `MBoM.json` picks
up the refreshed `pinned_commit_sha` + `license_text_hash`.

## Model Bill of Materials (MBoM) entry shape

```json
{
  "name": "pictorial-couinaud",
  "family": "segmentation",
  "source_url": "https://github.com/xukun-zhang/Couinaud-Segmentation",
  "pinned_commit_sha": "def5678",
  "license_text_hash": "<sha256 of LICENSE file>",
  "integration_date": "2026-04-19",
  "approver": "Levan Gogichaishvili",
  "covers_frs": ["FR-008", "FR-009"]
}
```

## Sanity checks enforced downstream

From `contracts/triton-stages.md §Stage 3` + `src/orchestrator/sanity.py`:

- All 8 segments present, each with `volume_ml > 0`
- `Σ segment_volume_ml ≈ parenchyma_volume_ml ± 2%`
- Vessel masks ≥90% contained within parenchyma

Failures emit `Analysis.implausible_output_reason = sum_mismatch` or
`segment_zero_volume` per the Pydantic contracts in `sanity.py`.

See sibling `model.info` for the plaintext key/value form.
