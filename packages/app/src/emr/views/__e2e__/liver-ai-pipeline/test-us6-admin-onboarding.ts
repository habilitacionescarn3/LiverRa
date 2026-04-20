/**
 * US6 — Admin self-serve tenant onboarding (P2) E2E spec.
 *
 * Plain-language: a tenant admin logs in, invites a new clinician, configures
 * the hospital PACS destination (with a C-ECHO pre-flight), and reviews the
 * audit log. We drive the whole flow against a mocked backend.
 *
 * Task: T294 (Phase 8 · US6 · P2)
 * Spec refs:
 *   - §US6, §FR-039 (admin ops), §FR-046 (deletion), §SC-007 (DPA + MFA).
 *
 * Three scenarios:
 *   1. Happy — invite + PACS config (C-ECHO ok) + audit browser shows events.
 *   2. Failure — C-ECHO fails → admin sees a technician-friendly slug error
 *      (never raw OS error text — FR-039 / NFR-007 PHI-scrub).
 *   3. Edge — suspending a user preserves their historical audit attribution
 *      (the user's user_id stays stamped on prior events).
 */
import { test, expect, Page } from '@playwright/test';

const API = '**/api/v1/admin';

async function mockAdminBackendHappy(page: Page): Promise<void> {
  await page.route(`${API}/tenants/me`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Dev Regensburg',
        locale_default: 'de',
        pacs_destination: null,
        allow_partial_coverage_override: false,
      }),
    }),
  );
  await page.route(`${API}/users`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'u1',
          email: 'alice@dev.local',
          display_name: 'Dr. Alice',
          role: 'hpb_surgeon',
          locale_preference: 'de',
          suspended: false,
          ruo_accepted_at: '2026-01-01T00:00:00Z',
          mfa_enrolled_at: '2026-01-01T00:00:00Z',
          last_active_at: '2026-04-01T00:00:00Z',
        },
      ]),
    }),
  );
  await page.route(`${API}/users/invite`, (r) =>
    r.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        invite_id: 'inv1',
        expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      }),
    }),
  );
  await page.route(`${API}/pacs-destination/echo`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        reachable: true,
        round_trip_ms: 12,
        scanner_ae_responded: 'HOSP_PACS',
        error: null,
      }),
    }),
  );
  await page.route(`${API}/audit*`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'a1',
          sequence_no: 101,
          category: 'admin_invite',
          recorded: '2026-04-18T12:00:00Z',
          actor: 'u-admin',
          outcome: 'success',
          summary: null,
        },
      ]),
    }),
  );
}

test.describe('US6: Admin onboarding (P2)', () => {
  test('Happy — invite + PACS C-ECHO ok + audit', async ({ page }) => {
    await mockAdminBackendHappy(page);
    await page.goto('/admin/users');

    await expect(page.getByRole('heading', { name: /user management/i })).toBeVisible();
    await page.getByRole('button', { name: /invite user/i }).click();

    await page.getByLabel(/email/i).fill('bob@dev.local');
    await page.getByLabel(/display name/i).fill('Dr. Bob');
    await page.getByRole('button', { name: /send invite/i }).click();

    await expect(page.getByRole('heading', { name: /user management/i })).toBeVisible();

    // PACS config
    await page.goto('/admin/pacs-config');
    await page.getByLabel(/ae title/i).fill('LIVERRA');
    await page.getByLabel(/host/i).fill('127.0.0.1');
    await page.getByRole('button', { name: /test with c-echo/i }).click();
    await expect(page.getByText(/c-echo succeeded/i)).toBeVisible();

    // Audit browser
    await page.goto('/admin/audit');
    await expect(page.getByText('admin_invite')).toBeVisible();
  });

  test('Failure — C-ECHO fails with PHI-scrubbed slug', async ({ page }) => {
    await page.route(`${API}/tenants/me`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 't1',
          name: 'Dev',
          locale_default: 'en',
          pacs_destination: null,
          allow_partial_coverage_override: false,
        }),
      }),
    );
    await page.route(`${API}/pacs-destination/echo`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reachable: false,
          round_trip_ms: null,
          scanner_ae_responded: null,
          error: 'connection_refused',
        }),
      }),
    );
    await page.goto('/admin/pacs-config');
    await page.getByLabel(/ae title/i).fill('LIVERRA');
    await page.getByLabel(/host/i).fill('10.0.0.99');
    await page.getByRole('button', { name: /test with c-echo/i }).click();
    await expect(page.getByText(/c-echo failed/i)).toBeVisible();
    await expect(page.getByText(/connection_refused/)).toBeVisible();
    // Raw OS error text must never leak.
    await expect(page.getByText(/errno/i)).toHaveCount(0);
  });

  test('Edge — suspended user preserves historical audit attribution', async ({ page }) => {
    let suspended = false;
    await page.route(`${API}/users`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'u1',
            email: 'alice@dev.local',
            display_name: 'Dr. Alice',
            role: 'hpb_surgeon',
            locale_preference: 'en',
            suspended,
            ruo_accepted_at: '2026-01-01T00:00:00Z',
            mfa_enrolled_at: '2026-01-01T00:00:00Z',
            last_active_at: '2026-04-01T00:00:00Z',
          },
        ]),
      }),
    );
    await page.route(/\/api\/v1\/admin\/users\/.*\/suspend/, (r) => {
      suspended = true;
      return r.fulfill({ status: 204 });
    });
    await page.route(`${API}/audit*`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'a1',
            sequence_no: 50,
            category: 'study_upload',
            recorded: '2026-03-01T10:00:00Z',
            actor: 'u1', // the now-suspended user — attribution preserved
            outcome: 'success',
            summary: null,
          },
        ]),
      }),
    );
    await page.goto('/admin/users');
    await page.getByRole('button', { name: /suspend/i }).first().click();
    await page.goto('/admin/audit');
    await expect(page.getByText('u1')).toBeVisible();
    await expect(page.getByText('study_upload')).toBeVisible();
  });
});
