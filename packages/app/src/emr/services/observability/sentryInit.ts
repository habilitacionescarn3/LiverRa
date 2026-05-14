/**
 * Sentry (browser) initialiser (T127).
 *
 * Plain-English:
 *   Sentry watches the React app for errors and session replays.
 *   Before *any* event leaves the browser, we pipe it through our
 *   PHI scrubber (`phiScrubber.scrubObject`). If the scrubber throws
 *   (fail-closed per FR-029b) the event is dropped on the floor —
 *   never sent. A failed scrub is itself a serious signal, so the
 *   failure is logged locally; the Python counter
 *   `phi_scrubber_failed_total` is how ops learns about it.
 *
 * References:
 *   - spec.md §NFR-007 (observability PHI scrubbing)
 *   - plan.md §Observability Event Catalogue → Sentry captures
 *   - ./phiScrubber.ts (T069 browser port)
 */
import * as Sentry from '@sentry/react';

import { ScrubberFailure, scrubObject } from './phiScrubber';

export interface SentryInitOptions {
  /** DSN. The host component selects the EU region (e.g. `@o0.ingest.de.sentry.io`). */
  dsn: string;
  /** `dev` | `staging` | `prod`. */
  environment: string;
  /** Git SHA or semantic version of the current bundle. */
  release?: string;
  /** Sampling fractions — default 0.1 in production. */
  tracesSampleRate?: number;
  /** Session-replay sampling (all hits redacted by default). */
  replaysSessionSampleRate?: number;
  /** Replay sampling on error only — defaults to 1.0. */
  replaysOnErrorSampleRate?: number;
  /** Opt-out for tests. */
  enabled?: boolean;
}

let _initialized = false;

export function isSentryInitialised(): boolean {
  return _initialized;
}

/**
 * Sentry events are `Record<string, unknown>`-compatible — the PHI
 * scrubber needs to walk arbitrary nested data, but the Sentry SDK
 * itself returns a strongly-typed structure post-scrub. M-TYPE-2 fix:
 * declare the boundary type explicitly so the cast no longer lies.
 */
type ScrubableSentryEvent = Sentry.ErrorEvent & Record<string, unknown>;

/**
 * Wrap Sentry's `beforeSend` with PHI scrubbing.
 *
 * Returns the scrubbed event on success. Returns `null` on ANY
 * scrubber failure, which tells Sentry to drop the event.
 */
function makeBeforeSend(): NonNullable<Sentry.BrowserOptions['beforeSend']> {
  return (event, _hint) => {
    try {
      // M-TYPE-2 fix: the scrubber operates on the event as a
      // generic record (PHI keys can live anywhere in nested data),
      // but Sentry expects the same shape back. Using a single
      // intersection type (``ScrubableSentryEvent``) describes both
      // requirements without an ``as unknown`` cast chain.
      const scrubable = event as ScrubableSentryEvent;
      const scrubbed = scrubObject(scrubable) as ScrubableSentryEvent;
      return scrubbed;
    } catch (err) {
      if (err instanceof ScrubberFailure) {
        console.warn('[liverra] Sentry event dropped — PHI scrubber failed:', err.message);
      } else {
        console.warn('[liverra] Sentry event dropped — unexpected error:', err);
      }
      return null;
    }
  };
}

/**
 * Initialise the Sentry browser SDK.
 *
 * Idempotent: calling twice is a no-op.
 *
 * @returns `true` if Sentry was initialised, `false` otherwise
 *   (missing DSN, disabled explicitly, SDK threw).
 */
export function initSentry(opts: SentryInitOptions): boolean {
  if (_initialized) return true;
  if (opts.enabled === false) return false;
  if (!opts.dsn) {
    console.info('[liverra] Sentry DSN missing — disabled');
    return false;
  }

  try {
    Sentry.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      tracesSampleRate: opts.tracesSampleRate ?? 0.1,
      replaysSessionSampleRate: opts.replaysSessionSampleRate ?? 0.0,
      replaysOnErrorSampleRate: opts.replaysOnErrorSampleRate ?? 1.0,
      // Belt-and-suspenders with the scrubber:
      sendDefaultPii: false,
      beforeSend: makeBeforeSend(),
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({
          // Redact every text + media surface. The scrubber is the
          // authoritative PHI filter but we layer replay masking too.
          maskAllText: true,
          blockAllMedia: true,
          maskAllInputs: true,
        }),
      ],
    });
    _initialized = true;
    return true;
  } catch (err) {
    console.error('[liverra] Sentry init failed:', err);
    return false;
  }
}

/**
 * Report a caught exception manually. Safe to call pre-init (no-op).
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (!_initialized) return;
  try {
    Sentry.captureException(err, extra ? { extra } : undefined);
  } catch {
    /* swallow — never bubble observability errors */
  }
}

/**
 * Attach the `incident_id` surfaced from `application/problem+json`
 * as a searchable Sentry tag. The `errorClient` middleware calls this.
 */
export function tagIncident(incidentId: string, err?: unknown): void {
  if (!_initialized) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('incident_id', incidentId);
      if (err) Sentry.captureException(err);
    });
  } catch {
    /* swallow */
  }
}

export default { initSentry, isSentryInitialised, captureException, tagIncident };
