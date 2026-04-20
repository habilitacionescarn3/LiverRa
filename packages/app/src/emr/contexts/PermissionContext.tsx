// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PermissionContext (T099).
 *
 * Plain-English: this is the bouncer's clipboard. The bouncer
 * (`<ProtectedRoute>`, `<RequirePermission>`, action buttons) asks
 * "does this user have permission X?" and the clipboard answers yes/no
 * without every component having to re-fetch the list of permissions.
 *
 * Wiring:
 *   - `AuthContext` (T116) is the owner of `permissions: string[]`.
 *     `PermissionProvider` reads the array from `useAuth()` and stores it
 *     in a `Set<LiverraPermission>` for O(1) membership checks.
 *   - `useHasPermission(perm)` / `usePermissions()` are the only hooks
 *     UI code should call. Both throw if rendered outside a provider so
 *     permission bugs surface immediately instead of silently allowing.
 *
 * Spec references: T099, plan.md §391-402, §477-484 (Frontend RBAC wiring).
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import type { LiverraPermission } from '../constants/permissions.gen';
import { useAuth } from '../services/auth';

interface PermissionContextValue {
  /** Set of all permissions the current user has in the active tenant. */
  permissions: ReadonlySet<LiverraPermission>;
  /** `true` while the initial `/auth/me` fetch is in-flight. */
  isLoading: boolean;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

interface PermissionProviderProps {
  children: ReactNode;
}

/**
 * Provider. Mount under `<AuthProvider>` so `useAuth()` resolves.
 *
 * See plan.md §117 provider nesting:
 *   AuthProvider → **PermissionProvider** → ThemeProvider → ...
 */
export function PermissionProvider({ children }: PermissionProviderProps): JSX.Element {
  const { permissions, isLoading } = useAuth();

  const value = useMemo<PermissionContextValue>(
    () => ({
      // The server is the source of truth; cast is safe because the server
      // only emits values from `rbac_matrix.yaml` — the same file that
      // generates the `LiverraPermission` union.
      permissions: new Set(permissions) as ReadonlySet<LiverraPermission>,
      isLoading,
    }),
    [permissions, isLoading],
  );

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

/**
 * `useHasPermission('report.finalize')` → `true | false`.
 *
 * Throws if called outside a `<PermissionProvider>` — permission checks
 * MUST NOT silently default to `false` (could mask routing bugs) or `true`
 * (obviously unsafe). Fail loud + early.
 */
export function useHasPermission(perm: LiverraPermission): boolean {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('useHasPermission must be used inside <PermissionProvider>');
  }
  return ctx.permissions.has(perm);
}

/**
 * Access the raw permission set (read-only). Use sparingly — prefer
 * `useHasPermission` so the dependency surface in each component is
 * narrow + explicit.
 */
export function usePermissions(): ReadonlySet<LiverraPermission> {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('usePermissions must be used inside <PermissionProvider>');
  }
  return ctx.permissions;
}

/**
 * Returns `true` while permissions are still loading. Useful for gating
 * redirects in `<ProtectedRoute>` so the router doesn't bounce the user
 * away during the initial auth handshake.
 */
export function usePermissionsLoading(): boolean {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('usePermissionsLoading must be used inside <PermissionProvider>');
  }
  return ctx.isLoading;
}

/**
 * Compatibility hook matching the access-control + nav components'
 * expected shape. Returns `{ permissions, loading, isAuthenticated }`.
 *
 * Follows the same naming pattern as `useAuthContext()` and
 * `useReviewSeatContext()` elsewhere in the app.
 */
export interface PermissionContextSnapshot {
  permissions: ReadonlySet<LiverraPermission>;
  loading: boolean;
  isAuthenticated: boolean;
}

export function usePermissionContext(): PermissionContextSnapshot {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    throw new Error('usePermissionContext must be used inside <PermissionProvider>');
  }
  const { user } = useAuth();
  return {
    permissions: ctx.permissions,
    loading: ctx.isLoading,
    isAuthenticated: user !== null,
  };
}
