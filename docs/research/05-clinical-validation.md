# LiverRa — Clinical Validation Strategy

## The Strongest Clinical Wedge

NOT HCC detection (saturated, 30+ competitors). The two strongest evidence-backed claims:

1. **Reduces LI-RADS inter-reader variability** — pooled literature shows LR-M ICC 0.46, ancillary features ICC 0.16-0.58 (poor). Subspecialist radiologists disagree 30-35% of the time.
2. **Accelerates surgical planning** — manual FLR volumetry 25-40 min (up to 90 min); LiverRa compresses to <5 min. CFO-ready ROI number.

---

## Current State (Baseline Workflow)

### Imaging read workflow
- 4-phase liver CT = unenhanced + late arterial (25-35s) + portal venous (60-75s) + delayed (3-5 min)
- MRI adds hepatobiliary phase with gadoxetic acid (~20 min)
- Reading time: 10-20 min for focused study, 20-30+ min for complex oncology/surveillance
- Radiologist workload: 14,900 → 26,457 studies/radiologist/year (2008-2018); +80% 2009-2020
- Burnout: 44% male / 65% female radiologists; RSNA 2024 + ACR 2024 named #1 concern

### Surgical-planning workflow (the real pain)
- Manual liver volumetry: 25-40 min (up to 90 min) using 3D Slicer Segment Editor
- Semi-automatic (RVX / Slicer-Liver): ~7-8 min
- Fully automatic (TotalSegmentator, nnU-Net): ~2 min
- FLR thresholds: healthy ≥20-25%, post-chemo ≥30%, cirrhotic ≥40%
- PHLF (post-hepatectomy liver failure) incidence: 15% at FLR <30% in high-risk; 32% with additional risk factors

### Current software landscape
- Visible Patient — bespoke 3D service, 48h turnaround, 769 cases 2009-2013
- Synapse 3D (Fujifilm), MeVis Distant Services — vendor-specific, expensive
- IQQA-Liver (EDDA) — FDA cleared, limited penetration outside referral centers
- 3D Slicer + Slicer-Liver — free but requires expertise

---

## LI-RADS (The AI Opportunity)

Liver Imaging Reporting and Data System v2018 (v2024 rolling out) stratifies observations in cirrhotic patients: LR-1 (benign) → LR-5 (HCC 95-99% probability) + LR-M (probably malignant, not HCC specific) + LR-TIV (tumor in vein).

### Inter-reader variability (the published evidence)

| Feature | Pooled kappa / ICC |
|---|---|
| APHE (arterial hyperenhancement) | κ 0.72 |
| Washout | κ 0.69 |
| Enhancing capsule | κ 0.66 |
| LR category overall | κ 0.70 |
| **LR-M** | **ICC 0.46 (POOR)** |
| **Ancillary features** | **ICC 0.16-0.58 (POOR-MODERATE)** |
| Research vs clinical readers | ICC 0.63 vs 0.68 |

Primary references: Radiology 2023 DOI 10.1148/radiol.222855 (PMID 37367445); Radiology 2024 DOI 10.1148/radiol.231212.

**Commercial framing:** "A 32-category system that specialist radiologists disagree on 30-35% of the time. LiverRa = deterministic LI-RADS calculator."

---

## Recommended Validation Study Design

### Phase 1 — Retrospective MRMC Pivotal (CE MDR + FDA 510k)
| Parameter | Spec |
|---|---|
| Design | Multi-reader multi-case, fully-crossed |
| Primary endpoint | Non-inferiority of LI-RADS assignment + liver/segment/tumor Dice vs expert consensus |
| Secondary | Time-to-report, inter-reader kappa with vs without AI, FLR accuracy vs manual reference |
| Cases | **N = 400** (200 HCC confirmed + 100 benign + 100 non-HCC malignant) |
| Readers | **20** (8 abdominal fellows + 8 general radiologists + 4 expert ground truth) |
| Sites | **4-5** (Georgia + 2 Germany + 1 Turkey + 1 France/Italy) |
| Reference | Histopathology where available, else multidisciplinary tumor board |
| Scanners | Min 3 vendors (GE + Siemens + Philips), CT + MRI |
| Duration | 10-12 months |
| Budget | **€1.2-1.5M** |

### Phase 2 — Prospective Surgical Planning Workflow
| Parameter | Spec |
|---|---|
| Design | Prospective single-arm, planning time + accuracy study |
| Primary | Time to 3D plan (LiverRa vs manual 3D Slicer) |
| Secondary | FLR Bland-Altman, vascular variant detection sens, surgeon Likert, intraop surprise rate |
| Cases | **N = 150** (50 resections + 50 PVE/ALPPS + 50 LDLT donors) |
| Sites | 3 (Tbilisi Transplant + 1 Germany HPB + 1 Italy/Turkey) |
| Duration | 9 months |
| Budget | **€500-600k** |

### Total
~**€2.1M, 18-21 months** to publishable pivotal evidence.

### Regulatory compliance
- **CLAIM 2024** — Radiology: AI 2024 update
- **STARD-AI** — Nat Med 2025
- **MI-CLAIM** — bias/fairness transparency
- **CONSORT-AI** — if randomized prospective
- Pre-register on ClinicalTrials.gov

---

## Clinical KPIs

| KPI | Target | Rationale |
|---|---|---|
| Liver parenchyma Dice | ≥0.93 | Matches SOTA |
| Couinaud per-segment Dice | ≥0.85 | Surgical prereq |
| Tumor detection sensitivity ≥1cm | ≥90% | SOTA gadoxetic MRI level |
| Tumor detection specificity | ≥90% | FDA CADx threshold |
| LI-RADS category agreement vs expert consensus | κ ≥0.80 | Must exceed human-human (0.70) |
| Inter-reader κ with AI assist | ≥0.80 (vs 0.70 unaided) | **Headline claim** |
| FLR volume vs manual | ICC ≥0.95, Bland-Altman ±3% | Surgery-grade |
| Time to LI-RADS report | −40% vs unaided | Plausible |
| Time to surgical plan | <5 min (vs 25-40 min manual) | **Commercial headline** |
| Vascular variant sensitivity | ≥85% | Safety metric |

---

## Value Proposition Ranking

| Claim | Evidence | Commercial | Regulatory Risk | Verdict |
|---|---|---|---|---|
| **Reduces LI-RADS inter-reader variability** | STRONG | HIGH (nobody owns) | LOW | **★ Primary** |
| **Accelerates surgical planning 40min→5min** | STRONG | HIGH (fragmented competitors) | LOW | **★ Primary** |
| Standardizes reporting | MODERATE | MODERATE | LOW | Fold into #1 |
| Detects HCC earlier | WEAK-MODERATE | LOW (saturated) | MEDIUM (FDA tough on CADx) | Supporting only |
| Improves patient outcomes | VERY WEAK | HIGH IF PROVEN | — | **Do NOT claim pre-pivotal** |
| Saves radiologist time | MODERATE (27% reduction in npj DM 2024) | MODERATE | LOW | Secondary |

---

## Claims That Would Fail Regulatory Scrutiny

| Claim | Why Fails |
|---|---|
| "Replaces the radiologist" | FDA/MDR mandate human-in-loop |
| "Improves patient survival" | Requires RCT with survival endpoint |
| "Diagnoses HCC without radiologist" | CADx triggers highest FDA scrutiny |
| "Works on any scanner" without multi-vendor data | Requires ≥3 vendors at external sites |
| "Adaptive learning in the field" | Triggers PCCP scrutiny; lock model for v1 |
| "Pure segmentation, not CADe" for anything highlighting tumor | Tumor highlighting = CADe regardless of marketing |

---

## Reimbursement Strategy by Market

### Germany (primary DACH)
- **NUB** (Neue Untersuchungs- und Behandlungsmethoden): 288/981 applications got Status 1 in 2024 (29%)
- Apply at 5-10 university hospitals simultaneously for momentum
- DiGA does NOT apply (patient-facing apps only)
- Route: sell into hospital capex + NUB at university hospitals Year 1-2; wait for InEK DRG inclusion Year 3-5

### France
- **LPPR** — long-term pathway, full clinical evidence required
- **Forfait Innovation** (reinforced 2026) — 2-3 years reimbursement while RWE collected
- CNEDiMTS review; HAS published dedicated AI evaluation principles Sept 2025
- Partner with academic center (AP-HP Paul Brousse, CHU Strasbourg / IRCAD, CHU Rennes)

### UK
- **NHS AI Diagnostic Fund** (£21M, 2024 closed with Annalise.ai for CXR)
- NHS AIDP pilot (standardized cloud infra for certified AI imaging)
- Overall NHS AI Lab budget cut £250M → £139M in 2024
- Private market (Bupa, Spire, Circle, HCA UK) realistic earlier

### United States
- **Category III CPT codes** near-term (pays $0 by default, tracks utilization 5 years)
- **Category I CPT**: only 2 exist for AI radiology as of 2025 (CPT 92229 retinopathy, CPT 75580 FFR-CT)
- **NTAP**: Viz.ai's $1,000/patient cap → actually averages $30-80/patient
- Not a 2026-2028 priority for LiverRa with €1M

### Middle East
- Saudi 2024 health budget SAR 214B ($57B), $1.5B for health IT
- UAE: SEHA POC deals (Lunit precedent), Cleveland Abu Dhabi, American Hospital Dubai
- Mostly **direct hospital capex**; private insurance for AI is rare
- Typical ACV private ME: $50-150k/site/year

---

## Clinical Workflow Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Crowded HCC-detection market | Lead with surgical planning + LI-RADS, NOT HCC detection |
| Ground-truth variability for LI-RADS | 3-expert consensus panel, pathology where available, Gwet's AC1 alongside kappa |
| Single-country training data (Georgian etiology ≠ Western HCV/NASH) | Early DACH + Turkish partnerships for training diversity |
| FLR functional ≠ anatomical volume | Position v1 as anatomical volumetry; functional via hepatobiliary MRI for v2 |
| Over-automation in safety-critical plans | Always include surgeon review/edit step (VISTA3D) |
| Class IIb vs IIa MDR | If LiverRa provides diagnostic categorization (LR-5 assignment) → IIb guaranteed |
| No reimbursement → slow adoption | Capex + per-case hospital pricing while awaiting CPT; hospital ROI on OR time saved + readmission avoided |
