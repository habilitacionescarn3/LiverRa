/**
 * HTTP → UX error-mapping client (T406).
 *
 * Plain-English:
 *   Every non-2xx response from the FastAPI backend lands in
 *   handleApiError. We try to parse application/problem+json
 *   (RFC 7807) and then map the HTTP status + slug to a concrete
 *   UX action — open the step-up modal, show a toast, redirect,
 *   etc. The modal/toast components themselves subscribe to DOM
 *   CustomEvents we emit here — decoupled pub/sub keeps this
 *   file independent of React.
 *
 * References:
 *   - plan.md §Error Handling §Frontend error hierarchy
 *   - spec.md §FR-032a (never hint at cross-tenant existence)
 *   - ./api-client.ts → wire this as onError in createApiClient
 */
import { captureException, tagIncident } from './observability/sentryInit';

/** Slugs mirror ErrorSlug in packages/ml-inference/src/services/errors/catalog.py */
export type ErrorSlug =
  | 'not-found'
  | 'forbidden'
  | 'validation'
  | 'step-up-required'
  | 'seat-taken'
  | 'analysis-expired'
  | 'analysis-failed'
  | 'analysis-timeout'
  | 'analysis-implausible-output'
  | 'pacs-unreachable'
  | 'pacs-rejected'
  | 'ruo-acceptance-required'
  | 'license-hash-drift'
  | 'audit-write-failed'
  | 'scrubber-failed'
  | 'erasure-in-progress'
  | 'erasure-mfa-stale'
  | 'rate-limit-exceeded'
  | 'unknown';

export interface ProblemDetail {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  'x-tenant-id'?: string;
  'x-claim-key'?: string;
  errors?: Array<{ path: string; message: string }>;
  [extension: string]: unknown;
}

/** Strongly-typed error thrown after handleApiError maps the response. */
export class LiverraApiError extends Error {
  override readonly name = 'LiverraApiError';
  readonly status: number;
  readonly slug: ErrorSlug;
  readonly instance: string;
  readonly problem: ProblemDetail;
  constructor(problem: ProblemDetail, slug: ErrorSlug) {
    super(problem.detail || problem.title || `HTTP ${problem.status}`);
    this.status = problem.status;
    this.slug = slug;
    this.instance = problem.instance ?? crypto.randomUUID();
    this.problem = problem;
  }
}

/** DOM events our modals + banners subscribe to. */
export const LIVERRA_ERROR_EVENTS = {
  StepUpRequired: 'liverra:step-up-required',
  ConflictResolution: 'liverra:conflict-resolution',
  SessionTimeout: 'liverra:session-timeout',
  GenericToast: 'liverra:toast',
  RetryBanner: 'liverra:retry-banner',
  CaseErased: 'liverra:case-erased',
  PermissionDenied: 'liverra:permission-denied',
} as const;

function dispatchDomEvent(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    /* SSR / jest without jsdom */
  }
}

/** Extract the slug from a problem+json type URI. */
function parseSlug(problem: ProblemDetail): ErrorSlug {
  const t = problem.type ?? '';
  const m = /\/errors\/([a-z-]+)$/.exec(t);
  return (m?.[1] as ErrorSlug) ?? 'unknown';
}

async function readProblem(response: Response): Promise<ProblemDetail> {
  const fallback: ProblemDetail = {
    status: response.status,
    title: response.statusText,
    instance: response.headers.get('X-Request-ID') ?? crypto.randomUUID(),
  };
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/problem+json') && !contentType.includes('application/json')) {
    return fallback;
  }
  try {
    const body = (await response.clone().json()) as Partial<ProblemDetail>;
    return {
      ...body,
      status: body.status ?? response.status,
      instance: body.instance ?? fallback.instance,
    };
  } catch {
    return fallback;
  }
}

/** Jittered exponential back-off for 429 / 5xx retries (100 ms → 6.4 s). */
export function backoffMs(attempt: number): number {
  const base = Math.min(100 * 2 ** attempt, 6400);
  const jitter = Math.random() * base * 0.3;
  return Math.floor(base + jitter);
}

export interface HandleApiErrorOptions {
  dispatch?: (name: string, detail: Record<string, unknown>) => void;
}

/**
 * Process a non-2xx Response — always throws.
 *
 * Behaviour by status:
 *   - 401 → emit step-up-required event + throw
 *   - 403 → emit permission-denied toast + Sentry capture
 *   - 404 → throw (renderer shows "Not found" per FR-032a)
 *   - 409 → emit conflict-resolution event
 *   - 410 → emit case-erased banner
 *   - 422 → throw so forms can read problem.errors
 *   - 429 → toast + retryAfter
 *   - 5xx → retry-banner event + Sentry capture
 */
export async function handleApiError(
  response: Response,
  options: HandleApiErrorOptions = {},
): Promise<never> {
  const emit = options.dispatch ?? dispatchDomEvent;
  const problem = await readProblem(response);
  const slug = parseSlug(problem);
  const apiError = new LiverraApiError(problem, slug);

  switch (response.status) {
    case 401:
      emit(LIVERRA_ERROR_EVENTS.StepUpRequired, {
        instance: apiError.instance,
        slug,
        returnTo: typeof window !== 'undefined' ? window.location.pathname : '/',
      });
      break;

    case 403:
      emit(LIVERRA_ERROR_EVENTS.GenericToast, {
        severity: 'error',
        messageKey: 'errors.requestAccess',
        instance: apiError.instance,
      });
      tagIncident(apiError.instance, apiError);
      captureException(apiError, { slug, status: response.status });
      break;

    case 404:
      // FR-032a: generic "Not found" shown upstream.
      break;

    case 409:
      emit(LIVERRA_ERROR_EVENTS.ConflictResolution, {
        instance: apiError.instance,
        slug,
        claimKey: problem['x-claim-key'],
      });
      break;

    case 410:
      emit(LIVERRA_ERROR_EVENTS.CaseErased, { instance: apiError.instance });
      break;

    case 422:
      // Surfaced to the form layer via problem.errors on the thrown error.
      break;

    case 429: {
      const header = response.headers.get('Retry-After');
      const retryAfterSec = header ? Number.parseInt(header, 10) : undefined;
      emit(LIVERRA_ERROR_EVENTS.GenericToast, {
        severity: 'warning',
        messageKey: 'errors.rateLimited',
        instance: apiError.instance,
        retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      });
      break;
    }

    default:
      if (response.status >= 500) {
        emit(LIVERRA_ERROR_EVENTS.RetryBanner, {
          instance: apiError.instance,
          slug,
          status: response.status,
        });
        tagIncident(apiError.instance, apiError);
        captureException(apiError, { slug, status: response.status });
      }
      break;
  }

  throw apiError;
}

export default { handleApiError, LiverraApiError, LIVERRA_ERROR_EVENTS, backoffMs };
