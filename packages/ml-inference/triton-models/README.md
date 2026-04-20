# Triton model repository — schema for `model.info`

Each subdirectory under `packages/ml-inference/triton-models/` represents
one pretrained model served by the Triton Inference Server. Every model
directory MUST contain:

- `model.info` — plaintext metadata (format below)
- `LICENSE` (or `LICENSE.md`) — the upstream license text, copied
  verbatim at integration time. The sha256 of this file is pinned
  into `MBoM.json` (`scripts/model-bom.sh`) and re-verified on every
  build by `scripts/license-check.sh` (T136) for FR-038 compliance.
- `config.pbtxt` — standard Triton model configuration (shape,
  batching, execution backend).
- weight artefacts (model.pt, onnx, trt, etc.) — not checked into
  git; pulled lazily via DVC or S3 at deploy time.

## `model.info` schema

Plaintext `key: value` pairs, one per line. Keys are case-insensitive.

| Key                   | Required | Example                                         | Notes                                               |
|-----------------------|:--------:|-------------------------------------------------|-----------------------------------------------------|
| `name`                | yes      | `stu-net`                                       | Canonical model identifier.                         |
| `family`              | yes      | `segmentation`                                  | Grouping tag (segmentation / classification / refine). |
| `source_url`          | yes      | `https://github.com/uni-medical/STU-Net`        | Upstream repo (GitHub / GitLab / Zenodo record).    |
| `pinned_commit_sha`   | yes      | `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`      | Full 40-char git SHA or Zenodo version DOI.         |
| `license_file`        | yes      | `LICENSE`                                       | Relative path inside this model directory.          |
| `integration_date`    | yes      | `2026-04-19`                                    | ISO-8601 date of integration PR merge.              |
| `approver`            | yes      | `Levan Gogichaishvili`                          | Human reviewer of the integration + licence.        |

### Example

```
name: stu-net
family: segmentation
source_url: https://github.com/uni-medical/STU-Net
pinned_commit_sha: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
license_file: LICENSE
integration_date: 2026-04-19
approver: Levan Gogichaishvili
```

## Licensing discipline

Every model MUST be Apache-2.0 (or equivalent permissive for
commercial use). See `CLAUDE.md` → "Model Licensing Discipline" for
the full allow / deny list.

The MBoM pipeline blocks the build on:

1. Missing LICENSE file.
2. Missing/invalid `model.info` keys.
3. Upstream LICENSE hash that no longer matches the pinned hash
   (licence drift — a human must review and re-approve).
