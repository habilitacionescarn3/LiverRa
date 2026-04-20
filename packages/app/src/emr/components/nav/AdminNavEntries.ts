// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * AdminNavEntries (T292).
 *
 * Plain-English: nav-menu entries for the admin console, matched 1:1
 * with AdminRouteRegistrations. Consumed by the top-nav / sidebar
 * menus (which filter by the current user's permissions).
 */
import { ADMIN_ROUTES } from './AdminRouteRegistrations';
import type { LiverraPermission } from '../../constants/permissions.gen';

export interface NavEntry {
  id: string;
  path: string;
  labelKey: string;
  iconName?: string;
  /** Permissions the current user must hold to see this entry. */
  requires: LiverraPermission[];
  /** Group label for sidebar rendering. */
  group: 'admin' | 'ops' | 'compliance' | 'help';
}

export const ADMIN_NAV_ENTRIES: NavEntry[] = ADMIN_ROUTES.map((r) => ({
  id: r.path,
  path: r.path,
  labelKey: r.labelKey,
  iconName: r.iconName,
  requires: [r.permission],
  group: 'admin' as const,
}));

export default ADMIN_NAV_ENTRIES;
