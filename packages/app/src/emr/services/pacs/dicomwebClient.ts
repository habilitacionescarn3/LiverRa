// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// DICOMweb Client (LiverRa)
// ============================================================================
// HTTP client for the clean-side Orthanc PACS via DICOMweb APIs:
//   - QIDO-RS: Search studies / series / instances (search engine)
//   - WADO-RS: Retrieve study metadata + image URLs (download links)
//   - STOW-RS: Store uploaded DICOM instances (filing cabinet)
//
// All requests go through an nginx proxy that validates the Cognito JWT and
// injects tenant context. Orthanc itself sits behind nginx and uses basic
// auth on its internal loopback.
//
// Ported from MediMind `services/pacs/dicomwebClient.ts` with auth swapped
// from Medplum JWT → Cognito JWT and the base URL driven by
// `import.meta.env.VITE_DICOM_WEB_BASE` (default
// http://localhost:8042/dicom-web). A tenant-id header is added for
// multi-tenant routing in the edge proxy.
// ============================================================================

import { captureException } from '../observability/sentryInit';

// ============================================================================
// Error Types
// ============================================================================

export class DicomWebError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string
  ) {
    super(message);
    this.name = 'DicomWebError';
  }
}

export class DicomWebAuthError extends DicomWebError {
  constructor(endpoint: string) {
    super(
      'Authentication failed — token may be expired. Please log in again.',
      401,
      endpoint
    );
    this.name = 'DicomWebAuthError';
  }
}

export class DicomWebNotFoundError extends DicomWebError {
  constructor(endpoint: string) {
    super('The requested DICOM resource was not found.', 404, endpoint);
    this.name = 'DicomWebNotFoundError';
  }
}

export class DicomWebUnavailableError extends DicomWebError {
  constructor(endpoint: string, statusCode = 503) {
    super('PACS server is unavailable. Please try again later.', statusCode, endpoint);
    this.name = 'DicomWebUnavailableError';
  }
}

// ============================================================================
// Types
// ============================================================================

/** DICOM JSON is an array of tag objects. Typed loosely — callers cast. */
export type DicomJsonObject = Record<string, DicomJsonTag>;
export interface DicomJsonTag {
  vr: string;
  Value?: Array<string | number | DicomJsonObject>;
}

// ============================================================================
// DICOM JSON type guards (ported from MediMind for the advanced-viewer port —
// usePACSViewer narrows unknown QIDO/WADO payloads through these).
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDicomJsonTag(value: unknown): value is DicomJsonTag {
  if (!isRecord(value) || typeof value.vr !== 'string') return false;
  return value.Value === undefined || Array.isArray(value.Value);
}

/** Type guard: is this value a DICOM JSON object (tag-keyed record)? */
export function isDicomJsonObject(value: unknown): value is DicomJsonObject {
  return isRecord(value) && Object.values(value).every(isDicomJsonTag);
}

export interface StudySearchParams {
  /** DICOM PatientID */
  patientId?: string;
  /** Accession number (ACC-YYYY-NNNNNN in LiverRa) */
  accessionNumber?: string;
  /** Study date or date range (YYYYMMDD or YYYYMMDD-YYYYMMDD) */
  studyDate?: string;
  /** Modality filter (e.g., 'CT', 'MR') */
  modalitiesInStudy?: string;
  limit?: number;
  offset?: number;
}

export interface SeriesSearchParams {
  modality?: string;
}

export interface StowResult {
  successCount: number;
  failedCount: number;
  failures: string[];
}

/**
 * Options for creating a DicomWebClient.
 */
export interface DicomWebClientOptions {
  /**
   * Base URL for DICOMweb — e.g. `http://localhost:8042/dicom-web` in local
   * dev, or `https://pacs.liverra.ai/dicom-web` in cloud. Defaults to
   * `import.meta.env.VITE_DICOM_WEB_BASE` or `/dicom-web`.
   */
  baseUrl?: string;
  /**
   * Callback that returns the current Cognito JWT access token, or null if
   * the user is signed out. Called on every request so the token stays
   * fresh across silent refreshes.
   */
  getAccessToken: () => string | null;
  /**
   * Callback that returns the current tenant ID (LiverRa is multi-tenant
   * per hospital). Added as the `X-LiverRa-Tenant` header so the edge
   * proxy can route to the correct Orthanc partition. Optional — if
   * omitted or returning null, the header is not sent and the proxy
   * falls back to the tenant claim on the JWT.
   */
  getTenantId?: () => string | null;
}

// ============================================================================
// UID Validation (security: prevents path traversal via crafted UIDs)
// ============================================================================

/**
 * DICOM UIDs (UI Value Representation) must contain only digits and dots,
 * and be at most 64 characters. A malicious UID like "1.2.3/../admin" could
 * let an attacker traverse paths on the server. This function blocks that.
 */
export function validateDicomUid(uid: string, fieldName: string): void {
  if (!uid) {
    throw new Error(`${fieldName} is required and cannot be empty`);
  }
  if (uid.length > 64) {
    throw new Error(
      `${fieldName} exceeds maximum DICOM UID length of 64 characters`
    );
  }
  if (!/^[\d.]+$/.test(uid)) {
    throw new Error(
      `${fieldName} contains invalid characters — DICOM UIDs may only contain digits and dots`
    );
  }
}

// ============================================================================
// Default base URL — read at module init from Vite env.
// ============================================================================

/**
 * Default DICOMweb base URL read from Vite env. Can be overridden per
 * client via `DicomWebClientOptions.baseUrl`.
 */
function resolveDefaultBaseUrl(): string {
  try {
    const envBase = (import.meta as unknown as {
      env?: { VITE_DICOM_WEB_BASE?: string };
    }).env?.VITE_DICOM_WEB_BASE;
    if (envBase && envBase.trim().length > 0) {
      return envBase.trim();
    }
  } catch {
    // import.meta.env not available (e.g., during SSR/tests) — fall through
  }
  // Relative path: rides the Vite dev proxy in dev (configured in
  // vite.config.ts), and in prod it hits the same-origin nginx terminus that
  // validates Cognito JWT + forwards to Orthanc.
  return '/dicom-web';
}

// ============================================================================
// DICOMweb Client
// ============================================================================

/**
 * Client for DICOMweb QIDO-RS (search), WADO-RS (retrieve), and STOW-RS
 * (store) operations against LiverRa's clean-side Orthanc.
 *
 * Construct via the {@link createDicomWebClient} factory so the plumbing
 * (auth callback + tenant callback) is supplied explicitly — services are
 * non-React, so the calling hook (`useDicomWebClient`) injects the live
 * Cognito session.
 */
export class DicomWebClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => string | null;
  private readonly getTenantId: () => string | null;

  constructor(options: DicomWebClientOptions) {
    const base = options.baseUrl ?? resolveDefaultBaseUrl();
    this.baseUrl = base.replace(/\/+$/, '');
    this.getAccessToken = options.getAccessToken;
    this.getTenantId = options.getTenantId ?? (() => null);
  }

  // ==========================================================================
  // QIDO-RS — Search
  // ==========================================================================

  /**
   * Search for studies matching the given criteria.
   * Maps to: GET /studies?PatientID=...&AccessionNumber=...
   */
  async qidoStudies(
    params: StudySearchParams = {},
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]> {
    const queryParams = new URLSearchParams();

    if (params.patientId) queryParams.set('PatientID', params.patientId);
    if (params.accessionNumber) queryParams.set('AccessionNumber', params.accessionNumber);
    if (params.studyDate) queryParams.set('StudyDate', params.studyDate);
    if (params.modalitiesInStudy) queryParams.set('ModalitiesInStudy', params.modalitiesInStudy);
    if (params.limit !== undefined) queryParams.set('limit', String(params.limit));
    if (params.offset !== undefined) queryParams.set('offset', String(params.offset));

    const query = queryParams.toString();
    const url = `${this.baseUrl}/studies${query ? `?${query}` : ''}`;
    return this.fetchJson(url, signal);
  }

  /**
   * Search for series within a specific study.
   * Maps to: GET /studies/{studyUID}/series
   */
  async qidoSeries(
    studyInstanceUID: string,
    params?: SeriesSearchParams,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]> {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    const queryParams = new URLSearchParams();
    if (params?.modality) queryParams.set('Modality', params.modality);

    const query = queryParams.toString();
    const url = `${this.baseUrl}/studies/${studyInstanceUID}/series${query ? `?${query}` : ''}`;
    return this.fetchJson(url, signal);
  }

  /**
   * Search for instances within a specific series.
   * Maps to: GET /studies/{studyUID}/series/{seriesUID}/instances
   */
  async qidoInstances(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]> {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    validateDicomUid(seriesInstanceUID, 'seriesInstanceUID');
    const url = `${this.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances`;
    return this.fetchJson(url, signal);
  }

  // ==========================================================================
  // WADO-RS — Retrieve
  // ==========================================================================

  /**
   * Retrieve metadata for all series/instances in a study.
   * Maps to: GET /studies/{studyUID}/metadata
   */
  async retrieveStudyMetadata(
    studyInstanceUID: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]> {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    const url = `${this.baseUrl}/studies/${studyInstanceUID}/metadata`;
    return this.fetchJson(url, signal);
  }

  /**
   * Retrieve metadata for all instances in a series.
   * Maps to: GET /studies/{studyUID}/series/{seriesUID}/metadata
   */
  async retrieveSeriesMetadata(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]> {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    validateDicomUid(seriesInstanceUID, 'seriesInstanceUID');
    const url = `${this.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/metadata`;
    return this.fetchJson(url, signal);
  }

  /**
   * Build the URL for retrieving a specific DICOM instance frame.
   * Used by Cornerstone3D image loader to fetch pixel data.
   *
   * Returns: `wadors:{baseUrl}/studies/{study}/series/{series}/instances/{sop}/frames/{frame}`
   * The `wadors:` prefix tells Cornerstone3D to use its WADO-RS loader.
   *
   * @param frame - Frame number (1-based). Default 1 for single-frame.
   */
  wadoInstance(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    frame = 1
  ): string {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    validateDicomUid(seriesInstanceUID, 'seriesInstanceUID');
    validateDicomUid(sopInstanceUID, 'sopInstanceUID');
    return `wadors:${this.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frame}`;
  }

  /** Backward-compatible alias for wadoInstance(). */
  getInstanceUrl = this.wadoInstance.bind(this);

  // ==========================================================================
  // MediMind-compat aliases (advanced-viewer port). The ported PACSViewer /
  // usePACSViewer code calls the MediMind method names; LiverRa's qido* names
  // stay canonical. Pure delegation — no behavior difference.
  // ==========================================================================

  /** MediMind-compat alias for {@link qidoStudies}. */
  searchStudies = this.qidoStudies.bind(this);

  /** MediMind-compat alias for {@link qidoSeries}. */
  searchSeries = this.qidoSeries.bind(this);

  /** MediMind-compat alias for {@link qidoInstances}. */
  searchInstances = this.qidoInstances.bind(this);

  /**
   * Build the URL for a JPEG thumbnail of a specific instance.
   */
  getThumbnailUrl(
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string
  ): string {
    validateDicomUid(studyInstanceUID, 'studyInstanceUID');
    validateDicomUid(seriesInstanceUID, 'seriesInstanceUID');
    validateDicomUid(sopInstanceUID, 'sopInstanceUID');
    return `${this.baseUrl}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/rendered`;
  }

  /**
   * Get the current access token for use in custom fetch headers.
   * Useful when Cornerstone3D image loader needs auth headers.
   */
  getAuthToken(): string | null {
    return this.getAccessToken();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ==========================================================================
  // STOW-RS — Store
  // ==========================================================================

  /**
   * Upload DICOM files to the PACS server via STOW-RS (multipart/related POST).
   * Like putting a stack of X-ray films into a filing cabinet — each file is
   * wrapped in its own envelope and sent in one big package.
   *
   * H-PACS-7: previous implementation issued one STOW-RS request per file
   * sequentially. For a 500-file CT study over a 100 ms RTT link that's
   * 50 seconds of pure round-trip latency before any disk write. We now
   * fan out with a bounded concurrency pool (default 4 in-flight).
   *
   * M-PACS-2: when an individual file fails with a 401, we no longer
   * abort the entire batch (which leaves an unknown number of files
   * "in limbo"). The auth error is surfaced as part of the per-file
   * failure list AND counted against the batch, but the remaining files
   * continue. Caller can still detect "batch was 401-throttled" by
   * inspecting the failures array.
   */
  async stowInstances(files: File[], signal?: AbortSignal): Promise<StowResult> {
    if (files.length === 0) {
      return { successCount: 0, failedCount: 0, failures: [] };
    }

    const result: StowResult = { successCount: 0, failedCount: 0, failures: [] };
    const concurrency = 4; // tuned for typical hospital LAN; tune via env if needed.

    let nextIndex = 0;
    let authErrorCount = 0;
    const workers: Promise<void>[] = [];

    const takeOne = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        const idx = nextIndex++;
        if (idx >= files.length) return;
        const file = files[idx];
        try {
          const singleResult = await this.storeSingleInstance(file, signal);
          result.successCount += singleResult.successCount;
          result.failedCount += singleResult.failedCount;
          result.failures.push(...singleResult.failures);
        } catch (err) {
          if (signal?.aborted) return;
          if (err instanceof DicomWebAuthError) {
            // Auth errors deserve a category code rather than a bald
            // throw — otherwise a transient JWT expiry mid-batch
            // poisons every remaining file even if a silent refresh
            // could have recovered. We surface the file name as a
            // category-only label (already free of DICOM tag data).
            authErrorCount += 1;
            result.failedCount += 1;
            result.failures.push('auth_expired');
            continue;
          }
          result.failedCount += 1;
          // C-PACS-1: never embed filenames in the user-visible failure
          // list (filenames frequently contain patient identifiers like
          // "Smith_John_CT.dcm"). Surface the error message only, which
          // mapStowFailureReason has already categorized.
          result.failures.push(
            err instanceof Error ? err.message : 'upload_failed',
          );
        }
      }
    };

    for (let w = 0; w < Math.min(concurrency, files.length); w++) {
      workers.push(takeOne());
    }
    await Promise.all(workers);

    if (authErrorCount > 0 && authErrorCount === files.length) {
      // Whole batch was auth-rejected — caller probably wants to surface
      // a re-login prompt rather than "500 of 500 failed (auth_expired)".
      throw new DicomWebAuthError(`${this.baseUrl}/studies`);
    }
    return result;
  }

  /**
   * Upload a single DICOM file. Exposed at the factory level as
   * `stowInstance(file)` for convenience.
   */
  async stowInstance(file: File, signal?: AbortSignal): Promise<StowResult> {
    return this.storeSingleInstance(file, signal);
  }

  private async storeSingleInstance(file: File, signal?: AbortSignal): Promise<StowResult> {
    const boundary = `----DICOMweb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();

    const header = encoder.encode(`\r\n--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`);
    const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
    const fileData = new Uint8Array(await file.arrayBuffer());

    const body = new Uint8Array(header.length + fileData.length + footer.length);
    body.set(header, 0);
    body.set(fileData, header.length);
    body.set(footer, header.length + fileData.length);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/studies`, {
        method: 'POST',
        headers: this.buildHeaders({
          'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
        }),
        body,
        signal,
      });
    } catch {
      throw new DicomWebUnavailableError(`${this.baseUrl}/studies`);
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new DicomWebAuthError(`${this.baseUrl}/studies`);
      }
      throw new DicomWebError(
        `STOW-RS failed with status ${response.status}`,
        response.status,
        `${this.baseUrl}/studies`
      );
    }

    return this.parseStowResponse(response, 1);
  }

  /**
   * Parse a STOW-RS response. Supports JSON (application/dicom+json) and
   * XML (application/dicom+xml). Falls back to assuming success if the
   * body is empty (some servers do that on 200).
   */
  private async parseStowResponse(response: Response, totalFiles: number): Promise<StowResult> {
    try {
      const contentType = response.headers.get('Content-Type') || '';
      const responseText = await response.text();

      if (!responseText.trim()) {
        return { successCount: totalFiles, failedCount: 0, failures: [] };
      }

      if (contentType.includes('json')) {
        return this.parseStowJsonResponse(responseText, totalFiles);
      }
      if (contentType.includes('xml')) {
        return this.parseStowXmlResponse(responseText, totalFiles);
      }

      try {
        return this.parseStowJsonResponse(responseText, totalFiles);
      } catch {
        return this.parseStowXmlResponse(responseText, totalFiles);
      }
    } catch (err) {
      // Route through the PHI-scrubbing Sentry pipeline instead of raw
      // console — STOW-RS responses may contain patient metadata in error
      // bodies. Keep a dev-only console trace for local debugging.
      captureException(err, { source: 'dicomwebClient.parseStowResponse' });
      if (import.meta.env.DEV) {
        console.error('[STOW-RS] Failed to parse response — treating as upload failure:', err);
      }
      return {
        successCount: 0,
        failedCount: totalFiles,
        failures: [
          `Response parsing failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        ],
      };
    }
  }

  private parseStowJsonResponse(text: string, totalFiles: number): StowResult {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // Response body may contain PHI — scrub via Sentry pipeline rather
      // than logging raw previews. Keep dev-only console for local debug.
      captureException(err, { source: 'dicomwebClient.parseStowJsonResponse' });
      if (import.meta.env.DEV) {
        const preview = text.slice(0, 500);
        console.error('[STOW-RS] Invalid JSON response:', preview);
      }
      if (text.trimStart().startsWith('<')) {
        throw new Error(
          'Server returned an error page instead of data. Contact your administrator.'
        );
      }
      throw new Error('Received invalid response from imaging server.');
    }
    const dataset = Array.isArray(json) ? json[0] : json;

    // Tag 00081199 = ReferencedSOPSequence (successful)
    const referenced = dataset?.['00081199']?.Value || [];
    // Tag 00081198 = FailedSOPSequence (failed)
    const failed = dataset?.['00081198']?.Value || [];

    const failures = failed.map((item: DicomJsonObject) => {
      // Tag 00081197 = FailureReason
      const reasonCode = item?.['00081197']?.Value?.[0];
      return mapStowFailureReason(reasonCode as number | undefined);
    });

    const successCount = referenced.length || totalFiles - failed.length;
    return { successCount, failedCount: failed.length, failures };
  }

  private parseStowXmlResponse(text: string, totalFiles: number): StowResult {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');

    const referencedElements = doc.querySelectorAll(
      'DicomAttribute[keyword="ReferencedSOPSequence"] > Item, [tag="00081199"] > Item'
    );
    const failedElements = doc.querySelectorAll(
      'DicomAttribute[keyword="FailedSOPSequence"] > Item, [tag="00081198"] > Item'
    );

    const failures: string[] = [];
    failedElements.forEach((item) => {
      const reasonEl = item.querySelector(
        'DicomAttribute[keyword="FailureReason"] > Value, [tag="00081197"] > Value'
      );
      const reasonCode = reasonEl?.textContent
        ? parseInt(reasonEl.textContent, 10)
        : undefined;
      failures.push(mapStowFailureReason(reasonCode));
    });

    const successCount =
      referencedElements.length || totalFiles - failedElements.length;
    return { successCount, failedCount: failedElements.length, failures };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Build request headers with auth + tenant context.
   * Always sends `Authorization: Bearer <cognito-jwt>` and, when a tenant
   * id is available, `X-LiverRa-Tenant: <tenant-id>`.
   */
  private buildHeaders(extra: Record<string, string> = {}): HeadersInit {
    const headers: Record<string, string> = { ...extra };
    const token = this.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const tenant = this.getTenantId();
    if (tenant) {
      headers['X-LiverRa-Tenant'] = tenant;
    }
    return headers;
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<DicomJsonObject[]> {
    // Note: we deliberately do NOT maintain an in-flight request dedup
    // cache here. Under React Strict Mode's mount→cleanup→remount cycle,
    // a dedup cache ends up handing the remount a stale aborted promise
    // from the first mount, which silently fails and leaves the viewer
    // with no image. TanStack Query already dedupes at the query-key
    // level for consumers that need it.
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return this.doFetch(url, signal);
  }

  private async doFetch(url: string, signal?: AbortSignal): Promise<DicomJsonObject[]> {
    let response: Response;

    try {
      response = await fetch(url, {
        headers: this.buildHeaders({ Accept: 'application/dicom+json' }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new DicomWebUnavailableError(url);
    }

    if (response.ok) {
      if (response.status === 204) {
        return [];
      }
      const text = await response.text();
      if (!text || text.trim() === '') {
        return [];
      }
      try {
        return JSON.parse(text) as DicomJsonObject[];
      } catch (err) {
        // Response body can include patient identifiers when Orthanc echoes
        // study data back on parse errors. Send through the PHI scrubber;
        // keep dev-only console for local triage.
        captureException(err, { source: 'dicomwebClient.doFetch', url });
        if (import.meta.env.DEV) {
          const preview = text.slice(0, 500);
          console.error('[DICOMweb] Invalid JSON response from', url, ':', preview);
        }
        if (text.trimStart().startsWith('<')) {
          throw new DicomWebError(
            'Server returned an error page instead of imaging data.',
            response.status,
            url
          );
        }
        throw new DicomWebError(
          'Received invalid response from imaging server.',
          response.status,
          url
        );
      }
    }

    switch (response.status) {
      case 401:
        throw new DicomWebAuthError(url);
      case 404:
        throw new DicomWebNotFoundError(url);
      case 500:
        throw new DicomWebUnavailableError(url, 500);
      case 503:
        throw new DicomWebUnavailableError(url);
      default:
        throw new DicomWebError(
          `DICOMweb request failed with status ${response.status}`,
          response.status,
          url
        );
    }
  }
}

// ============================================================================
// Factory (task T119 public surface)
// ============================================================================

/**
 * Shape returned by {@link createDicomWebClient}. Services/hooks consume this
 * as an opaque handle — the underlying `DicomWebClient` class is exported
 * too, but the factory keeps the call sites short and locks down the auth /
 * tenant-context wiring at construction time.
 */
export interface DicomWebClientHandle {
  qidoStudies(
    params?: StudySearchParams,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  qidoSeries(
    studyUid: string,
    params?: SeriesSearchParams,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  qidoInstances(
    studyUid: string,
    seriesUid: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  wadoInstance(
    studyUid: string,
    seriesUid: string,
    instanceUid: string,
    frame?: number
  ): string;
  retrieveStudyMetadata(
    studyUid: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  retrieveSeriesMetadata(
    studyUid: string,
    seriesUid: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  stowInstance(file: File, signal?: AbortSignal): Promise<StowResult>;
  stowInstances(files: File[], signal?: AbortSignal): Promise<StowResult>;
  getThumbnailUrl(studyUid: string, seriesUid: string, instanceUid: string): string;
  getAuthToken(): string | null;
  getBaseUrl(): string;
  // MediMind-compat aliases (advanced-viewer port) — delegate to the qido*/
  // wado* canonical methods above.
  searchStudies(
    params?: StudySearchParams,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  searchSeries(
    studyUid: string,
    params?: SeriesSearchParams,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  searchInstances(
    studyUid: string,
    seriesUid: string,
    signal?: AbortSignal
  ): Promise<DicomJsonObject[]>;
  getInstanceUrl(
    studyUid: string,
    seriesUid: string,
    instanceUid: string,
    frame?: number
  ): string;
}

/**
 * Create a DICOMweb client bound to the caller-supplied auth + tenant
 * callbacks. Services are non-React so this factory is how the React hook
 * layer (`useDicomWebClient`) wires in the live Cognito session.
 */
export function createDicomWebClient(options: DicomWebClientOptions): DicomWebClientHandle {
  const client = new DicomWebClient(options);

  return {
    qidoStudies: (params, signal) => client.qidoStudies(params, signal),
    qidoSeries: (studyUid, params, signal) => client.qidoSeries(studyUid, params, signal),
    qidoInstances: (studyUid, seriesUid, signal) =>
      client.qidoInstances(studyUid, seriesUid, signal),
    wadoInstance: (studyUid, seriesUid, instanceUid, frame) =>
      client.wadoInstance(studyUid, seriesUid, instanceUid, frame),
    retrieveStudyMetadata: (studyUid, signal) =>
      client.retrieveStudyMetadata(studyUid, signal),
    retrieveSeriesMetadata: (studyUid, seriesUid, signal) =>
      client.retrieveSeriesMetadata(studyUid, seriesUid, signal),
    stowInstance: (file, signal) => client.stowInstance(file, signal),
    stowInstances: (files, signal) => client.stowInstances(files, signal),
    getThumbnailUrl: (studyUid, seriesUid, instanceUid) =>
      client.getThumbnailUrl(studyUid, seriesUid, instanceUid),
    getAuthToken: () => client.getAuthToken(),
    getBaseUrl: () => client.getBaseUrl(),
    // MediMind-compat aliases (advanced-viewer port)
    searchStudies: (params, signal) => client.qidoStudies(params, signal),
    searchSeries: (studyUid, params, signal) => client.qidoSeries(studyUid, params, signal),
    searchInstances: (studyUid, seriesUid, signal) =>
      client.qidoInstances(studyUid, seriesUid, signal),
    getInstanceUrl: (studyUid, seriesUid, instanceUid, frame) =>
      client.wadoInstance(studyUid, seriesUid, instanceUid, frame),
  };
}

// ============================================================================
// STOW-RS Failure Reason Mapping
// ============================================================================

/**
 * Map DICOM STOW-RS failure reason codes to human-readable messages.
 * Codes defined in DICOM PS3.4 Table GG.4-1.
 */
function mapStowFailureReason(code: number | undefined): string {
  switch (code) {
    case 0x0110:
      return 'Processing failure — the PACS server could not process this file';
    case 0x0112:
      return 'Duplicate instance — this image already exists on the server';
    case 0x0122:
      return 'Missing required attribute — the DICOM file is incomplete';
    case 0x0124:
      return 'Unsupported attribute — the DICOM file contains unsupported data';
    case 0x0131:
      return 'Storage quota exceeded — the PACS server is out of storage space';
    case 0x0211:
      return 'Unrecognized operation — unsupported transfer syntax or format';
    case 0xa700:
      return 'Out of resources — the server ran out of memory or disk space';
    case 0xa900:
      return 'Data set does not match SOP class — wrong file type for this upload';
    case 0xc000:
      return 'Cannot understand — the DICOM file format is corrupted or invalid';
    default:
      return code
        ? `Upload failed (reason code: 0x${code.toString(16).toUpperCase().padStart(4, '0')})`
        : 'Upload failed (unknown reason)';
  }
}
