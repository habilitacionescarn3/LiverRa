// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LIVERRA_ROUTES (T104).
 *
 * Single source of truth for all application route paths. Imported by
 * `AppRoutes.tsx`, `nav-registry.ts`, and any component that needs to
 * construct a URL (breadcrumbs, deep-links, signed-out redirects).
 *
 * Plain-English: think of this file as the town map. Every address in the
 * LiverRa app is written down here exactly once, so nobody can misspell
 * `/compliance/mbom` as `/compliance/MBoM` somewhere else.
 *
 * All 25 routes mirror plan.md §Route registration (§589-618). Keep the
 * ordering there in sync with this file; CI spec-compliance check diffs
 * the two.
 */

export const LIVERRA_ROUTES = {
  // --- public / auth -------------------------------------------------------
  LANDING: '/',
  SIGNIN: '/signin',
  AUTH_CALLBACK: '/auth/callback',
  SILENT_CALLBACK: '/auth/silent-callback.html',
  NOT_FOUND: '/404',

  // --- onboarding ----------------------------------------------------------
  ONBOARDING: '/onboarding',

  // --- cases / analysis ----------------------------------------------------
  CASES_LIST: '/cases',
  CASE_DETAIL: '/cases/:id',
  CASE_LESIONS: '/cases/:id/lesions',
  CASE_REFINE: '/cases/:id/refine',
  CASE_FINALIZE: '/cases/:id/finalize',
  REPORT_VIEW: '/reports/:id',

  // --- admin ---------------------------------------------------------------
  ADMIN_USERS: '/admin/users',
  ADMIN_PACS_CONFIG: '/admin/pacs-config',
  ADMIN_AUDIT: '/admin/audit',

  // --- ops -----------------------------------------------------------------
  OPS_QUEUE: '/ops/queue',

  // --- compliance ----------------------------------------------------------
  COMPLIANCE_MBOM: '/compliance/mbom',
  COMPLIANCE_AUDIT_SUMMARY: '/compliance/audit-summary',
  COMPLIANCE_RUO_SPOT_CHECK: '/compliance/ruo-spot-check',
  COMPLIANCE_CLAIM_REGISTRY: '/compliance/claim-registry',

  // --- erasure (DPO) -------------------------------------------------------
  ERASURE: '/erasure',
  ERASURE_NEW: '/erasure/new',

  // --- help / settings / demo ---------------------------------------------
  HELP: '/help',
  HELP_GLOSSARY: '/help/glossary',
  SETTINGS_NOTIFICATIONS: '/settings/notifications',
  PROFILE: '/profile',
  DEMO_CASE: '/demo-case',
} as const;

export type LiverraRoutePath = (typeof LIVERRA_ROUTES)[keyof typeof LIVERRA_ROUTES];

/**
 * Helper: substitute `:param` placeholders in a route template.
 *
 * ```ts
 * buildPath(LIVERRA_ROUTES.CASE_DETAIL, { id: 'abc' }) // '/cases/abc'
 * ```
 */
export function buildPath(
  template: LiverraRoutePath,
  params: Readonly<Record<string, string | number>> = {},
): string {
  return (template as string).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(`buildPath: missing param "${key}" for template "${template}"`);
    }
    return encodeURIComponent(String(value));
  });
}
