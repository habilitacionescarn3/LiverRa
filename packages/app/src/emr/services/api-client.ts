/**
 * LiverRa typed API client.
 *
 * Plain-language: this is the glue between the React app and the FastAPI
 * backend. It takes the TypeScript types auto-generated from
 * `contracts/api-openapi.yaml` and gives React code a fully-typed
 * `client.GET('/path', {...})` surface with the right headers injected
 * automatically (auth + tenant).
 *
 * Analogy: if `api-schema.gen.ts` is the restaurant menu, this file is
 * the waiter who also validates your allergy card (auth) and remembers
 * which table you're on (tenant) before sending the order back.
 *
 * Source of truth: plan.md §Contract-first codegen.
 */
import createClient, { type Middleware } from 'openapi-fetch';

import type { paths } from './api-schema.gen';

/**
 * Configuration for the LiverRa API client.
 *
 * - `baseUrl` — absolute origin + `/api/v1` prefix (e.g. `https://app.liverra.ai/api/v1`).
 * - `getAccessToken` — returns the current Cognito bearer token (or `null` when
 *   anonymous). Called on every request.
 * - `getTenantId` — returns the active tenant id for multi-tenant scoping.
 *   Injected into the `X-LiverRa-Tenant` header.
 * - `onError` — optional hook fired for non-2xx responses. If the dedicated
 *   `errorClient` module is present (T406), callers should pass its
 *   `handleApiError` here; otherwise a minimal local thrower is used.
 */
export interface ApiClientConfig {
  baseUrl: string;
  getAccessToken: () => string | null | Promise<string | null>;
  getTenantId: () => string | null | Promise<string | null>;
  onError?: (response: Response) => void | Promise<void>;
}

/**
 * Default error handler used when the caller does not supply one.
 *
 * Intentionally minimal: the real error taxonomy / Sentry hook / toast
 * wiring lives in `errorClient.ts` (T189 / T406). When that module lands,
 * callers will pass its `handleApiError` as `config.onError`.
 */
async function defaultOnError(response: Response): Promise<never> {
  let detail = '';
  try {
    detail = await response.clone().text();
  } catch {
    detail = '<unreadable body>';
  }
  throw new Error(
    `LiverRa API error ${response.status} ${response.statusText}: ${detail.slice(0, 512)}`,
  );
}

/**
 * Build a tenant-aware, auth-aware typed API client.
 *
 * Uses `openapi-fetch` under the hood. The returned object exposes
 * `GET`, `POST`, `PUT`, `PATCH`, `DELETE` whose first argument is
 * constrained to paths declared in `api-schema.gen.ts`.
 */
export function createApiClient(config: ApiClientConfig) {
  const client = createClient<paths>({ baseUrl: config.baseUrl });

  const authAndTenantMiddleware: Middleware = {
    async onRequest({ request }) {
      const [token, tenantId] = await Promise.all([
        config.getAccessToken(),
        config.getTenantId(),
      ]);
      if (token) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      if (tenantId) {
        request.headers.set('X-LiverRa-Tenant', tenantId);
      }
      return request;
    },
    async onResponse({ response }) {
      if (!response.ok) {
        const handler = config.onError ?? defaultOnError;
        await handler(response);
      }
      return response;
    },
  };

  client.use(authAndTenantMiddleware);

  /**
   * TanStack Query adapter.
   *
   * Plain-language: TanStack Query wants a function that throws on failure
   * and returns parsed data on success. `openapi-fetch` returns `{ data, error }`,
   * so this wrapper collapses that into the shape Query expects.
   */
  function queryFn<T>(promise: Promise<{ data?: T; error?: unknown; response: Response }>) {
    return promise.then(({ data, error, response }) => {
      if (error !== undefined || !response.ok) {
        throw error ?? new Error(`HTTP ${response.status}`);
      }
      return data as T;
    });
  }

  return {
    /** Raw `openapi-fetch` client — use when you need `{ data, error }`. */
    raw: client,
    /** Typed GET. */
    GET: client.GET.bind(client),
    /** Typed POST. */
    POST: client.POST.bind(client),
    /** Typed PUT. */
    PUT: client.PUT.bind(client),
    /** Typed PATCH. */
    PATCH: client.PATCH.bind(client),
    /** Typed DELETE. */
    DELETE: client.DELETE.bind(client),
    /**
     * Wrap any `client.GET/POST(...)` call in a TanStack-Query-compatible thunk.
     *
     * @example
     *   useQuery({
     *     queryKey: ['analyses', id],
     *     queryFn: () => api.queryFn(api.GET('/analyses/{id}', { params: { path: { id } } })),
     *   });
     */
    queryFn,
  };
}

/** Inferred type of the client returned by `createApiClient`. */
export type LiverraApiClient = ReturnType<typeof createApiClient>;
