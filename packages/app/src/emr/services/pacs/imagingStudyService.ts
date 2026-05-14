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
import { captureException } from '../observability/sentryInit';

// ============================================================================
// Stub logging (H-PACS-2 / M-PACS-6) — centralized
// ============================================================================
// Each ported MediMind call site below expects a real persistence layer. We
// don't have one yet, so every function below returns a benign empty/null.
// To stop "always-empty" UIs from masquerading as "working", every stub call
// emits both a console warning (dev) AND a Sentry breadcrumb so we can see
// which queries the running UI actually issues. When persistence lands,
// each function is wired to the orchestrator endpoint and the helper drops
// out.

const STUB_LOGGED = new Set<string>();

function phaseStubLog(fnName: string, args: Record<string, unknown>): void {
  // Suppress noisy duplicates in a single tab session — once per fn+args
  // combination is enough to see the pattern.
  const key = `${fnName}|${JSON.stringify(args)}`;
  if (STUB_LOGGED.has(key)) return;
  STUB_LOGGED.add(key);

  // eslint-disable-next-line no-console
  console.warn(`[imaging-stub] ${fnName} not wired:`, args);

  // Surface as a Sentry breadcrumb so production telemetry shows which UI
  // surfaces still depend on stubbed endpoints. captureException is the
  // safest call we have today (the dedicated breadcrumb API isn't exposed
  // by our Sentry wrapper); we use a synthetic Error so the stack frame
  // points to phaseStubLog rather than into Sentry internals.
  try {
    captureException(new Error(`stubbed_imaging_call: ${fnName}`), {
      source: 'imagingStudyService.phaseStubLog',
      fnName,
      ...args,
    });
  } catch {
    // Sentry not initialized — fine.
  }
}

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
  phaseStubLog('getById', { studyId });
  return null;
}

/** STUB: fetch a study by its StudyInstanceUID. */
export async function getByUid(
  _fhir: LiverRaFhirClient,
  studyInstanceUid: string
): Promise<ImagingStudyLike | undefined> {
  phaseStubLog('getByUid', { studyInstanceUid });
  return undefined;
}

/** STUB: fetch a study by accession number. */
export async function getByAccessionNumber(
  _fhir: LiverRaFhirClient,
  accessionNumber: string
): Promise<ImagingStudyLike | undefined> {
  phaseStubLog('getByAccessionNumber', { accessionNumber });
  return undefined;
}

/** STUB: list studies for a patient. */
export async function listByPatient(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ImagingStudyLike[]> {
  phaseStubLog('listByPatient', { patientId });
  return [];
}

/** STUB: fetch DiagnosticReports keyed by study id. */
export async function fetchReportsForStudies(
  _fhir: LiverRaFhirClient,
  studyIds: string[],
  patientId: string
): Promise<Map<string, DiagnosticReportLike>> {
  phaseStubLog('fetchReportsForStudies', {
    patientId,
    studyCount: studyIds.length,
  });
  return new Map();
}

/** STUB: fetch pending imaging orders. */
export async function fetchPendingOrders(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ServiceRequestLike[]> {
  phaseStubLog('fetchPendingOrders', { patientId });
  return [];
}

/** STUB: list the most recent N studies. */
export async function listRecentStudies(
  _fhir: LiverRaFhirClient,
  count = 50
): Promise<ImagingStudyListItem[]> {
  phaseStubLog('listRecentStudies', { count });
  return [];
}

/** STUB: enriched study list for a patient. */
export async function listItemsByPatient(
  _fhir: LiverRaFhirClient,
  patientId: string
): Promise<ImagingStudyListItem[]> {
  phaseStubLog('listItemsByPatient', { patientId });
  return [];
}

/** STUB: get/create the FHIR Endpoint for a WADO-RS URL. */
export async function getOrCreateEndpoint(
  _fhir: LiverRaFhirClient,
  wadoRsUrl: string,
  name: string
): Promise<FhirResourceLike | null> {
  phaseStubLog('getOrCreateEndpoint', { name, wadoRsUrl });
  return null;
}

/** STUB: paginated unmatched studies. */
export async function listUnmatchedStudies(
  _fhir: LiverRaFhirClient,
  offset = 0,
  pageSize = 200
): Promise<PaginatedUnmatchedResult> {
  phaseStubLog('listUnmatchedStudies', { offset, pageSize });
  return { items: [], hasMore: false };
}

/** STUB: link an unmatched study to a patient. */
export async function linkStudyToPatient(
  _fhir: LiverRaFhirClient,
  studyId: string,
  patientId: string,
  patientDisplay: string
): Promise<ImagingStudyLike | null> {
  phaseStubLog('linkStudyToPatient', { studyId, patientId, patientDisplay });
  return null;
}

/** STUB: cascade reassignment of a study to a different patient. */
export async function reassignStudy(
  _fhir: LiverRaFhirClient,
  studyId: string,
  newPatientId: string,
  newPatientDisplay: string
): Promise<ReassignmentResult> {
  phaseStubLog('reassignStudy', { studyId, newPatientId, newPatientDisplay });
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
  phaseStubLog('findReportsForStudy', { studyId });
  return [];
}

/** STUB: delete a study. */
export async function deleteStudy(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<void> {
  phaseStubLog('deleteStudy', { studyId });
}

/** STUB: delete related annotations / key images / provenance. */
export async function deleteStudyRelatedResources(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<StudyCleanupResult> {
  phaseStubLog('deleteStudyRelatedResources', { studyId });
  return { annotations: 0, keyImages: 0, provenance: 0 };
}

/** @deprecated use `deleteStudyRelatedResources`. STUB. */
export async function deleteStudyAnnotations(
  _fhir: LiverRaFhirClient,
  studyId: string
): Promise<number> {
  phaseStubLog('deleteStudyAnnotations', { studyId });
  return 0;
}

/** STUB: search studies by accession / patient name. */
export async function searchStudies(
  _fhir: LiverRaFhirClient,
  query: string
): Promise<ImagingStudyLike[]> {
  phaseStubLog('searchStudies', { query });
  return [];
}

/** STUB: locate a prior study of the same modality / body part. */
export async function findPriorStudy(
  _fhir: LiverRaFhirClient,
  currentStudy: ImagingStudyListItem,
  _maxAgeDays?: number
): Promise<PriorStudyResult> {
  phaseStubLog('findPriorStudy', {
    currentStudyId: currentStudy.id,
    patientId: currentStudy.patientId,
  });
  return { study: undefined, timedOut: false };
}

/**
 * STUB: create a FHIR ImagingStudy row from an Orthanc study id.
 * Used by the study importer after a successful STOW-RS upload.
 */
export async function createImagingStudyFromOrthanc(
  orthancStudyId: string
): Promise<ImagingStudyLike | null> {
  phaseStubLog('createImagingStudyFromOrthanc', { orthancStudyId });
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
  phaseStubLog('syncOrthancToFhir', {});
  return { created: 0, updated: 0, errors: 0 };
}

/** STUB: PACS bridge monitoring stats. */
export async function fetchPacsBridgeStats(
  _accessToken?: string
): Promise<{ worklist: PacsBridgeWorklistStats } | null> {
  phaseStubLog('fetchPacsBridgeStats', {});
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
  phaseStubLog('searchImagingStudies', { params });
  return [];
}
