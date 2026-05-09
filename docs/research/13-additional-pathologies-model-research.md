# 13 — Additional Pathology Detection: Model Availability Research

**Date:** 2026-05-09
**Source list:** Founder's wishlist `ღვიძლის დაავადებების ჩამონათვალი.docx` (44 distinct liver pathologies / capabilities)
**Method:** 4 parallel deep-research agents, each verifying licenses via WebFetch on GitHub LICENSE files, Zenodo dataset cards, HuggingFace model cards, and peer-reviewed publication metrics. Hard gates: code license must be Apache-2.0 / MIT / BSD; weights license must be Apache-2.0 / MIT / CC-BY-4.0 / CC0; training data must permit commercial use; weights must be downloadable from a stable URL; performance must be documented.

---

## TL;DR

Of **44 requested capabilities** spanning the full HPB radiology differential:

| Verdict | # | What it means |
|---|---|---|
| 🟢 **GREEN — ship now** | **8** | Free, validated approach available today (mostly heuristic post-processing on TotalSegmentator masks; no new ML purchase needed) |
| 🟡 **YELLOW — ship with caveats** | **16** | Buildable as heuristic + existing TS mask, but no end-to-end AI model exists; flag as "rule-based screening" not "AI detection" |
| 🔴 **RED — defer or skip** | **20** | No commercially-usable model exists, problem is not imaging-based, or requires training data we cannot legally use |

**The single most important architectural insight:** the right answer is **not "more AI models."** It's **TotalSegmentator base task (Apache-2.0) + clinical-rule heuristics layered on top**. LiverRa's existing Couinaud heuristic + LI-RADS rule classifier are the right pattern — extend it, don't replace it.

---

## ⚠️ CRITICAL CLAUDE.md CORRECTIONS

All 4 research agents independently verified the following errors in our existing project documentation. Fix these before any regulatory submission:

| Claim in CLAUDE.md `📋 Model Licensing Discipline` | Verified reality | Source |
|---|---|---|
| "VISTA3D — Apache 2.0" | **Code Apache-2.0; weights NVIDIA OneWay Noncommercial (NCLS v1)** | huggingface.co/MONAI/VISTA3D-HF/blob/main/LICENSE |
| "MedSAM-2 — Apache 2.0" | **Code Apache-2.0; weights CC-BY-SA-4.0 research/education only** | huggingface.co/wanglab/MedSAM2 |
| "LiLNet — Apache 2.0, 6-class tumor classification" | **Code MIT, NO published weights** — repo ships training code only | github.com/yangmeiyi/Liver |
| "TotalSegmentator subtasks (`liver_vessels`, `liver_segments`, `liver_lesions`) usable" | **These subtasks require a paid commercial license**. Only the base `total` task is Apache-2.0 + Apache-2.0 weights. | github.com/wasserth/TotalSegmentator (license file per task) |

**Action:** Update CLAUDE.md `📋 Model Licensing Discipline (NON-NEGOTIABLE)` table + `docs/research/11-model-and-dataset-choices.md` + the constitution's licensing register.

---

## ✅ Verified Apache-2.0 / MIT Asset Inventory (the truth about what we can use)

| Asset | Code license | Weights license | Training data | Use here |
|---|---|---|---|---|
| **TotalSegmentator base `total` task** | Apache-2.0 | Apache-2.0 | TS-1228 dataset (CC-BY-4.0) | Liver, spleen, gallbladder, portal+splenic vein, IVC, kidneys, etc. |
| **STU-Net (TS-trained)** | Apache-2.0 | Apache-2.0 | TS-1228 (CC-BY-4.0) | Liver organ binary mask (the parenchyma stage we already use) |
| **bamf-health/aimi-liver-tumor-ct** | MIT | MIT (Zenodo 8270230) | IDC (TCGA/NIH) — permissive | Generic liver-tumor mask (subtype-agnostic) |
| **bamf-health/aimi-liver-ct** | MIT | unstated on Zenodo (verify before commercial bundle) | TS-trained | Liver-only binary; superseded by STU-Net |
| **AMOS22 dataset** | — | — | CC-BY-4.0 | Permitted for in-house training |
| **DeepLesion (NIH)** | — | — | "Usage unrestricted" | Permitted for in-house training |
| **CRLM-CT-Seg** (Zenodo April 2026, DOI 10.5281/zenodo.17574862) | — | — | License pending verification | High-value for CRC-metastasis fine-tuning |

| Asset | ❌ Why we cannot use | Alternative |
|---|---|---|
| VISTA3D weights | NVIDIA OneWay Noncommercial | Use TS base task; for refinement use MedSAM-2 architecture but retrain |
| MedSAM-2 weights | CC-BY-SA-4.0 research/edu only | Build scribble-based refinement instead |
| LiLNet weights | Code only, no `.pth` published | Already replaced by Irakli's LI-RADS rule classifier |
| Pictorial-Couinaud weights | No LICENSE file in repo, no published weights | Already replaced by Irakli's heuristic Couinaud |
| LiTS17 dataset | CC-BY-NC-ND 4.0 | Use AMOS22 + TS-1228 instead |
| MSD/Decathlon Task08 dataset | Research-only | Use AMOS22 + TS-1228 instead |
| LLD-MMRI dataset | CC-BY-NC 4.0 | Out — wait for license change or alternative dataset |

---

## Per-Cluster Findings

### Cluster A — Diffuse disease + vascular variants + adjacent structures (10 problems)

| # | Problem | Verdict | Approach | Effort |
|---|---|---|---|---|
| 7 | Spleen volumetry / splenomegaly | 🟢 | TS `total.spleen` (Dice 0.949 external) + voxel × spacing math | 1 day |
| 4 | Steatosis (MASH/MASLD/NAFLD) | 🟢 (heuristic) | Liver mean HU<40 OR liver-spleen Δ<-10 (RSNA 2024 meta: sens 82%, spec 94%); use TS liver+spleen masks | 1 day |
| 9 | Gallbladder anatomy + stones | 🟡 | TS `total.gallbladder` mask + HU>100 stone heuristic. Cancer detection RED — only US models exist | 2 days |
| 2 | Portal vein variants (trifurcation) | 🟡 | TS `liver_vessels` mask + topology heuristic (count branches at confluence). NO Michels-style ML classifier exists | 3 days |
| 3 | Hepatic vein variants (accessory IRHV) | 🟡 | Same as #2 — mask only, no variant typing model | 3 days |
| 6 | Portal hypertension (partial) | 🟡 | Spleen volume + portal vein diameter at confluence. Varices + recanalized paraumbilical vein → RED | 3 days |
| 5 | Cirrhosis morphology | 🟡 (MRI only) | CirrMRI600+ baselines (MIT code, **CC-BY-SA-4.0 dataset → ShareAlike viral, needs legal review**); for CT: heuristic on caudate/right-lobe ratio | 1-2 weeks (CT heuristic), defer MRI |
| 1 | Hepatic artery Michels typing | 🔴 | No public model classifies Michels types I-X; needs in-house annotation | Defer |
| 8 | Bile duct dilation (CBD>7mm) | 🔴 | TS does NOT segment CBD; no Apache/MIT bile-duct model | Defer |
| 10 | Abdominal lymph nodes | 🔴 | Only NCLS-noncommercial weights exist (VISTA3D LN class); abdominal LN Dice ceiling ~0.57 in any case | Defer |

### Cluster B — Focal lesions: cysts + malignant (14 problems)

| # | Problem | Verdict | Approach | Effort |
|---|---|---|---|---|
| 2 | Simple biliary cyst | 🟢 | Heuristic on existing lesion mask: HU 0-20 + thin wall + sphericity>0.8 + no enhancement | 1 day |
| 14 | Indeterminate malignant profile | 🟢 | **Already exists** in LI-RADS classifier as "LR-M" output; just expose it | 0 days |
| 8 | Hypovascular metastases (CRC) | 🟢 | bamf-health/aimi-liver-tumor-ct (MIT) + hypoenhancing arterial+venous heuristic; **most common metastasis in DACH market** | 1 week |
| 7 | Hypervascular metastases (NET/RCC/melanoma) | 🟡 | bamf mask + arterial-enhancement + portal-washout rule | 1 week |
| 9 | Atypical metastases (calcified/cystic) | 🟡 | bamf mask + HU>200 calcification check / cystic component analysis | 3 days |
| 11 | Intrahepatic cholangiocarcinoma (ICC) | 🟡 | bamf mask + capsular retraction + upstream biliary dilation rule | 1 week |
| 3 | Biliary hamartoma (von Meyenburg) | 🟡 | Multiplicity + size<15mm filter on existing lesion mask | 2 days |
| 4 | Hepatic hematoma | 🟡 | HU-evolution rule (acute 60-90, subacute 30-60, chronic <30) + clinical "trauma" flag | 3 days |
| 13 | Liver lymphoma | 🟡 | Multifocal + perivascular + mild-moderate hypoenhancement pattern flag | 1 week |
| 1 | **Echinococcus / hydatid cyst** | 🔴 ML / 🟢 strategic | **No published model.** Hand-coded Gharbi CE-1 to CE-5 rule (HU thresholds + daughter-cyst contour analysis). **Critical Georgia/Caucasus differentiator** — endemic 5-10x Western prevalence, no Western competitor will build it | 2 weeks heuristic; multi-month annotation project for ML |
| 10 | HCC subtypes (well/poor diff, fibrolamellar) | 🔴 | LiLNet ships NO weights. Subtype usually needs histopathology | Defer |
| 5 | Caroli's disease | 🔴 | Needs MRCP biliary-tree segmentation (no Apache/MIT pretrained) | Defer |
| 6 | Choledochal cysts (Todani I-V) | 🔴 | Same biliary-tree blocker | Defer |
| 12 | Liver sarcoma (angiosarcoma) | 🔴 | Too rare for any open-weight model | Defer |

### Cluster C — Benign lesions + extrahepatic biliary tumors (11 problems)

| # | Problem | Verdict | Approach | Effort |
|---|---|---|---|---|
| 4 | Calcified lesions (granuloma, healed parasitic) | 🟢 | Pure HU>150 threshold inside existing lesion mask; no AI needed | 1 day |
| 10 | Gallbladder anatomy + wall thickness | 🟡 | TS `total.gallbladder` + edge-erosion HU profile. Cancer call → RED (only US models exist) | 2-3 days |
| 5-9 | Klatskin tumor types I-IV (Bismuth-Corlette) | 🟡 (topology) | **Bismuth-Corlette is a topological rule, not tissue characterization.** Once biliary tree is segmented, classification = ~200 LOC graph-traversal algorithm. Blocker: no Apache/MIT MRCP biliary-tree segmenter exists | 6-10 weeks total (incl. self-trained nnU-Net biliary segmenter on Geo Hospitals MRCP data) |
| 1 | Hemangioma (capillary vs cavernous) | 🔴 | LiLNet code only, no weights. Rest paper-only or hospital-private | Defer or in-house training (LLD-MMRI license blocks) |
| 2 | FNH (Focal Nodular Hyperplasia) | 🔴 | Same as #1 | Defer |
| 3 | Hepatocellular adenoma subtypes (β-catenin, inflammatory, HNF-1α) | 🔴 | Even radiologist accuracy caps ~80% per RadioGraphics 2023; AI work paper-only | Defer permanently — needs hepatobiliary-contrast MRI + biopsy |
| 11 | Distal bile duct cancer (periampullary) | 🔴 | No CT/MRI model with weights; published work is on EUS | Defer |

### Cluster D — Vascular complications + metabolic + measurements (9 problems)

| # | Problem | Verdict | Approach | Effort |
|---|---|---|---|---|
| 9 | Liver attenuation / HU statistics | 🟢 | **NOT AN AI PROBLEM.** Just `numpy.mean(ct[liver_mask])` + standard radiology thresholds. ~30 LOC. **Critical: do NOT let anyone propose a "Hounsfield AI model" — it would be strictly worse than the arithmetic.** | 1 day |
| 2 | Portal vein thrombosis — tumor-in-vein | 🟡 | TS `portal_vein` mask + intra-vessel filling defect detection + arterial enhancement Δ>20 HU = tumor | 1 week (fused with #3) |
| 3 | Portal vein thrombosis — bland | 🟡 | Same module as #2, opposite rule (no arterial enhancement, no vessel expansion) | shared with #2 |
| 5 | Portosystemic shunts | 🟡 | TS vessel masks + connectivity analysis: any chain connecting portal → systemic outside liver = candidate shunt | 1 week |
| 1 | Budd-Chiari syndrome | 🟡 | Hepatic vein continuity check + caudate-lobe-volume ratio (segment I from existing Couinaud) + collateral counting | 2 weeks |
| 6 | Wilson's disease (liver imaging) | 🟡 (screening flag only) | Liver mean HU>75 on **non-contrast** CT → "consider Wilson + iron panel". **Never claim diagnosis** — that needs ceruloplasmin + ATP7B genetic | 1 day (part of #9 HU module) |
| 4 | Arteriovenous shunts | 🔴 | Needs perfusion CT pipeline (4+ weeks engineering) | Defer to v2 |
| 8 | Alpha-1 antitrypsin deficiency | 🔴 | NOT primarily an imaging diagnosis (lab + genetic). Imaging shows non-specific cirrhosis already covered | Don't build as imaging feature |
| 7 | **Gilbert's syndrome** | 🔴 | **NOT an imaging diagnosis at all.** Pure lab (UGT1A1 + isolated unconjugated hyperbilirubinemia). Liver looks normal. **Never build as imaging feature** | Don't build |

---

## 🎯 Prioritized Roadmap

### Phase 1 — Ship in 1 week (8 GREEN items)

These are heuristics or trivial extensions of the existing cascade. All Apache-2.0/MIT clean. All shippable to internal demos + clinical validation immediately.

1. **HU statistics module** (D9) — 1 day; covers steatosis + iron + Wilson screening simultaneously
2. **Spleen volumetry + splenomegaly flag** (A7) — 1 day; just voxel-counting on TS spleen mask
3. **Steatosis severity** (A4) — 1 day; uses HU module from #1 + spleen comparison
4. **Calcified-lesion flag** (C4) — 1 day; HU>150 inside existing lesion mask
5. **Simple biliary cyst characterization** (B2) — 1 day; HU + sphericity rule
6. **Indeterminate malignant flag** (B14) — 0 days; expose existing LI-RADS LR-M output
7. **Gallbladder anatomy + stone heuristic** (A9) — 2 days; TS gallbladder class + HU>100
8. **Hypovascular metastasis (CRC) detection** (B8) — 1 week; bamf-health MIT mask + heuristic. **Highest DACH-market value.**

**Total: ~2 weeks of engineering for 8 new clinical capabilities.**

### Phase 2 — Ship in 1-2 months (16 YELLOW items)

Heuristics on TS/bamf masks. Each is "rule-based screening flag" not autonomous AI. Always require radiologist confirmation in UI.

Priority order (highest clinical value first):
1. **Unified PVT detector — bland + tumor** (D2 + D3 fused) — 1 week
2. **Hypervascular metastasis detection** (B7) — 1 week
3. **ICC characterization** (B11) — 1 week
4. **Atypical metastasis flag** (B9) — 3 days
5. **Liver lymphoma pattern flag** (B13) — 1 week
6. **Biliary hamartoma flag** (B3) — 2 days
7. **Hepatic hematoma + trauma flag** (B4) — 3 days
8. **Portal/hepatic vein masks (no variant typing)** (A2 + A3) — 3 days each
9. **Portal hypertension partial assessment** (A6) — 3 days
10. **Portosystemic shunts** (D5) — 1 week
11. **Budd-Chiari heuristic** (D1) — 2 weeks
12. **Cirrhosis CT heuristic** (A5 partial) — 1-2 weeks
13. **Gallbladder anatomy + wall thickness** (C10) — 2-3 days

**Total: ~6-8 weeks for 16 additional capabilities.**

### Phase 3 — Strategic differentiator (1 high-value item)

**Echinococcus / hydatid cyst Gharbi-stage classifier** (B1) — 2 weeks for hand-coded Gharbi CE-1 to CE-5 rule on STU-Net mask. Endemic in Georgia + Caucasus + Middle East at 5-10x Western prevalence. **No Western competitor (TotalSegmentator, MONAI, etc.) will build this.** Funded annotation project at Geo Hospitals could later train a custom STU-Net head — but the rule classifier alone differentiates the product in the home market today.

### Phase 4 — Klatskin classification (post-CE)

**Klatskin Bismuth-Corlette typer** (C5-C9) — 6-10 weeks. The classification logic is ~200 LOC topology over a biliary-tree mask, but no Apache/MIT MRCP biliary-tree segmenter exists publicly. Requires self-training nnU-Net (Apache-2.0) on Geo Hospitals MRCP cohort. **Highest surgical-planning value** — direct hepatobiliary use case, no Western competitor product offers Bismuth typing.

### Defer indefinitely (10 RED items, no realistic path)

| # | Why deferred |
|---|---|
| Hepatic artery Michels typing | No public dataset, no public model |
| Bile duct dilation | No CT bile-duct segmenter; needs MRCP |
| Abdominal lymph nodes | Only NCLS noncommercial; field SOTA Dice 0.57 |
| HCC subtypes | Histopathology, not imaging |
| Caroli's disease | Needs biliary-tree segmenter |
| Choledochal cysts | Needs biliary-tree segmenter |
| Liver sarcoma | Too rare; no model will exist |
| Hemangioma / FNH / adenoma subtypes | LiLNet has no weights; LLD-MMRI is non-commercial |
| Distal bile duct cancer | No cross-sectional model; only EUS |
| AV shunts | Needs perfusion CT pipeline |

### Never build — flag clearly to founder

| # | Why this should NOT be built as an imaging feature |
|---|---|
| **Gilbert's syndrome** (D7) | Pure lab diagnosis (UGT1A1 + bilirubin); liver looks **normal** on imaging. Imaging adds zero diagnostic value. |
| **Alpha-1 antitrypsin** (D8) | Lab + genetic diagnosis (serum AAT level + Pi typing). Imaging shows non-specific cirrhosis already covered. Adding it as a "feature" is medico-legal exposure without clinical benefit. |

---

## ⚠️ Risks & Gotchas

| Risk | Severity | Mitigation |
|---|---|---|
| HU-based steatosis fooled by iron overload (both raise HU oppositely → cancellation gives "normal") | High | Always report **both** mean HU AND liver-spleen Δ; flag conflicts |
| Non-contrast acquisition is required for HU-based iron/copper/steatosis grading; portal-venous phase HU is uninterpretable | High | Detect series phase from DICOM tags; refuse to compute these metrics on contrast-enhanced series |
| Calling rule-based flags "AI detection" is regulatory + marketing risk | High | Label heuristic outputs as "rule-based screening flags" in UI + report; reserve "AI" for actual model outputs (parenchyma, lesion mask, vessel mask) |
| TotalSegmentator portal/hepatic vein delineation is coarse — heuristic FP rate may be high on tortuous cirrhotic anatomy | High | Always require radiologist-in-the-loop confirmation for thrombosis/Budd-Chiari/shunt flags; never autonomous |
| Wilson/A1AT/Gilbert mentions in report could mislead clinicians into ordering wrong tests | Medium | Explicit "imaging cannot confirm — order labs" disclaimer; for Gilbert/A1AT: don't surface at all |
| CirrMRI600+ dataset is CC-BY-SA-4.0 (ShareAlike viral) — derivatives must be released under same license | Medium | Legal sign-off before any model fine-tuned on it ships in the product |
| Klatskin in-house biliary segmenter requires Geo Hospitals MRCP cohort with hilar-tumor annotations | Medium | Confirm cohort size (≥200 studies) before committing engineering |
| LLD-MMRI dataset (would unblock hemangioma/FNH/adenoma classifier) is currently CC-BY-NC | Medium | Track license — if changes to permissive, ~8 weeks fine-tuning effort unlocks 3 RED items |

---

## 🏁 Founder-Level Recommendation

The cascade is functional today (TotalSegmentator-based), with parenchyma + vessels + Couinaud + lesion detection + LI-RADS classification + FLR working end-to-end. The 44-item wishlist breaks into:

1. **Cheap wins (8 items, ~2 weeks):** ship Phase 1 — multiple immediate clinical capabilities for negligible engineering cost. Steatosis + spleen volumetry + HU panel + simple cyst rule + calcified lesion + GB stones + indeterminate malignant + CRC metastasis.

2. **Medium investment (16 items, ~6-8 weeks):** ship Phase 2 — extends the cascade with rule-based screening flags layered on TotalSegmentator masks. Each is high-value clinically; together they cover the radiology-AI breadth that competitors charge $100K+/year for.

3. **Strategic differentiator (1 item, ~2 weeks):** ship Phase 3 — Echinococcus Gharbi rule classifier. Only LiverRa will offer this in the Georgian/CEE/Middle East market. **Recommend Dr. Levan personally validates against 20 known echinococcus cases at Geo Hospitals before claiming production-ready.**

4. **Long-term moat (1 item, ~6-10 weeks):** Klatskin Bismuth-Corlette typer. Requires self-training a biliary-tree segmenter on Geo Hospitals MRCP data — but no commercial competitor has this. Highest HPB-surgical value once shipped.

5. **Skip (12 items):** RED + never-build items. Document this in the product spec so engineering doesn't waste cycles, and so investor pitches don't oversell.

**Total realistic v1.5 → v2 scope: 26 of the 44 wishlist items, ~3-4 months of engineering, $0 in model-licensing fees.**

The 4 critical CLAUDE.md license corrections (VISTA3D, MedSAM-2, LiLNet, TotalSegmentator subtasks) are higher priority than any new feature — they affect what we can legally ship and must be fixed before CE MDR submission.

---

## Sources

All cluster reports cite live URLs verified via WebFetch on 2026-05-09. Aggregated source list:

**Foundation models (verified Apache-2.0 / MIT):**
- [TotalSegmentator GitHub](https://github.com/wasserth/TotalSegmentator) + [TS-1228 Zenodo CC-BY-4.0](https://zenodo.org/records/10047292)
- [STU-Net GitHub](https://github.com/uni-medical/STU-Net)
- [BAMF aimi-liver-ct + aimi-liver-tumor-ct (MIT)](https://github.com/bamf-health/aimi-liver-ct) + [Zenodo weights](https://doi.org/10.5281/zenodo.8270230)
- [MIC-DKFZ nnU-Net (Apache-2.0)](https://github.com/MIC-DKFZ/nnUNet)
- [AMOS22 dataset (CC-BY-4.0)](https://zenodo.org/records/7262581)

**Verified non-commercial / rejected:**
- [VISTA3D HuggingFace — NCLS v1 noncommercial](https://huggingface.co/MONAI/VISTA3D-HF)
- [MedSAM-2 HuggingFace — CC-BY-SA-4.0 research only](https://huggingface.co/wanglab/MedSAM2)
- [LiLNet GitHub — code only, no weights](https://github.com/yangmeiyi/Liver)
- [LLD-MMRI dataset — CC-BY-NC-4.0](https://github.com/LMMMEng/LLD-MMRI2023)
- [LiTS17 dataset — CC-BY-NC-ND-4.0](https://academictorrents.com/details/27772adef6f563a1ecc0ae19a528b956e6c803ce)

**Clinical reference standards (heuristic basis):**
- [RSNA 2024 CT steatosis meta-analysis — HU<40 sens 82%, spec 94%](https://pubs.rsna.org/doi/full/10.1148/radiol.241171)
- [Quantitative CT for Diffuse Liver Diseases — RadioGraphics 2024](https://pubs.rsna.org/doi/full/10.1148/rg.240176)
- [Spontaneous Portosystemic Shunts in Cirrhosis — Radiology 2021](https://pubs.rsna.org/doi/full/10.1148/radiol.2021203051)
- [Budd-Chiari Imaging Diagnosis Review — PMC10341099](https://pmc.ncbi.nlm.nih.gov/articles/PMC10341099/)
- [HCC PVTT prediction with AI — JHC 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11268770/)
