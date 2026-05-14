// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Annotation Service — Persist Cornerstone3D Measurements to FHIR
// ============================================================================
// Saves and loads Cornerstone3D annotations (length, angle, elliptical ROI, etc.)
// as FHIR Basic resources. Each user gets their own annotation resource per study,
// like a personal "sticky notes" layer on top of the medical images.
//
// Storage model:
//   One Basic resource per (study, user) pair.
//   The serialized annotation JSON lives in an extension.
//   Basic.code = "imaging-annotations" (PACS_BASIC_TYPES — inlined until Phase 4)
//   Basic.subject = ImagingStudy reference
//   Basic.author = Practitioner reference (who drew the annotations)
//
// Ported from MediMind. Persistence is stubbed through `LiverRaFhirClient`
// (see services/fhirClient.ts) until Phase 4 wires real Supabase-backed FHIR.
// Every call logs via `[fhir-stub]` so we can see what shape the backend must
// eventually support.
// ============================================================================

import { LiverRaFhirClient } from '../fhirClient';

// TODO(phase-4): replace with real FHIR types from @medplum/fhirtypes or
// packages/fhirtypes. For now we define the minimum shape the service needs.
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

// TODO(phase-4): port MediMind's constants/fhir-systems.ts to LiverRa so these
// aren't inlined. Until then, we keep the exact URL shapes from MediMind to
// keep the Supabase schema backward-compatible with the existing stream.
const LAB_PRODUCTION_BASIC_RESOURCE_TYPES =
  'http://medimind.ge/fhir/CodeSystem/basic-resource-types';
const PACS_BASIC_IMAGING_ANNOTATIONS = 'imaging-annotations';
const EXT_ANNOTATION_DATA =
  'http://medimind.ge/fhir/StructureDefinition/annotation-data';

// ============================================================================
// Types
// ============================================================================

/** Serializable annotation data stored in FHIR */
export interface StoredAnnotations {
  /** ImagingStudy FHIR resource ID */
  studyId: string;
  /** Practitioner FHIR resource ID of the author */
  authorId: string;
  /** Display name of the author */
  authorName: string;
  /** JSON-serialized Cornerstone3D annotation state */
  data: string;
  /** ISO timestamp of last save */
  lastSaved: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Build the Basic.code for imaging annotations */
function buildAnnotationCode(): FhirBasic['code'] {
  return {
    coding: [
      {
        system: LAB_PRODUCTION_BASIC_RESOURCE_TYPES,
        code: PACS_BASIC_IMAGING_ANNOTATIONS,
        display: 'Imaging Annotations',
      },
    ],
  };
}

/** Parse a Basic resource into our StoredAnnotations format */
function parseAnnotationResource(resource: FhirBasic): StoredAnnotations | undefined {
  const studyRef = resource.subject?.reference;
  const authorRef = resource.author?.reference;
  if (!studyRef || !authorRef) {
    return undefined;
  }

  const dataExt = resource.extension?.find((e) => e.url === EXT_ANNOTATION_DATA);
  const data = dataExt?.valueString || '';

  return {
    studyId: studyRef.replace('ImagingStudy/', ''),
    authorId: authorRef.replace('Practitioner/', ''),
    authorName: resource.author?.display || '',
    data,
    lastSaved: resource.meta?.lastUpdated || '',
  };
}

/** Build extension array for the annotation data */
function buildExtensions(annotationJson: string): FhirExtension[] {
  return [
    {
      url: EXT_ANNOTATION_DATA,
      valueString: annotationJson,
    },
  ];
}

/**
 * Resolve the current authenticated Practitioner. LiverRa's FHIR shim returns
 * `undefined` in Phase 2, so we fall back to a stable "local-user" identity.
 * TODO(phase-4): read the Cognito-backed profile from LiverRaFhirClient once
 * `getProfile()` is wired.
 */
interface LocalProfile {
  id: string;
  displayName: string;
}

function getCurrentProfile(_client: LiverRaFhirClient): LocalProfile {
  // TODO(phase-4): pull from the authenticated session. Using a fixed ID keeps
  // the (study, user) key stable across the stub lifetime so the same user
  // doesn't look like "multiple authors" to the UI.
  return {
    id: 'local-user',
    displayName: 'Local User',
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Save annotations for the current user on a study (upsert).
 *
 * If the user already has annotations on this study, updates them.
 * Otherwise, creates a new Basic resource.
 */
export async function saveAnnotations(
  client: LiverRaFhirClient,
  studyId: string,
  annotationJson: string,
): Promise<StoredAnnotations> {
  const profile = getCurrentProfile(client);
  const authorRef = `Practitioner/${profile.id}`;
  const authorName = profile.displayName;

  // Search for existing annotation resource for this (study, user) pair
  const searchResult = await client.search('Basic', {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_IMAGING_ANNOTATIONS}`,
    subject: `ImagingStudy/${studyId}`,
    author: authorRef,
    _count: '10',
  });
  const existing: FhirBasic[] = (searchResult.entry ?? [])
    .map((e) => e.resource as FhirBasic | undefined)
    .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');

  let saved: FhirBasic;

  if (existing.length > 0) {
    // Update with optimistic locking — HTTP 412 = another user saved in between
    try {
      saved = await client.updateResource<FhirBasic>({
        ...existing[0],
        meta: { versionId: existing[0].meta?.versionId },
        extension: buildExtensions(annotationJson),
      });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 412) {
        throw new Error('Annotations were modified by another user. Please refresh and retry.');
      }
      throw err;
    }

    // Clean up any duplicates from past race conditions
    if (existing.length > 1) {
      for (let i = 1; i < existing.length; i++) {
        if (existing[i].id) {
          try {
            await client.deleteResource('Basic', existing[i].id as string);
          } catch {
            // Ignore cleanup failures — not critical
          }
        }
      }
    }
  } else {
    // TODO(phase-4): real FHIR backend should support If-None-Exist for
    // conditional create to avoid race conditions. The stub accepts a plain
    // create today; when moving to Supabase, add the searchQuery above.
    saved = await client.createResource<FhirBasic>({
      resourceType: 'Basic',
      code: buildAnnotationCode(),
      subject: {
        reference: `ImagingStudy/${studyId}`,
      },
      author: {
        reference: authorRef,
        display: authorName,
      },
      extension: buildExtensions(annotationJson),
    });
  }

  return (
    parseAnnotationResource(saved) || {
      studyId,
      authorId: profile.id,
      authorName,
      data: annotationJson,
      lastSaved: saved.meta?.lastUpdated || new Date().toISOString(),
    }
  );
}

/**
 * Load all annotations for a study (from all users).
 */
export async function loadAnnotations(
  client: LiverRaFhirClient,
  studyId: string,
): Promise<StoredAnnotations[]> {
  const searchResult = await client.search('Basic', {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_IMAGING_ANNOTATIONS}`,
    subject: `ImagingStudy/${studyId}`,
    _count: '100',
  });
  const resources: FhirBasic[] = (searchResult.entry ?? [])
    .map((e) => e.resource as FhirBasic | undefined)
    .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');

  const results: StoredAnnotations[] = [];
  for (const resource of resources) {
    const parsed = parseAnnotationResource(resource);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

/**
 * Load only the current user's annotations for a study.
 */
export async function loadMyAnnotations(
  client: LiverRaFhirClient,
  studyId: string,
): Promise<StoredAnnotations | undefined> {
  const profile = getCurrentProfile(client);

  const searchResult = await client.search('Basic', {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_IMAGING_ANNOTATIONS}`,
    subject: `ImagingStudy/${studyId}`,
    author: `Practitioner/${profile.id}`,
    _count: '1',
  });
  const resources: FhirBasic[] = (searchResult.entry ?? [])
    .map((e) => e.resource as FhirBasic | undefined)
    .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');

  if (resources.length === 0) {
    return undefined;
  }

  return parseAnnotationResource(resources[0]);
}

/**
 * Delete the current user's annotations for a study.
 */
export async function deleteAnnotations(
  client: LiverRaFhirClient,
  studyId: string,
): Promise<boolean> {
  const profile = getCurrentProfile(client);

  const searchResult = await client.search('Basic', {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_IMAGING_ANNOTATIONS}`,
    subject: `ImagingStudy/${studyId}`,
    author: `Practitioner/${profile.id}`,
    _count: '1',
  });
  const resources: FhirBasic[] = (searchResult.entry ?? [])
    .map((e) => e.resource as FhirBasic | undefined)
    .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');

  if (resources.length === 0) {
    return false;
  }

  if (!resources[0].id) {
    return false;
  }

  // C-PACS-5: clinical annotations are part of the retained medical
  // record — soft-delete (set status=entered-in-error + deleted-at
  // extension) so the row stays auditable for the 10-year CE MDR window.
  await client.softDeleteResource<FhirBasic>(resources[0]);
  return true;
}
