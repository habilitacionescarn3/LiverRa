# Triton Model I/O Contracts

**Feature**: 001-zero-training-mvp · **Research**: [`../research.md`](../research.md) §C · **Plan**: [`../plan.md`](../plan.md)

Each cascade stage exposes a Triton endpoint with a versioned input/output contract. The orchestrator (research C.2) invokes these in sequence; `PipelineCheckpoint` rows are written at every boundary.

## Shared conventions

- **Base image**: `nvcr.io/nvidia/tritonserver:24.08-py3`
- **Model control mode**: `--model-control-mode=explicit` (research C.1)
- **Instance group**: `{ kind: KIND_GPU, count: 1 }` on every model
- **Max batch size**: `1` (single L4; 3D volumes do not batch well in this pipeline)
- **Transport**: gRPC from the FastAPI orchestrator (`tritonclient.grpc.InferenceServerClient`); shared memory for stage-to-stage NumPy tensors within a Celery task (research C.3)
- **Naming**: `liverra-<family>-<stage>-<version>`, version is a monotonic integer bumped per MBoM release
- **Dtypes**: `fp16` weights by default; inputs are `fp32` volumes, outputs are `uint8` label maps or `fp32` probability vectors per stage
- **Coordinate convention**: RAS+, 1.5 mm isotropic resampling at the orchestrator layer — models see pre-resampled volumes
- **Voxel convention for masks**: `uint8` with `0=background, N=structure index` for multi-class; `0/1` for binary
- **Audit binding**: every inference call carries `case_id`, `analysis_id`, `stage_no`, `model_version` in request metadata headers — copied into the AuditEvent

---

## Stage 1 — STU-Net Parenchyma

**Model name**: `liverra-stunet-parenchyma`
**Purpose**: Binary liver-parenchyma segmentation (FR-007)
**Tier**: A (always loaded — research C.1)
**Upstream**: https://github.com/uni-medical/STU-Net (STU-Net-Huge, 1.4B params; Apache 2.0)

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `ct_volume` | `[1, 1, Z, 512, 512]` | fp32 | HU values, pre-windowed abdominal preset (-150/250), resampled to 1.5 mm isotropic |
| input | `phase_hint` | `[1, 4]` | fp32 | One-hot: non_contrast / arterial / portal_venous / delayed. Missing phases = zero. |
| output | `parenchyma_mask` | `[1, 1, Z, 512, 512]` | uint8 | `1 = parenchyma`, `0 = background` |
| output | `confidence_per_voxel` | `[1, 1, Z, 512, 512]` | fp16 | Optional; used by sanity checks (research C.7) |
| output | `stage_metrics` | json | — | `{voxel_count, estimated_dice, inference_latency_ms}` |

**Sanity checks** (FR-007a):
- `300 mL ≤ voxel_count × voxel_volume_mL ≤ 3,500 mL`
- `parenchyma_mask.sum() > 0`
- No NaN in `confidence_per_voxel`

**Stage timeout**: 45 s (p99).
**Partial-result behavior**: Stage 1 failure ⇒ Analysis.status=failed (no downstream can proceed). No partial result to present.

---

## Stage 2 — STU-Net Lesion

**Model name**: `liverra-stunet-lesions`
**Purpose**: Lesion detection + binary lesion mask inside parenchyma (FR-010)
**Tier**: A (always loaded)
**Upstream**: Same family as Stage 1, refactored checkpoint; Apache 2.0

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `ct_volume` | `[1, 1, Z, 512, 512]` | fp32 | Same as Stage 1 |
| input | `parenchyma_mask` | `[1, 1, Z, 512, 512]` | uint8 | From Stage 1 — crops inference to liver |
| output | `lesion_mask` | `[1, 1, Z, 512, 512]` | uint8 | `N = lesion_index (1..L)`, `0 = non-lesion` |
| output | `lesion_count` | scalar | int32 | |
| output | `lesion_bboxes` | `[L, 6]` | int32 | `[z_min, y_min, x_min, z_max, y_max, x_max]` per lesion |
| output | `lesion_confidences` | `[L]` | fp32 | Per-lesion detection confidence |

**Sanity checks**:
- Every lesion voxel MUST be inside `parenchyma_mask` (≥95% containment per FR-007a)
- `lesion_count` ≥ 0; 0 is valid (no lesions)
- `lesion_confidences` all in `[0, 1]`

**Stage timeout**: 40 s.

---

## Stage 3 — Pictorial Couinaud

**Model name**: `liverra-couinaud-segments`
**Purpose**: 8-region Couinaud segmentation + portal/hepatic vein trunk masks (FR-008, FR-009)
**Tier**: A
**Upstream**: https://github.com/xukun-zhang/Couinaud-Segmentation (Apache 2.0)

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `ct_volume` | `[1, 1, Z, 512, 512]` | fp32 | |
| input | `parenchyma_mask` | `[1, 1, Z, 512, 512]` | uint8 | From Stage 1 |
| output | `couinaud_mask` | `[1, 1, Z, 512, 512]` | uint8 | `1..8 = Couinaud I..VIII`, `0 = background` |
| output | `portal_vein_mask` | `[1, 1, Z, 512, 512]` | uint8 | Binary |
| output | `hepatic_vein_mask` | `[1, 1, Z, 512, 512]` | uint8 | Binary |
| output | `per_segment_volume_ml` | `[8]` | fp32 | |
| output | `topology_confidence` | scalar | fp32 | Whole-liver topology confidence; flags below-threshold cases |

**Sanity checks**:
- All 8 segments present with `volume_ml > 0`
- Sum of segment volumes ≈ parenchyma volume (±2%)
- Vessel masks ≥90% contained in parenchyma

**Stage timeout**: 35 s.

---

## Stage 4 — LiLNet Classification

**Model name**: `liverra-lilnet-classify`
**Purpose**: Per-lesion 6-class classification (FR-010, FR-011) with temperature-scaled calibration (research C.7)
**Tier**: B (lazy-loaded on first call per session; unload after 10 min idle)
**Upstream**: https://github.com/yangmeiyi/Liver (Apache 2.0)

Called **once per lesion** (or batched if Triton supports dynamic batch; v1 = sequential).

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `lesion_crop` | `[1, 4, 96, 96, 96]` | fp32 | 4 phases × 96³ isotropic crop centered on lesion bbox |
| input | `lesion_phase_mask` | `[1, 4]` | fp32 | Which phases are present (to zero-out absent channels) |
| output | `class_logits` | `[1, 6]` | fp32 | Raw pre-softmax logits |
| output | `class_probs_calibrated` | `[1, 6]` | fp32 | Post-temperature-scaling softmax; Σ = 1.0 ± 1e-6 |
| output | `temperature_applied` | scalar | fp32 | Calibration T used |
| output | `abstain` | scalar | bool | `true` if `max(class_probs) < tenant_abstention_threshold` |

**Class order**: `[hcc, icc, metastasis, fnh, hemangioma, cyst]`
**Tenant abstention threshold**: default 0.50; configurable per tenant (FR-011).

**Sanity checks**:
- `class_probs_calibrated` all in `[0, 1]`; Σ = 1.0 ± 1e-6
- `abstain == true` ⇒ persisted `Classification.suggested_class = 'abstained'`

**Stage timeout**: 10 s per lesion (15 s cold-load budget on first call).

---

## Stage 5 — VISTA3D Interactive Refinement

**Model name**: `liverra-vista3d-refine`
**Purpose**: Click-to-refine any mask (FR-015) — out-of-band with the main pipeline
**Tier**: B (lazy-loaded on first refine click per session)
**Upstream**: https://github.com/Project-MONAI/VISTA (VISTA3D; Apache 2.0)

Invoked via `POST /api/v1/reviews/{review_id}/mask-refine`.

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `ct_volume_crop` | `[1, 1, Zc, 128, 128]` | fp32 | Crop around click point, Zc≈128 |
| input | `current_mask_crop` | `[1, 1, Zc, 128, 128]` | uint8 | The mask being refined, cropped identically |
| input | `click_point_local` | `[1, 3]` | int32 | Click coordinate in the crop |
| input | `click_mode` | scalar | int32 | `0 = add`, `1 = subtract` |
| input | `anatomy_class` | scalar | int32 | Which of the 127 VISTA3D classes to bias toward (liver, segment, vessel, lesion) |
| output | `refined_mask_crop` | `[1, 1, Zc, 128, 128]` | uint8 | |
| output | `refinement_latency_ms` | scalar | int32 | |

**Stage timeout**: 30 s (FR-015 hard limit).
**Note**: The 128³ crop keeps the API call under the 30 s budget on L4; the orchestrator composites the refined crop back into the full-resolution mask, writes a new Segmentation row with `generation_source=reviewer_edited`.

---

## Stage 6 — MedSAM-2 One-Prompt Tracking

**Model name**: `liverra-medsam2-track`
**Purpose**: Single-marker 3D tumor segmentation (FR-016)
**Tier**: B (lazy-loaded on first lesion re-prompt per session)
**Upstream**: https://github.com/MedicineToken/Medical-SAM2 (Apache 2.0; SAM2-tiny derivative)

Invoked via `POST /api/v1/reviews/{review_id}/lesion-prompt`.

| I/O | Name | Shape | Dtype | Notes |
|---|---|---|---|---|
| input | `ct_volume` | `[1, 1, Z, 512, 512]` | fp32 | Full volume (MedSAM-2 is efficient on 3D tracking) |
| input | `prompt_point` | `[1, 3]` | int32 | Voxel index |
| output | `lesion_mask` | `[1, 1, Z, 512, 512]` | uint8 | New binary lesion mask |
| output | `tracking_confidence` | scalar | fp32 | |
| output | `bounding_box` | `[6]` | int32 | `[z_min, y_min, x_min, z_max, y_max, x_max]` |

**Post-processing**: The orchestrator feeds the new `lesion_mask` through Stage 4 (LiLNet) for classification, then appends a new Lesion row with `discovery_source=reviewer_prompted`.

**Stage timeout**: 25 s.

---

## Pipeline invariants (orchestrator contract)

- **Order**: Stages 1 → 2 → 3 → 4 (per-lesion). Stages 5/6 out-of-band during review.
- **Checkpointing**: PipelineCheckpoint row written after every stage (research X.2). GPU lease released only after checkpoint commit.
- **Timeouts**: Sum of stages 1+2+3 ≤ 120 s (FR-014 hard limit). Analysis.status=failed on any stage timeout with `timeout_reason` set.
- **Sanity gate**: Every output passes the stage-specific sanity block before advancing (FR-007a). Failures → Analysis.status=failed with `implausible_output_reason`.
- **Model version**: Every inference carries the MBoM row key; AuditEvent's `model.version` extension is set from this (research X.4).
- **Cold start**: First case after GPU spin-up may incur 60–120 s Tier-A load + warm-up (FR-034). Surfaced to the client as a distinct "warming up" state, not an error.
