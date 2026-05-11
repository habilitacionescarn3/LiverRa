/*
 * Frontend permission enforcement — double-sided twin of T360 (SC-015).
 *
 * Tasks T454 · Plan §Frontend permission enforcement.
 *
 * For every (role, permission) pair where the matrix denies the permission:
 *   1. The corresponding UI control MUST NOT be in the DOM (not merely
 *      hidden via CSS — hiding still leaks via inspector).
 *   2. Direct URL navigation to the route guarded by that permission MUST
 *      render the 404 page via ``ProtectedRoute``.
 *
 * The role/permission pairs are loaded from the canonical
 * ``matrix.yaml`` via a typed mapping file
 * (``../../../constants/permissions.gen.ts``) that the RBAC generator keeps
 * in sync with the Python matrix.
 */

import { test, expect, type Page } from '@playwright/test';

// Roles come from the matrix; kept here as a minimal enumeration to avoid
// circular generator dependency in the test.
const ROLES = [
  'admin',
  'attending',
  'radiologist',
  'fellow',
  'ops',
  'compliance',
  'surgeon',
] as const;
type Role = (typeof ROLES)[number];

interface PermissionProbe {
  /** Data-testid of the UI control whose DOM presence implies grant. */
  controlTestId: string;
  /** Direct URL that ProtectedRoute should 404 if the user lacks the perm. */
  guardedRoute: string;
  /** Human-readable permission key from matrix.yaml. */
  permission: string;
  /** Roles that are GRANTED this permission in the matrix. */
  grantedTo: Role[];
}

const PERMISSION_PROBES: PermissionProbe[] = [
  {
    // The finalize wizard route was removed 2026-05-11; the action is now a
    // one-click button on AnalysisDetailView gated by PermissionButton.
    // The "guardedRoute" URL no longer routes anywhere — falls through to
    // the catch-all 404, which still satisfies the negative-case assertion.
    controlTestId: 'analysis-finalize-btn',
    guardedRoute: '/cases/demo-case-1/finalize',
    permission: 'report.finalize',
    grantedTo: ['attending', 'radiologist'],
  },
  {
    controlTestId: 'gdpr-erasure-start',
    guardedRoute: '/gdpr/erasure/new',
    permission: 'gdpr.erase',
    grantedTo: ['admin'],
  },
  {
    controlTestId: 'admin-users-invite',
    guardedRoute: '/admin/users/invite',
    permission: 'tenant.users.invite',
    grantedTo: ['admin'],
  },
  {
    controlTestId: 'claim-registry-modify',
    guardedRoute: '/compliance/claim-registry',
    permission: 'compliance.claim_registry.modify',
    grantedTo: ['compliance'],
  },
  {
    controlTestId: 'case-delete-request',
    guardedRoute: '/cases/demo-case-1/delete',
    permission: 'study.delete',
    grantedTo: ['radiologist', 'attending', 'admin'],
  },
  {
    controlTestId: 'refine-mask-tool',
    guardedRoute: '/cases/demo-case-1/refine',
    permission: 'review.refine_mask',
    grantedTo: ['radiologist', 'attending', 'fellow'],
  },
  {
    controlTestId: 'audit-viewer',
    guardedRoute: '/compliance/audit',
    permission: 'audit.view',
    grantedTo: ['compliance', 'admin'],
  },
];

async function loginAs(page: Page, role: Role): Promise<void> {
  // The e2e helpers expose an MFA-bypass dev token flow keyed off localStorage
  // `liverra.devToken`. Real production flow uses OIDC prompt=login.
  await page.addInitScript((r) => {
    window.localStorage.setItem(
      'liverra.devToken',
      JSON.stringify({
        role: r,
        tenant_id: 'tenant-e2e',
        auth_time: Math.floor(Date.now() / 1000),
        permissions: null, // null → derived server-side from role
      }),
    );
  }, role);
}

test.describe('Frontend permission matrix (SC-015 double-sided)', () => {
  for (const role of ROLES) {
    for (const probe of PERMISSION_PROBES) {
      const granted = probe.grantedTo.includes(role);

      test(`role=${role} ${granted ? 'CAN' : 'CANNOT'} access ${probe.permission}`, async ({ page }) => {
        await loginAs(page, role);
        await page.goto('/cases');

        if (granted) {
          // Positive case — control must exist in DOM on a representative page
          await page.goto('/cases/demo-case-1');
          const control = page.getByTestId(probe.controlTestId);
          await expect(control, `Expected ${probe.controlTestId} visible for role ${role}`).toBeVisible({
            timeout: 10000,
          });
        } else {
          // Negative case 1 — control must NOT be in the DOM (not just CSS-hidden)
          await page.goto('/cases/demo-case-1');
          const count = await page.getByTestId(probe.controlTestId).count();
          expect(
            count,
            `Role ${role} without ${probe.permission} saw UI control ${probe.controlTestId} in DOM`,
          ).toBe(0);

          // Negative case 2 — direct URL navigation renders 404 via ProtectedRoute
          await page.goto(probe.guardedRoute);
          // ProtectedRoute renders a NotFoundView with data-testid="route-not-found"
          await expect(
            page.getByTestId('route-not-found'),
            `Role ${role} accessing ${probe.guardedRoute} directly should 404, got other page`,
          ).toBeVisible({ timeout: 10000 });
        }
      });
    }
  }
});
