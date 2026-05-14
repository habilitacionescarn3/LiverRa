// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Radiology Report Service
// ============================================================================
// FHIR data layer for radiology reports (DiagnosticReport). Handles saving
// (upsert) and loading reports linked to ImagingStudy resources.
//
// Think of this like a radiologist's dictation workflow:
// 1. Draft a report (partial) → refine it → finalize it
// 2. The report body (HTML) is stored in presentedForm as base64
// 3. A plain-text impression/conclusion is stored in the conclusion field
//
// Phase-2 status (LiverRa):
//   Persistence is wired through the LiverRa FHIR client stub
//   (`useLiverraFhir` → `fhirClient.ts`). `saveRadiologyReport` logs via
//   `createResource` and returns a synthetic id so the UI flow works.
//   `loadRadiologyReport` returns null until Phase 4 wires real FHIR storage.
//
// Ported from MediMind (services/pacs/radiologyReportService.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient`.
//   - `@medplum/fhirtypes` DiagnosticReport / Bundle / Provenance inlined.
//   - Cardiology cath-lab + CAD-RADS extension hooks REMOVED (cardiology
//     scope cut per Phase-2 plan). Reports persist liver-relevant data only.
//   - Report TEMPLATES trimmed to liver-relevant ones only. See the
//     `RADIOLOGY_TEMPLATES` constant below.
//   - `requirePermission` removed; LiverRa RBAC lands in Phase 4.
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { sendFindingsNotification, parseTimeline } from './notificationHelpers';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';

// ============================================================================
// Minimal FHIR shapes (inlined — Phase 4 will swap for the real FHIR types)
// ============================================================================

interface Reference {
  reference?: string;
  display?: string;
}

interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

interface CodeableConcept {
  coding?: Coding[];
}

interface PresentedForm {
  contentType?: string;
  data?: string;
}

interface Extension {
  url: string;
  valueString?: string;
}

interface Signature {
  type?: Coding[];
  when?: string;
  who?: Reference;
}

interface Meta {
  versionId?: string;
}

/** Minimal FHIR `DiagnosticReport` shape used by this service. */
interface DiagnosticReport extends FhirResourceLike {
  resourceType: 'DiagnosticReport';
  id?: string;
  meta?: Meta;
  status: string;
  category?: CodeableConcept[];
  code?: CodeableConcept;
  subject?: Reference;
  imagingStudy?: Reference[];
  basedOn?: Reference[];
  effectiveDateTime?: string;
  conclusion?: string;
  performer?: Reference[];
  resultsInterpreter?: Reference[];
  presentedForm?: PresentedForm[];
  extension?: Extension[];
}

/** Minimal FHIR `Provenance` shape. */
interface Provenance extends FhirResourceLike {
  resourceType: 'Provenance';
  target: Reference[];
  recorded: string;
  agent: Array<{ type?: CodeableConcept; who: Reference }>;
  signature?: Signature[];
}

/** Minimal FHIR `ImagingStudy` shape (only the fields this service mutates). */
interface ImagingStudy extends FhirResourceLike {
  resourceType: 'ImagingStudy';
  id?: string;
  meta?: Meta;
  extension?: Extension[];
}

// ============================================================================
// Inlined URL constants (LiverRa-owned extension URLs)
// ============================================================================

const PACS_DIAGNOSTIC_REPORT = {
  CATEGORY: { system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD' },
  CODE: {
    system: 'http://loinc.org',
    code: '18748-4',
    display: 'Diagnostic imaging study',
  },
} as const;

const IMAGING_EXTENSIONS = {
  STUDY_STATUS: `${FHIR_BASE_URL}/StructureDefinition/imaging-study-status`,
  STUDY_TIMELINE: `${FHIR_BASE_URL}/StructureDefinition/imaging-study-timeline`,
} as const;

const PROVENANCE_PARTICIPANT_TYPE_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/provenance-participant-type';

// ============================================================================
// Local sanitize helpers
// ============================================================================
// LiverRa doesn't have the MediMind `utils/sanitize` module yet. Inline a
// minimal `escapeHtml` + allow-HTML `sanitizeHtml` (strip script/style/iframe
// + event handlers). Phase 4 should replace this with a full DOMPurify pass.

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHtml(input: string): string {
  // TODO(phase-4): swap for DOMPurify. This is a best-effort strip for now.
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

// ============================================================================
// Types
// ============================================================================

export interface SaveReportParams {
  /** FHIR ImagingStudy resource ID. */
  studyId: string;
  /** FHIR Patient resource ID. */
  patientId: string;
  /** Report status: draft, preliminary, or finalized. */
  reportStatus: 'partial' | 'preliminary' | 'final';
  /** Rich-text report body as HTML. */
  htmlContent: string;
  /** Plain-text impression/conclusion. */
  conclusion?: string;
  /** e.g., 'Practitioner/123' */
  practitionerRef?: string;
  /** Display name for the practitioner. */
  practitionerDisplay?: string;
}

export interface RadiologyReportData {
  id: string;
  status: string;
  htmlContent: string;
  conclusion?: string;
  effectiveDateTime?: string;
  performer?: string;
  /** Whether this report is an addendum linked to another report. */
  isAddendum?: boolean;
}

// ============================================================================
// Liver-relevant Report Templates
// ============================================================================
// MediMind ships ~10 templates covering CT/MR/X-ray/US, spine, head,
// mammography, cardiac CT, etc. LiverRa's hepatobiliary scope only keeps
// liver-relevant templates. Other MediMind templates were removed per the
// Phase-2 plan.

/** Supported locale codes. */
export type TemplateLocale = 'ka' | 'en' | 'ru' | 'de';

/** A reusable report template with multi-locale content. */
export interface ReportTemplate {
  id: string;
  name: string;
  nameKa?: string;
  nameRu?: string;
  nameDe?: string;
  description: string;
  /** HTML content (English source). */
  content: string;
  contentKa?: string;
  contentRu?: string;
  contentDe?: string;
}

/**
 * Get template content for the given locale; falls back to English when the
 * localised content isn't present.
 */
export function getTemplateContent(
  template: ReportTemplate,
  locale: TemplateLocale,
): string {
  if (locale === 'ka' && template.contentKa) {
    return template.contentKa;
  }
  if (locale === 'ru' && template.contentRu) {
    return template.contentRu;
  }
  if (locale === 'de' && template.contentDe) {
    return template.contentDe;
  }
  return template.content;
}

/**
 * Radiology report templates for LiverRa's hepatobiliary scope.
 *
 * Kept from MediMind:
 *   - Generic Radiology (useful for any study type).
 *   - CT Report (generic CT body).
 *   - MRI Report (generic MR body).
 *   - CT Abdomen/Pelvis (liver sits inside this exam).
 *
 * Added LiverRa-specific templates:
 *   - CT Abdomen with Contrast
 *   - MRI Liver Dynamic
 *   - CT Portal Phase
 *   - Pre-operative Hepatectomy Planning
 *   - Post-TACE Follow-up
 *
 * Removed (per Phase-2 plan):
 *   - rad-xray, rad-ultrasound, rad-mri-spine, rad-ct-head, rad-mammography,
 *     rad-cardiac-ct — none are in LiverRa's hepatobiliary scope.
 */
export const RADIOLOGY_TEMPLATES: ReportTemplate[] = [
  {
    id: 'rad-generic',
    name: 'Generic Radiology Report',
    nameKa: 'ზოგადი რადიოლოგიური',
    nameRu: 'Общий радиологический',
    description: 'Standard radiology report format',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Technique</h3>
<p><br></p>

<h3>Comparison</h3>
<p><br></p>

<h3>Findings</h3>
<p><br></p>

<h3>Impression</h3>
<p><br></p>`,
  },
  {
    id: 'rad-ct',
    name: 'CT Report',
    nameKa: 'CT კვლევა',
    nameRu: 'КТ исследование',
    description: 'Computed tomography report format',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Technique</h3>
<p><strong>Contrast:</strong> </p>
<p><strong>Dose (DLP):</strong> </p>
<p><br></p>

<h3>Comparison</h3>
<p><br></p>

<h3>Findings</h3>
<p><br></p>

<h3>Impression</h3>
<p><br></p>`,
  },
  {
    id: 'rad-mri',
    name: 'MRI Report',
    nameKa: 'MRI კვლევა',
    nameRu: 'МРТ исследование',
    description: 'Magnetic resonance imaging report format',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Technique</h3>
<p><strong>Sequences:</strong> </p>
<p><strong>Contrast:</strong> </p>
<p><br></p>

<h3>Comparison</h3>
<p><br></p>

<h3>Findings</h3>
<p><br></p>

<h3>Impression</h3>
<p><br></p>`,
  },
  {
    id: 'rad-ct-abdomen-pelvis',
    name: 'CT Abdomen/Pelvis',
    nameKa: 'CT მუცლის/მენჯის',
    nameRu: 'КТ брюшной полости/таза',
    description: 'Structured CT abdomen/pelvis report with organ-by-organ findings',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Comparison</h3>
<p>None available.</p>

<h3>Technique</h3>
<p><strong>Contrast:</strong> With / Without / Both</p>
<p><strong>Dose (DLP):</strong> </p>

<h3>Findings</h3>
<p><strong>Liver:</strong> Normal size and attenuation. No focal lesion identified.</p>
<p><strong>Gallbladder/Biliary:</strong> No gallstones. No biliary dilatation.</p>
<p><strong>Pancreas:</strong> Normal size and enhancement. No pancreatic duct dilatation.</p>
<p><strong>Spleen:</strong> Normal size. No focal lesion.</p>
<p><strong>Kidneys/Ureters:</strong> Normal size, symmetric enhancement. No hydronephrosis or calculi.</p>
<p><strong>Adrenals:</strong> Normal bilaterally.</p>
<p><strong>Bowel:</strong> No bowel wall thickening or obstruction.</p>
<p><strong>Mesentery/Peritoneum:</strong> No free fluid or fat stranding.</p>
<p><strong>Vasculature:</strong> Aorta and major branches are patent. No aneurysm.</p>
<p><strong>Lymph Nodes:</strong> No pathologically enlarged lymph nodes.</p>
<p><strong>Pelvis:</strong> Unremarkable pelvic structures.</p>

<h3>Impression</h3>
<p>No acute abdominal or pelvic abnormality.</p>`,
  },
  // ── LiverRa-specific liver templates ──
  {
    id: 'rad-ct-abdomen-contrast',
    name: 'CT Abdomen with Contrast',
    nameKa: 'CT მუცლის კონტრასტით',
    nameRu: 'КТ брюшной полости с контрастом',
    description: 'Triphasic CT abdomen report with explicit liver focus',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Comparison</h3>
<p>None available.</p>

<h3>Technique</h3>
<p><strong>Contrast:</strong> IV iodinated contrast (triphasic: arterial, portal venous, delayed).</p>
<p><strong>Dose (DLP):</strong> </p>

<h3>Findings</h3>
<p><strong>Liver:</strong> Normal size and attenuation. Smooth contour. No focal lesion identified on any phase.</p>
<p><strong>Hepatic Vasculature:</strong> Portal vein, hepatic veins, and hepatic artery are patent with normal caliber.</p>
<p><strong>Biliary Tree:</strong> No intrahepatic or extrahepatic biliary ductal dilatation.</p>
<p><strong>Gallbladder:</strong> Unremarkable. No gallstones.</p>
<p><strong>Pancreas / Spleen / Adrenals:</strong> Unremarkable.</p>
<p><strong>Kidneys:</strong> Normal size, symmetric enhancement.</p>
<p><strong>Bowel / Peritoneum:</strong> No free fluid, no wall thickening.</p>
<p><strong>Osseous Structures:</strong> No suspicious osseous lesion.</p>

<h3>Impression</h3>
<p>No focal hepatic lesion. Normal triphasic contrast-enhanced CT of the abdomen.</p>`,
  },
  {
    id: 'rad-mri-liver-dynamic',
    name: 'MRI Liver Dynamic',
    nameKa: 'ღვიძლის MRI დინამიური',
    nameRu: 'Динамическая МРТ печени',
    description: 'Gadolinium-enhanced dynamic MRI liver (arterial / portal / delayed / hepatobiliary)',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Comparison</h3>
<p>None available.</p>

<h3>Technique</h3>
<p><strong>Sequences:</strong> Axial T2 HASTE, T1 in/out-of-phase, DWI (b=50, 400, 800), dynamic multiphase T1 VIBE post-gadolinium (arterial, portal venous, delayed) with optional hepatobiliary phase.</p>
<p><strong>Contrast:</strong> Gadolinium (specify agent):  </p>

<h3>Findings</h3>
<p><strong>Liver:</strong> Normal size, morphology, and signal intensity. No focal lesion identified.</p>
<p><strong>Hepatic Vasculature:</strong> Portal vein, hepatic veins, and hepatic artery are patent.</p>
<p><strong>Biliary Tree:</strong> No biliary dilatation.</p>
<p><strong>Gallbladder / Pancreas / Spleen:</strong> Unremarkable.</p>
<p><strong>Adjacent Structures:</strong> No ascites or lymphadenopathy.</p>

<h3>Impression</h3>
<p>Normal multiphase dynamic MRI of the liver.</p>`,
  },
  {
    id: 'rad-ct-portal-phase',
    name: 'CT Portal Phase',
    nameKa: 'CT პორტალური ფაზა',
    nameRu: 'КТ портальная фаза',
    description: 'Single-phase portal-venous CT of the abdomen',
    content: `<h3>Clinical Indication</h3>
<p><br></p>

<h3>Comparison</h3>
<p>None available.</p>

<h3>Technique</h3>
<p><strong>Contrast:</strong> IV iodinated contrast, portal venous phase (~70 s).</p>
<p><strong>Dose (DLP):</strong> </p>

<h3>Findings</h3>
<p><strong>Liver:</strong> Normal attenuation. No focal lesion on portal venous phase.</p>
<p><strong>Portal / Hepatic Veins:</strong> Patent.</p>
<p><strong>Other Abdominal Organs:</strong> Unremarkable.</p>

<h3>Impression</h3>
<p>No focal hepatic lesion on portal venous phase CT.</p>`,
  },
  {
    id: 'rad-preop-hepatectomy',
    name: 'Pre-operative Hepatectomy Planning',
    nameKa: 'პრეოპერაციული ჰეპატექტომიის დაგეგმვა',
    nameRu: 'Предоперационное планирование гепатэктомии',
    description: 'Pre-op liver resection planning with volumetry + FLR',
    content: `<h3>Clinical Indication</h3>
<p>Pre-operative planning for hepatectomy.</p>

<h3>Comparison</h3>
<p><br></p>

<h3>Technique</h3>
<p><strong>Modality:</strong> Multiphase CT / MRI.</p>
<p><strong>Contrast:</strong> </p>

<h3>Findings</h3>
<p><strong>Lesion Inventory:</strong>  (number, segment, size, enhancement pattern)</p>
<p><strong>Couinaud Segments:</strong> Segments I–VIII evaluated; vascular pedicles traced.</p>
<p><strong>Portal / Hepatic Venous Anatomy:</strong>  (variants, patency)</p>
<p><strong>Hepatic Artery Anatomy:</strong>  (variants, replaced / accessory branches)</p>
<p><strong>Biliary Anatomy:</strong>  (variants)</p>
<p><strong>Total Liver Volume (TLV):</strong>  cm³</p>
<p><strong>Future Liver Remnant (FLR):</strong>  cm³ (   % of TLV)</p>
<p><strong>Standardised FLR / Body Weight:</strong>  (if relevant)</p>
<p><strong>Extra-hepatic Disease:</strong> </p>

<h3>Impression</h3>
<p><strong>Resection Plan:</strong> </p>
<p><strong>FLR Adequacy:</strong> </p>
<p><strong>Caveats / Recommendations:</strong> </p>`,
  },
  {
    id: 'rad-post-tace',
    name: 'Post-TACE Follow-up',
    nameKa: 'TACE-ის შემდგომი მონიტორინგი',
    nameRu: 'Наблюдение после TACE',
    description: 'Follow-up imaging after trans-arterial chemoembolisation',
    content: `<h3>Clinical Indication</h3>
<p>Follow-up after trans-arterial chemoembolisation (TACE).</p>

<h3>Comparison</h3>
<p>Prior imaging date: </p>

<h3>Technique</h3>
<p><strong>Modality:</strong> Contrast-enhanced CT / MRI.</p>
<p><strong>Protocol:</strong> Multiphase (arterial / portal venous / delayed).</p>

<h3>Findings</h3>
<p><strong>Treated Lesion(s):</strong>  (size, segment, residual enhancement, mRECIST / LI-RADS TR category)</p>
<p><strong>Lipiodol Deposition:</strong> </p>
<p><strong>New Lesions:</strong> </p>
<p><strong>Portal Vein Thrombosis:</strong> </p>
<p><strong>Ascites / Lymphadenopathy:</strong> </p>

<h3>Impression</h3>
<p><strong>Treatment Response:</strong> </p>
<p><strong>Recommendation:</strong> </p>`,
  },
];

// ============================================================================
// Core: Save (upsert) a radiology report
// ============================================================================

/**
 * Save or update a radiology report for an imaging study. If a DiagnosticReport
 * already exists for the study it's updated; otherwise a new one is created.
 *
 * Phase-2 status: writes go through the FHIR stub so the UI flow works and
 * the payload is logged — real persistence lands in Phase 4 when the
 * LiverRa FHIR backend is wired.
 *
 * @returns The saved DiagnosticReport resource ID (synthetic for the stub).
 */
export async function saveRadiologyReport(
  medplum: LiverRaFhirClient,
  params: SaveReportParams,
): Promise<string> {
  const {
    studyId,
    patientId,
    reportStatus,
    htmlContent,
    conclusion,
    practitionerRef,
    practitionerDisplay,
  } = params;

  // Build the performer reference if provided
  const performerRef = practitionerRef
    ? [{ reference: practitionerRef, display: practitionerDisplay }]
    : undefined;

  // Encode HTML content as UTF-8-safe base64 for presentedForm
  const encodedHtml = btoa(unescape(encodeURIComponent(htmlContent)));

  // Check if a report already exists for this study
  const existingBundle = await medplum.search('DiagnosticReport', {
    'imaging-study': `ImagingStudy/${studyId}`,
    _count: '1',
  });
  const existing = (existingBundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is DiagnosticReport => Boolean(r) && r?.resourceType === 'DiagnosticReport');

  const reportData: DiagnosticReport = {
    resourceType: 'DiagnosticReport',
    status: reportStatus,
    category: [
      {
        coding: [
          {
            system: PACS_DIAGNOSTIC_REPORT.CATEGORY.system,
            code: PACS_DIAGNOSTIC_REPORT.CATEGORY.code,
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: PACS_DIAGNOSTIC_REPORT.CODE.system,
          code: PACS_DIAGNOSTIC_REPORT.CODE.code,
          display: PACS_DIAGNOSTIC_REPORT.CODE.display,
        },
      ],
    },
    subject: { reference: `Patient/${patientId}` },
    imagingStudy: [{ reference: `ImagingStudy/${studyId}` }],
    effectiveDateTime: new Date().toISOString(),
    conclusion,
    performer: performerRef,
    resultsInterpreter: performerRef,
    presentedForm: [
      {
        contentType: 'text/html',
        data: encodedHtml,
      },
    ],
  };

  let saved: DiagnosticReport;

  if (existing.length > 0 && existing[0].id) {
    const currentReport = (await medplum.readResource('DiagnosticReport', existing[0].id)) as
      | DiagnosticReport
      | null;

    if (currentReport?.status === 'final') {
      throw new Error('Cannot modify a finalized report. Create an addendum instead.');
    }

    // C-LOCK-3: pass the observed versionId as If-Match.
    saved = await medplum.updateResource<DiagnosticReport>(
      {
        ...reportData,
        id: currentReport?.id ?? existing[0].id,
        meta: { versionId: currentReport?.meta?.versionId },
      },
      { ifMatch: currentReport?.meta?.versionId },
    );
  } else {
    saved = await medplum.createResource<DiagnosticReport>(reportData);
  }

  // The FHIR stub doesn't invent ids — synthesise one so the UI can route.
  // TODO(phase-4): remove fallback once real persistence returns server-assigned ids.
  return saved.id ?? `stub-diagnosticreport-${studyId}`;
}

// ============================================================================
// Core: Load a radiology report
// ============================================================================

/**
 * Load the radiology report for a given imaging study.
 *
 * Phase-2 status: returns null because the FHIR stub has no storage. The UI
 * still renders (empty editor) and saves are logged.
 *
 * @returns The report data, or null if no report exists yet.
 */
export async function loadRadiologyReport(
  medplum: LiverRaFhirClient,
  studyId: string,
): Promise<RadiologyReportData | null> {
  const bundle = await medplum.search('DiagnosticReport', {
    'imaging-study': `ImagingStudy/${studyId}`,
    _count: '1',
  });
  const results = (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is DiagnosticReport => Boolean(r) && r?.resourceType === 'DiagnosticReport');

  if (results.length === 0 || !results[0].id) {
    return null;
  }

  const report = results[0];

  // Decode HTML from base64 presentedForm
  let htmlContent = '';
  const formData = report.presentedForm?.[0]?.data;
  if (formData) {
    try {
      htmlContent = decodeURIComponent(escape(atob(formData)));
    } catch {
      htmlContent = '';
    }
  }

  const performer = report.performer?.[0]?.display ?? undefined;

  return {
    id: report.id,
    status: report.status,
    htmlContent,
    conclusion: report.conclusion,
    effectiveDateTime: report.effectiveDateTime,
    performer,
    isAddendum: isAddendum(report),
  };
}

// ============================================================================
// Sign a radiology report (creates Provenance + updates study status)
// ============================================================================

export interface SignReportParams {
  reportId: string;
  studyId: string;
  patientId: string;
  /** Signer's Practitioner ID. */
  signerId: string;
  /** Signer's display name. */
  signerName: string;
}

/** Result of report signing — includes any non-critical warnings. */
export interface SignReportResult {
  success: boolean;
  warnings: string[];
}

/**
 * Sign a radiology report: set status to 'final' + create Provenance.
 *
 * MediMind wraps these two mutations in a FHIR transaction Bundle so they
 * succeed or fail atomically. LiverRa's FHIR stub doesn't support `executeBatch`
 * yet, so we perform two sequential calls; when the real backend arrives in
 * Phase 4 we'll reintroduce the transaction Bundle.
 */
export async function signRadiologyReport(
  medplum: LiverRaFhirClient,
  params: SignReportParams,
): Promise<SignReportResult> {
  const { reportId, studyId, patientId, signerId, signerName } = params;
  const now = new Date().toISOString();
  const warnings: string[] = [];

  // Step 1: read the current report + prevent re-signing
  const report = (await medplum.readResource('DiagnosticReport', reportId)) as
    | DiagnosticReport
    | null;

  if (report?.status === 'final') {
    throw new Error('Report is already finalized and cannot be re-signed');
  }

  const signatureType: Coding = {
    system: 'urn:iso-astm:E1762-95:2013',
    code: '1.2.840.10065.1.12.1.1',
    display: "Author's Signature",
  };

  const provenance: Provenance = {
    resourceType: 'Provenance',
    target: [{ reference: `DiagnosticReport/${reportId}` }],
    recorded: now,
    agent: [
      {
        type: {
          coding: [
            {
              system: PROVENANCE_PARTICIPANT_TYPE_SYSTEM,
              code: 'author',
              display: 'Author',
            },
          ],
        },
        who: {
          reference: `Practitioner/${signerId}`,
          display: signerName,
        },
      },
    ],
    signature: [
      {
        type: [signatureType],
        when: now,
        who: {
          reference: `Practitioner/${signerId}`,
          display: signerName,
        },
      },
    ],
  };

  // Step 2: finalize the report (sequential — transaction lands in Phase 4).
  //
  // C-LOCK-2: two surgeons hitting "Finalize" simultaneously must not
  // both succeed at flipping the report to ``final`` (the second flip
  // would race-overwrite the first signer's Provenance attribution).
  // We thread the version we just read as ``If-Match``; Phase 4's FHIR
  // server will reject the second mutation with 412 Precondition
  // Failed, and the catch surfaces the conflict as a friendly toast
  // rather than a generic "save failed".
  if (report) {
    try {
      await medplum.updateResource<DiagnosticReport>(
        {
          ...report,
          status: 'final',
        },
        { ifMatch: report.meta?.versionId },
      );
    } catch (err) {
      // Phase 4 will surface a real Response with status === 412; for
      // the stub we map by message-string so the user-facing error is
      // already wired when the backend lands.
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: number }).status
          : null;
      if (status === 412) {
        throw new Error(
          'Another reviewer finalized this report — refresh to see the latest.',
        );
      }
      throw err;
    }
  }
  await medplum.createResource<Provenance>(provenance);

  // Step 3 (non-critical): Update ImagingStudy status to 'reported'
  try {
    await updateStudyStatusToReported(medplum, studyId, signerName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Study status update failed: ${msg}`);
  }

  // Step 4 (non-critical): Send "findings available" notification.
  try {
    await sendFindingsNotification(
      { createResource: (r) => medplum.createResource(r as FhirResourceLike) },
      studyId,
      patientId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Notification failed: ${msg}`);
  }

  return { success: true, warnings };
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract a specific extension's valueString from a resource. */
function getExtensionValueString(
  resource: { extension?: Extension[] } | null | undefined,
  url: string,
): string {
  return resource?.extension?.find((e) => e.url === url)?.valueString ?? '';
}

/** Update ImagingStudy status to 'reported' and append a timeline entry. */
async function updateStudyStatusToReported(
  medplum: LiverRaFhirClient,
  studyId: string,
  actorName: string,
): Promise<void> {
  const study = (await medplum.readResource('ImagingStudy', studyId)) as ImagingStudy | null;
  if (!study) {
    // Stub returns null; no-op until Phase 4 wires real storage.
    return;
  }

  const extensions = (study.extension ?? []).filter(
    (ext) =>
      ext.url !== IMAGING_EXTENSIONS.STUDY_STATUS &&
      ext.url !== IMAGING_EXTENSIONS.STUDY_TIMELINE,
  );

  extensions.push({
    url: IMAGING_EXTENSIONS.STUDY_STATUS,
    valueString: 'reported',
  });

  const existingTimeline = parseTimeline(
    getExtensionValueString(study, IMAGING_EXTENSIONS.STUDY_TIMELINE),
  );
  existingTimeline.push({
    status: 'reported',
    timestamp: new Date().toISOString(),
    actor: actorName,
  });
  extensions.push({
    url: IMAGING_EXTENSIONS.STUDY_TIMELINE,
    valueString: JSON.stringify(existingTimeline),
  });

  // C-LOCK-3: pass the observed versionId as If-Match.
  await medplum.updateResource<ImagingStudy>(
    {
      ...study,
      meta: { versionId: study.meta?.versionId },
      extension: extensions,
    },
    { ifMatch: study.meta?.versionId },
  );
}

// ============================================================================
// Addendum: create, detect, and fetch addenda to signed reports
// ============================================================================

/**
 * Create a new addendum DiagnosticReport linked to an original (signed) report.
 * Think of an addendum like a P.S. on a letter — extra notes added after
 * signing. The addendum starts as 'partial' so the radiologist can edit it.
 */
export async function createAddendum(
  medplum: LiverRaFhirClient,
  originalReportId: string,
): Promise<DiagnosticReport> {
  const original = (await medplum.readResource('DiagnosticReport', originalReportId)) as
    | DiagnosticReport
    | null;

  const addendum: DiagnosticReport = {
    resourceType: 'DiagnosticReport',
    status: 'partial',
    basedOn: [{ reference: `DiagnosticReport/${originalReportId}` }],
    category: original?.category,
    code: original?.code,
    subject: original?.subject,
    effectiveDateTime: new Date().toISOString(),
    conclusion: '',
    presentedForm: [
      {
        contentType: 'text/html',
        data: btoa(''),
      },
    ],
  };

  return medplum.createResource<DiagnosticReport>(addendum);
}

/** Check whether a DiagnosticReport is an addendum (basedOn → DiagnosticReport). */
export function isAddendum(report: DiagnosticReport): boolean {
  return (report.basedOn ?? []).some(
    (ref) => ref.reference?.startsWith('DiagnosticReport/'),
  );
}

/** Get the original report ID from an addendum's basedOn reference. */
export function getOriginalReportId(report: DiagnosticReport): string | null {
  const ref = (report.basedOn ?? []).find(
    (r) => r.reference?.startsWith('DiagnosticReport/'),
  );
  return ref?.reference?.replace('DiagnosticReport/', '') ?? null;
}

/** Fetch all addenda linked to an original report. */
export async function getAddenda(
  medplum: LiverRaFhirClient,
  originalReportId: string,
): Promise<RadiologyReportData[]> {
  const bundle = await medplum.search('DiagnosticReport', {
    'based-on': `DiagnosticReport/${originalReportId}`,
    _count: '100',
  });
  const results = (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is DiagnosticReport => Boolean(r) && r?.resourceType === 'DiagnosticReport');

  return results
    .filter((r) => r.id)
    .map((report) => {
      let htmlContent = '';
      const formData = report.presentedForm?.[0]?.data;
      if (formData) {
        try {
          htmlContent = decodeURIComponent(escape(atob(formData)));
        } catch {
          htmlContent = '';
        }
      }

      return {
        id: report.id as string,
        status: report.status,
        htmlContent,
        conclusion: report.conclusion,
        effectiveDateTime: report.effectiveDateTime,
        performer: report.performer?.[0]?.display ?? undefined,
        isAddendum: isAddendum(report),
      };
    });
}

// ============================================================================
// Print report (opens browser print dialog with formatted HTML)
// ============================================================================

/** Parameters accepted by `printRadiologyReport`. */
export interface PrintRadiologyReportParams {
  htmlContent: string;
  studyDescription?: string;
  patientName?: string;
  studyDate?: string;
  modalities?: string[];
  signerName?: string;
  signedAt?: string;
  /** Locale for date formatting and labels (defaults to `navigator.language`). */
  locale?: string;
  /** Translated labels for print output (defaults to English). */
  labels?: {
    title?: string;
    patient?: string;
    modality?: string;
    study?: string;
    date?: string;
    signedBy?: string;
  };
}

/** Print styles kept separate so the document tree can reference them via a
 * single <style> textContent assignment (no `document.write`). */
const PRINT_CSS = `
@page { margin: 2cm; }
body {
  font-family: 'Segoe UI', 'DejaVu Sans', sans-serif;
  font-size: 12pt;
  line-height: 1.5;
  color: #1a1a1a;
}
/* Print stylesheet — uses static hex literals because PDF renderers don't
 * evaluate CSS custom properties. Brand-ramp swap (T464) requires a separate
 * touch-up: once brand-tokens.md status flips to 'approved', replace #1a365d
 * here with the new --liverra-primary-700 raw hex value. */
.header {
  border-bottom: 2px solid #1a365d;
  padding-bottom: 12px;
  margin-bottom: 20px;
}
.header h1 {
  font-size: 16pt;
  color: #1a365d;
  margin: 0 0 6px 0;
}
.meta {
  font-size: 10pt;
  color: #555;
}
.report-body h3 {
  font-size: 13pt;
  color: #1a365d;
  border-bottom: 1px solid #ddd;
  padding-bottom: 4px;
  margin-top: 16px;
}
.signature {
  margin-top: 40px;
  padding-top: 12px;
  border-top: 1px solid #ddd;
  font-size: 10pt;
  color: #555;
}
`;

/**
 * Print a radiology report using the browser's print dialog. Opens a new
 * window and builds the print document via DOM APIs (no `document.write`).
 */
export function printRadiologyReport(params: PrintRadiologyReportParams): void {
  const {
    htmlContent,
    studyDescription,
    patientName,
    studyDate,
    modalities,
    signerName,
    signedAt,
    locale,
    labels,
  } = params;
  const lang = locale ?? navigator.language;
  const l = {
    title: labels?.title ?? 'Radiology Report',
    patient: labels?.patient ?? 'Patient',
    modality: labels?.modality ?? 'Modality',
    study: labels?.study ?? 'Study',
    date: labels?.date ?? 'Date',
    signedBy: labels?.signedBy ?? 'Signed by',
  };

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    throw new Error('Print popup blocked by browser. Please allow popups for this site.');
  }

  const doc = printWindow.document;

  // ---- <head> ----
  doc.title = l.title;
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.appendChild(meta);
  const styleEl = doc.createElement('style');
  styleEl.textContent = PRINT_CSS;
  doc.head.appendChild(styleEl);

  // ---- <body> header ----
  const header = doc.createElement('div');
  header.className = 'header';
  const h1 = doc.createElement('h1');
  h1.textContent = l.title;
  header.appendChild(h1);

  const metaDiv = doc.createElement('div');
  metaDiv.className = 'meta';
  const addMetaRow = (label: string, value: string | undefined): void => {
    if (!value) { return; }
    const row = doc.createElement('div');
    const strong = doc.createElement('strong');
    strong.textContent = `${label}:`;
    row.appendChild(strong);
    row.appendChild(doc.createTextNode(` ${value}`));
    metaDiv.appendChild(row);
  };
  addMetaRow(l.patient, patientName);
  addMetaRow(l.modality, modalities?.join(', '));
  addMetaRow(l.study, studyDescription);
  addMetaRow(l.date, studyDate ? new Date(studyDate).toLocaleDateString(lang) : undefined);
  header.appendChild(metaDiv);
  doc.body.appendChild(header);

  // ---- report body (sanitised HTML) ----
  const body = doc.createElement('div');
  body.className = 'report-body';
  // The HTML is sanitised above (strips script/style/iframe + on-handlers) so
  // setting innerHTML here is acceptable. TODO(phase-4): replace with DOMPurify.
  body.innerHTML = sanitizeHtml(htmlContent);
  doc.body.appendChild(body);

  // ---- signature ----
  if (signerName) {
    const sig = doc.createElement('div');
    sig.className = 'signature';
    const addSigRow = (label: string, value: string): void => {
      const row = doc.createElement('div');
      const strong = doc.createElement('strong');
      strong.textContent = `${label}:`;
      row.appendChild(strong);
      row.appendChild(doc.createTextNode(` ${value}`));
      sig.appendChild(row);
    };
    addSigRow(l.signedBy, signerName);
    if (signedAt) {
      addSigRow(l.date, new Date(signedAt).toLocaleString(lang));
    }
    doc.body.appendChild(sig);
  }

  // Keep escapeHtml referenced so unused-vars lint doesn't fire (it's retained
  // for Phase-4 swap to a full DOMPurify + template-literal strategy).
  void escapeHtml;

  printWindow.focus();
  printWindow.print();
}
