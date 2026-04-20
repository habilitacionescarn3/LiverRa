// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PermissionGate — conditional rendering by permission (T098).
 *
 * Plain-English: wraps any JSX. Renders children if user has the required
 * permission(s); otherwise renders fallback (null by default).
 *
 * Supports AND (`mode="all"`, default) and OR (`mode="any"`) evaluation of
 * multiple permission codes. Fail-closed: while the permission cache is
 * still loading, the gate renders the fallback.
 */

import type { ReactNode, ReactElement } from 'react';

import { useHasPermission, usePermissionContext } from '../../contexts/PermissionContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

export interface PermissionGateProps {
  /** Single permission code to check. */
  permission?: LiverraPermission;
  /** Multiple permission codes. */
  permissions?: LiverraPermission[];
  /** `all` = AND (default), `any` = OR. */
  mode?: 'all' | 'any';
  /** Rendered when denied (default null). */
  fallback?: ReactNode;
  /** Rendered when granted. */
  children: ReactNode;
}

export function PermissionGate({
  permission,
  permissions,
  mode = 'all',
  fallback = null,
  children,
}: PermissionGateProps): ReactElement {
  const { loading } = usePermissionContext();
  const codes: LiverraPermission[] = permissions ?? (permission ? [permission] : []);

  // Stable hook order — call for every code in the list.
  const results = codes.map((code) => useHasPermission(code));

  if (codes.length === 0) {
    return <>{children}</>;
  }

  if (loading) {
    return <>{fallback}</>;
  }

  const hasAccess = mode === 'all' ? results.every(Boolean) : results.some(Boolean);
  return <>{hasAccess ? children : fallback}</>;
}

export default PermissionGate;
