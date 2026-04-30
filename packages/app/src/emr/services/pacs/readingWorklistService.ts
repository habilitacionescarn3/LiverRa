// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// Reading Worklist Service (LiverRa)
// ============================================================================
// Builds a prioritized queue of unread imaging studies for radiologists.
// Sort order: priority (STAT → urgent → routine), then wait time (longest
// first). Calculates `waitTime` + `isOverdue`, enriches with the ordering
// doctor, and applies optional filters (priority, modality, body part,
// subspecialty).
//
// Ported from MediMind with Medplum swapped for the LiverRa FHIR shim. The
// shim's persistence is stubbed until Phase 4, so every call path falls
// through to an empty-result branch and callers behave gracefully.
// ============================================================================

import type { LiverRaFhirClient } from '../fhirClient';
import type {
  ImagingPriority,
  ReadingWorklistFilters,
  ReadingWorklistItem,
} from '../../types/pacs';
import {
  toListItem,
  type ImagingStudyLike,
  type ServiceRequestLike,
} from './imagingStudyService';

// ============================================================================
// Constants
// ============================================================================

/** STAT studies are considered overdue after 30 minutes. */
const STAT_OVERDUE_MINUTES = 30;

/** TTL for the prior-study cache (5 minutes). */
const PRIOR_CACHE_TTL_MS = 5 * 60 * 1000;

/** Priority sort order — lower number = higher priority. */
const PRIORITY_ORDER: Record<ImagingPriority, number> = {
  stat: 0,
  urgent: 1,
  routine: 2,
};

/** Cap on prior-study cache to avoid unbounded growth. */
const MAX_PRIOR_CACHE_SIZE = 500;

// ============================================================================
// Local minimal Practitioner shape (no @medplum/fhirtypes)
// ============================================================================

interface PractitionerLike {
  resourceType: 'Practitioner';
  id?: string;
  name?: Array<{ given?: string[]; family?: string }>;
}

// ============================================================================
// Prior-study cache (patientId → hasPriors flag)
// ============================================================================

const priorStudyCache = new Map<string, { hasPriors: boolean; timestamp: number }>();

/** Clear the prior-study cache (call on logout / session reset). */
export function clearReadingWorklistCache(): void {
  priorStudyCache.clear();
}

/** Add an entry to the cache, evicting the oldest if we hit capacity. */
function addToPriorStudyCache(
  key: string,
  value: { hasPriors: boolean; timestamp: number }
): void {
  if (priorStudyCache.size >= MAX_PRIOR_CACHE_SIZE) {
    const oldestKey = priorStudyCache.keys().next().value;
    if (oldestKey !== undefined) {
      priorStudyCache.delete(oldestKey);
    }
  }
  priorStudyCache.set(key, value);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute how many minutes have elapsed since the study's `started` timestamp.
 * Returns 0 if the date is missing / malformed.
 */
function calculateWaitTime(study: ImagingStudyLike): number {
  const dateStr = study.started;
  if (!dateStr) return 0;
  const startTime = new Date(dateStr).getTime();
  if (isNaN(startTime)) return 0;
  const diffMs = Date.now() - startTime;
  return Math.max(0, Math.round(diffMs / 60_000));
}

/** Extract the ordering practitioner reference from a ServiceRequest. */
function getOrderingPractitionerRef(order?: ServiceRequestLike): string | undefined {
  return order?.requester?.reference;
}

// ============================================================================
// Types
// ============================================================================

/** Paginated worklist result. */
export interface PaginatedWorklistResult {
  items: ReadingWorklistItem[];
  /** True when there may be more pages beyond what was fetched. */
  hasMore: boolean;
}

// ============================================================================
// Core entry point — the ReadingWorklist component calls this.
// ============================================================================

/**
 * Fetch unread imaging studies and shape them into worklist items.
 * "Unread" = study lifecycle status extension == 'images-available'.
 *
 * TODO(phase-4): wire Supabase persistence — the FHIR calls below return
 * empty / stub values today, so callers see `{ items: [], hasMore: false }`.
 *
 * @param offset   FHIR `_offset` equivalent (pagination).
 * @param pageSize Page size (default 200 for MediMind parity).
 */
export async function getWorklistItems(
  fhir: LiverRaFhirClient,
  filters?: ReadingWorklistFilters,
  offset = 0,
  pageSize = 200
): Promise<PaginatedWorklistResult> {
  // Step 1: fetch ImagingStudy page.
  const studiesBundle = await fhir.search('ImagingStudy', {
    _count: String(pageSize),
    _offset: String(offset),
    _sort: '-started',
    _elements:
      'id,status,subject,started,modality,description,numberOfSeries,numberOfInstances,identifier,extension,basedOn,series',
  });
  const studies = (studiesBundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is ImagingStudyLike => !!r && r.resourceType === 'ImagingStudy');

  const hasMore = studies.length >= pageSize;

  // Client-side filter to "unread": status extension === 'images-available'.
  // Required because the FHIR shim doesn't expose a custom search parameter
  // for our lifecycle status yet.
  const unreadStudies = studies.filter((study) => {
    const ext = study.extension?.find(
      (e) =>
        e.url === 'http://liverra.ai/fhir/StructureDefinition/imaging-study-status'
    );
    return (ext?.valueString as string | undefined) === 'images-available';
  });

  if (unreadStudies.length === 0) {
    return { items: [], hasMore };
  }

  // Step 2: batch-fetch related ServiceRequests (orders) to get ordering doctor info.
  const orderRefs = unreadStudies
    .map((s) => s.basedOn?.[0]?.reference)
    .filter((ref): ref is string => !!ref);

  const uniqueOrderIds = [
    ...new Set(
      orderRefs
        .filter((ref) => ref.startsWith('ServiceRequest/'))
        .map((ref) => ref.replace('ServiceRequest/', ''))
    ),
  ];

  const orderMap = new Map<string, ServiceRequestLike>();
  if (uniqueOrderIds.length > 0) {
    const ordersBundle = await fhir.search('ServiceRequest', {
      _id: uniqueOrderIds.join(','),
      _count: '100',
    });
    for (const entry of ordersBundle.entry ?? []) {
      const order = entry.resource as ServiceRequestLike | undefined;
      if (order?.id && order.resourceType === 'ServiceRequest') {
        orderMap.set(order.id, order);
      }
    }
  }

  // Step 3: batch-fetch Practitioner resources for the orders.
  const practitionerRefs = new Set<string>();
  for (const order of orderMap.values()) {
    const ref = getOrderingPractitionerRef(order);
    if (ref?.startsWith('Practitioner/')) {
      practitionerRefs.add(ref.replace('Practitioner/', ''));
    }
  }

  const practitionerMap = new Map<string, PractitionerLike>();
  const practIds = [...practitionerRefs];
  if (practIds.length > 0) {
    const practsBundle = await fhir.search('Practitioner', {
      _id: practIds.join(','),
      _count: '100',
    });
    for (const entry of practsBundle.entry ?? []) {
      const pract = entry.resource as PractitionerLike | undefined;
      if (pract?.id && pract.resourceType === 'Practitioner') {
        practitionerMap.set(pract.id, pract);
      }
    }
  }

  // Step 4: shape each study into a ReadingWorklistItem.
  const items: ReadingWorklistItem[] = unreadStudies.map((study) => {
    const baseItem = toListItem(study);
    const waitTime = calculateWaitTime(study);
    const isOverdue =
      baseItem.priority === 'stat' && waitTime > STAT_OVERDUE_MINUTES;

    const orderRef = study.basedOn?.[0]?.reference;
    const orderId = orderRef?.replace('ServiceRequest/', '');
    const order = orderId ? orderMap.get(orderId) : undefined;
    const practRef = getOrderingPractitionerRef(order);
    const practId = practRef?.replace('Practitioner/', '');
    const practitioner = practId ? practitionerMap.get(practId) : undefined;

    const doctorName = practitioner?.name?.[0]
      ? [practitioner.name[0].given?.join(' '), practitioner.name[0].family]
          .filter(Boolean)
          .join(' ')
      : order?.requester?.display || '';

    return {
      ...baseItem,
      waitTime,
      isOverdue,
      orderingDoctor: {
        id: practId || '',
        name: doctorName,
      },
    };
  });

  // Step 5: enrich with prior-study flag (5 min cache).
  const uniquePatientIds = [
    ...new Set(items.map((i) => i.patientId).filter(Boolean)),
  ];
  if (uniquePatientIds.length > 0) {
    try {
      const now = Date.now();
      const priorMap = new Map<string, boolean>();
      const uncachedIds: string[] = [];
      for (const patId of uniquePatientIds) {
        const cached = priorStudyCache.get(patId);
        if (cached && now - cached.timestamp < PRIOR_CACHE_TTL_MS) {
          priorMap.set(patId, cached.hasPriors);
        } else {
          uncachedIds.push(patId);
        }
      }

      const BATCH_SIZE = 50;
      for (let i = 0; i < uncachedIds.length; i += BATCH_SIZE) {
        const chunk = uncachedIds.slice(i, i + BATCH_SIZE);
        const priorsBundle = await fhir.search('ImagingStudy', {
          patient: chunk.map((id) => `Patient/${id}`).join(','),
          _count: '500',
          _elements: 'id,subject',
        });
        const priorStudies = (priorsBundle.entry ?? [])
          .map((e) => e.resource)
          .filter((r): r is ImagingStudyLike => !!r);

        const countByPatient = new Map<string, number>();
        for (const study of priorStudies) {
          const patRef = study.subject?.reference?.replace('Patient/', '');
          if (patRef) {
            countByPatient.set(patRef, (countByPatient.get(patRef) || 0) + 1);
          }
        }
        for (const patId of chunk) {
          const hasPriors = (countByPatient.get(patId) || 0) > 1;
          priorMap.set(patId, hasPriors);
          addToPriorStudyCache(patId, { hasPriors, timestamp: now });
        }
      }

      for (const item of items) {
        item.hasPriors = priorMap.get(item.patientId) || false;
      }
    } catch {
      // Non-critical — leave hasPriors undefined if the search failed.
    }
  }

  // Step 6: apply filters.
  const filtered = applyFilters(items, filters);

  // Step 7: sort by priority, then by wait time descending.
  filtered.sort((a, b) => {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.waitTime - a.waitTime;
  });

  return { items: filtered, hasMore };
}

// ============================================================================
// Filtering
// ============================================================================

function applyFilters(
  items: ReadingWorklistItem[],
  filters?: ReadingWorklistFilters
): ReadingWorklistItem[] {
  if (!filters) return items;

  return items.filter((item) => {
    if (filters.priority && filters.priority.length > 0) {
      if (!filters.priority.includes(item.priority)) return false;
    }

    if (filters.modality && filters.modality.length > 0) {
      const hasMatch = item.modalities.some((m) =>
        filters.modality!.includes(m)
      );
      if (!hasMatch) return false;
    }

    if (filters.bodyPart && filters.bodyPart.length > 0) {
      if (!item.bodyPart || !filters.bodyPart.includes(item.bodyPart)) {
        return false;
      }
    }

    if (filters.subspecialty) {
      const desc = (item.description || '').toLowerCase();
      if (!desc.includes(filters.subspecialty.toLowerCase())) {
        return false;
      }
    }

    return true;
  });
}

// ============================================================================
// Derived: overdue STAT count
// ============================================================================

/**
 * Count how many STAT studies are currently overdue (>30 min wait).
 * Used by the worklist header badge.
 */
export async function getOverdueStatCount(
  fhir: LiverRaFhirClient
): Promise<number> {
  const result = await getWorklistItems(fhir, { priority: ['stat'] });
  return result.items.filter((item) => item.isOverdue).length;
}
