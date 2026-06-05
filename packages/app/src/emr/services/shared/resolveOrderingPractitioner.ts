// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper for resolving the ordering Practitioner of a ServiceRequest or
 * ImagingStudy, handling the PractitionerRole → Practitioner redirection.
 *
 * (Ported from MediMind; adapted: MedplumClient → LiverRaFhirClient with
 * minimal local FHIR shapes — LiverRa's FHIR persistence is currently the
 * phaseStubLog facade, so this resolves to `null` until Phase 4 wires real
 * resources. The PACSViewer caller already treats `null` as "no ordering
 * doctor to display".)
 *
 * Used by:
 * - PACS viewer header (ordering-doctor display)
 */

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';

/** Minimal FHIR Reference shape (display + literal reference). */
export interface PractitionerReference {
  reference?: string;
  display?: string;
}

interface ServiceRequestLike extends FhirResourceLike {
  requester?: PractitionerReference;
  basedOn?: Array<{ reference?: string }>;
}

interface ImagingStudyLike extends FhirResourceLike {
  basedOn?: Array<{ reference?: string }>;
}

interface PractitionerRoleLike extends FhirResourceLike {
  practitioner?: PractitionerReference;
}

/**
 * Look up the ordering physician for a ServiceRequest or ImagingStudy.
 *
 * The complexity: `ServiceRequest.requester` may be either a Practitioner
 * reference OR a PractitionerRole reference. Notifications and display need
 * the underlying Practitioner (not PractitionerRole), so this helper does the
 * one-hop redirect when needed.
 *
 * Returns `null` if:
 * - The resource isn't found
 * - No ServiceRequest exists (for ImagingStudy lookups)
 * - ServiceRequest has no requester
 * - PractitionerRole has no practitioner reference
 * - Any fetch fails (errors are caught and logged, never thrown)
 *
 * @param fhir - LiverRa FHIR client
 * @param resourceId - FHIR ID (either ServiceRequest or ImagingStudy)
 * @param resourceType - Which resource type to start from. Defaults to ServiceRequest.
 */
export async function resolveOrderingPractitioner(
  fhir: LiverRaFhirClient,
  resourceId: string,
  resourceType: 'ServiceRequest' | 'ImagingStudy' = 'ServiceRequest'
): Promise<PractitionerReference | null> {
  try {
    let serviceRequest: ServiceRequestLike | null = null;

    if (resourceType === 'ServiceRequest') {
      serviceRequest = (await fhir.readResource('ServiceRequest', resourceId)) as ServiceRequestLike | null;
    } else {
      // Start from the ImagingStudy and find the linked ServiceRequest
      const study = (await fhir.readResource('ImagingStudy', resourceId)) as ImagingStudyLike | null;
      const basedOnRef = study?.basedOn?.find((ref) =>
        ref.reference?.startsWith('ServiceRequest/')
      );

      if (basedOnRef?.reference) {
        const srId = basedOnRef.reference.replace('ServiceRequest/', '');
        serviceRequest = (await fhir.readResource('ServiceRequest', srId)) as ServiceRequestLike | null;
      } else {
        // Fallback: search for ServiceRequests that reference this study
        const bundle = await fhir.search('ServiceRequest', {
          'based-on': `ImagingStudy/${resourceId}`,
          _count: '1',
        });
        serviceRequest = (bundle.entry?.[0]?.resource as ServiceRequestLike | undefined) ?? null;
      }
    }

    if (!serviceRequest || !serviceRequest.requester?.reference) {
      return null;
    }

    const requesterRef = serviceRequest.requester.reference;

    // PractitionerRole → resolve to underlying Practitioner
    if (requesterRef.startsWith('PractitionerRole/')) {
      const roleId = requesterRef.replace('PractitionerRole/', '');
      const role = (await fhir.readResource('PractitionerRole', roleId)) as PractitionerRoleLike | null;
      if (role?.practitioner?.reference) {
        return {
          reference: role.practitioner.reference,
          display: role.practitioner.display,
        };
      }
      return null;
    }

    // Direct Practitioner reference
    if (requesterRef.startsWith('Practitioner/')) {
      return {
        reference: requesterRef,
        display: serviceRequest.requester.display,
      };
    }

    return null;
  } catch (err) {
    console.warn('[resolveOrderingPractitioner] Failed to resolve ordering doctor:', err);
    return null;
  }
}
