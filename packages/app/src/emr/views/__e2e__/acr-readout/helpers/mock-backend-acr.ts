/**
 * Mock backend for ACR structured readout E2E tests (002-acr-structured-readout T052).
 *
 * Plain-language: these helpers intercept every `/api/v1/*` request the readout
 * panel makes during a test, so the test runs without FastAPI / Postgres /
 * MinIO. The handler is configurable: callers supply the ReportSummary body,
 * the ETag, an optional "stale" ETag returned by HEAD probes, and an audit
 * response (status + body). The returned handle exposes a list of intercepted
 * audit POSTs so tests can assert against them.
 *
 * Style follows `views/__e2e__/liver-ai-pipeline/helpers/mock-backend.ts`.
 */
import type { Page, Route } from '@playwright/test';

export interface AcrMockFixtures {
  /** Body returned by GET /api/v1/analyses/:id/report/summary. */
  summary: unknown;
  /** ETag header value attached to both GET and HEAD by default. */
  etag?: string;
  /**
   * When set, the HEAD probe returns THIS ETag (different from `etag`) so the
   * clipboard service's freshness gate trips — used by stale-finding scenarios.
   */
  staleEtagAfterHead?: string;
  /** Audit POST stub. Defaults to 201 with an empty body. */
  auditResponse?: { status: number; body?: unknown };
  /**
   * Optional raw bytes/text returned by the vessels stage image endpoint.
   * Real backend serves a PNG via S3 presign; this is used only when the
   * test exercises the vessels section.
   */
  vesselsImage?: Buffer | string;
  /**
   * Override `/api/v1/users/me` payload — used by TS-09 (view-only role).
   * Defaults to a `radiologist` user.
   */
  user?: { id: string; email: string; roles: string[]; tenant_id: string };
  /**
   * Override `/api/v1/system/ruo-disclaimer` text — used by TS-04/TS-05
   * locale-switch scenarios. Default emits the English banner.
   */
  ruoDisclaimer?: { text: string; locale: string };
}

/** Captured audit POST body + headers — tests assert against this. */
export interface InterceptedAuditPost {
  body: unknown;
  headers: Record<string, string>;
}

export interface AcrMockHandle {
  /** Every audit POST observed during this test. Mutated by reference. */
  interceptedAuditPosts: InterceptedAuditPost[];
  /** Total HEAD probes seen (useful for freshness-gate assertions). */
  headProbeCount: () => number;
}

const json = (
  route: Route,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'x-ruo-disclaimer': 'Research Use Only', ...extraHeaders },
    body: JSON.stringify(body),
  });

/**
 * Install configurable mocks for the ACR readout panel. Returns a handle
 * whose `interceptedAuditPosts` field collects every clipboard-export POST.
 */
export async function installAcrMocks(
  page: Page,
  fixtures: AcrMockFixtures,
): Promise<AcrMockHandle> {
  const intercepted: InterceptedAuditPost[] = [];
  let headCount = 0;

  const etag = fixtures.etag ?? 'etag-fixture-001';
  const staleEtag = fixtures.staleEtagAfterHead ?? null;

  // ---- /system/health + /users/me + /ruo-disclaimer ----
  await page.route('**/api/v1/system/health', (route) =>
    json(route, 200, { status: 'ok', gpu: { state: 'warm', predicted_warm_s: 0 } }),
  );
  await page.route('**/api/v1/system/ruo-disclaimer', (route) =>
    json(
      route,
      200,
      fixtures.ruoDisclaimer ?? {
        text: 'Research Use Only — not for clinical decision-making.',
        locale: 'en',
      },
    ),
  );
  await page.route('**/api/v1/users/me', (route) =>
    json(
      route,
      200,
      fixtures.user ?? {
        id: 'user-acr-e2e',
        email: 'acr@liverra.ai',
        roles: ['radiologist'],
        tenant_id: 'tenant-acr-e2e',
      },
    ),
  );

  // ---- /report/summary GET + HEAD ----
  await page.route('**/api/v1/analyses/*/report/summary', async (route) => {
    const method = route.request().method().toUpperCase();
    if (method === 'HEAD') {
      headCount += 1;
      await route.fulfill({
        status: 200,
        headers: { ETag: staleEtag ?? etag },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        ETag: etag,
        'Last-Modified': new Date().toUTCString(),
        'x-ruo-disclaimer': 'Research Use Only',
      },
      body: JSON.stringify(fixtures.summary),
    });
  });

  // ---- /report/clipboard-export POST ----
  await page.route('**/api/v1/analyses/*/report/clipboard-export', async (route) => {
    const req = route.request();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(req.postData() ?? 'null');
    } catch {
      parsed = req.postData();
    }
    intercepted.push({
      body: parsed,
      headers: req.headers(),
    });
    const resp = fixtures.auditResponse ?? { status: 201, body: { ok: true } };
    await route.fulfill({
      status: resp.status,
      contentType: 'application/json',
      body: JSON.stringify(resp.body ?? {}),
    });
  });

  // ---- Optional: vessels stage image ----
  if (fixtures.vesselsImage !== undefined) {
    await page.route('**/api/v1/analyses/*/stages/*/preview*', async (route) => {
      const isBuffer = Buffer.isBuffer(fixtures.vesselsImage);
      await route.fulfill({
        status: 200,
        contentType: isBuffer ? 'image/png' : 'text/plain',
        body: fixtures.vesselsImage as Buffer | string,
      });
    });
  }

  return {
    interceptedAuditPosts: intercepted,
    headProbeCount: () => headCount,
  };
}
