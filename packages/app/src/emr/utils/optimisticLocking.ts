// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// Optimistic locking helpers (ported from MediMind, adapted to LiverRaFhirClient)
// ============================================================================
// Slim port: only the helpers the PACS viewer closure needs
// (updateWithIfMatch for calibrationService, deleteWithIfMatch for
// viewingPresetsService). MediMind's retry/transaction machinery
// (updateWithIfMatchRetry, transactionResources) was NOT ported — bring it
// over from medplum_medimind/packages/app/src/emr/utils/optimisticLocking.ts
// if a future module needs it.
//
// LiverRaFhirClient carries the version via `options.ifMatch` (see C-LOCK-3
// note in services/fhirClient.ts) instead of MedplumClient's raw
// `{ headers: { 'If-Match': … } }`.
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../services/fhirClient';

/**
 * Thrown when a user's edit lost a race against another user's concurrent
 * edit. The UI catches this so it can surface a "refresh and try again"
 * prompt instead of overwriting the other user's change.
 */
export class StaleEditConflictError extends Error {
  constructor(message = 'Another user modified this entry. Refresh and try again.') {
    super(message);
    this.name = 'StaleEditConflictError';
  }
}

interface ResourceWithMeta extends FhirResourceLike {
  meta?: { versionId?: string };
}

function isPreconditionFailed(error: unknown): boolean {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  const message = (error as { message?: string })?.message ?? '';
  return status === 412 || message.includes('412') || message.includes('Precondition Failed');
}

/**
 * Wraps `fhir.updateResource` with an `If-Match` version guard for optimistic
 * locking. If another user modified the resource since it was loaded, the
 * server returns 412 and we throw a user-friendly error instead of silently
 * overwriting their changes.
 */
export async function updateWithIfMatch<T extends ResourceWithMeta>(
  fhir: LiverRaFhirClient,
  resource: T
): Promise<T> {
  const versionId = resource.meta?.versionId;
  if (!versionId) {
    throw new Error(
      'Cannot update resource without versionId. Fetch the resource first to get the current version.'
    );
  }

  try {
    return await fhir.updateResource(resource, { ifMatch: `W/"${versionId}"` });
  } catch (error: unknown) {
    if (isPreconditionFailed(error)) {
      throw new Error('Resource was modified by another user. Please refresh and try again.');
    }
    throw error;
  }
}

/**
 * Delete a FHIR resource only if it is still the version we read.
 */
export async function deleteWithIfMatch<T extends ResourceWithMeta>(
  fhir: LiverRaFhirClient,
  resource: T
): Promise<void> {
  const versionId = resource.meta?.versionId;
  if (!resource.id) {
    throw new Error(`Cannot delete ${resource.resourceType} without id.`);
  }
  if (!versionId) {
    throw new Error(
      'Cannot delete resource without versionId. Fetch the resource first to get the current version.'
    );
  }

  try {
    await fhir.deleteResource(resource.resourceType, resource.id, {
      ifMatch: `W/"${versionId}"`,
    });
  } catch (error: unknown) {
    if (isPreconditionFailed(error)) {
      throw new Error('Resource was modified by another user. Please refresh and try again.');
    }
    throw error;
  }
}
