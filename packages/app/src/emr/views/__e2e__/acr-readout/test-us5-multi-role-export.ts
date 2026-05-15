// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * test-us5-multi-role-export — feature 002-acr-structured-readout T098.
 *
 * Playwright test asserting three non-attending roles can each copy the
 * readout and that the audit chain captures each role distinctly.
 */
import { test, expect } from '@playwright/test';

const ROLES: Array<{ role: string; cookieValue: string }> = [
  { role: 'resident', cookieValue: 'role=resident' },
  { role: 'mdt_coordinator', cookieValue: 'role=mdt_coordinator' },
  { role: 'referring_physician', cookieValue: 'role=referring_physician' },
];

const DEMO = '/cases/demo-case-1';

for (const r of ROLES) {
  test(`TS-09 [${r.role}] Copy succeeds and audit captures role-at-action-time`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Set a role-impersonation cookie picked up by the dev backend.
    await context.addCookies([
      {
        name: 'liverra-dev-role',
        value: r.role,
        url: 'http://localhost:5173',
      },
    ]);

    const auditRequests: { body: unknown }[] = [];
    await page.route('**/api/v1/analyses/*/report/clipboard-export', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      auditRequests.push({ body });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          audit_event_id: '11111111-2222-3333-4444-555555555555',
          sequence_no: 1,
          outcome: 'success',
          persisted_at: new Date().toISOString(),
        }),
      });
    });

    await page.goto(DEMO);
    await page.waitForSelector('[data-testid="acr-readout-root"]');
    await page.click('[data-testid="acr-copy-button"]');
    await page.waitForTimeout(300);

    expect(auditRequests.length).toBeGreaterThanOrEqual(1);
    const lastPayload = auditRequests[auditRequests.length - 1].body as {
      actor_role?: string;
    };
    // The frontend reads actor_role from the auth context. If the role
    // cookie was honored, the recorded role matches.
    expect(lastPayload.actor_role).toBe(r.role);
  });
}
