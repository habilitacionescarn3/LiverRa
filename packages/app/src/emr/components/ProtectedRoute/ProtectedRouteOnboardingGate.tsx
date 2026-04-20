// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * ProtectedRouteOnboardingGate (T307).
 *
 * Plain-English: drop-in wrapper that blocks authenticated users from
 * reaching the main app until they have completed RUO + MFA. Used by
 * `AppRoutes.tsx` — it wraps the children of `<ProtectedRoute>` so
 * every protected screen respects the same onboarding gate.
 *
 * If the current URL is itself under `/onboarding` or `/auth`, we
 * render the children immediately (otherwise the wizard could not
 * reach its own routes).
 */
import type { ReactNode, ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';

export interface ProtectedRouteOnboardingGateProps {
  children: ReactNode;
}

export function ProtectedRouteOnboardingGate({
  children,
}: ProtectedRouteOnboardingGateProps): ReactElement {
  const { blocked, redirectTo, loading } = useOnboardingStatus();
  if (loading) return <>{children}</>;
  if (blocked && redirectTo) {
    return <Navigate to={redirectTo} replace />;
  }
  return <>{children}</>;
}

export default ProtectedRouteOnboardingGate;
