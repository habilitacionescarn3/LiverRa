/**
 * PostHog event catalogue (T128).
 *
 * Plain-English:
 *   Every product-analytics event the app can emit is named here as
 *   a compile-time constant. This prevents silent typos (a string
 *   like `"upload-started"` vs `"upload_started"`) and gives ops a
 *   single source of truth when building dashboards.
 *
 *   The list below is mirrored in the server-side "allow-list" used
 *   by the PostHog ingest proxy. A new event type requires a PR that
 *   touches both sides — that friction is deliberate (FR-038 audit
 *   trail discipline, plan.md §Telemetry event catalog).
 *
 * References:
 *   - plan.md §Telemetry event catalog
 *   - spec.md §NFR-007 (observability — EU-hosted, anonymous)
 */

/** Union of every PostHog event name the frontend may emit. */
export type PostHogEventName =
  | 'upload_started'
  | 'upload_completed'
  | 'analysis_queued'
  | 'analysis_completed'
  | 'plane_dragged'
  | 'lesion_clicked'
  | 'refinement_click'
  | 'finalize_started'
  | 'finalize_completed'
  | 'pacs_push_attempted'
  | 'pacs_push_failed'
  | 'report_viewed'
  | 'report_downloaded'
  | 'auth_signin'
  | 'auth_signout'
  | 'session_timeout'
  | 'seat_acquired'
  | 'seat_released'
  | 'config_changed'
  | 'erasure_requested'
  | 'ruo_disclaimer_acknowledged'
  | 'acr_readout_viewed'
  | 'acr_clipboard_copy_succeeded'
  | 'acr_clipboard_copy_failed'
  | 'acr_pdf_section_rendered'
  | 'acr_copy_tooltip_seen'
  | 'acr_copy_tooltip_dismissed';

/**
 * Runtime-readable array of every valid event name. The PostHog
 * client (`postHogClient.ts`) uses this to assert at call-site that
 * a caller did not pass an ad-hoc string.
 */
export const POSTHOG_EVENTS = [
  'upload_started',
  'upload_completed',
  'analysis_queued',
  'analysis_completed',
  'plane_dragged',
  'lesion_clicked',
  'refinement_click',
  'finalize_started',
  'finalize_completed',
  'pacs_push_attempted',
  'pacs_push_failed',
  'report_viewed',
  'report_downloaded',
  'auth_signin',
  'auth_signout',
  'session_timeout',
  'seat_acquired',
  'seat_released',
  'config_changed',
  'erasure_requested',
  'ruo_disclaimer_acknowledged',
  'acr_readout_viewed',
  'acr_clipboard_copy_succeeded',
  'acr_clipboard_copy_failed',
  'acr_pdf_section_rendered',
  'acr_copy_tooltip_seen',
  'acr_copy_tooltip_dismissed',
] as const satisfies readonly PostHogEventName[];

/** Return true if `event` is a recognised PostHog event name. */
export function isKnownEvent(event: string): event is PostHogEventName {
  return (POSTHOG_EVENTS as readonly string[]).includes(event);
}
