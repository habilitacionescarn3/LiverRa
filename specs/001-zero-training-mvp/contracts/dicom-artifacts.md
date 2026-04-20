# DICOM-SEG + DICOM-SR Artifact Contracts

**Feature**: 001-zero-training-mvp · **Research**: [`../research.md`](../research.md) §B · **Spec FR**: FR-024, FR-025, FR-026/a/b/c, FR-027, FR-028a

Defines the wire shape of the two DICOM artifacts LiverRa finalizes per Report. Both are produced by `packages/ml-inference/src/services/seg_sr/` using `highdicom`. Hospital PACS consume them via standard C-STORE (research B.6).

## Common

- **Manufacturer**: `LiverRa`
- **ManufacturerModelName**: `LiverRa v1 MVP`
- **SoftwareVersions**: `{app_version}-{pipeline_version}-{mbom_hash[0:8]}`
- **DeviceSerialNumber**: `{tenant_id}` — used as the audit channel on the hospital side
- **SeriesDescription prefix**: `LiverRa AI — ` (DICOM viewer hint that this is AI-derived)
- **SpecificCharacterSet**: `ISO_IR 192` (UTF-8; research B.8)
- **SOP Instance UID generation**: `pydicom.uid.generate_uid(prefix=LIVERRA_UID_ROOT)` — fresh per finalize (FR-026b). `LIVERRA_UID_ROOT` acquired once at org level; stored in AWS Secrets Manager.
- **Reference back to source**: all SEG/SR reference the original CT `StudyInstanceUID` + per-phase `SeriesInstanceUID`s (from the anonymized post-CTP copy).
- **RUO watermark**: SEG → `SeriesDescription` suffix ` (RUO)` + per-segment `AlgorithmIdentificationSequence.name` prefix `LiverRa-RUO-`. SR → leading `TextContentItem` with the tri-lingual RUO disclaimer body.

## Artifact 1 — DICOM-SEG (MULTI_SEGMENT_BINARY)

**Modality**: `SEG`
**SOPClassUID**: `1.2.840.10008.5.1.4.1.1.66.4` (Segmentation Storage)
**One SEG per finalize**; encodes all structures in a single Instance.

### Segments

Segment number is stable across analyses of the same study.

| # | Label | SNOMED-CT | Category | Type | Algorithm (MBoM reference) |
|---|---|---|---|---|---|
| 1 | Liver parenchyma | `10200004` "Liver structure" | Organ | AUTOMATIC | STU-Net parenchyma |
| 2 | Couinaud Segment I | `245302009` | Structure subdivision | AUTOMATIC | Pictorial Couinaud |
| 3 | Couinaud Segment II | `245303004` | — | — | — |
| 4 | Couinaud Segment III | `245304005` | — | — | — |
| 5 | Couinaud Segment IV | `245305006` | — | — | — |
| 6 | Couinaud Segment V | `245306007` | — | — | — |
| 7 | Couinaud Segment VI | `245307003` | — | — | — |
| 8 | Couinaud Segment VII | `245308008` | — | — | — |
| 9 | Couinaud Segment VIII | `245309003` | — | — | — |
| 10 | Portal vein (trunk + primary) | `32764006` | Vascular structure | AUTOMATIC | Pictorial Couinaud |
| 11 | Hepatic vein (trunks) | `8887007` | Vascular structure | AUTOMATIC | Pictorial Couinaud |
| 12..N | Lesion N (one segment per lesion) | One of: `109841003` HCC, `312104005` ICC, `62129009` FNH, `235857004` Hemangioma, `235866006` Hepatic cyst, `94381002` Secondary liver neoplasm — OR `MORPHOLOGY_UNCERTAIN` code if LiLNet abstained | Morphologically altered structure | AUTOMATIC or SEMIAUTOMATIC (if reviewer-prompted via MedSAM-2) | STU-Net lesions + LiLNet (reviewer-prompted → + MedSAM-2) |

### Geometry

- Per-frame `PixelSpacing`, `SliceThickness`, `FrameOfReferenceUID` MUST match the source CT (after 1.5 mm resampling is inverted; SEG is emitted at the original CT resolution).
- `SegmentsOverlapValues = NO` — each segment is a disjoint region; lesion voxels do NOT overlap with Couinaud voxels conceptually but ARE drawn inside parenchyma, which is resolved at the SEG encoding level by per-segment binary planes.

### Fields the SEG writer MUST set

- `SeriesDescription`: `LiverRa AI — Liver Segmentation (RUO)`
- `ReferencedSeriesSequence`: all 4 phase series from the source Study (by SeriesInstanceUID)
- `ContentCreatorName`: `LiverRa^AI^v1`
- `InstitutionName`: `{tenant.display_name}` if `tenant.institution_name_preserve = true`, else empty
- `ContentDate` / `ContentTime`: finalize timestamp
- `ClinicalTrialSubjectID` / `ClinicalTrialProtocolID`: left blank (RUO, not a trial)
- `AlgorithmIdentificationSequence` per segment: `{name, version}` from MBoM — e.g. `{name: "liverra-stunet-parenchyma", version: "1.0.3"}`

### Acceptance tests

- Round-trip: produced SEG loads in Orthanc + a test PACS; all segments render in MediMind viewer.
- SNOMED coverage: every segment has a coded label from the table above (unit test).
- RUO: `SeriesDescription` ends with ` (RUO)`; every `AlgorithmIdentificationSequence.name` begins with `liverra-` (SR + SEG writer lint).

## Artifact 2 — DICOM-SR (TID 1500 Measurement Report)

**Modality**: `SR`
**SOPClassUID**: `1.2.840.10008.5.1.4.1.1.88.33` (Comprehensive SR)
**Template**: TID 1500 (Measurement Report) with TID 1411 (Volumetric ROI Measurements) subtemplates.

### Structure

```
Measurement Report (TID 1500)
├── ObserverContext
│   ├── ObserverType: DEVICE
│   ├── DeviceObserverUID: {LIVERRA_UID_ROOT}.{app_version}
│   ├── DeviceObserverName: "LiverRa v1 MVP"
│   └── DeviceObserverManufacturerModelName: "LiverRa v1 MVP"
├── TextContentItem (DCM 121106 "Comment")
│   └── Value: Tri-lingual RUO disclaimer body (en + de + ka; see research B.8 for font requirements)
├── ProcedureReported: CID 100 "CT of Abdomen"
└── ImagingMeasurements
    ├── VolumetricROI — Whole liver (TID 1411)
    │   ├── ReferencedSegment → SEG seg 1
    │   └── Measurement: Volume (SCT 118565006) value: {parenchyma.volume_ml} mL
    ├── VolumetricROI — Couinaud Segment I..VIII (×8)
    │   ├── ReferencedSegment → SEG seg 2..9
    │   └── Measurement: Volume
    ├── Measurement Group — Future Liver Remnant
    │   ├── TextValue: `resection_plane_hash={fnv1a(plane_normal, plane_offset)}; operator={user_id_hash}`
    │   ├── Measurement: FLR Volume (SCT 118565006) value: {flr.remnant_volume_ml} mL
    │   ├── Measurement: FLR Percentage (SCT 118586006 "Percentage") value: {flr.remnant_pct_functional} %
    │   └── QualitativeEvaluation: Adequacy
    │       ├── <25% → SCT 260385009 "Negative"
    │       ├── 25–30% (non-cirrhotic) → SCT 262188008 "Borderline"
    │       └── >30% → SCT 260379002 "Adequate"
    └── VolumetricROI — Lesion (per lesion, up to N)
        ├── ReferencedSegment → SEG seg 12..(11+N)
        ├── Measurement: Longest Diameter (DCM 112039) value: {lesion.longest_diameter_mm} mm
        ├── Measurement: Volume (SCT 118565006) value: {lesion.volume_ml} mL
        ├── QualitativeEvaluation: Lesion class
        │   └── One of: HCC 109841003 / ICC 312104005 / FNH 62129009 / Hemangioma 235857004 / Hepatic cyst 235866006 / Secondary liver neoplasm 94381002 / "Uncertain" (if abstained)
        ├── NumericMeasurement: LiLNet confidence (UCUM `1`) value: {max(class_probs_calibrated)} ∈ [0,1]
        └── CodedConcept: TemperatureScaled (LiverRa custom coding) value: {temperature_applied}
```

### Fields the SR writer MUST set

- `SeriesDescription`: `LiverRa AI — Measurement Report (RUO)`
- `Evidence`: the SEG + all source CT series
- `VerifyingObserver`: null in RUO v1 (no clinician "sign-off" in DICOM sense — the finalizing surgeon is in `ObserverContext.PersonObserverName` if opt-in per tenant)
- `CompletionFlag`: `COMPLETE`
- `VerificationFlag`: `UNVERIFIED` (RUO; flip to `VERIFIED` only after regulatory clearance per claim — FR-028b)

### Acceptance tests

- SR renders in Orthanc's SR viewer with all 10+ measurement groups visible.
- `ReferencedSegment` resolves to the SEG's Segment Number (pydicom `Dataset` traversal test).
- RUO disclaimer `TextContentItem` present as first child of `ContentSequence` in en/de/ka (Unicode assert).
- Chain-of-custody: SR's `DeviceObserverUID` is the canonical LiverRa device UID root + app_version.

## Delivery (PACS push) — covered by `api-openapi.yaml` + research B.6

Summary of wire behavior:

1. Pre-flight C-ECHO on PACS destination save (`POST /api/v1/admin/pacs-destination/echo`). Must succeed before SEG/SR push is allowed.
2. Transactional push per `Report`: SEG and SR pushed in one `pynetdicom` Association; commit `ReportDelivery.status = acknowledged` only when **both** return `0x0000`.
3. Retry policy: exponential backoff 1 → 2 → 4 → 8 → 16 → 32 → 60 min, max 6 attempts; then `ReportDelivery.status = failed` with a manual-fallback option.
4. Error sanitization: all PHI scrubbed from `last_error` before Postgres write.
5. Re-finalize creates NEW SOP Instance UIDs (FR-026b); never overwrite.
