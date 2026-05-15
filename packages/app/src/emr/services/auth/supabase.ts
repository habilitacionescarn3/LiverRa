// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Supabase Auth client singleton + thin helpers.
 *
 * Bridges Supabase's email/password auth into LiverRa's existing
 * AuthContext shape: getCurrentAccessToken() reads the active Supabase
 * session.access_token; the SigninView calls signInWithPassword / signUp.
 *
 * Reads from VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (set in
 * Netlify env). If either is missing the client is null — getCurrentSupabaseToken()
 * returns null and the app falls back to the dev-bypass behaviour.
 */

import {
  createClient,
  type Session,
  type SupabaseClient,
  type User as SbUser,
  type AuthError,
} from '@supabase/supabase-js';

function readEnv(): { url?: string; key?: string } {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return { url: env.VITE_SUPABASE_URL, key: env.VITE_SUPABASE_ANON_KEY };
}

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_client) return _client;
  const { url, key } = readEnv();
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  });
  return _client;
}

let _cachedSession: Session | null = null;

/**
 * Subscribe to Supabase session changes; updates the cached token used by
 * getCurrentSupabaseToken(). Idempotent — safe to call multiple times.
 */
export function initSupabaseAuth(): () => void {
  const client = getSupabaseClient();
  if (!client) return () => {};
  client.auth.getSession().then(({ data }) => {
    _cachedSession = data.session;
  });
  const { data: sub } = client.auth.onAuthStateChange((_evt, session) => {
    _cachedSession = session;
  });
  return () => sub.subscription.unsubscribe();
}

/** Return the current Supabase access_token, or null if not signed in. */
export function getCurrentSupabaseToken(): string | null {
  const tok = _cachedSession?.access_token;
  return typeof tok === 'string' && tok.length > 0 ? tok : null;
}

export function getCurrentSupabaseUser(): SbUser | null {
  return _cachedSession?.user ?? null;
}

export interface SupabaseAuthResult {
  ok: boolean;
  message?: string;
  needsConfirmation?: boolean;
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<SupabaseAuthResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, message: 'Supabase auth not configured' };
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) return { ok: false, message: friendlyError(error) };
  // If email confirmations are on, data.session is null until confirmed.
  return { ok: true, needsConfirmation: !data.session };
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SupabaseAuthResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, message: 'Supabase auth not configured' };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyError(error) };
  _cachedSession = data.session;
  return { ok: true };
}

export async function signOutSupabase(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  await client.auth.signOut();
  _cachedSession = null;
}

function friendlyError(err: AuthError): string {
  const msg = err.message || 'Authentication failed';
  // Supabase returns "Invalid login credentials" for both wrong-pw and
  // unknown-email — keep it as-is, friendlier than the raw error.
  return msg;
}
