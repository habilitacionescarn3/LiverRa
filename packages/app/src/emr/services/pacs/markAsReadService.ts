// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// Mark-As-Read Service (LiverRa)
// ============================================================================
// "Sign-off" pipeline for a radiologist finishing a read:
//   1. Create a DiagnosticReport with findings (preliminary or final).
//   2. Update the ImagingStudy status extension + timeline entry.
//   3. Send a findings-available notification (Communication).
//
// Steps 1+2 run as a FHIR transaction so either both apply or neither does —
// no half-read studies.
//
// Ported from MediMind with Medplum swapped for the LiverRa FHIR shim. Phase-1
// stubs in `fhirClient.ts` mean the transaction is logged but not persisted;
// Phase 4 wires real Supabase storage. Surface is preserved so the worklist
// "Mark as Read" button compiles + runs without call-site changes.
// ============================================================================

import type { FhirResourceLike, LiverRaFhirClient } from '../fhirClient';
import type { StatusTimelineEntry } from '../../types/pacs';
import {
  sendFindingsNotification,
  parseTimeline,
} from './notificationHelpers';

// ============================================================================
// Types
// ============================================================================

export interface MarkAsReadParams {
  /** FHIR ImagingStudy resource ID. */
  studyId: string;
  /** FHIR Patient resource ID. */
  patientId: string;
  /** Preliminary or final reading. */
  reportStatus: 'preliminary' | 'final';
  /** Radiologist's findings text. */
  findingsText: string;
  /** Display name of the practitioner (e.g. "Dr. Gogichaishvili"). */
  practitionerDisplay?: string;
  /** Locale for the notification body (defaults to 'en'). */
  locale?: string;
}

// ============================================================================
// Minimal FHIR shapes used here
// ============================================================================

interface ImagingStudyLike extends FhirResourceLike {
  resourceType: 'ImagingStudy';
  status?: string;
  extension?: Array<{ url: string; valueString?: string }>;
  meta?: { versionId?: string };
}

interface DiagnosticReportLike extends FhirResourceLike {
  resourceType: 'DiagnosticReport';
  status?: 'preliminary' | 'final' | 'registered' | 'amended' | 'appended' | 'cancelled' | 'corrected' | 'entered-in-error' | 'partial' | 'preliminary' | 'unknown';
  category?: Array<{ coding?: Array<{ system?: string; code?: string }> }>;
  code?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  subject?: { reference?: string };
  imagingStudy?: Array<{ reference?: string }>;
  performer?: Array<{ reference?: string }>;
  conclusion?: string;
  effectiveDateTime?: string;
}

// ============================================================================
// Stub FHIR URIs (match MediMind PACS_DIAGNOSTIC_REPORT constants)
// ============================================================================

const PACS_DIAGNOSTIC_REPORT_CATEGORY_SYSTEM =
  'http://terminology.hl7.org/CodeSystem/v2-0074';
const PACS_DIAGNOSTIC_REPORT_CATEGORY_CODE = 'RAD';
const PACS_DIAGNOSTIC_REPORT_CODE_SYSTEM = 'http://loinc.org';
const PACS_DIAGNOSTIC_REPORT_CODE = '68604-8';
const PACS_DIAGNOSTIC_REPORT_CODE_DISPLAY = 'Diagnostic imaging study';

const IMAGING_STATUS_EXT =
  'http://liverra.ai/fhir/StructureDefinition/imaging-study-status';
const IMAGING_TIMELINE_EXT =
  'http://liverra.ai/fhir/StructureDefinition/imaging-study-timeline';

// ============================================================================
// Core entry point
// ============================================================================

/**
 * Mark a study as read. Returns the created DiagnosticReport id (empty string
 * if the FHIR persistence layer is stubbed).
 */
export async function markStudyAsRead(
  fhir: LiverRaFhirClient,
  params: MarkAsReadParams
): Promise<string> {
  const {
    studyId,
    patientId,
    reportStatus,
    findingsText,
    practitionerDisplay,
    locale,
  } = params;

  const { reportId } = await createReportAndUpdateStudy(fhir, {
    studyId,
    patientId,
    reportStatus,
    findingsText,
    practitionerDisplay,
  });

  try {
    await sendFindingsNotification(fhir, studyId, patientId, locale);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[markStudyAsRead] Failed to send notification:', err);
  }

  return reportId;
}

// ============================================================================
// Atomic report + study-status update (stubbed — logs the intended operation)
// ============================================================================

async function createReportAndUpdateStudy(
  fhir: LiverRaFhirClient,
  params: MarkAsReadParams
): Promise<{ reportId: string }> {
  const {
    studyId,
    patientId,
    reportStatus,
    findingsText,
    practitionerDisplay,
  } = params;

  // Read the current study. With the Phase-1 stub this returns `null`; the
  // `?? fallback` keeps the code path compiling so Phase 4 only has to flip
  // the shim implementation.
  const studyResource = (await fhir.readResource('ImagingStudy', studyId)) as
    | ImagingStudyLike
    | null;
  const study: ImagingStudyLike = studyResource ?? {
    resourceType: 'ImagingStudy',
    id: studyId,
    extension: [],
  };

  // Build the new report resource.
  const report: DiagnosticReportLike = {
    resourceType: 'DiagnosticReport',
    status: reportStatus,
    category: [
      {
        coding: [
          {
            system: PACS_DIAGNOSTIC_REPORT_CATEGORY_SYSTEM,
            code: PACS_DIAGNOSTIC_REPORT_CATEGORY_CODE,
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: PACS_DIAGNOSTIC_REPORT_CODE_SYSTEM,
          code: PACS_DIAGNOSTIC_REPORT_CODE,
          display: PACS_DIAGNOSTIC_REPORT_CODE_DISPLAY,
        },
      ],
    },
    subject: { reference: `Patient/${patientId}` },
    imagingStudy: [{ reference: `ImagingStudy/${studyId}` }],
    conclusion: findingsText,
    effectiveDateTime: new Date().toISOString(),
  };

  // Build updated study extensions — preserve every extension except the
  // two we're rewriting (STUDY_STATUS + STUDY_TIMELINE). Constructing clean
  // extension objects avoids the stale-valueString bug MediMind fixed.
  const newStatus: 'reported' | 'preliminary-read' =
    reportStatus === 'final' ? 'reported' : 'preliminary-read';

  const existingTimeline = parseTimeline(
    study.extension?.find((e) => e.url === IMAGING_TIMELINE_EXT)?.valueString ??
      ''
  );
  const newEntry: StatusTimelineEntry = {
    status: newStatus,
    timestamp: new Date().toISOString(),
    actor: practitionerDisplay || 'Radiologist',
  };
  existingTimeline.push(newEntry);

  const extensions = (study.extension ?? []).filter(
    (ext) => ext.url !== IMAGING_STATUS_EXT && ext.url !== IMAGING_TIMELINE_EXT
  );
  extensions.push({ url: IMAGING_STATUS_EXT, valueString: newStatus });
  extensions.push({
    url: IMAGING_TIMELINE_EXT,
    valueString: JSON.stringify(existingTimeline),
  });

  const updatedStudy: ImagingStudyLike = {
    ...study,
    extension: extensions,
  };

  // TODO(phase-4): execute as a FHIR transaction Bundle so both updates are
  // atomic. For now we issue two sequential writes through the shim — the
  // shim's stub returns the echoed resource, so `reportId` will be empty.
  const created = (await fhir.createResource(report)) as DiagnosticReportLike;
  // C-LOCK-3: thread the observed versionId as If-Match.
  await fhir.updateResource(updatedStudy, { ifMatch: study.meta?.versionId });

  return { reportId: created.id ?? '' };
}
