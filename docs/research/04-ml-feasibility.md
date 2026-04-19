# LiverRa — ML Feasibility Analysis

## The 3-Floor Building Model

| Floor | Capabilities | Status | Timeline |
|---|---|---|---|
| **1. Bedrock** | Liver parenchyma seg, Couinaud segments, FLR volumetry | Ship now | 3-6 months |
| **2. Scaffolded** | Vessel trees (trunks), lesion detection, 3-class tumor triage | Near-term | 6-12 months |
| **3. Under construction** | LI-RADS auto-classification, multi-class HCC differential, hepatic artery, biliary tree | Research | Year 2+ |

**Climb them in order. Don't sell top-floor before floor 1 is polished.**

---

## Per-Capability Maturity Table

| # | Capability | Maturity | Best Published Metric | Reality Check |
|---|---|---|---|---|
| 1 | Liver parenchyma segmentation (CT) | **Ship now** | Dice 0.97 (Swin UNETR), 0.95 (nnU-Net) | Commodity. Use STU-Net / TotalSegmentator base (Apache 2.0) |
| 2 | Liver parenchyma (MRI) | Ship now | Dice 0.84 (TotalSegmentator MRI) | Slightly less mature than CT |
| 3 | Couinaud 8 segments | **Near-term** (3-6mo) | Dice 0.93-0.95 per segment (Pictorial method) | Works with vessel landmarks; small segments (I, IV) weaker |
| 4 | FLR volumetry | Ship now (derivative) | Within 5% of manual (Xie 2023) | Once Couinaud works, FLR is geometric calc |
| 5 | Lesion segmentation (contrast CT) | Near-term | Dice 0.70-0.76 (LiTS, CRLM-CT-Seg) | Small lesions (<10mm) weak — decade-old problem |
| 6 | Portal vein segmentation | **Research** | Dice 0.80-0.83 (VSNet 2024) | Distal branches fail; topology unsolved |
| 7 | Hepatic vein segmentation | Research | Dice 0.82-0.84 | Same challenges as portal |
| 8 | Hepatic artery segmentation | **Open problem** | No strong benchmark | Thin, highly variable anatomy |
| 9 | Biliary tree segmentation | Open problem | Specialized MRCP only | Non-contrast CT basically impossible |
| 10 | Lesion detection (any tumor) | Near-term | Sens 0.83-0.93 (SALSA, HCC studies) | Small lesion recall weak |
| 11 | HCC vs non-HCC binary | Near-term | AUC 0.95-0.98 internal; 0.85-0.90 external | Ceiling is radiologist-comparable, external gap real |
| 12 | Multi-class (HCC/HEM/MET/FNH/CYST/ICC) | Research | LiLNet 88.6-88.7% (Nature Comm 2024) | Real-world drops 10-15 pts; FNH vs adenoma genuinely hard |
| 13 | LI-RADS auto-classification | **Not clinical-grade** | Kappa 0.56, F1 0.69-0.84 (Cancer Imaging 2025) | Authors say "further improvements desirable before clinical translation" |
| 14 | Multi-phase temporal modeling | Evolving | SDR-Former, LIDIA, MI-TransSeg (all 2024) | No single established winner; phase alignment headache |

---

## Why Cascaded Wins Over End-to-End (April 2026 Evidence)

The CRLM-CT-Seg benchmark (April 2026, Zenodo DOI: 10.5281/zenodo.17574862) compared cascaded modeling strategies (Liver → Lesions → FLR) against end-to-end (E2E) volumetric processing using nnU-Net, SwinUNETR, and STU-Net.

**Findings:**
- **Cascaded nnU-Net** achieved the highest FLR segmentation **Dice 0.767**
- Pretrained **STU-Net** provided superior CRLM detection at **Dice 0.620**, demonstrating resilience to compounding errors across cascade

**Optimal engineering pathway:** hybrid cascaded architecture where STU-Net is the primary lesion detection engine, feeding into an anatomically constrained prior network (like Pictorial Couinaud) for precise FLR calculation.

---

## Recommended Architecture (v1 MVP)

### Base segmentation layer
**STU-Net** (Apache 2.0, 1.4B params) — fine-tune on your 10k scans to push liver Dice to 0.95+, lesion to 0.65+.

### Couinaud layer
**Pictorial Couinaud model** with landmark-guided supervision (Xie 2023 approach). Uses vessels as scaffold — produces surgically valid segments (not zig-zag voxel-wise boundaries).

### Vessel refinement
**Scope to trunks + primary branches only** for v1 FLR calculation. Defer sub-segmental vessel trees.

### Tumor detection + classification (two-stage)
- **Detection:** LIDIA or SDR-Former style multi-phase transformer with iterative phase fusion
- **Classification:** **LiLNet** (Apache 2.0) fine-tuned on your biopsy-confirmed data + CRLM-CT-Seg metastases. Always with abstention on low-confidence cases. 6 classes: HCC/ICC/MET/FNH/HEM/CYST.

### LI-RADS (decision support only, v1)
Feature extractor highlights arterial hyperenhancement, washout, capsule — does NOT auto-classify LR category. Radiologist confirms.

### Interactive refinement
**VISTA3D + MedSAM-2** as safety net — surgeon clicks to correct masks, one-prompt propagation for novel cases.

---

## Dataset Strategy Summary

**Commercial training:** Your 10k Georgian + AMOS22 (CC BY 4.0) + CRLM-CT-Seg April 2026 (verify CC BY) + future DPA partners (Regensburg, Potsdam).

**Evaluation only:** LiTS17, MSD Task 8, 3D-IRCADb, CHAOS, HCC-TACE-Seg, LLD-MMRI, AbdomenCT-1K.

**Foundation weights:** STU-Net, LiLNet, VISTA3D, MedSAM-2, Pictorial Couinaud (all Apache 2.0).

See `11-model-and-dataset-choices.md` for details.

---

## Deployment / Inference Specifics

- **Typical pipeline latency** (L4 GPU): Liver seg 10s → Couinaud 15s → vessels 20s → lesion detection 15s → classification 5s = **~60-90s total**
- **Cloud cost per scan** (L4 on AWS): ~$0.02-0.05 GPU time — negligible
- **Memory peaks:** 12-16 GB VRAM — works on any GPU ≥16GB
- **DICOM-native workflow:** MONAI Deploy SDK + Orthanc; output DICOM-SEG + SR for PACS round-trip

---

## Honest Reality Check on Pitch Claims

### "Foundation models exceed radiologist accuracy"
- **TRUE** for liver parenchyma seg (pixel-level Dice on curated CT)
- **MIXED** for HCC in cirrhotic livers (matches non-expert radiologists on internal; drops below expert readers on external)
- **FALSE** for full LI-RADS, atypical lesion differential, hepatic artery, biliary tree, any task requiring clinical context
- **Missing caveat:** "Radiologist-level" almost always means "average of 2-3 general radiologists" on curated test set — NOT a subspecialty-trained abdominal radiologist with full clinical context

### "10,000 proprietary scans gives moat"
- Moat for **rare-lesion classification + multi-phase diversity:** yes, IF scans are well-distributed across classes with biopsy ground truth
- Moat for **general segmentation:** minimal — public data + pretrained weights close the gap
- **Real moat:** annotation quality + expert time + clinical workflow integration — NOT raw scan count

### "AI replaces radiologist for liver reads"
- Not in 12-month horizon. Not in 36-month horizon. Not in any regulator's jurisdiction.
- Realistic positioning: **second reader / quantification / triage** (Class IIb SaMD)
- Arterys has this for liver already; Nanox HealthFLD FDA-cleared 2024 for fatty liver quantification
- Auto-LI-RADS is NOT FDA-cleared as of 2026

---

## Framework Stack

- **PyTorch 2.3** — DL engine
- **MONAI 1.4+** — medical-imaging transforms + pipelines
- **MONAI Deploy App SDK** — packaging as Docker with standard I/O
- **NVIDIA Triton** — production inference server
- **Starting weights:** STU-Net (Apache 2.0) for CT + MRI organs/vessels/lesions
- **Annotation:** MONAI Label + 3D Slicer (active learning → 4x throughput)

**Avoid:**
- Training from scratch (2026 edge is fine-tuning + data curation)
- TensorFlow (dying in medical imaging)
- Raw PyTorch for inference (Triton gives 4x throughput via dynamic batching)
- HuggingFace transformers for 3D medical (wrong tool for voxels)
- TotalSegmentator specialized sub-modules (paid commercial license)

---

## Risk Table

| Risk | Severity | Mitigation |
|---|---|---|
| Domain shift across CT scanners | High | Multi-site data; GE + Siemens + Philips + Canon; strong augmentation |
| Phase labels wrong in DICOM | **High (15-30% wrong in wild)** | Audit phase metadata before training |
| Small lesions missed | High | Size-stratified metrics; don't let averages hide this |
| Non-biopsy labels limit classification | High | Report two accuracy numbers: biopsy-confirmed vs full dataset |
| Vessel topology failures | Medium | Use clDice or centerline metrics, not just Dice |
| Missing-phase at inference | Medium | LIDIA-style phase-flexible architecture |
| Overfitting to single institution | Medium | ≥30% external validation held out |
| Commercial license contamination | Medium | Audit: MSD/LiTS research-only; STU-Net/LiLNet/VISTA3D/MedSAM-2 safe |
| Radiologist inter-annotator disagreement | Medium | ≥2 readers on test set; kappa as performance ceiling |

---

## Recommended 12-Month Realistic Roadmap

1. **Q1-Q2 (months 1-6): Segmentation product** — Liver + Couinaud + FLR on contrast CT, Dice 0.95+ liver, 0.90+ segments. Fine-tuned STU-Net. This ships and generates revenue.
2. **Q2-Q3 (months 4-9): Vessel + tumor mask add-on** — Portal/hepatic vein trunks + primary branches for FLR; tumor mask + volumetric follow-up.
3. **Q3-Q4 (months 7-12): Tumor detection + 3-class classification** — benign/malignant + simple-cyst/hemangioma/solid-suspicious. Always with abstention + radiologist review.
4. **Q4 (months 10-12): LI-RADS feature extractor** (not auto-classifier). Highlights APHE, washout, capsule as decision support.
5. **Defer to year 2+:** Full LI-RADS auto-classification, biliary tree, hepatic artery, FNH/adenoma differentiation.
