// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// DICOM SR Service — Export/Import Annotations with Audit Logging
// ============================================================================
// Provides structured export and import of imaging annotations as DICOM
// Structured Report (SR) representations stored in FHIR Basic resources.
// Every operation (export, import) is audit-logged as a fire-and-forget
// AuditEvent so there is a complete trail of who saved or loaded annotations.
//
// Think of it like a save/load system for annotations:
//   - Export: serializes annotations into a Basic resource tagged as "dicom-sr"
//   - Import: searches for all Basic resources matching a study, returns their data
//   - Audit: every step writes an AuditEvent so admins can see the history
//
// Ported from MediMind. The SR BUILDER code (UID generation, extension
// assembly, payload shaping) is verbatim. The persistence boundary is stubbed
// through `LiverRaFhirClient`; real Supabase writes land in Phase 4.
// ============================================================================

import { LiverRaFhirClient } from '../fhirClient';

// TODO(phase-4): replace with real FHIR types from @medplum/fhirtypes or
// packages/fhirtypes. Until then, we inline the minimal shapes we need.
/** Minimal FHIR `Extension` shape used by this service. */
interface FhirExtension {
  url: string;
  valueString?: string;
  valueInteger?: number;
}

/** Minimal FHIR `Basic` shape used by this service. */
interface FhirBasic {
  resourceType: 'Basic';
  id?: string;
  code?: {
    coding?: Array<{ system: string; code: string; display?: string }>;
  };
  subject?: { reference?: string };
  author?: { reference?: string; display?: string };
  extension?: FhirExtension[];
  meta?: { versionId?: string; lastUpdated?: string };
}

/**
 * Minimal FHIR `AuditEvent` shape used by this service. The outcome, action,
 * and type enums below are pulled straight from FHIR R4 — copied here so we
 * don't need @medplum/fhirtypes.
 */
interface FhirAuditEvent {
  resourceType: 'AuditEvent';
  type: { system: string; code: string; display?: string };
  subtype?: Array<{ system: string; code: string; display?: string }>;
  action?: 'C' | 'R' | 'U' | 'D' | 'E';
  recorded: string;
  outcome?: '0' | '4' | '8' | '12';
  outcomeDesc?: string;
  agent: Array<{
    who?: { reference?: string; display?: string };
    requestor: boolean;
  }>;
  source: { observer: { reference?: string; display?: string } };
  entity?: Array<{
    what?: { display?: string; reference?: string };
    type?: { system: string; code: string; display?: string };
  }>;
}

// TODO(phase-4): port MediMind's constants/fhir-systems.ts to LiverRa so we
// can drop these inlined values. Keeping MediMind's canonical URLs preserves
// backward compatibility for any Supabase rows that carry them.
const STANDARD_AUDIT_EVENT_TYPE = 'http://terminology.hl7.org/CodeSystem/audit-event-type';
const STANDARD_AUDIT_ENTITY_TYPE = 'http://terminology.hl7.org/CodeSystem/audit-entity-type';
const CUSTOM_AUDIT_SUBTYPE = 'http://medimind.ge/fhir/CodeSystem/audit-subtype';
const EXT_STUDY_INSTANCE_UID =
  'http://medimind.ge/fhir/StructureDefinition/study-instance-uid';
const EXT_SOP_INSTANCE_UID =
  'http://medimind.ge/fhir/StructureDefinition/sop-instance-uid';
const EXT_SR_ANNOTATION_DATA =
  'http://medimind.ge/fhir/StructureDefinition/sr-annotation-data';

// ============================================================================
// Types
// ============================================================================

/** All possible audit actions for SR export/import operations */
export type SRAuditAction =
  | 'SR_EXPORT_STARTED'
  | 'SR_EXPORT_SUCCEEDED'
  | 'SR_EXPORT_FAILED'
  | 'SR_IMPORT_STARTED'
  | 'SR_IMPORT_SUCCEEDED'
  | 'SR_IMPORT_FAILED';

/** A single audit log entry describing one SR operation step */
export interface SRAuditEntry {
  /** Which operation step this entry represents */
  action: SRAuditAction;
  /** The DICOM Study Instance UID that annotations belong to */
  studyInstanceUID: string;
  /** FHIR Practitioner ID of the user performing the action */
  practitionerId: string;
  /** ISO 8601 timestamp of when this happened */
  timestamp: string;
  /** Number of annotations involved (optional) */
  annotationCount?: number;
  /** SOP Instance UID of the created SR (export only, optional) */
  sopInstanceUID?: string;
  /** SOP Instance UIDs of imported SRs (import only, optional) */
  srInstanceUIDs?: string[];
  /** Display names of SR authors (import only, optional) */
  authorNames?: string[];
  /** How long the operation took in milliseconds (optional) */
  durationMs?: number;
  /** Error message if the operation failed (optional) */
  error?: string;
}

/** Result of exporting annotations to a DICOM SR Basic resource */
export interface SRExportResult {
  /** Whether the export succeeded */
  success: boolean;
  /** SOP Instance UID of the created SR (only present on success) */
  sopInstanceUID?: string;
  /** Number of annotations that were exported */
  annotationCount: number;
  /** How long the export took in milliseconds */
  durationMs: number;
}

/** A single annotation imported from a DICOM SR Basic resource */
export interface SRImportedAnnotation {
  /** SOP Instance UID that identifies this SR */
  srInstanceUID: string;
  /** Display name of the author who created this SR */
  authorName: string;
  /** Serialized annotation data (JSON string) */
  data: string;
}

/** Result of importing annotations from DICOM SR Basic resources */
export interface SRImportResult {
  /** Whether the import succeeded */
  success: boolean;
  /** The imported annotation records */
  annotations: SRImportedAnnotation[];
  /** Total number of annotations found */
  annotationCount: number;
  /** How long the import took in milliseconds */
  durationMs: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Audit subtype codes for SR export/import operations */
const SR_AUDIT_SUBTYPES = {
  SR_EXPORT: 'dicom-sr-export',
  SR_IMPORT: 'dicom-sr-import',
} as const;

/** Root prefix for generating SOP Instance UIDs */
const SOP_UID_ROOT = '1.2.826.0.1.3680043.8.498';

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Generate a SOP Instance UID.
 *
 * SOP Instance UIDs uniquely identify each DICOM object. We combine a
 * well-known root OID with a timestamp and random number to guarantee
 * uniqueness without needing a central registry.
 */
function generateSopInstanceUID(): string {
  return `${SOP_UID_ROOT}.${Date.now()}.${Math.floor(Math.random() * 1000000)}`;
}

// ============================================================================
// Audit Logging
// ============================================================================

/**
 * Write a fire-and-forget AuditEvent for a SR export/import operation.
 *
 * Maps the human-readable SRAuditAction to the correct FHIR AuditEvent
 * fields (action code, outcome, subtype). If the write fails, it logs
 * a warning to the console but never throws — auditing should never
 * block the user's workflow.
 *
 * TODO(phase-4): real Supabase-backed audit_events table. The stub currently
 * goes through `client.createResource` which logs `[fhir-stub] createResource`.
 */
export function auditLog(client: LiverRaFhirClient, entry: SRAuditEntry): void {
  // Determine whether this is an export or import operation
  const isExport = entry.action.startsWith('SR_EXPORT');
  const subtypeCode = isExport ? SR_AUDIT_SUBTYPES.SR_EXPORT : SR_AUDIT_SUBTYPES.SR_IMPORT;
  const subtypeDisplay = isExport ? 'DICOM SR Export' : 'DICOM SR Import';

  // Map action to FHIR action code:
  //   - Successful export = Create ('C')
  //   - Successful import = Read ('R')
  //   - Everything else (started, failed) = Execute ('E')
  let fhirAction: FhirAuditEvent['action'];
  if (entry.action === 'SR_EXPORT_SUCCEEDED') {
    fhirAction = 'C';
  } else if (entry.action === 'SR_IMPORT_SUCCEEDED') {
    fhirAction = 'R';
  } else {
    fhirAction = 'E';
  }

  // Failed operations get outcome '8' (serious failure), others get '0' (success)
  const outcome: FhirAuditEvent['outcome'] = entry.action.endsWith('_FAILED') ? '8' : '0';

  // Build a human-readable description by joining all non-empty parts
  const descParts: string[] = [entry.action];
  if (entry.annotationCount !== undefined) {
    descParts.push(`annotations=${entry.annotationCount}`);
  }
  if (entry.sopInstanceUID) {
    descParts.push(`sopUID=${entry.sopInstanceUID}`);
  }
  if (entry.srInstanceUIDs && entry.srInstanceUIDs.length > 0) {
    descParts.push(`srUIDs=[${entry.srInstanceUIDs.join(',')}]`);
  }
  if (entry.authorNames && entry.authorNames.length > 0) {
    descParts.push(`authors=[${entry.authorNames.join(',')}]`);
  }
  if (entry.durationMs !== undefined) {
    descParts.push(`duration=${entry.durationMs}ms`);
  }
  if (entry.error) {
    descParts.push(`error=${entry.error}`);
  }
  const description = descParts.join(' | ');

  const auditEvent: FhirAuditEvent = {
    resourceType: 'AuditEvent',
    type: {
      system: STANDARD_AUDIT_EVENT_TYPE,
      code: 'rest',
      display: 'RESTful Operation',
    },
    subtype: [
      {
        system: CUSTOM_AUDIT_SUBTYPE,
        code: subtypeCode,
        display: subtypeDisplay,
      },
    ],
    action: fhirAction,
    recorded: entry.timestamp,
    outcome,
    outcomeDesc: description,
    agent: [
      {
        who: {
          reference: `Practitioner/${entry.practitionerId}`,
        },
        requestor: true,
      },
    ],
    source: {
      observer: {
        display: 'LiverRa PACS Viewer',
      },
    },
    entity: [
      {
        what: {
          display: `StudyInstanceUID: ${entry.studyInstanceUID}`,
        },
        type: {
          system: STANDARD_AUDIT_ENTITY_TYPE,
          code: '2',
          display: 'System Object',
        },
      },
    ],
  };

  // Fire-and-forget — never await, never throw
  client.createResource<FhirAuditEvent>(auditEvent).catch((err) => {
    console.warn('[dicomSRService] Audit log failed:', err);
  });
}

// ============================================================================
// Export — Save annotations as a DICOM SR Basic resource
// ============================================================================

/**
 * Export annotation data as a DICOM Structured Report stored in a FHIR Basic
 * resource. The annotation JSON is saved as an extension on the Basic resource,
 * alongside study/SOP instance UIDs and an author reference.
 */
export async function exportAnnotationsToSR(
  client: LiverRaFhirClient,
  studyInstanceUID: string,
  annotationData: string,
  practitionerId: string,
  patientId: string,
): Promise<SRExportResult> {
  const startTime = Date.now();

  // Count annotations by parsing the JSON — if it's an array, use length;
  // if it's a single object, count as 1; if parse fails, count as 0
  let annotationCount = 0;
  try {
    const parsed = JSON.parse(annotationData);
    annotationCount = Array.isArray(parsed) ? parsed.length : 1;
  } catch (e) {
    // L-CATCH-1: parse-failure means we cannot audit "N annotations"
    // accurately — log to console.debug so a corrupt SR payload is
    // visible during development without failing the export.
    // eslint-disable-next-line no-console
    console.debug('[dicomSRService] annotation JSON parse failed', { e });
    annotationCount = 0;
  }

  auditLog(client, {
    action: 'SR_EXPORT_STARTED',
    studyInstanceUID,
    practitionerId,
    timestamp: new Date().toISOString(),
    annotationCount,
  });

  try {
    const sopInstanceUID = generateSopInstanceUID();

    // Store the SR as a Basic resource with extensions for all metadata
    // TODO(phase-4): LiverRa FHIR backend must support the same Basic shape
    // and extension URLs — or a `DocumentReference` equivalent. Until the
    // backend lands, the shim logs `[fhir-stub] createResource` and returns
    // the passed payload unchanged.
    await client.createResource<FhirBasic>({
      resourceType: 'Basic',
      code: {
        coding: [
          {
            system: CUSTOM_AUDIT_SUBTYPE,
            code: 'dicom-sr',
            display: 'DICOM Structured Report',
          },
        ],
      },
      subject: {
        reference: `Patient/${patientId}`,
      },
      author: {
        reference: `Practitioner/${practitionerId}`,
      },
      extension: [
        {
          url: EXT_STUDY_INSTANCE_UID,
          valueString: studyInstanceUID,
        },
        {
          url: EXT_SOP_INSTANCE_UID,
          valueString: sopInstanceUID,
        },
        {
          url: EXT_SR_ANNOTATION_DATA,
          valueString: annotationData,
        },
      ],
    });

    const durationMs = Date.now() - startTime;

    auditLog(client, {
      action: 'SR_EXPORT_SUCCEEDED',
      studyInstanceUID,
      practitionerId,
      timestamp: new Date().toISOString(),
      sopInstanceUID,
      annotationCount,
      durationMs,
    });

    return { success: true, sopInstanceUID, annotationCount, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    auditLog(client, {
      action: 'SR_EXPORT_FAILED',
      studyInstanceUID,
      practitionerId,
      timestamp: new Date().toISOString(),
      annotationCount,
      durationMs,
      error: errorMessage,
    });

    return { success: false, annotationCount, durationMs };
  }
}

// ============================================================================
// Import — Load annotations from DICOM SR Basic resources
// ============================================================================

/**
 * Import all annotations for a given study by searching for Basic resources
 * tagged as "dicom-sr" and filtering to those matching the study UID.
 */
export async function importAnnotationsFromSR(
  client: LiverRaFhirClient,
  studyInstanceUID: string,
  practitionerId: string,
  patientId: string,
): Promise<SRImportResult> {
  const startTime = Date.now();

  auditLog(client, {
    action: 'SR_IMPORT_STARTED',
    studyInstanceUID,
    practitionerId,
    timestamp: new Date().toISOString(),
  });

  try {
    // Search for all Basic resources tagged as DICOM SRs (paginated to avoid 100-cap)
    const PAGE_SIZE = 100;
    const MAX_PAGES = 10; // Safety cap: 1000 SRs max
    let allResults: FhirBasic[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const batchResult = await client.search('Basic', {
        code: `${CUSTOM_AUDIT_SUBTYPE}|dicom-sr`,
        subject: `Patient/${patientId}`,
        _count: String(PAGE_SIZE),
        _offset: String(offset),
      });
      const batch: FhirBasic[] = (batchResult.entry ?? [])
        .map((e) => e.resource as FhirBasic | undefined)
        .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');
      allResults = allResults.concat(batch);
      if (batch.length < PAGE_SIZE) {
        break; // No more pages
      }
      offset += PAGE_SIZE;
    }

    // Filter to only those matching our study UID (stored in an extension)
    const matchingResources = allResults.filter((resource) => {
      const studyExt = resource.extension?.find((ext) => ext.url === EXT_STUDY_INSTANCE_UID);
      return studyExt?.valueString === studyInstanceUID;
    });

    // Extract annotations, SOP UIDs, and author names from matching resources
    const annotations: SRImportedAnnotation[] = [];
    const srInstanceUIDs: string[] = [];
    const authorNameSet = new Set<string>();

    for (const resource of matchingResources) {
      const sopExt = resource.extension?.find((ext) => ext.url === EXT_SOP_INSTANCE_UID);
      const dataExt = resource.extension?.find((ext) => ext.url === EXT_SR_ANNOTATION_DATA);

      const srInstanceUID = sopExt?.valueString ?? '';
      const authorName = resource.author?.display ?? '';
      const data = dataExt?.valueString ?? '';

      if (srInstanceUID) {
        srInstanceUIDs.push(srInstanceUID);
      }
      if (authorName) {
        authorNameSet.add(authorName);
      }

      annotations.push({ srInstanceUID, authorName, data });
    }

    const durationMs = Date.now() - startTime;
    const authorNames = Array.from(authorNameSet);

    auditLog(client, {
      action: 'SR_IMPORT_SUCCEEDED',
      studyInstanceUID,
      practitionerId,
      timestamp: new Date().toISOString(),
      srInstanceUIDs,
      annotationCount: annotations.length,
      authorNames,
      durationMs,
    });

    return {
      success: true,
      annotations,
      annotationCount: annotations.length,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    auditLog(client, {
      action: 'SR_IMPORT_FAILED',
      studyInstanceUID,
      practitionerId,
      timestamp: new Date().toISOString(),
      durationMs,
      error: errorMessage,
    });

    return { success: false, annotations: [], annotationCount: 0, durationMs };
  }
}
