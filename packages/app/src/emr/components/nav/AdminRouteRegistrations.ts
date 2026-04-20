// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * AdminRouteRegistrations (T292).
 *
 * Plain-English: declarative list of admin routes + their required
 * permissions. Consumed by `AppRoutes.tsx` so admin routes register
 * themselves without touching the core router file. Each entry is a
 * lazy-loadable view so the admin console stays out of the initial
 * bundle.
 *
 * Shape: every entry includes `path`, `permission` (must match the
 * AWS Cognito claim → RBAC registry), and a dynamic-import factory.
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { LiverraPermission } from '../../constants/permissions.gen';
import {
  AuditBrowserView,
  PacsConfigView,
  UserManagementView,
  lazyLoaders,
} from '../../views/lazy-registry';

export interface AdminRouteDef {
  path: string;
  permission: LiverraPermission;
  /** Translation key for menu / breadcrumb label. */
  labelKey: string;
  /** Optional icon name from @tabler/icons-react. */
  iconName?: string;
  load: () => Promise<{ default: ComponentType<unknown> }>;
  Component: LazyExoticComponent<ComponentType<unknown>>;
}

function r(
  path: string,
  permission: LiverraPermission,
  labelKey: string,
  iconName: string,
  load: () => Promise<{ default: ComponentType<unknown> }>,
  Component: LazyExoticComponent<ComponentType<unknown>>,
): AdminRouteDef {
  return {
    path,
    permission,
    labelKey,
    iconName,
    load,
    Component,
  };
}

/** Admin console route table (T292).
 *  `load` + `Component` are sourced from `views/lazy-registry.ts` so both
 *  this module and `AppRoutes.tsx` share the same `import()` call sites —
 *  Vite emits one chunk per view instead of one per reference. */
export const ADMIN_ROUTES: AdminRouteDef[] = [
  r(
    '/admin/users',
    'admin.view_audit' as LiverraPermission,
    'admin:nav.users',
    'IconUsers',
    lazyLoaders.userManagementView,
    UserManagementView,
  ),
  r(
    '/admin/pacs-config',
    'admin.configure_pacs' as LiverraPermission,
    'admin:nav.pacs',
    'IconPlug',
    lazyLoaders.pacsConfigView,
    PacsConfigView,
  ),
  r(
    '/admin/audit',
    'admin.view_audit' as LiverraPermission,
    'admin:nav.audit',
    'IconHistory',
    lazyLoaders.auditBrowserView,
    AuditBrowserView,
  ),
];

export default ADMIN_ROUTES;
