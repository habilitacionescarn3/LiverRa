// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// LiverRa FHIR Client — Medplum facade shim
// ============================================================================
// Medplum → LiverRa FHIR facade. Currently stubbed; Phase 4 wires the real
// Supabase-backed FHIR persistence. Every call is logged so we can see
// exactly what MediMind-ported code expects the FHIR store to do — that log
// stream is the input to the Phase 4 persistence spec.
//
// Surface design: mirrors the subset of `MedplumClient` that PACS code uses
// (readResource / search / create / update / delete / getAccessToken /
// isAuthenticated). Components that called `useMedplum()` in MediMind should
// swap to `useLiverraFhir()` (see hooks/useLiverraFhir.ts) with zero further
// signature changes.
// ============================================================================

/**
 * Minimal FHIR resource shape used by the shim. Intentionally loose —
 * the Phase 4 backend will tighten this to `@medplum/fhirtypes` / the
 * local `packages/fhirtypes` package.
 */
export interface FhirResourceLike {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Minimal FHIR Bundle shape returned from `search`.
 */
export interface FhirSearchBundle {
  entry?: Array<{ resource?: FhirResourceLike }>;
  total?: number;
}

/**
 * `MedplumClient`-shaped facade. Keeps the surface area tiny so we can
 * expand only when a ported module demands it — that keeps the log stream
 * focused on actual Phase 4 requirements instead of speculative endpoints.
 */
export class LiverRaFhirClient {
  /**
   * Read a single resource by type + id.
   * STUB: returns `null` and logs the call. Phase 4 will proxy to Supabase.
   */
  async readResource(resourceType: string, id: string): Promise<FhirResourceLike | null> {
    // eslint-disable-next-line no-console
    console.warn(`[fhir-stub] readResource not wired: ${resourceType}/${id}`);
    return null;
  }

  /**
   * Run a FHIR search and return a Bundle-shaped envelope.
   * STUB: returns an empty Bundle. Phase 4 will proxy to Supabase.
   */
  async search(
    resourceType: string,
    params?: Record<string, unknown>,
  ): Promise<FhirSearchBundle> {
    const paramSummary = params ? JSON.stringify(params) : '(none)';
    // eslint-disable-next-line no-console
    console.warn(`[fhir-stub] search not wired: ${resourceType} params=${paramSummary}`);
    return { entry: [], total: 0 };
  }

  /**
   * Create a new resource. STUB: echoes the input and logs the call.
   * Phase 4 will issue a real POST /<resourceType>.
   */
  async createResource<T extends FhirResourceLike>(resource: T): Promise<T> {
    // eslint-disable-next-line no-console
    console.warn(`[fhir-stub] createResource not wired: ${resource.resourceType}`);
    return resource;
  }

  /**
   * Update an existing resource. STUB: echoes the input and logs the call.
   * Phase 4 will issue a real PUT /<resourceType>/<id>.
   */
  async updateResource<T extends FhirResourceLike>(resource: T): Promise<T> {
    // eslint-disable-next-line no-console
    console.warn(
      `[fhir-stub] updateResource not wired: ${resource.resourceType}/${resource.id ?? '(no-id)'}`,
    );
    return resource;
  }

  /**
   * Delete a resource by type + id. STUB: no-op + log.
   */
  async deleteResource(resourceType: string, id: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.warn(`[fhir-stub] deleteResource not wired: ${resourceType}/${id}`);
  }

  /**
   * Return the current access token for outbound calls. Real auth arrives
   * from Cognito via `useDicomWebClient`; this stub returns `undefined`.
   */
  getAccessToken(): string | undefined {
    return undefined;
  }

  /**
   * Whether the caller is authenticated. Stubbed `true` so ported UI
   * renders; TODO wire real auth in Phase 4.
   */
  isAuthenticated(): boolean {
    // TODO Phase 4: replace with real session check (Cognito/Supabase).
    return true;
  }
}

/**
 * Singleton used by `useLiverraFhir()` and any non-React caller.
 * Keeping one instance per process lets Phase 4 attach observability
 * (request counts, p95 latency) without threading the client through
 * every module.
 */
export const fhirClient = new LiverRaFhirClient();
