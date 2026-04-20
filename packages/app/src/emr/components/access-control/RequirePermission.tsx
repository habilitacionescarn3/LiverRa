// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RequirePermission — LiverRa RBAC route guard (T098).
 *
 * Plain-English: a door-keeper for routes. If the current user holds the
 * required permission, it renders the children. If not, it redirects
 * (default: 404 so we don't leak the route's existence — see FR-032a) or
 * shows a fallback node.
 *
 * Ported from MediMind but re-wired to LiverRa's single
 * `useHasPermission(perm: LiverraPermission)` hook from
 * `contexts/PermissionContext` (defined by sibling T099).
 */

import type { ReactNode, ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { Center, Loader } from '@mantine/core';

import { useHasPermission, usePermissionContext } from '../../contexts/PermissionContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

export interface RequirePermissionProps {
  /** Single permission code required. */
  permission?: LiverraPermission;
  /** Multiple permissions — user must have ALL of them (AND logic). */
  permissions?: LiverraPermission[];
  /** Where to redirect if denied. Default: `/404` (avoid leaking route existence per FR-032a). */
  redirectTo?: string;
  /** Children rendered when permission granted. */
  children: ReactNode;
  /** Show loading spinner while permissions are loading (default true). */
  showLoading?: boolean;
  /** Fallback content to render instead of redirecting. */
  fallback?: ReactNode;
}

/**
 * Fail-closed route guard. If the permission cache is still loading and
 * `showLoading` is false, we treat the user as denied. Never "default allow".
 */
export function RequirePermission({
  permission,
  permissions,
  redirectTo = '/404',
  children,
  showLoading = true,
  fallback,
}: RequirePermissionProps): ReactElement {
  const { loading, isAuthenticated } = usePermissionContext();
  const permissionCodes: LiverraPermission[] = permissions ?? (permission ? [permission] : []);

  // Call the hook for every code so hook order stays stable across renders.
  const results = permissionCodes.map((code) => useHasPermission(code));
  const hasAllPermissions = results.every(Boolean);

  if (!isAuthenticated) {
    return <Navigate to="/signin" replace />;
  }

  if (loading && showLoading) {
    return (
      <Center h={200}>
        <Loader size="lg" />
      </Center>
    );
  }

  if (permissionCodes.length === 0 || hasAllPermissions) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }
  return <Navigate to={redirectTo} replace />;
}

export default RequirePermission;
