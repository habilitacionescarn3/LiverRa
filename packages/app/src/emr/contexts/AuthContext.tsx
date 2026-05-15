// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AuthContext (T116).
 *
 * Plain-English: the front-door controller. When the app boots, this
 * provider (a) asks the OIDC library "are we signed in right now?",
 * (b) if yes, calls `/api/v1/auth/me` to get the user's tenant + full
 * permission list, and (c) tells every other piece of the app via the
 * `useAuth()` hook.
 *
 * Why a wrapper over the existing `useAuth()` stub?
 *   `services/auth/index.ts` shipped earlier (T048) with a
 *   module-local stub + `__setAuthStub()` escape hatch so other code
 *   could import `useAuth()` before the provider landed. This file is
 *   that provider: it drives the stub's state. Any component calling
 *   `useAuth()` keeps working because the stub's listeners wake them up
 *   on every state change.
 *
 * Side-effects this provider owns:
 *   - Creates the OIDC `UserManager` from `VITE_LIVERRA_OIDC_*` env.
 *   - On silent-renew success / token expiry, re-primes the stub.
 *   - Exposes a minimal `AuthContextValue` (user / tenant / permissions /
 *     isLoading + sign-in / sign-out / refresh / challengeStepUp) for
 *     components that prefer context over the stub-backed hook.
 *
 * Spec references: T116, plan.md §477-484 (Frontend RBAC), research §A.1.
 */

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { User, UserManager } from 'oidc-client-ts';

import { createOidcClient, decodeAccessToken, extractAuthTime } from '../services/auth/oidcClient';
import { __setAuthStub, useAuth as useAuthHook } from '../services/auth';
import { LIVERRA_PERMISSIONS } from '../constants/permissions.gen';

// ---------------------------------------------------------------------------
// Context value
// ---------------------------------------------------------------------------

export interface AuthContextUser {
  id: string;
  email: string | null;
  name: string | null;
  /** Cognito `sub` — same as `id`, kept separately so callers can be explicit. */
  cognito_sub: string;
}

export interface AuthContextTenant {
  id: string;
}

export interface AuthContextValue {
  user: AuthContextUser | null;
  tenant: AuthContextTenant | null;
  permissions: readonly string[];
  /** `auth_time` claim (Unix seconds) — used by step-up guards. */
  authTime: number | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  challengeStepUp: (permission: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Env loader — tolerates missing vars so dev/tests can mount the provider
// without exploding. When unset we simply never create a UserManager and
// the app behaves as "unauthenticated".
// ---------------------------------------------------------------------------

interface OidcEnv {
  authority: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri?: string;
  apiBaseUrl: string;
}

function readOidcEnv(): OidcEnv | null {
  // Vite exposes env on `import.meta.env`; guard for non-Vite test runners.
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const authority = meta.VITE_LIVERRA_OIDC_AUTHORITY;
  const clientId = meta.VITE_LIVERRA_OIDC_CLIENT_ID;
  const redirectUri = meta.VITE_LIVERRA_OIDC_REDIRECT_URI;
  const apiBaseUrl = meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1';
  if (!authority || !clientId || !redirectUri) return null;
  return {
    authority,
    clientId,
    redirectUri,
    postLogoutRedirectUri: meta.VITE_LIVERRA_OIDC_POST_LOGOUT_URI,
    apiBaseUrl,
  };
}

// ---------------------------------------------------------------------------
// /auth/me response shape
// ---------------------------------------------------------------------------

interface AuthMeResponse {
  user: { id: string; email: string | null; name?: string | null };
  tenant: { id: string };
  permissions: readonly string[];
}

async function fetchAuthMe(apiBaseUrl: string, accessToken: string): Promise<AuthMeResponse | null> {
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthMeResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface AuthProviderProps {
  children: ReactNode;
  /**
   * Optional dependency-injection hook for tests: supply a pre-built
   * UserManager + `/auth/me` result synchronously. When omitted, the
   * provider reads env + creates its own client.
   */
  testOverrides?: {
    manager?: UserManager | null;
    initialUser?: User | null;
    authMe?: AuthMeResponse | null;
  };
}

export function AuthProvider({ children, testOverrides }: AuthProviderProps): JSX.Element {
  const managerRef = useRef<UserManager | null>(null);
  const envRef = useRef<OidcEnv | null>(null);

  // L-HOOK-4 / H-HOOK-3: capture ``testOverrides`` once at mount so the
  // init effect (deps ``[]``) reads a stable value. Swapping overrides
  // post-mount would change semantics in a test but never in prod, and
  // the alternative — listing them in deps — re-runs the entire init
  // including ``manager.events.addUserLoaded`` subscriptions.
  const overridesRef = useRef(testOverrides);

  const [user, setUser] = useState<User | null>(testOverrides?.initialUser ?? null);
  const [authMe, setAuthMe] = useState<AuthMeResponse | null>(testOverrides?.authMe ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(!testOverrides);

  // One-time init: build UserManager, subscribe to its events, load initial user.
  useEffect(() => {
    let cancelled = false;
    const testOverrides = overridesRef.current;

    if (testOverrides) {
      managerRef.current = testOverrides.manager ?? null;
      if (managerRef.current) {
        __setAuthStub({
          manager: managerRef.current,
          user: testOverrides.initialUser ?? null,
          permissions: testOverrides.authMe?.permissions ?? [],
        });
      }
      return;
    }

    const env = readOidcEnv();
    envRef.current = env;
    if (!env) {
      // Dev-only bypass: let the founder click through the app locally
      // without Cognito + API server. Gated behind BOTH `import.meta.env.DEV`
      // AND an explicit flag — Vite tree-shakes the branch out of prod.
      const meta =
        (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
      // Staging deploy (Netlify build) — bypass after the credentials gate
      // (SigninView) sets `liverra:staging-auth=ok` in localStorage. Without
      // that flag the user lands on /signin and is forced to enter the
      // shared staging credentials.
      // When staging creds are configured (locally OR on Netlify) the gate
      // owns the flow — dev-bypass is suppressed so `vite dev` mirrors
      // staging instead of silently auto-signing the dev user in.
      const stagingGateConfigured =
        Boolean(meta.VITE_LIVERRA_STAGING_EMAIL) &&
        Boolean(meta.VITE_LIVERRA_STAGING_PASSWORD);
      const stagingGatePassed =
        stagingGateConfigured &&
        typeof window !== 'undefined' &&
        window.localStorage?.getItem('liverra:staging-auth') === 'ok';
      const devBypassActive =
        !stagingGateConfigured &&
        import.meta.env.DEV &&
        meta.VITE_LIVERRA_DEV_BYPASS === 'true';
      if (devBypassActive || stagingGatePassed) {
        const mockUser = {
          profile: { sub: 'dev-user', email: 'dev@liverra.local', name: 'Dev User' },
          access_token: 'dev-access-token',
          expired: false,
        } as unknown as User;
        __setAuthStub({
          user: mockUser,
          permissions: [...LIVERRA_PERMISSIONS],
        });
        setIsLoading(false);
        return;
      }
      // No OIDC configured → treat as unauthenticated + stop loading so
      // consumers render their signed-out state instead of a spinner.
      setIsLoading(false);
      return;
    }

    const manager = createOidcClient({
      authority: env.authority,
      client_id: env.clientId,
      redirect_uri: env.redirectUri,
      post_logout_redirect_uri: env.postLogoutRedirectUri,
    });
    managerRef.current = manager;
    __setAuthStub({ manager });

    const onUserLoaded = (next: User): void => {
      if (cancelled) return;
      setUser(next);
      __setAuthStub({ user: next });
      void refreshAuthMe(next);
    };
    const onUserUnloaded = (): void => {
      if (cancelled) return;
      setUser(null);
      setAuthMe(null);
      __setAuthStub({ user: null, permissions: [] });
    };
    const onSilentRenewError = (): void => {
      // Silent renew failed → force sign-in round-trip on next protected action.
      if (cancelled) return;
      setUser(null);
      setAuthMe(null);
      __setAuthStub({ user: null, permissions: [] });
    };

    manager.events.addUserLoaded(onUserLoaded);
    manager.events.addUserUnloaded(onUserUnloaded);
    manager.events.addSilentRenewError(onSilentRenewError);

    // Initial bootstrap: if a session already exists, hydrate it.
    (async () => {
      try {
        const existing = await manager.getUser();
        if (cancelled) return;
        if (existing && !existing.expired) {
          setUser(existing);
          __setAuthStub({ user: existing });
          await refreshAuthMe(existing);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    async function refreshAuthMe(u: User): Promise<void> {
      if (!envRef.current) return;
      const token = u.access_token;
      if (!token) return;
      const me = await fetchAuthMe(envRef.current.apiBaseUrl, token);
      if (cancelled) return;
      setAuthMe(me);
      __setAuthStub({ permissions: me?.permissions ?? [] });
    }

    return () => {
      cancelled = true;
      manager.events.removeUserLoaded(onUserLoaded);
      manager.events.removeUserUnloaded(onUserUnloaded);
      manager.events.removeSilentRenewError(onSilentRenewError);
    };
  }, []);

  // ------------------ Derived values ------------------

  const derivedUser = useMemo<AuthContextUser | null>(() => {
    if (!user) return null;
    const profile = user.profile ?? {};
    const sub = String(profile.sub ?? '');
    return {
      id: authMe?.user.id ?? sub,
      cognito_sub: sub,
      email: authMe?.user.email ?? (typeof profile.email === 'string' ? profile.email : null),
      name: authMe?.user.name ?? (typeof profile.name === 'string' ? profile.name : null),
    };
  }, [user, authMe]);

  const derivedTenant = useMemo<AuthContextTenant | null>(() => {
    if (authMe) return { id: authMe.tenant.id };
    const claims = decodeAccessToken(user);
    const tid = claims?.['custom:tenant_id'];
    return tid ? { id: String(tid) } : null;
  }, [user, authMe]);

  const permissions = authMe?.permissions ?? [];
  const authTime = extractAuthTime(user);

  // ------------------ Actions (delegate to the stub-backed hook) ------------------
  // We intentionally call the existing hook's functions rather than re-implementing
  // them — keeps both surfaces (context + hook) in sync.
  const stubHook = useAuthHook();
  const signIn = useCallback(() => stubHook.signIn(), [stubHook]);
  const signOut = useCallback(() => stubHook.signOut(), [stubHook]);
  const refresh = useCallback(() => stubHook.refresh(), [stubHook]);
  const challengeStepUp = useCallback(
    (permission: string) => stubHook.challengeStepUp(permission),
    [stubHook],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user: derivedUser,
      tenant: derivedTenant,
      permissions,
      authTime,
      isLoading,
      signIn,
      signOut,
      refresh,
      challengeStepUp,
    }),
    [derivedUser, derivedTenant, permissions, authTime, isLoading, signIn, signOut, refresh, challengeStepUp],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Optional direct accessor. Most code should continue to use the
 * `useAuth()` hook from `services/auth` — it's stub-backed and works
 * without requiring callers to mount `AuthProvider` in unit tests.
 * Use this hook when you explicitly need the provider-backed shape.
 */
export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext must be used inside <AuthProvider>');
  }
  return ctx;
}
