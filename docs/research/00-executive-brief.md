# LiverRa — Executive Research Brief

*Consolidated output from 8 parallel deep-research agents, April 2026. Decision-grade, not exhaustive.*

---

## The Verdict (One Paragraph)

LiverRa is a **conditional go**. The clinical need is real, the founder has world-class credentials (HPB transplant surgeon + ALPPS-originator Schlitt partnership), the category has meaningful whitespace (surgeon-native UX for CEE/DACH/ME markets where incumbents are weak), and 2026 pretrained models are good enough to ship a working demo in 6 weeks. However, the pitch deck as written will not survive Series A diligence: €1M pre-seed is ~4-9x under-budget for CE MDR Class IIb + FDA 510(k), the competitive slide omits ~20 real competitors, and the "only fully-specialized option" claim is false. The realistic path is **€2-3M pre-seed (or €1M + stacked EIC/EIT grants), reposition the wedge from saturated HCC detection to LI-RADS standardization + surgical planning automation, and ship a Research Use Only zero-training MVP in 6 weeks to unlock design-partner adoption**. Five-year realistic exit: **$80-250M strategic acquisition by Guerbet, Bayer/Calantic, or Olympus/Ziosoft**.

---

## The Five Things That Must Change

1. **Raise €2-3M pre-seed instead of €1M** (or stack EIC Accelerator €2.5M + EIT Health €850k + ZIM €550k → €3.9M non-dilutive on top of €1M equity).
2. **Reposition the wedge** from "HCC detection" (saturated, 30+ competitors) to **"surgical planning + LI-RADS standardization for HPB surgeons"** (contested but winnable).
3. **Rewrite the competitive slide.** Expand from 4 to 15-20 competitors. New positioning: "surgeon-native, real-time, automated full-stack for CEE/DACH/ME where incumbents have weak local presence."
4. **Set up an EU subsidiary** (Estonia or Germany) while keeping R&D in Georgia. Georgia lacks GDPR adequacy — this blocks EU hospital data flows otherwise.
5. **Narrow v1 scope** to CT-only, liver segmentation + Couinaud + FLR (ship-now tech), defer MRI + multi-class tumor classification to v2.

---

## Cross-Cutting Findings (Where Multiple Agents Converged)

### Finding 1: "Foundation models exceed radiologist accuracy" needs decomposition
- **TRUE** for liver parenchyma segmentation on contrast CT (Dice 0.95+ achievable)
- **MIXED** for HCC detection in cirrhotic livers (drops 5-15% on external data)
- **FALSE** for full LI-RADS auto-classification, hepatic artery segmentation, biliary tree, atypical lesion differential

### Finding 2: The strongest clinical wedge is LI-RADS standardization + surgical planning speed
- LI-RADS inter-reader agreement is genuinely poor (ICC 0.46 for LR-M)
- Manual FLR volumetry takes 25-40 min today; LiverRa compresses to <5 min — CFO-ready ROI number
- Nobody owns this positioning (Aidoc/Qure/Annalise chase radiologists, not HPB surgeons)

### Finding 3: Four market tailwinds align 2026
- Bayer Calantic/Blackford shutdown Sept 2025 → 150+ AI apps + thousands of hospitals seeking new distribution
- Liver cancer 870k → 1.52M cases/year by 2050 (Lancet Commission 2025)
- Middle East AI healthcare CAGR 37% (fastest globally)
- Imaging AI VC rebounded Jan 2025 after 48% drop in 2024

### Finding 4: Budget reality check (across 3 agents)
| Line item | Deck | Realistic |
|---|---|---|
| Regulatory | €100k (10%) | €400-900k |
| Clinical validation | €300k part of 30% | €1.5-2.1M total |
| Total to CE + first paid customer | €1M | €4-6M Seed after €1M pre-seed |

---

## The Recommended Path

### Phase 1: Zero-training MVP (Weeks 1-6)
Integrate 5 Apache 2.0 pretrained models into standalone web app:
- **STU-Net (1.4B)** — parenchyma + metastases
- **Pictorial Couinaud** — 8-segment topology
- **LiLNet** — 6-class tumor classification (94.7% accuracy)
- **VISTA3D** — interactive refinement
- **MedSAM-2** — zero-shot 3D tracking

All cascaded, not end-to-end. All commercial-safe. Ship "Research Use Only" disclaimer.

### Phase 2: Design-partner validation (Months 2-6)
Deploy at Regensburg + Potsdam + Geo Hospitals. Collect real-world feedback + failure cases + new annotated data.

### Phase 3: Targeted fine-tuning (Months 4-9)
Fine-tune weak spots only (LiLNet on European distribution; vessel segmentation on your annotated data). Do NOT retrain everything.

### Phase 4: Clinical validation + regulatory (Months 6-18)
Multi-site MRMC study (400 cases × 20 readers × 4-5 sites) → €1.2-1.5M. CE MDR Class IIb submission + FDA 510(k) Pre-Sub.

### Phase 5: Commercial launch (Months 15-24)
CE mark → paid customers in CEE/ME private → Series A (€5-10M) on evidence milestones.

---

## Realistic 12-Month Targets on €1M

- 3-5 design partner sites (mostly unpaid)
- 2 peer-reviewed papers submitted (European Radiology + HPB/Annals of Surgery)
- CE MDR Class IIb submission underway (not cleared)
- 1 marketplace listing live (deepc first)
- First paid pilot Month 10-12 (€30-60k)
- **Revenue year 1: €50-150k — NOT €500k**

---

## Critical Open Questions for Founder

1. How many of the 10,000 Georgian scans are **biopsy-confirmed**? This determines what's learnable.
2. Are scans **multi-phase complete** (non-contrast + arterial + PV + delayed)?
3. Is v1 product **diagnostic (autonomous)** or **decision-support**? Different regulatory bars.
4. CT-only or CT+MRI for v1? Recommend CT-only.
5. Schlitt commitment level — advisory vs clinical investigator vs co-founder?
6. Which market is first paying customer — CEE private, ME private, or DACH academic pilot?

---

## Full Research Files

- `01-pitch-deck-analysis.md` — LiverRa pitch deck evaluation
- `02-regulatory-pathway.md` — CE MDR IIb + FDA 510(k) details
- `03-competitive-landscape.md` — 20+ competitors mapped
- `04-ml-feasibility.md` — Per-capability maturity table
- `05-clinical-validation.md` — Study design, LI-RADS, FLR
- `06-business-model.md` — Pricing, reimbursement, unit economics
- `07-technical-architecture.md` — Hybrid edge/cloud, AWS, exact stack
- `08-market-sizing-funding.md` — TAM/SAM/SOM, funding comparables
- `09-gtm-partnerships.md` — KOL strategy, conferences, pilots
- `10-mvp-strategy.md` — Zero-training cascaded pipeline
- `11-model-and-dataset-choices.md` — Apache 2.0 models + dataset licensing
- `12-spec-input-prompt.md` — Ready-to-paste for /speckit.specify
