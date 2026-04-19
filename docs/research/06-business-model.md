# LiverRa — Business Model, Pricing, Unit Economics

## Revenue Model Summary

**Tiered SaaS (subscription + per-case) with OEM + dataset licensing as Phase 2 revenue lines.**

| Revenue stream | Tier | Price range | When |
|---|---|---|---|
| Design partner (free) | T1 | €0 | Months 1-12, LOI + publication rights + data access |
| CEE/ME private subscription | T2 | €40k/site/year + €150/case overage | Months 9-18 (post-MVP) |
| DACH flagship subscription | T3 | €80-120k/site/year + €15-25k onboarding | Months 15-30 (post-CE) |
| Enterprise multi-site | T4 | €60-90k/site × 5+ sites | Year 2-3 |
| Per-case (no subscription) | — | €300-600/case surgical; €50-100/case triage; €20-50/case API | All phases |
| OEM / white-label | — | 25-30% royalty + €100-200k MG | Year 2+ |
| Dataset licensing to pharma | — | €250-500/anonymized study with outcome linkage → €150-500k per deal | Year 3+ |

**Expected first-10-customer blended ACV: €55-75k.**
**Target markets: CEE / DACH / Middle East.** See 09-gtm-partnerships.md.

---

## Pricing Benchmarks (From Real Comparables)

| Company | Model | Public price points |
|---|---|---|
| **Aidoc** | Enterprise subscription + implementation | Implementation $5-15k SMB, $20-50k enterprise; volume-tiered (NDA) |
| **Viz.ai** | Per-algorithm annual site license | $25k/site/year in CMS filings; ARR $100M (2024) on 2,000 US hospitals; blended ARPU ~$50k |
| **Qure.ai** | Per-scan + enterprise | $1-5 per scan (PACS-integrated); $65.2M revenue on ~300 staff |
| **Zebra Medical** (pre-acq) | "AI1" all-in-one | $1/scan flat unlimited algorithms |
| **Koios** (ultrasound) | Per-scan via CPT | CPT 0689T/0690T increases reimbursement 30% professional, 10% technical |
| **HeartFlow FFR-CT** | Per-case (CPT 75580) | ~$1,450-1,500/case Medicare |
| **Perspectum LiverMultiScan** | Per-scan clinical | **£430/scan** end-to-end MRI + analysis (NHS) |
| **MeVis LiverSuite** | License + "Distant Services" per-case expert | NDA; $17.7M TTM revenue |
| **Visible Patient** | Per-case 3D modeling service | NDA; French mutuelle coverage |
| **GE Healthcare AI apps** | Platform + app bundle | 8-12% annual maintenance of original value |
| **Siemens syngo.via AI** | Per-app à la carte | $25-75k per AI package |
| **Philips AI Orchestrator** | Platform + per-study | Platform $50-150k/site; apps per-study on top |

**Fee-per-study range:** $200 high-value reimbursable → $1 commoditized multi-finding. Liver surgical planning sits at $200-600/case band.

---

## Unit Economics

### Cloud inference cost per scan
- Liver CT segmentation on V100/A100: 2-5 sec/slice series
- Full pipeline (seg + vessels + volumetry + report): 3-8 min GPU time per case
- AWS p3.2xlarge (V100) ≈ $3/hr; A10G Spot ~$0.40/hr
- **COGS per case: €0.50-2.00 GPU + €0.20-0.50 storage + €0.30 egress = €1.00-3.00 fully loaded**
- At €300/case → gross margin 97-99% on compute
- At €30/case API → gross margin ~90%

### ACV benchmarks
- Boutique single-organ AI: €30-80k/site/year
- Mid-tier multi-organ: €80-200k/site/year
- Enterprise horizontal: €150-500k/site/year
- **LiverRa realistic first 10 customers: €40-80k/yr** site license

### CAC
- Hospital AI sales: 1 rep can close 2-4 deals/year in DACH (long cycles)
- Fully-loaded CAC: €40-80k Europe, €60-120k US
- **Payback 6-24 months** for €40-80k ACV (acceptable if NRR >110%)
- CEE distributor deals: 30-40% margin give-up, 50% faster cycles, near-zero internal CAC

### LTV
- Hospital AI contract tenure: 3-5 years
- Churn <10%/year after year 2
- **LTV: 3-5× ACV = €120-400k** per customer

---

## Hospital Procurement Reality

### Sales cycle by market
| Market | Traditional | AI tools (2025) |
|---|---|---|
| US health systems | 8.0 mo | 6.6 mo (-18%) |
| US outpatient | 6.0 mo | 4.7 mo (-22%) |
| US payers | 9.4 mo | 11.3 mo (+20%, slowing) |
| Pharma/biotech | ~10 mo | ~10 mo |
| **DACH hospitals** | **12-24 mo** | No dramatic AI acceleration |
| **Middle East private** | **3-9 mo** | POC fast-track |
| **UK NHS (Trust)** | 9-18 mo | **3-6 mo if on AIDP/AI Award** |

### Buyer map
Every hospital AI purchase requires:
1. **Chief of Radiology** — gatekeeper
2. **CMIO / CIO** — integration, cybersecurity
3. **CMO / Chief Quality Officer** — outcomes
4. **CFO / Procurement** — ROI, reimbursement
5. **CEO** for enterprise or >€100k deals
6. **IT Security** — DPIA (GDPR), HIPAA risk assessment
7. **Hospital AI Governance Committee** — rising; multi-stakeholder review (Aidoc pattern)

**For LiverRa (surgical planning):** add **Chief of HPB/Transplant Surgery** as co-champion. Unique to LiverRa — most radiology AI doesn't need a surgeon advocate, but surgical planning does. That surgeon champion is often the deal-maker.

### Payment structure
- Budget source: surgical capex OR imaging opex OR AI innovation fund (KHZG Germany)
- Contract structure: 1-year pilot + 2-year renewal option
- Per-site flat (€40-120k/yr) or per-scan (€80-150/scan) — avoid per-scanner (legacy PACS thinking)

### Pilot → paid conversion
- 3-6 month pilot is norm (some up to 5 years)
- AI Award program (NHS): 50% of 10 technologies saw adoption; 20% converted to commercial
- **LiverRa target: 25-40% pilot-to-paid at first 8-10 sites if surgeon champion secured; <15% without**

---

## OEM / White-Label Economics

Public royalty data is NDA-protected. Triangulated from Signify Research, KLAS, analogous SaaS:
- **Small AI vendor + large platform:** 60/40 to 70/30 split favoring AI vendor on net software revenue
- **Minimum guarantees:** $50-250k/year for exclusive modality/region
- **Bundled vs separate:** Third-party (Aidoc via GE Edison, Qure via Nuance) pay platform fees $5-25k/site/year on top of royalty
- **Blackford / Nuance / deepc:** ~30% take rate + platform fee
- **LiverRa realistic OEM deal:** 25% royalty + €100-200k/year MG with Sectra or Agfa for CEE/DACH

---

## Reimbursement Summary (detail in 05-clinical-validation.md)

- **Germany:** NUB → DRG (2-4 yr cycle); DiGA does NOT apply
- **France:** Forfait Innovation 2-3 yr bridge → LPPR
- **UK:** NHS AIDP + AIDF; private market realistic earlier
- **US:** Category III CPT (pays $0); no dedicated liver AI CPT exists; NTAP modest
- **Middle East:** direct capex purchase from private hospitals; very rare insurance reimbursement

**Strategy:** Year 1-2 revenue from ME + CEE private (capex); DACH public follows once CE + NUB secured (Year 2-3); France Forfait Innovation if academic partnership locks.

---

## Why €1M is Tight (Reality Check)

### What €1M buys in EU 2024-2026
| Stage | Amount | Comparable |
|---|---|---|
| Typical EU pre-seed medical AI | **€0.8-2M** | Sycai Medical (€3.1M), Quantia (€1.2M) |
| Typical seed | €3-10M | — |
| Series A | €10-40M | Quibim €50M (2025), Harrison.ai €112M (2025) |

### What €1M funds (realistic 18-month runway)
- 4-6 FTE (2 ML + 1 full-stack + 1 regulatory + founder/commercial + 0.5 design)
- €400k → 18-month salaries (Tbilisi dev saves 40% vs DACH)
- €150k → cloud + GPU + data acquisition
- €150k → ISO 13485 + CE Class IIa technical file prep
- €100k → KOL honoraria, ethics/IRB
- €100k → commercial (part-time BD, conferences)
- €100k → buffer

### What €1M CANNOT do
- Complete CE-MDR Class IIb submission (~€300k + 12-18 months active)
- FDA 510(k) submission
- 5-person commercial team
- Deploy to paying DACH/NHS hospital as certified medical device

**Verdict:** €1M is a **bridge to Seed**. Plan €4-6M Seed raise at Month 12-15 on evidence milestones. OR stack non-dilutive:
- EIC Accelerator: €2.5M grant + €0.5-15M equity (~7% success; 32% of awards are Health)
- EIT Health: €850k
- ZIM (Germany, if EU sub): €550k

**Potential total non-dilutive: €3.5-17.5M in 24 months on top of €1M equity.**

---

## Strategy Cascade

### Phase 1 (Month 0-6): Foundation
- €1M pre-seed closed
- EIC Step 1 applied (prime target)
- EIT Health applied
- ISO 13485 QMS consultant engaged
- 2-3 academic design partners LOIs

### Phase 2 (Month 6-15): First Revenue + Regulatory Prep
- 2-3 paid POCs at ME + CEE private (€20-50k each, research use positioning)
- Peer-reviewed paper submitted
- CE-MDR Class IIb technical file drafted
- **Seed raise €4-6M** Month 12-15

### Phase 3 (Month 15-24): CE Mark + Commercial Launch
- CE Class IIb granted
- First 5-8 paid commercial sites (T2 pricing)
- France Forfait Innovation application
- First OEM partnership signed
- 2-3 commercial reps hired

### Phase 4 (Month 24-36): DACH Scale
- NUB Status 1 at 5+ German hospitals
- 15-25 paying sites total
- Series A €10-20M (Month 30) for FDA 510(k) + France LPPR + commercial scale

---

## Pricing Recommendation (Locked-In for MVP Phase)

**Tier 1 — Academic Design Partner** (Months 1-12)
- €0 for 6-12 months
- In exchange: anonymized data access + publication co-authorship + LOI for commercial conversion

**Tier 2 — Clinical Starter** (CEE + ME + private, Months 9-18)
- Site license: €40k/year unlimited cases (cap 500 cases/year, €150/case overage)
- Onboarding: €5k one-time

**Tier 3 — Flagship Hospital** (DACH + UK + France + flagship ME, Months 15-30)
- Site license: €80-120k/year unlimited
- Onboarding + integration: €15-25k one-time

**Tier 4 — Enterprise** (Year 2+)
- €60-90k/site × 5+ sites, central contract

**Per-case (pay-per-use)**
- €300-600/case surgical planning full package
- €50-100/case triage/screening
- €20-50/case API/dev tier

**OEM/white-label**
- 25-30% royalty to LiverRa
- €100-200k/year MG for exclusivity
- €50k one-time integration fee

**Dataset licensing to pharma**
- €250-500/anonymized study with outcome linkage
- €100-150/study imaging-only
- Typical deal 1-3k studies = €150-500k per contract

---

## Key Risks

| Risk | Severity | Mitigation |
|---|---|---|
| €1M underfunds CE-MDR | **HIGH** | Raise €2-3M OR stack EIC/EIT |
| Niche TAM (liver-only) | HIGH | Expand to pancreas/kidney/gallbladder Y2-3 (MeVis playbook) |
| 3-5 yr reimbursement lag | HIGH | Target private first (capex, no reimbursement needed) |
| Visible Patient / MeVis competition | HIGH | Differentiate: automation, turnaround, pricing |
| PACS OEM lockout | MEDIUM | Non-exclusive OEM deals; retain direct rights |
| NUB Status 1 doesn't guarantee payment | MEDIUM | File at 5+ hospitals simultaneously |
| AI liability (missed lesion → surgical error) | HIGH | Decision support positioning, €2-5M professional indemnity ~€15-30k/yr |
| MDR class reclassification | MEDIUM | Pre-Sub with NB early |
| Dataset bias | MEDIUM | Multi-site DACH + CEE + ME from Day 1 |
| Cybersecurity audit (NUB + CE + ME data residency) | MEDIUM | On-prem deployment option from v1 |
| Surgeon champion churn | MEDIUM | Institutional MOUs, not personal agreements |
| Cloud GPU cost spiral | LOW | Multi-cloud, spot instances, reserved at $10k+/mo |
