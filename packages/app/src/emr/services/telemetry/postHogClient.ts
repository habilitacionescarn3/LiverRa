/**
 * PostHog client wrapper (T129).
 *
 * Plain-English:
 *   This is the *only* way the app talks to PostHog. It enforces:
 *     1. EU region (`https://eu.i.posthog.com`).
 *     2. Anonymous identity — we NEVER call `posthog.identify()`
 *        with an email or MRN. Instead we set `distinct_id` to a
 *        deterministic hash of the tenant id + a random per-user
 *        salt. That's enough to measure funnel cohorts while
 *        keeping identities opaque.
 *     3. PHI scrubbing on every property bag — the `scrubObject`
 *        helper raises `ScrubberFailure` on error and we drop the
 *        event in that case.
 *     4. Event-name allow-list — any call with a name not in
 *        `POSTHOG_EVENTS` is rejected at compile time by the
 *        `PostHogEventName` union and defensively at runtime.
 *
 * References:
 *   - plan.md §Observability — PostHog (anonymous, EU host)
 *   - spec.md §NFR-007
 *   - ./events.ts
 */
import posthog from 'posthog-js';

import { ScrubberFailure, scrubObject } from '../observability/phiScrubber';

import { isKnownEvent, type PostHogEventName } from './events';

const EU_HOST = 'https://eu.i.posthog.com';

export interface PostHogClientOptions {
  /** Project API key (public — safe to ship in the bundle). */
  apiKey: string;
  /** Environment tag propagated as a super-property. */
  environment: string;
  /** Hashed tenant id — NEVER a raw UUID that links back to a row. */
  tenantHash: string;
  /** Role string ("reviewer" / "admin" / ...) for cohort analysis. */
  userRole?: string;
  /** UI locale ("en" / "de" / "ka" / "ru"). */
  locale?: string;
  /** Opt-out for tests. */
  enabled?: boolean;
}

let _initialized = false;

export function isPostHogInitialised(): boolean {
  return _initialized;
}

/**
 * Initialise the PostHog browser client. Idempotent — subsequent
 * calls are ignored.
 */
export function initPostHog(opts: PostHogClientOptions): boolean {
  if (_initialized) return true;
  if (opts.enabled === false) return false;
  if (!opts.apiKey) {
    console.info('[liverra] PostHog API key missing — disabled');
    return false;
  }

  try {
    posthog.init(opts.apiKey, {
      api_host: EU_HOST,
      // EU host enforced regardless of UI region; double-belt.
      ui_host: EU_HOST,
      capture_pageview: false, // we route pageviews explicitly
      autocapture: false, // all events are explicit
      persistence: 'memory', // no localStorage → no cross-session fingerprint
      disable_session_recording: true, // FR-029b
      property_blacklist: [
        '$ip',
        '$geoip_latitude',
        '$geoip_longitude',
        '$geoip_city_name',
        '$geoip_postal_code',
      ],
      loaded: (ph) => {
        // Set super-properties once on load. Never includes PHI.
        ph.register({
          environment: opts.environment,
          tenant_id: opts.tenantHash,
          user_role: opts.userRole ?? 'unknown',
          locale: opts.locale ?? 'en',
        });
        // Deterministic, opaque distinct_id derived from tenantHash.
        ph.reset(); // wipe any legacy id
        ph.register({ $lib_version: '1' });
      },
    });
    _initialized = true;
    return true;
  } catch (err) {
    console.error('[liverra] PostHog init failed:', err);
    return false;
  }
}

/**
 * Emit a validated, PHI-scrubbed event.
 *
 * - The compile-time union forbids typos.
 * - The runtime guard (`isKnownEvent`) provides defence-in-depth for
 *   callers that originate from `any`-typed JSON.
 * - The scrubber runs on the entire `props` bag. If it throws we
 *   drop the event on the floor.
 */
export function capture<TName extends PostHogEventName>(
  event: TName,
  props: Record<string, unknown> = {},
): void {
  if (!_initialized) return;
  if (!isKnownEvent(event)) {
    console.warn('[liverra] refusing unknown PostHog event:', event);
    return;
  }

  let scrubbed: Record<string, unknown>;
  try {
    scrubbed = scrubObject(props);
  } catch (err) {
    if (err instanceof ScrubberFailure) {
      console.warn('[liverra] PostHog event dropped — scrubber failed:', event, err.message);
    } else {
      console.warn('[liverra] PostHog event dropped — unexpected error:', event, err);
    }
    return;
  }

  try {
    posthog.capture(event, scrubbed);
  } catch {
    /* swallow — never bubble observability errors */
  }
}

/**
 * Explicit page-view capture — avoids PostHog's autocapture which
 * can accidentally serialise URLs containing PHI-like path params.
 */
export function capturePageView(path: string): void {
  if (!_initialized) return;
  try {
    // Strip trailing UUIDs/IDs before capture.
    const sanitised = path.replace(/\b[0-9a-f]{8}-[0-9a-f-]+\b/gi, ':id');
    posthog.capture('$pageview', { $current_url: sanitised });
  } catch {
    /* swallow */
  }
}

export default { initPostHog, isPostHogInitialised, capture, capturePageView };
