// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Lazy view registry.
 *
 * Plain-English: a single “coat closet” for lazy-loaded views that are
 * referenced from more than one place (the main router AND a nav /
 * registration file). If two files each call `React.lazy(() => import('X'))`
 * for the same module, Vite/Rollup cannot deduplicate them and emits two
 * tiny per-call-site chunks. Declaring the `lazy()` + its `import()` factory
 * once here gives us ONE chunk per view.
 *
 * Consumed by:
 *   - `AppRoutes.tsx` (router element)
 *   - `emr/components/nav/AdminRouteRegistrations.ts` (admin console metadata)
 *   - `emr/components/nav/DemoRouteRegistration.ts` (help-menu demo entry)
 *
 * Only views that are referenced from more than one module belong here.
 * Views used by a single module should keep their local `lazy()` in that
 * module.
 */

import type { ComponentType, LazyExoticComponent } from 'react';
import { lazy } from 'react';

type Loader<T = unknown> = () => Promise<{ default: ComponentType<T> }>;

const loadUserManagementView: Loader = () => import('./admin/UserManagementView');
const loadPacsConfigView: Loader = () => import('./admin/PacsConfigView');
const loadAuditBrowserView: Loader = () => import('./admin/AuditBrowserView');
const loadDemoCaseRunnerView: Loader = () => import('./demo/DemoCaseRunnerView');

/** Single-source `import()` factories — re-export so registrations can
 *  hand one to React Router / preloaders without re-declaring the import. */
export const lazyLoaders = {
  userManagementView: loadUserManagementView,
  pacsConfigView: loadPacsConfigView,
  auditBrowserView: loadAuditBrowserView,
  demoCaseRunnerView: loadDemoCaseRunnerView,
} as const;

/** Single-source `React.lazy()` wrappers — every consumer imports the
 *  SAME LazyExoticComponent so Vite emits one chunk per view. */
export const UserManagementView: LazyExoticComponent<ComponentType<unknown>> =
  lazy(loadUserManagementView);
export const PacsConfigView: LazyExoticComponent<ComponentType<unknown>> =
  lazy(loadPacsConfigView);
export const AuditBrowserView: LazyExoticComponent<ComponentType<unknown>> =
  lazy(loadAuditBrowserView);
export const DemoCaseRunnerView: LazyExoticComponent<ComponentType<unknown>> =
  lazy(loadDemoCaseRunnerView);
