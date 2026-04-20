// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Navigation registry (T106).
 *
 * Plain-English: this is the menu card for the app, keyed by user role.
 * When the logged-in user is an HPB surgeon we show their menu; when it's
 * a DPO we show theirs. No component builds its own menu — they all read
 * from here so the sidebar / top nav / mobile drawer all stay in sync.
 *
 * Mirrors plan.md §622-638 (Navigation port). Order within each role is
 * the presentation order in the main nav bar. `children` arrays describe
 * submenu contents (used by the horizontal sub-menu / mobile accordion).
 *
 * Every `requires` value MUST be a permission that exists in
 * `permissions.gen.ts` — the compiler enforces this via the typed union.
 */

import { createElement, type ReactNode } from 'react';
import {
  IconFolder,
  IconPlayerPlay,
  IconListDetails,
  IconUsers,
  IconServer,
  IconFileText,
  IconPackage,
  IconCheckbox,
  IconCertificate,
  IconTrash,
  IconHelpCircle,
  IconUser,
  type Icon as TablerIcon,
} from '@tabler/icons-react';

import type { LiverraPermission, LiverraRole } from './permissions.gen';
import { LIVERRA_ROUTES, type LiverraRoutePath } from './routes';

export interface NavItem {
  /** Stable key for React `key` props + telemetry event tags. */
  key: string;
  /** Translation key (or literal label until i18n lands for the nav bundle). */
  label: string;
  /** Tabler icon name, resolved at render time by the UI layer. */
  icon?: string;
  /** Route path to navigate to (omitted for pure group headers). */
  path?: LiverraRoutePath;
  /** Permissions required to see this entry. AND semantics — all required. */
  requires?: readonly LiverraPermission[];
  /** Nested items (rendered as a submenu / accordion group). */
  children?: readonly NavItem[];
}

// -----------------------------------------------------------------------------
// Shared items (help / sign-out appear in every role nav)
// -----------------------------------------------------------------------------

const HELP_ITEM: NavItem = {
  key: 'help',
  label: 'nav:help',
  icon: 'help-circle',
  path: LIVERRA_ROUTES.HELP,
};

const PROFILE_ITEM: NavItem = {
  key: 'profile',
  label: 'nav:profile',
  icon: 'user',
  path: LIVERRA_ROUTES.PROFILE,
};

// -----------------------------------------------------------------------------
// Per-role navigation
// -----------------------------------------------------------------------------

export const NAV_REGISTRY: Record<LiverraRole, readonly NavItem[]> = {
  hpb_surgeon: [
    {
      key: 'upload',
      label: 'nav:upload',
      icon: 'upload',
      path: LIVERRA_ROUTES.CASES_LIST, // upload is accessed from the cases list toolbar
      requires: ['study.upload'] as const,
    },
    {
      key: 'cases',
      label: 'nav:my_cases',
      icon: 'folder',
      path: LIVERRA_ROUTES.CASES_LIST,
      requires: ['study.view'] as const,
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  radiologist: [
    {
      key: 'upload',
      label: 'nav:upload',
      icon: 'upload',
      path: LIVERRA_ROUTES.CASES_LIST,
      requires: ['study.upload'] as const,
    },
    {
      key: 'my-cases',
      label: 'nav:my_cases',
      icon: 'folder',
      path: LIVERRA_ROUTES.CASES_LIST,
      requires: ['study.view'] as const,
    },
    {
      key: 'all-cases',
      label: 'nav:all_cases',
      icon: 'folders',
      path: LIVERRA_ROUTES.CASES_LIST,
      requires: ['study.view'] as const,
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  fellow: [
    {
      key: 'cases',
      label: 'nav:my_cases',
      icon: 'folder',
      path: LIVERRA_ROUTES.CASES_LIST,
      requires: ['study.view'] as const,
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  admin: [
    {
      key: 'admin',
      label: 'nav:administration',
      icon: 'settings',
      requires: ['admin.user_create'] as const,
      children: [
        {
          key: 'admin-users',
          label: 'nav:admin_users',
          icon: 'users',
          path: LIVERRA_ROUTES.ADMIN_USERS,
          requires: ['admin.user_create'] as const,
        },
        {
          key: 'admin-pacs',
          label: 'nav:admin_pacs',
          icon: 'server',
          path: LIVERRA_ROUTES.ADMIN_PACS_CONFIG,
          requires: ['pacs.config_read'] as const,
        },
        {
          key: 'admin-audit',
          label: 'nav:admin_audit',
          icon: 'file-text',
          path: LIVERRA_ROUTES.ADMIN_AUDIT,
          requires: ['audit.view'] as const,
        },
      ],
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  ops: [
    {
      key: 'ops-queue',
      label: 'nav:ops_queue',
      icon: 'list-details',
      path: LIVERRA_ROUTES.OPS_QUEUE,
      requires: ['ops.queue_view'] as const,
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  compliance: [
    {
      key: 'compliance',
      label: 'nav:compliance',
      icon: 'shield-check',
      requires: ['compliance.view'] as const,
      children: [
        {
          key: 'compliance-mbom',
          label: 'nav:compliance_mbom',
          icon: 'package',
          path: LIVERRA_ROUTES.COMPLIANCE_MBOM,
          requires: ['mbom.view'] as const,
        },
        {
          key: 'compliance-audit',
          label: 'nav:compliance_audit',
          icon: 'file-text',
          path: LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY,
          requires: ['audit.view'] as const,
        },
        {
          key: 'compliance-spotcheck',
          label: 'nav:compliance_spotcheck',
          icon: 'checkbox',
          path: LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK,
          requires: ['compliance.view'] as const,
        },
        {
          key: 'compliance-claim-registry',
          label: 'nav:compliance_claim_registry',
          icon: 'certificate',
          path: LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY,
          requires: ['claim_registry.view'] as const,
        },
      ],
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],

  dpo: [
    {
      key: 'erasure',
      label: 'nav:erasure_requests',
      icon: 'trash',
      path: LIVERRA_ROUTES.ERASURE,
      requires: ['erasure.execute'] as const,
    },
    {
      key: 'dpo-audit',
      label: 'nav:admin_audit',
      icon: 'file-text',
      path: LIVERRA_ROUTES.ADMIN_AUDIT,
      requires: ['audit.view'] as const,
    },
    HELP_ITEM,
    PROFILE_ITEM,
  ],
};

/**
 * Flatten nav tree into a linear list of navigable items (children + parents
 * that have a `path`). Useful for breadcrumb generation + sitemap builders.
 */
export function flattenNav(items: readonly NavItem[]): NavItem[] {
  const out: NavItem[] = [];
  for (const item of items) {
    if (item.path) out.push(item);
    if (item.children) out.push(...flattenNav(item.children));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Flat menu for EMRMainMenu (T107)
// -----------------------------------------------------------------------------

/**
 * Shape consumed by `components/nav/EMRMainMenu.tsx`. Lives here (rather
 * than inside the component module) so all menu sources — per-role
 * registry, admin console, dev bypass — share one source of truth.
 *
 * `icon` is a pre-rendered ReactNode because Tabler icons are `forwardRef`
 * objects (not plain function components). `EMRMainMenu.renderIcon` only
 * calls-as-component when `typeof icon === 'function'`, so forwardRefs
 * fall through and React throws "Objects are not valid as a React child"
 * unless we hand it JSX up front.
 */
export interface MenuNavItem {
  key: string;
  translationKey: string;
  path: string;
  icon: ReactNode;
  permission?: LiverraPermission;
}

function renderTablerIcon(IconComp: TablerIcon, size = 20): ReactNode {
  return createElement(IconComp, { size });
}

/**
 * Full, flat menu covering every production surface in the app. The menu
 * component filters by permission at render time, so users only see what
 * their role grants. With the dev-bypass user (all permissions) every
 * entry is visible — the whole app becomes clickable.
 */
export const FULL_MENU_ITEMS: readonly MenuNavItem[] = [
  {
    key: 'cases',
    translationKey: 'nav:cases',
    path: LIVERRA_ROUTES.CASES_LIST,
    icon: renderTablerIcon(IconFolder),
    permission: 'study.view',
  },
  {
    key: 'demo',
    translationKey: 'nav:demo',
    path: LIVERRA_ROUTES.DEMO_CASE,
    icon: renderTablerIcon(IconPlayerPlay),
  },
  {
    key: 'ops-queue',
    translationKey: 'nav:ops_queue',
    path: LIVERRA_ROUTES.OPS_QUEUE,
    icon: renderTablerIcon(IconListDetails),
    permission: 'ops.queue_view',
  },
  {
    key: 'admin-users',
    translationKey: 'nav:admin_users',
    path: LIVERRA_ROUTES.ADMIN_USERS,
    icon: renderTablerIcon(IconUsers),
    permission: 'admin.user_create',
  },
  {
    key: 'admin-pacs',
    translationKey: 'nav:admin_pacs',
    path: LIVERRA_ROUTES.ADMIN_PACS_CONFIG,
    icon: renderTablerIcon(IconServer),
    permission: 'pacs.config_read',
  },
  {
    key: 'admin-audit',
    translationKey: 'nav:admin_audit',
    path: LIVERRA_ROUTES.ADMIN_AUDIT,
    icon: renderTablerIcon(IconFileText),
    permission: 'audit.view',
  },
  {
    key: 'compliance-mbom',
    translationKey: 'nav:compliance_mbom',
    path: LIVERRA_ROUTES.COMPLIANCE_MBOM,
    icon: renderTablerIcon(IconPackage),
    permission: 'mbom.view',
  },
  {
    key: 'compliance-audit',
    translationKey: 'nav:compliance_audit',
    path: LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY,
    icon: renderTablerIcon(IconFileText),
    permission: 'audit.view',
  },
  {
    key: 'compliance-spotcheck',
    translationKey: 'nav:compliance_spotcheck',
    path: LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK,
    icon: renderTablerIcon(IconCheckbox),
    permission: 'compliance.view',
  },
  {
    key: 'compliance-claims',
    translationKey: 'nav:compliance_claim_registry',
    path: LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY,
    icon: renderTablerIcon(IconCertificate),
    permission: 'claim_registry.view',
  },
  {
    key: 'erasure',
    translationKey: 'nav:erasure_requests',
    path: LIVERRA_ROUTES.ERASURE,
    icon: renderTablerIcon(IconTrash),
    permission: 'erasure.execute',
  },
  {
    key: 'help',
    translationKey: 'nav:help',
    path: LIVERRA_ROUTES.HELP,
    icon: renderTablerIcon(IconHelpCircle),
  },
  {
    key: 'profile',
    translationKey: 'nav:profile',
    path: LIVERRA_ROUTES.PROFILE,
    icon: renderTablerIcon(IconUser),
  },
];
