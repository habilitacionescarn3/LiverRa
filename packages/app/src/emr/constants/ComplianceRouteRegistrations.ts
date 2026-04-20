// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ComplianceRouteRegistrations (T351).
 *
 * Plain-English: a single-source-of-truth side file that lists every
 * compliance route + its required permission + whether the compliance
 * role is allowed to step across tenants (`complianceAssignmentScope`).
 *
 * Why a side file? The master router (`AppRoutes.tsx`) already wires
 * the routes; the master nav registry (`nav-registry.ts`) already
 * lists them for the compliance role. This file is the *third* view —
 * the one the ComplianceAssignment scope filter reads to know which
 * routes a cross-tenant auditor is allowed to visit for a specific
 * tenant assignment.
 *
 * Analogy: the app router is the town map, the nav registry is the
 * menu, and this is the access roster the security guard at the door
 * uses to decide who can enter which room for which tenant tonight.
 *
 * Spec refs: data-model.md §21 (ComplianceAssignment), plan §Route
 * registration + FR-032a (tenant isolation).
 */

import type { LiverraPermission } from './permissions.gen';
import { LIVERRA_ROUTES, type LiverraRoutePath } from './routes';

/**
 * Describe one compliance route's access properties.
 */
export interface ComplianceRouteRegistration {
  /** Stable key matching the nav registry. */
  key: string;
  /** Canonical path from `LIVERRA_ROUTES`. */
  path: LiverraRoutePath;
  /** Permission required to load the view. */
  requires: LiverraPermission;
  /**
   * Whether this route respects `ComplianceAssignment` scope filtering.
   *
   * Compliance reviewers with a cross-tenant assignment are additionally
   * filtered through the assignment's `scope_json.permissions_scope`
   * array — a route with `complianceAssignmentScope=true` only renders
   * if that permission survives the intersection.
   */
  complianceAssignmentScope: boolean;
  /**
   * Whether the route accepts a `tenant_id` query-string to override
   * the default (own-tenant) read. Relevant for the audit-summary
   * view where a reviewer may audit a different assigned tenant.
   */
  acceptsTenantQuery: boolean;
  /** Step-up MFA required to enter the route (not just to mutate). */
  stepUpOnEntry: boolean;
}

export const COMPLIANCE_ROUTE_REGISTRATIONS: readonly ComplianceRouteRegistration[] = [
  {
    key: 'compliance-mbom',
    path: LIVERRA_ROUTES.COMPLIANCE_MBOM,
    requires: 'compliance.view_mbom' as LiverraPermission,
    complianceAssignmentScope: true,
    acceptsTenantQuery: false,
    stepUpOnEntry: false,
  },
  {
    key: 'compliance-audit-summary',
    path: LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY,
    requires: 'compliance.generate_audit_summary' as LiverraPermission,
    complianceAssignmentScope: true,
    acceptsTenantQuery: true,
    stepUpOnEntry: false,
  },
  {
    key: 'compliance-ruo-spot-check',
    path: LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK,
    requires: 'compliance.spot_check_ruo' as LiverraPermission,
    complianceAssignmentScope: true,
    acceptsTenantQuery: false,
    stepUpOnEntry: false,
  },
  {
    key: 'compliance-claim-registry',
    path: LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY,
    requires: 'compliance.view_mbom' as LiverraPermission,
    complianceAssignmentScope: true,
    acceptsTenantQuery: false,
    // Individual mutations step-up via PermissionButton; the route
    // itself is read-allowable without step-up.
    stepUpOnEntry: false,
  },
];

/**
 * Filter the compliance routes a user can actually navigate to, given
 * their flat permission set and (optionally) the narrower
 * `permissions_scope` from a specific `ComplianceAssignment` row.
 *
 * Behaviour:
 *   - Route is kept only if the user holds `requires`.
 *   - If `assignmentScope` is provided AND the route is marked
 *     `complianceAssignmentScope=true`, the route is additionally kept
 *     only if `requires` is present in `assignmentScope`.
 *   - `assignmentScope=null` means "no narrowing" — use the user's
 *     own tenant scope without intersection.
 *
 * This is pure — no React / fetch — so it can be unit-tested with no
 * setup.
 */
export function filterComplianceRoutes(
  userPermissions: readonly string[],
  assignmentScope: readonly string[] | null,
): readonly ComplianceRouteRegistration[] {
  const perms = new Set(userPermissions);
  const scope = assignmentScope ? new Set(assignmentScope) : null;

  return COMPLIANCE_ROUTE_REGISTRATIONS.filter((reg) => {
    if (!perms.has(reg.requires)) return false;
    if (reg.complianceAssignmentScope && scope !== null && !scope.has(reg.requires)) {
      return false;
    }
    return true;
  });
}

export default COMPLIANCE_ROUTE_REGISTRATIONS;
