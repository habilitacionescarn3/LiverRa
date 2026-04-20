// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Breadcrumbs — LiverRa route breadcrumbs (T109).
 *
 * Plain-English: reads the currently matched React Router routes and builds
 * a breadcrumb trail from each route's `handle.breadcrumb(data)` function.
 * Think of it like Hansel & Gretel's trail — every route drops a crumb, and
 * this component strings them together so the user always knows where they
 * are.
 *
 * Rendering is delegated to the shared `EMRBreadcrumbs` component from the
 * common library, which handles mobile "back button" collapse, max-items
 * truncation, and theming automatically.
 */

import type { ReactElement } from 'react';
import { useMatches } from 'react-router-dom';

import { EMRBreadcrumbs } from '../common';
import type { BreadcrumbItem } from '../common/EMRBreadcrumbs';

type BreadcrumbFn = (data: unknown) => string;

function hasBreadcrumb(handle: unknown): handle is { breadcrumb: BreadcrumbFn } {
  return Boolean(
    handle && typeof (handle as { breadcrumb?: unknown }).breadcrumb === 'function',
  );
}

/**
 * Breadcrumbs — drops one crumb per route that exports
 * `handle: { breadcrumb: (data) => string }` in its route definition. The
 * last crumb is marked "current" (no `href`), earlier crumbs are clickable.
 */
export function Breadcrumbs(): ReactElement | null {
  const matches = useMatches();

  const items: BreadcrumbItem[] = matches
    .filter((m) => hasBreadcrumb(m.handle))
    .map((m, idx, arr): BreadcrumbItem => {
      const handle = m.handle as { breadcrumb: BreadcrumbFn };
      const label = handle.breadcrumb(m.data);
      const isLast = idx === arr.length - 1;
      return {
        label,
        href: isLast ? undefined : m.pathname,
      };
    });

  if (items.length === 0) {
    return null;
  }

  return <EMRBreadcrumbs items={items} />;
}

export default Breadcrumbs;
