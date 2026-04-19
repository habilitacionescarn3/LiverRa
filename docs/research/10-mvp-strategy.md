# LiverRa v1 MVP Strategy — Zero-Training Cascaded Pipeline

## The Core Insight

In 2026, pretrained medical imaging models are good enough that **shipping a working clinical-grade demo without any custom training is now possible**. This is new. Three years ago it wasn't. It collapses the "6 months training → demo" playbook into "6 weeks integration → demo."

**LiverRa v1 MVP = integrate 5 Apache 2.0 pretrained models into a standalone web application. No fine-tuning. No custom training. Research Use Only disclaimer.**

---

## Expected Quality Without Fine-Tuning

| Task | Zero-training accuracy | Clinically usable? |
|---|---|---|
| Liver parenchyma segmentation | Dice 0.92-0.94 | ✅ Yes |
| Couinaud 8 segments | Dice 0.82-0.88 | ✅ Yes (demo-quality) |
| Portal/hepatic vein trunks | Dice 0.72-0.80 | ⚠️ Trunks OK, distal branches miss |
| FLR volume | ±5-8% error | ✅ Within clinical tolerance |
| Lesion detection ≥10mm | 78-88% sensitivity | ⚠️ Demo; NOT autonomous clinical use |
| Lesion detection <10mm | 45-65% sensitivity | ❌ "Radiologist must review" |
| LiLNet benign vs malignant | AUC 0.90-0.94 | ✅ Good demo |
| LiLNet HCC/ICC/MET subtype | 75-82% accuracy | ⚠️ Usable with abstention |

**Good enough for:** design-partner demos, investor showcases, clinical workflow validation, publications, KOL feedback.

**NOT good enough for:** regulatory submission, autonomous clinical use, commercial production at scale.

---

## The Cascaded Pipeline (Not End-to-End)

The April 2026 CRLM-CT-Seg benchmark confirmed **cascaded architectures beat end-to-end** for FLR prediction (Dice 0.767 vs lower). Each model does one job; errors don't compound across stages.

```
Input: 4-phase liver CT DICOM
  ↓
Stage 1: Phase alignment + QC
  ↓
Stage 2: STU-Net → liver parenchyma mask
  ↓
Stage 3: Vessel segmentation (STU-Net fine-tuned, or nnU-Net)
  ↓
Stage 4: Pictorial Couinaud → 8 segments (using vessel scaffold)
  ↓
Stage 5: STU-Net → lesion detection + mask
  ↓
Stage 6: LiLNet → classification {HCC|ICC|MET|FNH|HEM|CYST}
  ↓
Stage 7: FLR calculator (geometric reasoning)
  ↓
Stage 8: Surgeon review (VISTA3D + MedSAM-2 for interactive edit)
  ↓
Output: DICOM-SEG + structured PDF report + 3D mesh
```

**Total inference time: ~90 seconds on NVIDIA L4 GPU.**
**Surgeon interaction: 30 seconds to open + 2-5 min review/edit.**

---

## Scope Boundaries for v1

### ✅ IN scope
- Contrast-enhanced liver CT (4-phase)
- Liver parenchyma segmentation
- Couinaud 8 segments
- Portal + hepatic vein trunks
- Tumor detection + 6-class classification
- FLR volumetric calculation
- Web-based 3D viewer (OHIF + Cornerstone3D)
- Interactive surgeon edit (VISTA3D + MedSAM-2)
- Structured PDF report
- DICOM-SEG + DICOM-SR output
- DICOM upload via web (drag-drop) OR direct PACS push
- Single-tenant (one hospital per deployment)
- Research Use Only disclaimer

### ❌ OUT of scope (v2+)
- MRI (HCC gadoxetic-acid MRI is v2)
- Biliary tree segmentation (requires MRCP, defer)
- Hepatic artery segmentation (research-grade, defer)
- Multi-tenancy (per-hospital namespace isolation)
- Full HIPAA/GDPR-grade audit logging (basic only for MVP)
- Advanced LI-RADS auto-classification (decision support only)
- FDA submission artifacts
- Mobile app
- EHR integration beyond FHIR basics
- Pre-op chemo "vanishing metastases" handling
- ALPPS multi-stage planning
- Living donor donor-recipient matching

---

## User Personas for v1

### Primary: HPB Surgeon (Decision Maker + User)
- 5-20 years HPB experience
- Does 50-200 hepatectomies/year
- Currently uses: manual ROI drawing in PACS, or sends out to Visible Patient for 48h turnaround
- Pain: time-consuming FLR calc, uncertainty on small segments, borderline resectability cases

### Secondary: Abdominal Radiologist (Enabler + Validator)
- Reads liver MRI/CT in oncology context
- Uses LI-RADS for cirrhotic patients
- Pain: inter-reader variability (ICC 0.46 for LR-M), reporting time, consistency

### Tertiary: Clinical Fellow / Resident (Power User)
- Learning HPB surgery
- Uses 3D Slicer for study/research
- Pain: steep learning curve, no integration with hospital systems

---

## Success Criteria for v1 (Research Use Only phase)

1. **End-to-end pipeline runs** on 20 representative Geo Hospital scans with no crashes
2. **Inference time < 2 minutes** per scan on single L4 GPU
3. **FLR calculation within 5%** of expert manual volumetry on validation set
4. **Couinaud segmentation accuracy** validated by HPB surgeon review (qualitative: "surgically usable" on ≥80% of cases)
5. **Design partners signed:** 3 sites (Regensburg + Potsdam + Geo) with Data Processing Agreements
6. **First clinical case used in tumor board:** documented publicly
7. **Abstract submitted** to one of: ECR 2027, ESGAR 2026, IHPBA 2026

---

## 6-Week Sprint Plan

| Week | Goal | Deliverable |
|---|---|---|
| 0 (prep) | Hire team, accounts | Senior ML + full-stack engineer hired, AWS account, GitHub org, domain registered |
| 1 | Models run locally | Dev laptop can segment a test DICOM using all 5 models |
| 2 | Backend orchestration | FastAPI + Celery + Orthanc; scan-in → results-out via local pipeline |
| 3 | Frontend viewer | OHIF-based web UI, upload flow, 3D segment display |
| 4 | Cloud deployment | AWS g5.xlarge + Triton; move inference off dev laptop |
| 5 | Surgeon edit workflow | VISTA3D + MedSAM-2 interactive refinement + PDF report |
| 6 | Polish + demo prep | Deploy to app.liverra.ai with HTTPS, demo accounts, record demo video |

**Budget:** €15-25k development + €800-1,500/month AWS runtime.
**Team:** 1 senior ML engineer + 1 full-stack + clinical validation from Dr. Gogichaishvili.

---

## What Makes This Credible (Not Just Hype)

1. **All models open-sourced Apache 2.0** — no licensing risk (see `11-model-and-dataset-choices.md`)
2. **All models peer-reviewed** with published benchmarks on public datasets
3. **All models recently released** (STU-Net 2023, LiLNet 2024, VISTA3D June 2025, MedSAM-2 2024, Pictorial Couinaud 2025)
4. **Architecture pattern is proven** — Visible Patient, MeVis, Perspectum all use cascaded pipelines; end-to-end was the old way
5. **Regulatory precedent exists** — Perspectum Hepatica (FDA K-cleared 2021) and MeVis Liver Suite (K232045, 2023) show the pathway works

---

## Risks Unique to Zero-Training Approach

| Risk | Severity | Mitigation |
|---|---|---|
| Dataset shift (models trained on Western/Asian cohorts; Georgian patients differ) | Medium | Collect real-world failure cases during design-partner phase → targeted fine-tune in Phase 3 |
| Small-lesion miss (<10mm) | High | Always display "AI-generated — radiologist confirmation required" + conservative detection threshold |
| LiLNet classifier drift on non-HCC tumor types common in Europe (e.g. colorectal mets-heavy) | Medium | Fine-tune LiLNet on CRLM-CT-Seg (April 2026) + your metastasis cases |
| Model version management before MLflow is set up | Low | MLflow + DVC from Day 1 — regulatory traceability demand |
| Confusion between "Research Use" and "Clinical Use" in user workflow | High | Prominent UI disclaimer, watermarked PDF reports, explicit acceptance checkbox |

---

## Reference Documents for Spec Generation

- `04-ml-feasibility.md` — per-capability maturity + published benchmarks
- `11-model-and-dataset-choices.md` — exact model URLs + dataset licensing
- `07-technical-architecture.md` — infrastructure + deployment
- `05-clinical-validation.md` — clinical workflow context
