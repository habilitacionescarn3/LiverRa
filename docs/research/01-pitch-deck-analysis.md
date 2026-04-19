# LiverRa Pitch Deck Analysis

## Deck Contents (11 slides)

| # | Slide | Key claim | Verdict |
|---|---|---|---|
| 1 | Title | AI-powered liver diagnostics & surgical planning | OK |
| 2 | Problem | 2M deaths/year, late-stage dx, manual CT/MRI, no unified platform | Mostly OK; cite real numbers (870k→1.52M by 2050 Lancet 2025) |
| 3 | Solution | Automated CT/MRI, liver seg, tumor detection (HCC/HEM/MET), surgical planning | OK — but overclaims "no unified AI platform exists specifically for liver diagnostics and HPB surgery" (false) |
| 4 | Product | Upload → AI → Output (seg, lesions, report) | OK (oversimplified) |
| 5 | Why Now | Imaging +40% in 5y, foundation models matured, 880M affected globally, EU AI Act / FDA SaMD | ⚠️ "Foundation models now exceed radiologist-level accuracy" = overclaim |
| 6 | Traction | 10k+ scans, Schlitt + Beyer collaboration, Geo Hospitals, ESSO | **Strongest slide** — named KOLs are huge |
| 7 | Competitive | Visible Patient, Mint, Medimsight, 3D Slicer — LiverRa only fully-specialized | ❌ **Completely rewrite** — ~20 real competitors missing |
| 8 | Business Model | SaaS + per-scan + API/white-label + dataset licensing | OK; lacks numbers |
| 9 | Team | Founder + radiology + AI/ML + data science + clinical validators | OK |
| 10 | Funding | €1M pre-seed: 40% AI, 30% validation, 20% product, 10% regulatory | ❌ 10% regulatory is 4-11x too low |
| 11 | Vision | Global standard for liver AI; expand to biliary/pancreas/transplant | OK |

---

## What Must Change in the Deck Before Investor Meetings

### Slide 2 — Problem
Cite specific numbers:
- 870,000 new HCC cases/year globally → 1.52M by 2050 (Lancet Commission 2025)
- LI-RADS inter-reader agreement ICC 0.46 for LR-M (poor)
- Manual FLR volumetry: 25-40 min (up to 90 min) per case
- 880M+ people affected by liver disease globally (keep, but contextualize — this is the universe, not TAM)

### Slide 5 — Why Now
Drop "foundation models exceed radiologist-level accuracy" (overclaim). Replace with:
- LI-RADS standardization crisis (ICC 0.46 for LR-M — even subspecialist radiologists disagree 30-35% of time)
- HPB surgeon shortage + imaging workload growth +80% 2009-2020
- Bayer Calantic + Blackford exit (Sept 2025) → distribution vacuum
- EU AI Act + MDR compliance windows align 2026-2027
- Pretrained models (STU-Net, LiLNet, VISTA3D) now commercial-safe Apache 2.0

### Slide 7 — Competitive Landscape
**Complete rewrite needed.** Current 4-row table is insufficient. Include:

**Tier 1 (dedicated liver/HPB):** Visible Patient (J&J/Ethicon), Fraunhofer MeVis Liver Suite (DACH), EDDA IQQA-Liver, Perspectum Hepatica, Fujifilm Synapse 3D Liver, Innersight Labs (KARL STORZ Jan 2024), CAScination, Techsomed.

**Tier 2 (OEM modules):** Siemens AI-Rad Companion, Philips IntelliSpace CT Liver, GE Edison + MIM Software (acquired April 2024), Canon Medical.

**Tier 3 (horizontal radiology AI):** Aidoc ($370M raised), Qure.ai, Annalise.ai, Arterys/Tempus, Nanox HealthFLD.

**Tier 4 (open source):** 3D Slicer + Slicer-Liver extension — the "zero competitor" for academic HPB departments.

**Revised positioning statement:** *"The only surgeon-native, real-time, automated full-stack liver AI for CEE / DACH / Middle East markets where incumbents have weak local presence."*

### Slide 10 — Funding
Two options:
1. **Raise to €2-3M** pre-seed (realistic for EU medical imaging AI 2024-2026)
2. **Keep €1M but show grant stack:** EIC Accelerator (€2.5M grant + €0.5-15M equity) + EIT Health (€850k) + ZIM (€550k) = potential €3.9M non-dilutive on top

**Regulatory allocation:** increase from 10% → 15-20%. Clinical validation: increase from (30% buried line) to 20% explicit.

Realistic allocation on €1M:
- R&D / product: 35-45%
- Regulatory + QMS: 15%
- Clinical validation: 20%
- NB + FDA fees: 8%
- Commercial/GTM: 15%
- Legal/IP/corp: 7%

---

## What the Deck Got RIGHT

1. **Team + KOL slide** — the Schlitt (ALPPS originator) + Beyer combo is a ~$5M-valuation credential that VCs respect
2. **ESSO Regional Lead credential** for Dr. Gogichaishvili — hard to replicate
3. **10,000+ CT/MRI scans** — legitimately valuable moat IF biopsy-confirmed subset is meaningful
4. **Vision of HPB expansion** (biliary, pancreas, transplant) — shows roadmap beyond liver-only (necessary since liver-only TAM caps at ~$172M)
5. **Target market selection** (CEE + DACH + ME) — correctly avoids saturated US-first trap

---

## Strongest Defensible Claims for Revised Deck

Replace vague claims with these specific, evidence-backed statements:

1. "The only **surgeon-native, real-time, automated** HPB planning tool for CEE/DACH/ME"
2. "The only **full-stack** liver AI (segmentation + FLR + 6-class tumor classification + 3D planning + structured report) as single product built for HPB surgeons, not radiologists"
3. "Local presence and clinical partnerships in markets ignored by Visible Patient, MeVis, EDDA, GE"
4. "**Tumor-class characterization** (HCC / ICC / metastasis / FNH / hemangioma / cyst), not just lesion segmentation — powered by LiLNet open-source weights (94.7% accuracy, 4,039-patient multi-center training)"
5. "Manual FLR volumetry 25-40 min → LiverRa 2-5 min. CFO-ready ROI."

---

## Three Strategic Actions Before Investor Meetings

1. **Benchmark tumor-characterization accuracy** against published 3D Slicer-Liver, Visible Patient, MeVis results on LiTS/MSD datasets — this is the "vs. free" defense
2. **Lock 2-3 flagship HPB hospital partnerships** in Poland / Czechia / UAE / Saudi to prove local-market lead before Visible Patient or MeVis notices and enters
3. **Pick a clear distribution wedge:** direct-to-HPB-surgeon sales, Sectra / deepc OEM, OR J&J / KARL STORZ / Sirtex therapy channel. All viable; none free; picking wrong burns 12 months

---

## Post-Research Go/No-Go

**GO conditional on:**
- Raise €2-3M OR €1M + committed EIC/EIT applications
- Reposition wedge to LI-RADS + surgical planning (not HCC detection)
- Rewrite competitive slide honestly
- EU subsidiary for GDPR (Estonia / Ireland / Germany)
- Narrow v1 to CT-only, volumetry + FLR + 6-class (defer MRI + biliary tree)

**5-year exit corridor:** $80-250M strategic to Guerbet (already owns 39% of Intrasense), Bayer (Calantic refugee story), Olympus/Ziosoft (launched liver planning March 2025), or Siemens Healthineers.
