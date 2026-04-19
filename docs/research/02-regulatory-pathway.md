# LiverRa — Regulatory Pathway

## The Verdict

- **EU:** MDR Class **IIb** (not IIa) under Rule 11 — "software informing diagnosis of serious disease"
- **US:** 510(k) with predicates Perspectum Hepatica + MeVis Liver Suite
- **Timeline:** EU 24-30 months, US 12-20 months (pursue in parallel)
- **Cost:** **€388k-€1.1M realistic** (deck's €100k is 4-11x too low)
- **AI Act overlay:** Class IIb = automatic "high-risk AI" — extra data governance, logging, bias testing by Aug 2027
- **Georgia HQ:** CE-marking works, but need EU Authorized Rep + PRRC + likely EU subsidiary for GDPR data flows

---

## EU CE MDR Class IIb (The Correct Classification)

Under Rule 11 of MDR Annex VIII, software informing diagnostic/therapeutic decisions is **at least Class IIa**, and escalates to **IIb when decisions may cause serious health deterioration or surgical intervention**.

LiverRa's outputs directly drive:
- **FLR estimation** — if miscalculated, post-hepatectomy liver failure (catastrophic mortality)
- **Tumor characterization (HCC vs hemangioma vs MET)** — changes surgical vs ablation vs transplant vs observation
- **Surgical planning** — literally drives the operative plan

Both Johner Institute and OpenRegulatory list "analysis of CT/MRI informing cancer diagnosis" as Class IIb worked example. MDCG 2019-11 Rev.1 (June 2025) reinforces this. **There is no credible path to Class IIa for a surgical planning tool.**

"Decision support" framing does NOT drop the class here — Rule 11 looks at the IMPACT of decisions the software informs, not the label.

### Could it be Class III?
Only if framed as autonomous / no physician in loop. Keeping a licensed surgeon as final decision-maker keeps it at IIb. Never claim autonomous diagnosis — that's Class III territory.

---

## EU AI Act Overlay

Because LiverRa is Class IIb requiring third-party conformity assessment, it's **automatically high-risk AI** under the AI Act.

Per MDCG 2025-6 (joint MDCG + AI Board guidance):
- **Aug 2, 2026:** Most AI Act provisions apply
- **Aug 2, 2027:** High-risk AI requirements for medical devices fully kick in

Extra obligations layered on MDR:
- Data governance (Article 10)
- Record-keeping / logging
- Transparency
- Human oversight
- Accuracy / robustness / cybersecurity testing
- Bias mitigation
- Representativeness of training/validation data (demographic, geographic, scanner vendor diversity)

**These are documented in the tech file and audited by the same notified body.**

---

## FDA Pathway: 510(k)

### Predicates
| Predicate | K-number | Cleared | Relevance |
|---|---|---|---|
| **Perspectum Hepatica** | (K203406-era) | Jan 2021 | Closest analog: AI Couinaud + FLR + surgical decision support |
| **MeVis Liver Suite** | K232045 | Oct 2023 | AI segmentation liver + hepatic artery/vein/portal vein; Dice >85% |
| **MeVis Liver Suite (earlier)** | K201501 | Feb 2021 | Earlier clearance of same family |
| Scout Liver (Pathfinder) | — | — | Commercial HPB planning |
| PlaniSight Linasys | K082228 | 2008 | Legacy resection planning |

**71.5% of all FDA AI/ML clearances in 2025 were radiology** (211/295). Only ~10% included PCCP — include one from day 1.

### Tumor classification caveat
If LiverRa's classification output is treated as **lesion classification (CADx)** rather than just detection (CADe), FDA raises the evidence bar significantly. CADx historically has fewer predicates → may require **De Novo** pathway for classification module even if volumetry goes 510(k).

**Strategy: decouple submissions.** v1 510(k) = volumetry + FLR only. v2 De Novo = tumor classification.

---

## Realistic Timeline

### EU MDR Class IIb
| Phase | Duration |
|---|---|
| QMS build (ISO 13485 + IEC 62304 + 14971 + 82304 + 62366) | 6-9 months |
| Tech file + Clinical Evaluation Report | 4-6 months |
| Notified Body application → certificate | 12-18 months |
| **Total realistic** | **24-30 months** |

### US 510(k)
| Phase | Duration |
|---|---|
| Pre-Sub (Q-Sub) meeting | 3-4 months |
| Clinical validation study | 6-12 months |
| FDA 510(k) review | 3-6 months |
| **Total** | **12-20 months** (parallel to EU possible) |

---

## Realistic Cost (2025-2026 figures)

| Line item | Low | High |
|---|---|---|
| QMS implementation (ISO 13485 + IEC 62304) | €40k | €120k |
| Tech file + risk file + IEC 62366 usability | €30k | €80k |
| Clinical Evaluation Report (MDCG 2020-1) | €25k | €60k |
| **Clinical validation** (multi-site external, reader study) | **€120k** | **€400k** |
| Notified Body MDR fees (Class IIb SaMD) | €40k | €100k |
| EU Authorized Rep + PRRC (annual) | €8k | €20k/yr |
| FDA 510(k) user fee (FY2026 small business) | $6k | $6k |
| FDA 510(k) submission support | €60k | €150k |
| AI Act compliance add-on | €30k | €80k |
| Cybersecurity (SBOM, IEC 81001-5-1) | €20k | €50k |
| Post-market surveillance + PMCF | €15k | €40k |
| **Pre-market TOTAL (EU + US)** | **€388k** | **€1.1M** |

Plus ~€50-100k/yr ongoing post-launch.

**Deck's €100k allocation: 4-11x too low.**

---

## Clinical Study Requirements

### Accepted design
- **Retrospective studies accepted** by FDA for most radiology AI (only ~5% had prospective per JAMA)
- **Multi-center external validation expected** (not optional)
- **Reader studies** (MRMC — multi-reader multi-case) for detection/classification claims

### Sample sizes (rules of thumb)
- **Segmentation:** 100-300 cases, 50+ per anatomical variant
- **Detection:** 500-1,500 cases, prevalence-enriched, pathology-confirmed preferred
- **Classification:** 1,000+ cases, multi-institutional, pathology for significant subset
- **Reader study:** 5-10 radiologists × 100-200 cases, crossover design

### For LiverRa — recommended design
| Phase | Design | N | Sites | Duration | Budget |
|---|---|---|---|---|---|
| 1 | Retrospective MRMC | 400 cases × 20 readers | 4-5 sites | 10-12 mo | €1.2-1.5M |
| 2 | Prospective surgical workflow | 150 cases | 3 sites | 9 mo | €500-600k |
| **Total** | | | | **18-21 months** | **~€2.1M** |

A single well-designed multi-site study can satisfy FDA + MDR + AI Act data governance in one go.

---

## Georgia-Specific

### GDPR adequacy
**Georgia is NOT on the EU adequacy list.** Implication: to train on EU hospital data, must use:
- Standard Contractual Clauses (SCCs) + Transfer Impact Assessment — most common
- Binding Corporate Rules — impractical for startup
- **Pseudonymization on-site in EU with only model weights leaving** — gold standard (federated learning)
- **EU subsidiary** — simplest structural fix ← **RECOMMENDED**

### EU subsidiary recommendation
- **Estonia via e-Residency** — €800 first year, 0% tax on retained earnings
- **Ireland** — 12.5% corporate, strong VC ecosystem
- **Germany** — proximity to TÜV SÜD, DEKRA notified bodies + largest medical device market

### Can a Georgian entity hold CE certificate?
**Yes.** MDR doesn't restrict manufacturer's country. Need: EU Authorized Representative (EC REP) + PRRC + EUDAMED registration + EC REP address on label/IFU.

---

## Notified Body Selection

| NB | Strengths |
|---|---|
| **BSI (NL)** | Publishes lead times, strong software history, English-first, ~3 month QMS audit |
| **TÜV SÜD** | Most SaMD experience, German thoroughness, longer queue |
| **DEKRA** | Growing SaMD practice, more available capacity |

**Apply to 2-3 in parallel; switching mid-review is painful.**

---

## Budget Reframe on €1M

**Deck:** €100k regulatory (10%). **Reality:** €400-900k for pre-market.

### Suggested reallocation on €1M:
| Bucket | Amount | % |
|---|---|---|
| R&D / product | €350-450k | 35-45% |
| **Regulatory + QMS** | **€150k** | **15%** |
| **Clinical validation** | **€200k** | **20%** |
| Notified body + FDA fees | €80k | 8% |
| Commercial / GTM | €150k | 15% |
| Legal, IP, corp | €70k | 7% |

### If €1M is hard ceiling, options:
1. **Narrow v1 to volumetry + FLR only** (drop tumor classification) — cuts validation cost ~40%
2. **Defer US** — do EU first, raise Series A on CE + traction
3. **Raise €2-3M pre-seed** — medical imaging AI at €1M is thin
4. **Stack EIC Accelerator (€2.5M grant) + EIT Health (€850k)** — non-dilutive

---

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Misclassify as IIa → rejected → restart as IIb | Scope intended use for IIb from day 1; get Pre-Sub clarification |
| Tumor classification forces De Novo in US | Stage submissions: volumetry first (510k via Hepatica), classification second (De Novo) |
| GDPR data transfer blocks EU partnerships | EU entity OR federated learning on-site — don't defer |
| NB queue delays certification 6+ months | Apply to 2 NBs in parallel; start QMS before product done |
| AI Act compliance gap (Aug 2027) | Build data governance + logging + bias testing into QMS day 1 |
| Under-budgeting clinical validation | Single multi-site study serving FDA + MDR; €300k+ for this line |
| Single-vendor CT training → dataset shift | Min 3 scanner vendors × multiple field strengths × contrast protocols |
| Cybersecurity deficiencies at NB audit | IEC 81001-5-1 + SBOM + threat model from day 1 |

---

## Bottom Line for Constitution

LiverRa must operate as a **Class IIb SaMD candidate from day 1**:
- ISO 13485 QMS
- IEC 62304 Class B/C software lifecycle (Class C for anything that classifies cancer)
- ISO 14971 risk management with AI hazard analysis (AAMI TIR 34971)
- AI Act data governance + logging + bias testing
- Full model provenance (MLflow + DVC)
- Every inference logged (input hash, model version, output hash, timestamp)
- Every DICOM transaction logged
- Human-in-the-loop always — decision support, never autonomous diagnosis
