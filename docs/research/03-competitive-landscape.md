# LiverRa — Competitive Landscape

## The Honest Truth

The pitch deck's claim of being "only fully-specialized option" does NOT survive diligence. There are **at least 20 credible competitors**, not 4. The real question is not "do we have competitors" but "where's the actual whitespace?"

---

## Real Whitespace (Defensible)

1. **HPB-surgeon-native full-stack UX** — Visible Patient requires 24-48h service turnaround; MeVis is dual-audience radiologist-heavy; EDDA UX is legacy; Fujifilm is bundled into PACS. A real-time automated surgeon-first cockpit covering segmentation → FLR → tumor characterization → 3D viz → report as ONE product is not fully owned.
2. **CEE geographic gap** — No Tier-1 incumbent has meaningful sales footprint in Poland, Czechia, Hungary, Romania, Serbia, Georgia, Ukraine, Turkey, or Balkans.
3. **Middle East public-system play** — Siemens + GE dominate via CT/MRI hardware, but liver AI is module-within-platform. A surgeon-first tool for UAE / Saudi / Qatar private HPB centers can land without OEM bundling.
4. **Platform-exit vacuum** — Bayer Calantic + Blackford shutdown Sept 2025 created hospitals seeking new distribution.
5. **Multi-class tumor characterization** — generic lesion seg (RSIP, Arterys, MIM) doesn't distinguish HCC vs HEM vs MET. LiLNet's 6-class output is a real differentiator.

---

## Complete Competitor Matrix (Rewritten)

| Vendor | Liver-Specific | Surgical Planning | FLR Calc | Tumor Characterization | Surgeon-Led | CE | FDA | Target Market | Pricing |
|---|---|---|---|---|---|---|---|---|---|
| **LiverRa (planned)** | ✅ | ✅ | ✅ | ✅ (6-class) | ✅ | TBD | TBD | CEE/DACH/ME | €40-120k/site/yr + €300-600/case |
| Visible Patient (J&J/Ethicon) | ✅ | ✅ (deep) | Interactive | Weak | Semi | ✅ IIa | ✅ K151988 | Global via J&J | Per-case service + free SW |
| MeVis Liver Suite | ✅ | ✅ | ✅ | Vessels + tumor seg | Partial | ✅ | ✅ | DACH/EU | License (not public) |
| EDDA IQQA-Liver/Guide | ✅ | ✅ | ✅ | Lesion quant | ✅ | ✅ | ✅ (2006, 2015) | US/China | Enterprise |
| Perspectum Hepatica | ✅ | ✅ | ✅ (Couinaud AI) | Limited | Partial | ✅ | ✅ (Jan 2021) | UK/US | Subscription |
| Perspectum LiverMultiScan | ✅ | ❌ | ❌ | ❌ (diffuse only) | ❌ | ✅ | ✅ (2016) | Global pharma | Subscription |
| Mint Lesion (Brainlab) | ✅ (HCC staging) | ❌ | ❌ | ✅ (BCLC/TNM) | ❌ | ✅ (2010) | ✅ (2011) | Global | Enterprise |
| Innersight Labs (KARL STORZ) | Partial | ✅ | Limited | ❌ | ✅ | ✅ UKCA | ? | UK + Storz | Per-case |
| CAScination CAS-One | ✅ (intraop) | ❌ (intraop nav) | ❌ | ❌ | ✅ | ✅ | ✅ (2015) | EU | Capital equipment |
| Techsomed VisAble/BioTrace | ✅ (ablation) | ✅ (ablation only) | ❌ | Ablation zone | ✅ IR | Likely | ✅ (2023-24) | US/Global | Subscription |
| Fujifilm Synapse 3D Liver | ✅ | ✅ | ✅ | Vessels + lesions | Partial | ✅ | ✅ K110186 | Japan/Global | Bundled PACS |
| GE Liver Assist VP + MIM (Apr 2024) | Partial | Partial (embolization + Y90) | ❌ (dosimetry) | Lesion seg | Partial | ✅ | ✅ | Global | Enterprise bundled |
| Philips CT Liver Analysis | ✅ | Partial | ✅ | Whole-organ + seg | Partial | ✅ | Pending | Global | Enterprise bundled |
| Siemens AI-Rad Companion | ❌ (no liver module confirmed) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | Global | Enterprise |
| Aidoc abdominal CT triage | Partial (injury) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ (Jan 2026) | Global | Subscription |
| Quibim QP-Liver | ✅ | ❌ | ❌ | ❌ (diffuse fat/iron) | ❌ | ✅ (Mar 2024) | ❌ | EU primary | Subscription |
| Nanox HealthFLD | ✅ (steatosis) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ (Feb 2024) | Global | Per-scan |
| 3D Slicer-Liver (OSS) | ✅ | ✅ | ✅ | Limited | Academic | ❌ | ❌ | Global academic | FREE |
| Materialise Mimics | ❌ (horizontal) | ✅ (3D-print focus) | Manual | Manual | ❌ | ✅ | ✅ | Global | Enterprise |
| Arterys / Tempus MICA | Partial (lesions) | ❌ | ❌ | Tracking only | ❌ | ✅ (27 countries) | ✅ | Global | Cloud subscription |

---

## Biggest Threats (Ranked)

### 1. Visible Patient / Ethicon (J&J) — Distribution Muscle
- J&J surgical sales force is the single most formidable distribution in global surgery
- "Free software, paid 3D service" model has customer inertia
- Counter: speed (minutes vs 24-48h), in-house (hospital data stays local), DICOM-native integration, per-site subscription beats per-case at >30 cases/month
- Don't attack directly — position as "complement for high-volume HPB centers wanting in-house capability"

### 2. Fraunhofer MeVis Liver Suite — DACH Killer
- Same home turf as Regensburg + Potsdam design partners
- 20+ years clinical credibility, Fraunhofer research pedigree
- German hospital default when pressed to pick one
- Counter: AI-native automation vs their semi-manual workflow; surgeon-first UX; faster product iteration

### 3. GE HealthCare Edison + MIM (post-April 2024 acquisition)
- Y90 liver treatment planning + dosimetry now in-house
- CT/MRI bundle advantage in Middle East (huge GE installed base)
- Structural advantage — LiverRa cannot out-distribute
- Counter: specialize deeper in surgical planning vs their interventional-radiology focus

### 4. 3D Slicer-Liver (Open Source) — The "Zero Competitor"
- Free, CE/FDA not cleared (research use only)
- Every academic HPB department knows it
- Counter: surgeon time × €100/hr × 15 min saved per case vs free-but-legally-risky; no liability; no audit trail; not defensible in clinical workflow under MDR

---

## Players Who'd Move Into the Space if LiverRa Succeeded

1. **Brainlab** — owns mint Medical + medPhoton, surgeon UX DNA, could assemble HPB product in 12-18 months
2. **Siemens Healthineers** — adding Liver AI-Rad Companion module is overnight if TAM justifies
3. **Aidoc** ($370M raised, 31 FDA clearances) — small R&D bet to add HPB-specific workflow
4. **Owkin / Bioptimus** — French AI health unicorn, Cleveland Clinic HCC model in research
5. **KARL STORZ** (via Innersight) — deepen hepatic with MIS instrument bundle
6. **Tempus AI (Arterys)** — owns lesion seg, could prioritize liver

---

## Recent M&A / Funding Signals (2023-2026)

| Date | Event | LiverRa Implication |
|---|---|---|
| Jan 2023 | Bayer acquires Blackford Analysis | AI platform consolidation |
| Jan 2023 | Perspectum Series C $36M | Liver MRI biomarker maturity |
| Oct 2022 | Tempus acquires Arterys | Liver lesion AI → oncology stack |
| 2022 | Brainlab acquires medPhoton | Surgical planning + intraop |
| **Jan 2024** | **KARL STORZ acquires Innersight Labs** | **MIS + 3D planning bundle threat** |
| Feb 2024 | Nanox HealthFLD FDA | Liver steatosis screening mainstream |
| Mar 2024 | Quibim QP-Liver CE/UKCA | Spain competitor in liver MRI |
| **Apr 1, 2024** | **GE HealthCare closes MIM Software acquisition** | **Liver oncology + Y90 consolidation** |
| Jan 2024 | Techsomed BioTrace FDA De Novo | First US ablation tissue response AI |
| Sept 2024 | Qure.ai $65M Series D | Radiology AI scale-up |
| Jan 2025 | Quibim $50M Series A | Spanish liver MRI scale-up |
| Mar 2025 | Quibim QP-Prostate FDA | Spain competitor first US clearance |
| Jul 2025 | Aidoc $150M ($370M total) | Radiology AI + NVIDIA |
| **Sept 2025** | **Bayer exits Calantic + Blackford** | **Distribution vacuum ← opportunity** |
| Sept 2025 | deepc acquires Osimis | European AI platform consolidation |

---

## OEM / White-Label Targets

### High-priority for LiverRa (DACH/Nordics)
1. **Sectra Amplifier Marketplace** (Sweden) — best-in-KLAS PACS, structured AI-as-a-Service
2. **deepc / deepcOS** (Germany) — 35+ AI vendors, DACH-focused, acquired Osimis

### Medium-priority
3. **Philips IntelliSpace AI Workflow Suite** — open marketplace, slower onboarding
4. **GE Edison Marketplace** — important for Middle East (GE dominant via Al Jeel KSA)
5. **Siemens teamplay / Digital Marketplace** — Rad AI precedent for small AI vendors

### Avoid / deferred
6. **Nuance AI Marketplace (Microsoft)** — US-primary, slow
7. **Blackford / Calantic** — shutting down

### Therapy-vendor channels (HPB-specific)
- Sirtex (Y90 microspheres) — collaborates with MIM on SurePlan LiverY90
- Boston Scientific (ablation)
- Medtronic (Emprint/Covidien ablation)
- Angiodynamics (NanoKnife IRE)

---

## Positioning Statement for Investors

*"LiverRa is the only surgeon-native, AI-automated, full-stack liver surgical planning platform built for HPB surgeons (not radiologists) in CEE, DACH, and Middle East markets. We compress 25-40 min of manual FLR volumetry to under 5 minutes, standardize LI-RADS reporting (where inter-reader agreement is currently ICC 0.46 for LR-M), and differentiate 6 tumor types with published 94.7% accuracy — all at 1/3 the per-case cost of Visible Patient's service bureau model, with no 48h turnaround. We target the 300+ HPB/transplant centers in our regions where Visible Patient (J&J), MeVis (Fraunhofer), and GE+MIM have weak local presence. Our 5-model cascaded pipeline (STU-Net + Pictorial Couinaud + LiLNet + VISTA3D + MedSAM-2) is 100% Apache 2.0 licensed — zero legal friction for commercial deployment."*
