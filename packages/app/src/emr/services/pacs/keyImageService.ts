// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Key Image Service — Flag and manage significant images in a study
// ============================================================================
// Lets doctors "bookmark" important images within an imaging study. Think of it
// like putting a gold star on the most critical X-ray in a folder — so anyone
// reviewing the case later can instantly see which images matter most.
//
// Storage model:
//   One Basic resource per flagged image (study + SOPInstanceUID + optional frame).
//   Basic.code = "key-image" (PACS_BASIC_TYPES — inlined until Phase 4)
//   Basic.subject = ImagingStudy reference
//   Basic.author = Practitioner who flagged it
//   Extensions store the SOPInstanceUID, reason, and frame number.
//
// Cross-user visibility: Any authenticated user can see all flagged key images
// for a study, but only the original author (or an admin) can unflag.
//
// Ported from MediMind. The audit and permission surfaces are local stubs —
// Phase 4 will replace them with Supabase-backed audit_events table + the
// real permission registry (`Guarded` RBAC).
// ============================================================================

import { LiverRaFhirClient } from '../fhirClient';
import { logKeyImageFlag } from './auditService';

// TODO(phase-4): replace with real FHIR types from @medplum/fhirtypes.
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

// TODO(phase-4): source from constants/fhir-systems.ts after it lands. Keeping
// the MediMind URLs preserves row-compat for any audit trail carried forward.
const LAB_PRODUCTION_BASIC_RESOURCE_TYPES =
  'http://medimind.ge/fhir/CodeSystem/basic-resource-types';
const PACS_BASIC_KEY_IMAGE = 'key-image';
const EXT_KEY_IMAGE_SOP_UID =
  'http://medimind.ge/fhir/StructureDefinition/key-image-sop-uid';
const EXT_KEY_IMAGE_REASON =
  'http://medimind.ge/fhir/StructureDefinition/key-image-reason';
const EXT_KEY_IMAGE_FRAME =
  'http://medimind.ge/fhir/StructureDefinition/key-image-frame';

// ============================================================================
// Local profile resolution (permission check stub)
// ============================================================================
// Phase 4 replaces this with the real authenticated session identity. Until
// then we attribute all flags/unflags to a single stub user so the UI stays
// consistent with a known author.

/** Local profile shape resolved from the FHIR shim today (stubbed Phase 4). */
interface LocalProfile {
  id: string;
  displayName: string;
}

function getCurrentProfile(_client: LiverRaFhirClient): LocalProfile {
  // TODO(phase-4): pull from the authenticated session. Using a fixed ID keeps
  // flagger attribution stable across the stub lifetime.
  return { id: 'local-user', displayName: 'Local User' };
}

// ============================================================================
// Types
// ============================================================================

/** A flagged key image in a study */
export interface KeyImage {
  /** FHIR Basic resource ID (needed for unflagging) */
  id: string;
  /** ImagingStudy FHIR resource ID */
  studyId: string;
  /** DICOM SOP Instance UID of the flagged image */
  sopInstanceUid: string;
  /** Why this image was flagged (e.g., "Suspicious nodule") */
  reason: string;
  /** Frame number for multi-frame instances (0-based, undefined for single-frame) */
  frameNumber?: number;
  /** Practitioner ID who flagged this image */
  authorId: string;
  /** Display name of the author */
  authorName: string;
  /** ISO timestamp when the image was flagged */
  flaggedAt: string;
}

/** Options for flagging a key image */
export interface FlagKeyImageOptions {
  /** ImagingStudy FHIR resource ID */
  studyId: string;
  /** DICOM SOP Instance UID of the image to flag */
  sopInstanceUid: string;
  /** Reason for flagging (e.g., "Suspicious nodule", "Reference baseline") */
  reason: string;
  /** Frame number for multi-frame DICOM instances (optional) */
  frameNumber?: number;
  /** Patient ID (for audit logging) */
  patientId?: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Build the Basic.code for key images */
function buildKeyImageCode(): FhirBasic['code'] {
  return {
    coding: [
      {
        system: LAB_PRODUCTION_BASIC_RESOURCE_TYPES,
        code: PACS_BASIC_KEY_IMAGE,
        display: 'Key Image',
      },
    ],
  };
}

/** Build extension array for a key image */
function buildExtensions(opts: FlagKeyImageOptions): FhirExtension[] {
  const extensions: FhirExtension[] = [
    {
      url: EXT_KEY_IMAGE_SOP_UID,
      valueString: opts.sopInstanceUid,
    },
    {
      url: EXT_KEY_IMAGE_REASON,
      valueString: opts.reason,
    },
  ];

  if (opts.frameNumber !== undefined) {
    extensions.push({
      url: EXT_KEY_IMAGE_FRAME,
      valueInteger: opts.frameNumber,
    });
  }

  return extensions;
}

/** Parse a Basic resource into our KeyImage format */
function parseKeyImageResource(resource: FhirBasic): KeyImage | undefined {
  const studyRef = resource.subject?.reference;
  const authorRef = resource.author?.reference;
  if (!studyRef || !authorRef) {
    return undefined;
  }

  const sopUid = resource.extension?.find((e) => e.url === EXT_KEY_IMAGE_SOP_UID)
    ?.valueString;

  if (!sopUid) {
    return undefined;
  }

  const reason =
    resource.extension?.find((e) => e.url === EXT_KEY_IMAGE_REASON)?.valueString || '';

  const frameExt = resource.extension?.find((e) => e.url === EXT_KEY_IMAGE_FRAME);
  const frameNumber = frameExt?.valueInteger;

  return {
    id: resource.id || '',
    studyId: studyRef.replace('ImagingStudy/', ''),
    sopInstanceUid: sopUid,
    reason,
    frameNumber,
    authorId: authorRef.replace('Practitioner/', ''),
    authorName: resource.author?.display || '',
    flaggedAt: resource.meta?.lastUpdated || '',
  };
}

async function searchBasicResources(
  client: LiverRaFhirClient,
  params: Record<string, unknown>,
): Promise<FhirBasic[]> {
  const res = await client.search('Basic', params);
  return (res.entry ?? [])
    .map((e) => e.resource as FhirBasic | undefined)
    .filter((r): r is FhirBasic => !!r && r.resourceType === 'Basic');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Flag an image as a key image (bookmark it as significant).
 */
export async function flagKeyImage(
  client: LiverRaFhirClient,
  opts: FlagKeyImageOptions,
): Promise<KeyImage> {
  // Reason is required — can't flag an image without saying why it matters
  if (!opts.reason || opts.reason.trim().length === 0) {
    throw new Error('Reason is required when flagging a key image');
  }

  const profile = getCurrentProfile(client);

  // Dedup check: see if this exact image (study + SOP instance) is already flagged
  const existingFlags = await searchBasicResources(client, {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_KEY_IMAGE}`,
    subject: `ImagingStudy/${opts.studyId}`,
    _count: '100',
  });

  // Check if any existing flag matches the same SOP Instance UID (and frame if applicable)
  for (const existing of existingFlags) {
    const sopUid = existing.extension?.find((e) => e.url === EXT_KEY_IMAGE_SOP_UID)
      ?.valueString;
    const frameNum = existing.extension?.find((e) => e.url === EXT_KEY_IMAGE_FRAME)
      ?.valueInteger;

    if (sopUid === opts.sopInstanceUid && frameNum === opts.frameNumber) {
      // Already flagged — return existing instead of creating duplicate
      const parsed = parseKeyImageResource(existing);
      if (parsed) {
        return parsed;
      }
    }
  }

  const authorRef = `Practitioner/${profile.id}`;
  const authorName = profile.displayName;

  // Create the Basic resource (no duplicate exists)
  const resource = await client.createResource<FhirBasic>({
    resourceType: 'Basic',
    code: buildKeyImageCode(),
    subject: {
      reference: `ImagingStudy/${opts.studyId}`,
    },
    author: {
      reference: authorRef,
      display: authorName,
    },
    extension: buildExtensions(opts),
  });

  // Fire-and-forget audit event
  logKeyImageFlag({
    studyId: opts.studyId,
    patientId: opts.patientId,
    description: `Key image flagged: ${opts.reason} (SOP: ${opts.sopInstanceUid})`,
  });

  return (
    parseKeyImageResource(resource) || {
      id: resource.id || '',
      studyId: opts.studyId,
      sopInstanceUid: opts.sopInstanceUid,
      reason: opts.reason,
      frameNumber: opts.frameNumber,
      authorId: profile.id,
      authorName,
      flaggedAt: resource.meta?.lastUpdated || new Date().toISOString(),
    }
  );
}

/**
 * Get all key images for a study (from all users — cross-user visibility).
 */
export async function getKeyImages(
  client: LiverRaFhirClient,
  studyId: string,
): Promise<KeyImage[]> {
  const resources = await searchBasicResources(client, {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_KEY_IMAGE}`,
    subject: `ImagingStudy/${studyId}`,
    _sort: '-_lastUpdated',
    _count: '100',
  });

  const results: KeyImage[] = [];
  for (const resource of resources) {
    const parsed = parseKeyImageResource(resource);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

/**
 * Get the count of key images for a study (quick count without full data).
 */
export async function getKeyImageCount(
  client: LiverRaFhirClient,
  studyId: string,
): Promise<number> {
  const resources = await searchBasicResources(client, {
    code: `${LAB_PRODUCTION_BASIC_RESOURCE_TYPES}|${PACS_BASIC_KEY_IMAGE}`,
    subject: `ImagingStudy/${studyId}`,
    _count: '100',
  });
  return resources.length;
}

/**
 * Unflag a key image (remove the bookmark).
 *
 * Permission check: Only the original author or the current user can unflag.
 */
export async function unflagKeyImage(
  client: LiverRaFhirClient,
  keyImageId: string,
  skipPermissionCheck = false,
): Promise<boolean> {
  const profile = getCurrentProfile(client);

  // Read the resource first to check ownership
  const resource = (await client.readResource('Basic', keyImageId)) as FhirBasic | null;
  if (!resource) {
    throw new Error('Key image resource not found or malformed');
  }
  const parsed = parseKeyImageResource(resource);

  if (!parsed) {
    throw new Error('Key image resource not found or malformed');
  }

  // Permission check: only the original author can unflag (unless admin override)
  if (!skipPermissionCheck && parsed.authorId !== profile.id) {
    throw new Error('Only the original author can unflag this key image');
  }

  // Delete the Basic resource
  await client.deleteResource('Basic', keyImageId);

  // Fire-and-forget audit event
  logKeyImageFlag({
    studyId: parsed.studyId,
    description: `Key image unflagged: ${parsed.reason} (SOP: ${parsed.sopInstanceUid})`,
  });

  return true;
}
