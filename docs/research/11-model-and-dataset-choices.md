# LiverRa — Model & Dataset Choices

## Locked-In Model Stack (All Apache 2.0)

### 1. STU-Net (1.4B parameters)
**Role:** Liver parenchyma segmentation + metastasis detection
**Replaces:** TotalSegmentator (which has paid commercial license on specialized sub-modules — legal trap)
**Why it wins:** 1.4B params pretrained on 100,000+ annotations; Apache 2.0; best-in-class on LiTS + CRLM-CT-Seg
**Expected accuracy:** Liver Dice >0.95, CRLM Dice 0.62
**GitHub:** https://github.com/uni-medical/STU-Net
**Paper:** arxiv.org/abs/2304.06716

### 2. Pictorial Couinaud Segmentation
**Role:** 8-segment topological parsing using vessel bifurcations as anchors
**Why it wins:** Beats voxel-wise segmentation by 15-20% on functional accuracy; produces surgically valid segments (not zig-zag boundaries); patient-specific vascular scaffold
**Expected accuracy:** Dice 0.90+ per segment, robust modality-agnostic
**GitHub:** https://github.com/xukun-zhang/Couinaud-Segmentation
**DOI:** 10.1007/s00261-025-05123-3

### 3. LiLNet (Liver Lesion Network)
**Role:** 6-class tumor classification (HCC / ICC / MET / FNH / HEM / CYST)
**Why it wins:** Trained on 4,039 patients across 6 medical centers; specifically designed for multi-phase contrast CT temporal analysis
**Expected accuracy:** 94.7% benign vs malignant; 97.2% AUC; 88.7% HCC/ICC/MET differentiation
**GitHub:** https://github.com/yangmeiyi/Liver
**Paper:** Nature Communications 2024

### 4. VISTA3D (NVIDIA + MONAI, June 2025)
**Role:** Interactive refinement — surgeon clicks to correct masks in real time
**Why it wins:** Foundation model for 127 anatomical structures; native 3D (not adapted 2D); human-in-loop design
**Expected accuracy:** Zero-shot Dice >0.85 on unseen multi-organ datasets
**GitHub:** https://github.com/Project-MONAI/VISTA
**DOI:** 10.1109/CVPR52734.2025.01943

### 5. MedSAM-2
**Role:** Zero-shot 3D tumor segmentation via one-slice prompt
**Why it wins:** Treats 3D volume as video stream; self-sorting memory bank; single bounding box propagates through entire volume
**Expected accuracy:** Dice >0.90 (prompt-dependent), superior to base SAM on irregular structures
**GitHub:** https://github.com/MedicineToken/Medical-SAM2
**DOI:** 10.48550/arXiv.2408.00874

### Why these 5 and not others

- **TotalSegmentator base** is Apache 2.0 but its **specialized sub-modules require a paid commercial license** — licensing trap. STU-Net replaces it.
- **MedSAM v1** lacks 3D tracking. MedSAM-2 solves this.
- **nnU-Net** is a framework, not a specific model — we use it as STU-Net's foundation.
- **SAM-Med3D** is promptable but not fully automatic — less useful for pipeline vs MedSAM-2's better tracking.

---

## Framework & Tooling

| Layer | Choice | Why |
|---|---|---|
| Deep learning | PyTorch 2.3 | Industry standard, all our models are PyTorch-native |
| Medical imaging extensions | MONAI 1.4+ | Domain-optimized for medical; provides Dice metrics, 3D augmentation, I/O |
| Deployment packaging | MONAI Deploy App SDK | Packages inference as Docker with standard I/O |
| Inference server | NVIDIA Triton | Multi-framework, dynamic batching, MIG-aware GPU sharing |
| Annotation (if fine-tuning later) | MONAI Label + 3D Slicer | Active learning loop → 4x throughput |
| Model registry | MLflow | Regulatory traceability requirement |
| Data versioning | DVC | Regulatory traceability |

---

## Dataset Strategy

### Datasets with Commercial Training Rights (CAN train on)

| Dataset | Size | Modality | License | Role |
|---|---|---|---|---|
| **CRLM-CT-Seg** (April 2026) | 197 CT + FLR masks | CT | CC BY 4.0 (verify on Zenodo) | **Critical — the only public FLR ground truth** |
| **AMOS22** | 500 CT + 100 MRI | Both | **CC BY 4.0** | General abdominal pretraining |
| **Your 10,000 Georgian scans** | 10,000 | CT | DPA-protected (you own) | **Primary commercial training set** |
| **Regensburg + Potsdam** (future DPAs) | 500-2,000 | CT + MRI | DPA-protected | Multi-site diversity |

Zenodo DOI for CRLM-CT-Seg: 10.5281/zenodo.17574862

### Datasets for EVALUATION ONLY (Do NOT train commercial weights on these)

| Dataset | Size | License | Role |
|---|---|---|---|
| **LiTS17** | 131 CT | CC BY-NC-SA | Industry benchmarking |
| **Medical Segmentation Decathlon Task 8** | 131+70 CT | CC BY-SA | Benchmarking |
| **3D-IRCADb-01** | 20 CT | Research | Vessel + tumor gold standard |
| **CHAOS** | 40 CT + 120 MRI | CC BY-SA | MRI baseline |
| **HCC-TACE-Seg (TCIA)** | 105 CT | TCIA default (verify collection) | HCC fine-tune candidate |
| **LiverHccSeg (2026)** | ~500 MRI | Verify before use | MRI HCC (v2 scope) |
| **LLD-MMRI** | ~500 MRI | Research | LiLNet original training distribution |
| **AbdomenCT-1K** | 1,112 CT | CC BY-NC-SA | General organ pretraining (research) |

### Licensing Discipline (NON-NEGOTIABLE)

- Every dataset must have a license audit screenshot stored in `/docs/compliance/dataset-licenses/`
- Training data directory split enforced in code: `/data/train_commercial/` vs `/data/eval_research_only/`
- Dataloader code must raise an error if it points at `eval_research_only/`
- Fraudulent claims about training data are criminal under FDA/MDR — see `02-regulatory-pathway.md`

---

## The 10,000 Scan Question

**Claim in pitch deck:** 10,000 CT/MRI scans available for AI training.

**Reality check (must be answered before v2 fine-tuning):**
1. How many are **biopsy-confirmed** (pathology ground truth)?
2. How many are **multi-phase complete** (non-contrast + arterial + portal venous + delayed)?
3. How many per tumor class? (If 8,500 HCC + 500 hemangioma + 200 mets + rare others → class imbalance crisis)
4. How many scanner vendors / models? (Single-vendor = dataset shift risk)
5. How many institutions? (Single-site = generalization risk)
6. What's the BMI/age/sex/etiology distribution?
7. Are Data Processing Agreements in place?

**For v1 MVP (zero-training): these questions don't block you.**
**For v2 (fine-tuning) and regulatory submission: these are gating.**

---

## Fine-Tuning Strategy (Deferred to Phase 3, Months 4-9)

After v1 MVP + design-partner feedback:

1. **Fine-tune LiLNet** on European patient distribution (LiLNet was trained on Chinese cohorts; European etiology mix differs — more NASH/MAFLD, less HepB)
2. **Fine-tune vessel segmentation** on your annotated vessel data (biggest weakness of zero-training)
3. **Leave STU-Net parenchyma untouched** — it already works
4. **Fine-tune Pictorial Couinaud** only if vessel quality improvement demands it

**Do NOT retrain from scratch.** Always start from Apache 2.0 pretrained weights.

---

## Model Licensing Discipline Summary

✅ **TRAIN commercial weights on:** own data (DPA), CC BY / CC0 datasets, Apache 2.0 pretrained weights
❌ **NEVER train commercial weights on:** CC BY-NC, CC BY-SA, research-only, GPL datasets
✅ **EVALUATE (inference only) on:** any dataset regardless of license (legal because no training occurs)
✅ **BASE your stack on:** Apache 2.0 pretrained weights from the 5 chosen models
❌ **NEVER use:** TotalSegmentator specialized sub-modules without paid license

---

## References

- Foundation model benchmark paper: nnU-Net Revisited (MICCAI 2024)
- LiTS benchmark: Med Image Analysis 2022
- CRLM-CT-Seg benchmarking: Cascaded nnU-Net achieves Dice 0.767 for FLR on this dataset
- TotalSegmentator MRI: Radiology 2025
- MedSAM-2: arXiv 2408.00874
- LiLNet: Nature Communications 2024
- VISTA3D: CVPR 2025 paper 01943
- Pictorial Couinaud: 10.1007/s00261-025-05123-3
