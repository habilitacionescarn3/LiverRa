// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// LiverRa ImagingStudy Service — STUB for Phase 3
// ============================================================================
// Full MediMind `imagingStudyService.ts` is 1,034 LOC and is deeply coupled to
// Medplum FHIR + LiverRa's `fhir-systems` / `fhir-extensions` constants.
// Porting the persistence layer requires the Supabase-backed FHIR store
// decisions that land in Phase 4, so this file intentionally only exposes
// stubbed function signatures today. Callers (study list / worklist /
// unmatched queue ported alongside this file) import from here the same way
// MediMind did — no signature drift. Every call logs to the console so the
// Phase 4 persistence spec can see the real query traffic the UI produces.
//
// TODO(phase-4): wire real Supabase persistence for every function below.
// ============================================================================

import type { FhirResourceLike, LiverRaFhirClient } from '../fhirClient';
import type {
  ImagingStudyListItem,
  ImagingStudyStatus,
  ImagingPriority,
  StatusTimelineEntry,
} from '../../types/pacs';

// ============================================================================
// Minimal local FHIR shapes
// ============================================================================
// MediMind imports from `@medplum/fhirtypes`. We inline the slices we touch so
// the stub compiles without pulling the Medplum dependency. Tighten in Phase
// 4 when the real backend types land.

/** Minimal ImagingStudy shape for UI adapters. */
export interface ImagingStudyLike extends FhirResourceLike {
  resourceType: 'ImagingStudy';
  status?: string;
  started?: string;
  description?: string;
  numberOfSeries?: number;
  numberOfInstances?: number;
  identifier?: Array<{ system?: string; value?: string }>;
  extension?: Array<{ url: string; valueString?: string; [key: string]: unknown }>;
  subject?: { reference?: string; display?: string };
  basedOn?: Array<{ reference?: string }>;
  series?: Array<{
    modality?: { code?: string; system?: string };
    bodySite?: { code?: string; display?: string };
    numberOfInstances?: number;
    instance?: unknown[];
  }>;
}

/** Minimal DiagnosticReport shape. */
export interface DiagnosticReportLike extends FhirResourceLike {
  resourceType: 'DiagnosticReport';
  status?: string;
  conclusion?: string;
  imagingStudy?: Array<{ reference?: string }>;
  subject?: { reference?: string };
}

/** Minimal ServiceRequest shape. */
export interface ServiceRequestLike extends FhirResourceLike {
  resourceType: 'ServiceRequest';
  status?: string;
  priority?: string;
  authoredOn?: string;
  subject?: { reference?: string; display?: string };
  code?: { text?: string; coding?: Array<{ display?: string; code?: string }> };
  orderDetail?: Array<{ coding?: Array<{ code?: string }> }>;
  requester?: { reference?: string; display?: string };
}

/** Paginated result for unmatched studies. */
export interface PaginatedUnmatchedResult {
  items: ImagingStudyLike[];
  hasMore: boolean;
}

/** Summary of a cascade reassignment. */
export interface ReassignmentResult {
  study: ImagingStudyLike;
  updatedReports: number;
  updatedAnnotations: number;
  updatedKeyImages: number;
  updatedProvenance: number;
  failures: Array<{ resourceType: string; id: string; error: string }>;
}

/** Summary of study-related resource cleanup. */
export interface StudyCleanupResult {
  annotations: number;
  keyImages: number;
  provenance: number;
}

/** Prior study search result. */
export interface PriorStudyResult {
  study: ImagingStudyListItem | undefined;
  timedOut: boolean;
}

/** PACS Bridge worklist stats. */
export interface PacsBridgeWorklistStats {
  activeEntries: number;
  pendingOrders: number;
  lastSyncAt: string | null;
  totalPublished: number;
}

// ============================================================================
// Helpers kept local to this stub so callers behave plausibly today
// ============================================================================

/** Safe read of the first matching extension value. */
function readExtensionValue(
  resource: ImagingStudyLike | undefined,
  url: string
): string | undefined {
  const ext = resource?.extension?.find((e) => e.url === url);
  return (ext?.valueString as string | undefined) ?? undefined;
}

// ============================================================================
// Stub constants (matches MediMind's fhir-systems export shape)
// ============================================================================
// Kept private so the rest of the stub can reference the same URL tokens
// that the real implementation will publish. Phase 4 replaces these with
// imports from `constants/fhir-systems.ts` / `fhir-extensions.ts`.

const IMAGING_STATUS_EXT = 'http://liverra.ai/fhir/StructureDefinition/imaging-study-status';
const IMAGING_TIMELINE_EXT = 'http://liverra.ai/fhir/StructureDefinition/imaging-study-timeline';
const IMAGING_PRIORITY_EXT = 'http://liverra.ai/fhir/StructureDefinition/imaging-priority';
const IMAGING_ORTHANC_ID_EXT = 'http://liverra.ai/fhir/StructureDefinition/orthanc-study-id';

// ============================================================================
// Transforms (pure — safe to run against stubbed data)
// ============================================================================

/**
 * Convert a FHIR-ish `ImagingStudy` into a UI list item.
 * Pure and stateless — callers use this to format studies that the
 * (Phase 4) backend returns. Safe to keep live today.
 */
export function toListItem(
  study: ImagingStudyLike,
  report?: DiagnosticReportLike
): ImagingStudyListItem {
  const patientRef = study.subject?.reference ?? '';
  const patientId = patientRef.replace('Patient/', '');
  const patientName = study.subject?.display ?? '';

  const modalities: string[] = [];
  for (const series of study.series ?? []) {
    const mod = series.modality?.code;
    if (mod && !modalities.includes(mod)) {
      modalities.push(mod);
    }
  }

  let instanceCount = 0;
  for (const series of study.series ?? []) {
    instanceCount += series.numberOfInstances ?? series.instance?.length ?? 0;
  }

  const bodyPart =
    study.series?.[0]?.bodySite?.display ?? study.series?.[0]?.bodySite?.code;

  const hasFindings = !!report?.conclusion;
  const findingsText = report?.conclusion;
  const reportStatus =
    report?.status === 'preliminary'
      ? 'preliminary'
      : report?.status === 'final'
        ? 'final'
        : undefined;

  const orthancId = readExtensionValue(study, IMAGING_ORTHANC_ID_EXT) ?? '';
  const source: ImagingStudyListItem['source'] = orthancId ? 'pacs' : 'local-upload';

  const studyUid =
    study.identifier?.find((id) => id.system === 'urn:dicom:uid')?.value ?? '';
  const accessionNumber = study.identifier?.find(
    (id) => id.system === 'http://liverra.ai/fhir/sid/accession-number'
  )?.value;

  let timeline: StatusTimelineEntry[] | undefined;
  const timelineValue = readExtensionValue(study, IMAGING_TIMELINE_EXT);
  if (timelineValue) {
    try {
      timeline = JSON.parse(timelineValue) as StatusTimelineEntry[];
    } catch {
      timeline = undefined;
    }
  }

  const status =
    (readExtensionValue(study, IMAGING_STATUS_EXT) as ImagingStudyStatus | undefined) ??
    'ordered';
  const priority =
    (readExtensionValue(study, IMAGING_PRIORITY_EXT) as ImagingPriority | undefined) ??
    'routine';

  return {
    id: study.id ?? '',
    orthancStudyId: orthancId,
    studyInstanceUid: studyUid.replace(/^urn:oid:/, ''),
    accessionNumber,
    patientId,
    patientName,
    date: study.started ?? '',
    modalities,
    bodyPart,
    description: study.description,
    seriesCount: study.numberOfSeries ?? study.series?.length ?? 0,
    instanceCount: study.numberOfInstances ?? instanceCount,
    status,
    priority,
    orderRef: study.basedOn?.[0]?.reference,
    hasFindings,
    findingsText,
    reportStatus,
    timeline,
    source,
  };
}

/** Convert a pending ServiceRequest into a list item. Pure. */
export function serviceRequestToListItem(order: ServiceRequestLike): ImagingStudyListItem {
  const patientRef = order.subject?.reference ?? '';
  const patientId = patientRef.replace('Patient/', '');
  const patientName = order.subject?.display ?? '';

  const modalities: string[] = [];
  for (const detail of order.orderDetail ?? []) {
    const mod = detail.coding?.[0]?.code;
    if (mod && !modalities.includes(mod)) {
      modalities.push(mod);
    }
  }

  let priority: ImagingPriority = 'routine';
  if (order.priority === 'stat') {
    priority = 'stat';
  } else if (order.priority === 'urgent' || order.priority === 'asap') {
    priority = 'urgent';
  }

  return {
    id: `order-${order.id ?? ''}`,
    orthancStudyId: '',
    studyInstanceUid: '',
    patientId,
    patientName,
    date: order.authoredOn ?? '',
    modalities,
    description: order.code?.text ?? order.code?.coding?.[0]?.display,
    status: 'ordered',
    priority,
    seriesCount: 0,
    instanceCount: 0,
    hasFindings: false,
    orderRef: `ServiceRequest/${order.id ?? ''}`,
    source: 'order',
  };
}

/**
 * Merge studies + pending orders into a single newest-first list,
 * deduplicating orders that already have a matching study. Pure.
 */
export function mergeStudiesAndOrders(
  studies: ImagingStudyListItem[],
  orders: ServiceRequestLike[]
): ImagingStudyListItem[] {
  const existingOrderRefs = new Set<string>();
  for (const study of studies) {
    if (study.orderRef) {
      existingOrderRefs.add(study.orderRef);
    }
  }

  const orderItems: ImagingStudyListItem[] = [];
  for (const order of orders) {
    const ref = `ServiceRequest/${order.id ?? ''}`;
    if (!existingOrderRefs.has(ref)) {
      orderItems.push(serviceRequestToListItem(order));
    }
  }

  const merged = [...studies, ...orderItems];
  merged.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    return dateB - dateA;
  });
  return merged;
}

// ============================================================================
// Persistence stubs — every one logs + no-ops
// ============================================================================
// TODO(phase-4): wire Supabase persistence for every function below.

/** STUB: fetch a study by its FHIR id. */
export async function getById(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<ImagingStudyLike | null> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] getById not wired: ImagingStudy/${studyId}`);
  return null;
}

/** STUB: fetch a study by its StudyInstanceUID. */
export async function getByUid(
  _fhir: LiverRaFhirClient,
  studyInstanceUid: string
): Promise<ImagingStudyLike | undefined> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] getByUid not wired: uid=${studyInstanceUid}`);
  return undefined;
}

/** STUB: fetch a study by accession number. */
export async function getByAccessionNumber(
  _fhir: LiverRaFhirClient,
  accessionNumber: string
): Promise<ImagingStudyLike | undefined> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] getByAccessionNumber not wired: ${accessionNumber}`);
  return undefined;
}

/** STUB: list studies for a patient. */
export async function listByPatient(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ImagingStudyLike[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] listByPatient not wired: Patient/${patientId}`);
  return [];
}

/** STUB: fetch DiagnosticReports keyed by study id. */
export async function fetchReportsForStudies(
  _fhir: LiverRaFhirClient,
  studyIds: string[],
  patientId: string
): Promise<Map<string, DiagnosticReportLike>> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] fetchReportsForStudies not wired: patient=${patientId} studies=${studyIds.length}`
  );
  return new Map();
}

/** STUB: fetch pending imaging orders. */
export async function fetchPendingOrders(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ServiceRequestLike[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] fetchPendingOrders not wired: Patient/${patientId}`);
  return [];
}

/** STUB: list the most recent N studies. */
export async function listRecentStudies(
  _fhir: LiverRaFhirClient,
  count = 50
): Promise<ImagingStudyListItem[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] listRecentStudies not wired: count=${count}`);
  return [];
}

/** STUB: enriched study list for a patient. */
export async function listItemsByPatient(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ImagingStudyListItem[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] listItemsByPatient not wired: Patient/${patientId}`);
  return [];
}

/** STUB: get/create the FHIR Endpoint for a WADO-RS URL. */
export async function getOrCreateEndpoint(
  _fhir: LiverRaFhirClient,
  wadoRsUrl: string,
  name: string
): Promise<FhirResourceLike | null> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] getOrCreateEndpoint not wired: ${name} @ ${wadoRsUrl}`);
  return null;
}

/** STUB: paginated unmatched studies. */
export async function listUnmatchedStudies(
  _fhir: LiverRaFhirClient,
  offset = 0,
  pageSize = 200
): Promise<PaginatedUnmatchedResult> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] listUnmatchedStudies not wired: offset=${offset} pageSize=${pageSize}`
  );
  return { items: [], hasMore: false };
}

/** STUB: link an unmatched study to a patient. */
export async function linkStudyToPatient(
  _fhir: LiverRaFhirClient,
  studyId: string,
  patientId: string,
  patientDisplay: string
): Promise<ImagingStudyLike | null> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] linkStudyToPatient not wired: ImagingStudy/${studyId} → Patient/${patientId} (${patientDisplay})`
  );
  return null;
}

/** STUB: cascade reassignment of a study to a different patient. */
export async function reassignStudy(
  _fhir: LiverRaFhirClient,
  studyId: string,
  newPatientId: string,
  newPatientDisplay: string
): Promise<ReassignmentResult> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] reassignStudy not wired: ImagingStudy/${studyId} → Patient/${newPatientId} (${newPatientDisplay})`
  );
  return {
    study: { resourceType: 'ImagingStudy', id: studyId } as ImagingStudyLike,
    updatedReports: 0,
    updatedAnnotations: 0,
    updatedKeyImages: 0,
    updatedProvenance: 0,
    failures: [],
  };
}

/** STUB: find DiagnosticReports referencing a study. */
export async function findReportsForStudy(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<DiagnosticReportLike[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] findReportsForStudy not wired: ImagingStudy/${studyId}`);
  return [];
}

/** STUB: delete a study. */
export async function deleteStudy(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] deleteStudy not wired: ImagingStudy/${studyId}`);
}

/** STUB: delete related annotations / key images / provenance. */
export async function deleteStudyRelatedResources(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<StudyCleanupResult> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] deleteStudyRelatedResources not wired: ImagingStudy/${studyId}`
  );
  return { annotations: 0, keyImages: 0, provenance: 0 };
}

/** @deprecated use `deleteStudyRelatedResources`. STUB. */
export async function deleteStudyAnnotations(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<number> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] deleteStudyAnnotations not wired: ImagingStudy/${studyId}`);
  return 0;
}

/** STUB: search studies by accession / patient name. */
export async function searchStudies(
  _fhir: LiverRaFhirClient,
  query: string
): Promise<ImagingStudyLike[]> {
  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] searchStudies not wired: query=${JSON.stringify(query)}`);
  return [];
}

/** STUB: locate a prior study of the same modality / body part. */
export async function findPriorStudy(
  _fhir: LiverRaFhirClient,
  currentStudy: ImagingStudyListItem,
  _maxAgeDays?: number
): Promise<PriorStudyResult> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] findPriorStudy not wired: current=${currentStudy.id} patient=${currentStudy.patientId}`
  );
  return { study: undefined, timedOut: false };
}

/**
 * STUB: create a FHIR ImagingStudy row from an Orthanc study id.
 * Used by the study importer after a successful STOW-RS upload.
 */
export async function createImagingStudyFromOrthanc(
  orthancStudyId: string
): Promise<ImagingStudyLike | null> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] createImagingStudyFromOrthanc not wired: orthancStudyId=${orthancStudyId}`
  );
  return null;
}

/**
 * STUB: sync Orthanc studies into FHIR.
 * Bridge-equivalent bulk reconciliation entry point.
 */
export async function syncOrthancToFhir(): Promise<{
  created: number;
  updated: number;
  errors: number;
}> {
  // eslint-disable-next-line no-console
  console.warn('[imaging-stub] syncOrthancToFhir not wired');
  return { created: 0, updated: 0, errors: 0 };
}

/** STUB: PACS bridge monitoring stats. */
export async function fetchPacsBridgeStats(
  _accessToken?: string
): Promise<{ worklist: PacsBridgeWorklistStats } | null> {
  // eslint-disable-next-line no-console
  console.warn('[imaging-stub] fetchPacsBridgeStats not wired');
  return null;
}

/**
 * Alias kept for spec compatibility — older callers prefer this name.
 * Returns `null` today because persistence is not wired yet.
 */
export async function getImagingStudy(
  fhir: LiverRaFhirClient,
  id: string
): Promise<ImagingStudyLike | null> {
  return getById(fhir, id);
}

/** Alias — kept for spec compatibility. */
export async function searchImagingStudies(
  _fhir: LiverRaFhirClient,
  params: Record<string, unknown>
): Promise<ImagingStudyLike[]> {
  // eslint-disable-next-line no-console
  console.warn(
    `[imaging-stub] searchImagingStudies not wired: params=${JSON.stringify(params)}`
  );
  return [];
}
