// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * DemoRouteRegistration (T440).
 *
 * Plain-English: declarative `/demo-case` route + Help-menu entry.
 * Consumed by `AppRoutes.tsx` and the Help nav renderer. Visible to all
 * roles per SC-013 (re-runnable demo from Help).
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import { DemoCaseRunnerView, lazyLoaders } from '../../views/lazy-registry';
import type { NavEntry } from './AdminNavEntries';

export interface DemoRouteDef {
  path: string;
  labelKey: string;
  iconName: string;
  load: () => Promise<{ default: ComponentType<unknown> }>;
  Component: LazyExoticComponent<ComponentType<unknown>>;
}

// `load` + `Component` are sourced from `views/lazy-registry.ts` so the
// `AppRoutes.tsx` reference and this registration share the same
// `import()` call site (Vite emits one chunk instead of two).
export const DEMO_ROUTE: DemoRouteDef = {
  path: '/demo-case',
  labelKey: 'onboarding:demo.navLabel',
  iconName: 'IconFlask',
  load: lazyLoaders.demoCaseRunnerView,
  Component: DemoCaseRunnerView,
};

export const DEMO_NAV_ENTRY: NavEntry = {
  id: DEMO_ROUTE.path,
  path: DEMO_ROUTE.path,
  labelKey: DEMO_ROUTE.labelKey,
  iconName: DEMO_ROUTE.iconName,
  requires: [],
  group: 'help',
};
