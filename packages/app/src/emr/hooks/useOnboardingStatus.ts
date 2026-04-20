// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * useOnboardingStatus (T306).
 *
 * Plain-English: gates access across the whole app. If the current
 * user has not yet accepted RUO terms OR enrolled MFA, we force them
 * back to ``/onboarding`` — with the exception of ``/onboarding/*``
 * and ``/auth/*`` paths so they can actually complete the wizard.
 *
 * Shape:
 *   - `status` — the full onboarding state from /auth/me/onboarding-status
 *   - `loading` — initial fetch state
 *   - `blocked` — true if current path requires redirect
 *   - `redirectTo` — where ProtectedRouteOnboardingGate should send them
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

export interface OnboardingStatus {
  user_id: string;
  tenant_id: string;
  ruo_accepted_at: string | null;
  mfa_enrolled_at: string | null;
  sample_case_run_at: string | null;
  tour_completed_at: string | null;
  completed: boolean;
}

const EXEMPT_PREFIXES = ['/onboarding', '/auth', '/404'];

export interface UseOnboardingStatusResult {
  status: OnboardingStatus | null;
  loading: boolean;
  error: Error | null;
  blocked: boolean;
  redirectTo: string | null;
  refresh: () => void;
}

export function useOnboardingStatus(): UseOnboardingStatusResult {
  const location = useLocation();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch('/api/v1/auth/me/onboarding-status', { credentials: 'include' })
      .then((r) => {
        if (r.status === 401) return null; // unauthenticated — separate flow
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<OnboardingStatus>;
      })
      .then((data) => {
        if (!cancelled) setStatus(data ?? null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const { blocked, redirectTo } = useMemo(() => {
    if (!status) return { blocked: false, redirectTo: null };
    const exempt = EXEMPT_PREFIXES.some((p) => location.pathname.startsWith(p));
    if (exempt) return { blocked: false, redirectTo: null };
    if (!status.ruo_accepted_at || !status.mfa_enrolled_at) {
      return { blocked: true, redirectTo: '/onboarding' };
    }
    return { blocked: false, redirectTo: null };
  }, [status, location.pathname]);

  return {
    status,
    loading,
    error,
    blocked,
    redirectTo,
    refresh: () => setReloadKey((n) => n + 1),
  };
}
