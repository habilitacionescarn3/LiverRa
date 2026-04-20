// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * onboarding/telemetry (T308).
 *
 * Plain-English: tiny PostHog wrapper used by every wizard step to
 * emit `onboarding_step_started` + `onboarding_step_completed` events.
 * Fail-safe: if PostHog is not loaded (e.g. in tests), we log to the
 * console and move on.
 */
export type OnboardingStepName =
  | 'password'
  | 'mfa'
  | 'ruo'
  | 'tour'
  | 'sample_case';

export type OnboardingStepOutcome =
  | 'started'
  | 'completed'
  | 'completed_sso'
  | 'skipped'
  | 'failed';

interface PostHogLike {
  capture?: (event: string, props?: Record<string, unknown>) => void;
}

export function trackOnboardingStep(
  step: OnboardingStepName,
  outcome: OnboardingStepOutcome,
  props: Record<string, unknown> = {},
): void {
  const ph = (globalThis as unknown as { posthog?: PostHogLike }).posthog;
  const eventName = outcome === 'started' ? 'onboarding_step_started' : 'onboarding_step_completed';
  try {
    if (ph?.capture) {
      ph.capture(eventName, { step, outcome, ...props });
    } else if (typeof console !== 'undefined') {
      console.debug('[telemetry]', eventName, { step, outcome, ...props });
    }
  } catch {
    // swallow — telemetry must never block the wizard
  }
}
