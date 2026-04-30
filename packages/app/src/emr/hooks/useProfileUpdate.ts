// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useProfileUpdate — mutate the signed-in user's profile (T475).
 *
 * Plain-English: the remote control for "save my preferences". The user
 * clicks Save in the Profile page, this hook PUTs to `/auth/me`, then
 * re-fetches the auth context so every other component sees the new
 * display name / locale / theme.
 *
 * Implementation notes:
 *   - API base is taken from `VITE_LIVERRA_API_BASE_URL`, default `/api/v1`.
 *   - `credentials: 'include'` so the session cookie rides along.
 *   - `problem+json` error bodies are parsed into `Error & { slug? }` so
 *     the caller can key error messaging off a stable machine code.
 *   - On success we invalidate `['auth', 'me']` TanStack queries AND call
 *     `useAuth().refresh()` — the two are complementary because some
 *     consumers read the stub-backed `useAuth()` while others listen to a
 *     React Query cache. Either path is safe to no-op.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../services/auth';
import type { Locale } from '../services/localeService';

/** Narrow augmentation of the standard Error with a server-side slug. */
export type ProfileUpdateError = Error & { slug?: string };

/** Shape accepted by `PUT /auth/me`. All fields optional; server patches partials. */
export interface ProfileUpdatePayload {
  display_name?: string;
  locale_preference?: Locale;
  theme_preference?: 'light' | 'dark' | 'system';
}

export interface UseProfileUpdateResult {
  update: (payload: ProfileUpdatePayload) => Promise<void>;
  isLoading: boolean;
  error: ProfileUpdateError | null;
}

/** Read VITE_LIVERRA_API_BASE_URL with a sane default; safe in non-Vite runners. */
function readApiBase(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const raw = meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1';
  return raw.replace(/\/$/, '');
}

/**
 * Parse a `problem+json` body (RFC 7807) into an Error with an optional
 * machine-readable `slug`. Falls back to generic status-line messaging
 * when the response isn't JSON.
 */
async function toProblemError(res: Response): Promise<ProfileUpdateError> {
  const fallback: ProfileUpdateError = Object.assign(
    new Error(`PUT /auth/me failed: ${res.status}`),
    { slug: undefined as string | undefined },
  );
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return fallback;
    const body = (await res.json()) as { title?: string; detail?: string; slug?: string };
    const message = body.detail ?? body.title ?? fallback.message;
    return Object.assign(new Error(message), { slug: body.slug });
  } catch {
    return fallback;
  }
}

/**
 * React hook exposing `{ update, isLoading, error }`. Components render
 * a Save button, call `update(payload)`, and surface `error` inline.
 *
 * @example
 * ```tsx
 * const { update, isLoading, error } = useProfileUpdate();
 * <EMRButton loading={isLoading} onClick={() => update({ display_name: name })}>
 *   Save
 * </EMRButton>
 * ```
 */
export function useProfileUpdate(): UseProfileUpdateResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ProfileUpdateError | null>(null);
  const { refresh } = useAuth();
  const queryClient = useQueryClient();

  const update = useCallback(
    async (payload: ProfileUpdatePayload): Promise<void> => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch(`${readApiBase()}/auth/me`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw await toProblemError(res);
        }
        // Invalidate any React Query caches that read `/auth/me` and also
        // trigger the stub-backed refresh — the two coexist while the auth
        // layer is mid-migration (see services/auth/index.ts header).
        await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
        try {
          await refresh();
        } catch {
          // `refresh()` throws when UserManager isn't wired (e.g. tests).
          // That's fine — the React Query invalidation above will re-fetch.
        }
      } catch (e) {
        const err = e instanceof Error ? (e as ProfileUpdateError) : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [queryClient, refresh],
  );

  return { update, isLoading, error };
}

export default useProfileUpdate;
