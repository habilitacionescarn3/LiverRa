// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ProtectedRoute (T102).
 *
 * Plain-English: wraps a route so that (a) the user must be signed in and
 * (b) they must hold every permission in `requires`. If they aren't signed
 * in, we redirect to /signin with a returnTo. If they ARE signed in but
 * missing a permission, we redirect to /404 (not 403) — FR-032a: a 403
 * would leak "this resource exists in another tenant", so we pretend it
 * doesn't exist at all).
 *
 * Analogy: the velvet rope at a club. No ticket → box office (sign-in).
 * Wrong ticket tier → "sorry, wrong address" (404) rather than "this
 * floor is above your pay grade" (403).
 *
 * Port of MediMind's ProtectedRoute, rewritten for LiverRa's typed
 * permission union + 404-on-deny semantics.
 *
 * Spec references: T102, plan.md §477-484, FR-032a.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import type { LiverraPermission } from '../../constants/permissions.gen';
import { LIVERRA_ROUTES } from '../../constants/routes';
import { usePermissions, usePermissionsLoading } from '../../contexts/PermissionContext';
import { useAuth } from '../../services/auth';

export interface ProtectedRouteProps {
  /**
   * Permissions the user must hold (AND semantics). Omit for routes that
   * only require an authenticated session.
   */
  requires?: readonly LiverraPermission[];
  children: ReactNode;
}

export function ProtectedRoute({ requires, children }: ProtectedRouteProps): JSX.Element | null {
  const location = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  const permissions = usePermissions();
  const permsLoading = usePermissionsLoading();

  // While either auth or permissions are still hydrating, render nothing
  // rather than bouncing the user away. The root `<Suspense fallback>` in
  // the router handles the visual placeholder.
  if (authLoading || permsLoading) {
    return null;
  }

  // Not signed in → /signin?returnTo=<current URL>. Preserving the query +
  // hash so deep-links work after login.
  if (!user) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);
    return <Navigate to={`${LIVERRA_ROUTES.SIGNIN}?returnTo=${returnTo}`} replace />;
  }

  // Signed in but missing permissions → 404 (never 403; see FR-032a).
  if (requires && requires.length > 0) {
    const hasAll = requires.every((perm) => permissions.has(perm));
    if (!hasAll) {
      return <Navigate to={LIVERRA_ROUTES.NOT_FOUND} replace />;
    }
  }

  return <>{children}</>;
}

export default ProtectedRoute;
