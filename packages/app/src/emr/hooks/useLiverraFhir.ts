// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// useLiverraFhir — React hook wrapper around the FHIR shim
// ============================================================================
// Components and ported hooks call `useLiverraFhir()` exactly the way
// MediMind code calls `useMedplum()`. Today it returns the singleton shim
// from `services/fhirClient`; Phase 4 will swap this to resolve the real
// Supabase/FHIR client via React context.
// ============================================================================

import { fhirClient, type LiverRaFhirClient } from '../services/fhirClient';

/**
 * Returns the active FHIR client. Stable reference — safe to use in
 * dependency arrays without retriggering effects.
 */
export function useLiverraFhir(): LiverRaFhirClient {
  return fhirClient;
}
