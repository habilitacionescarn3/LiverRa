// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth barrel + `useAuth()` hook (T048).
 *
 * This module is the single import site for the app's authentication
 * surface. It re-exports `oidcClient.ts` helpers and provides the React
 * hook that components use to access user / tenant / permissions state and
 * trigger sign-in / sign-out / step-up.
 *
 * The hook reads from an `AuthContext` that another agent (T117) wires
 * into the provider tree. While that wiring is pending we fall back to a
 * module-local IIFE cache so downstream UI work can import `useAuth()`
 * and the compiler stays happy. Once `AuthContext` lands, the only change
 * needed here is to flip the `useContext(AuthContext)` branch on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User, UserManager } from 'oidc-client-ts';

import {
  createOidcClient,
  decodeAccessToken,
  extractAuthTime,
  type CognitoAccessTokenClaims,
  type CreateOidcClientOptions,
} from './oidcClient';

export { createOidcClient, decodeAccessToken, extractAuthTime };
export type { CognitoAccessTokenClaims, CreateOidcClientOptions };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  /** Cognito sub (stable UUID). */
  id: string;
  /** Primary email (from the ID token / user info endpoint). */
  email: string | null;
  /** Display name, when available. */
  name: string | null;
}

export interface AuthTenant {
  /** `custom:tenant_id` claim. */
  id: string;
}

export interface UseAuthResult {
  /** Null while unauthenticated or while the initial load is in-flight. */
  user: AuthUser | null;
  /** Null until the first successful authentication. */
  tenant: AuthTenant | null;
  /** Flat permissions list derived from the access token + server grants. */
  permissions: readonly string[];
  /** `true` during initial user-manager load + any active sign-in redirect. */
  isLoading: boolean;
  /** Start the Cognito Authorization Code flow. Resolves when the redirect begins. */
  signIn: () => Promise<void>;
  /** Revoke tokens + return the user to the post-logout URL. */
  signOut: () => Promise<void>;
  /** Force a token refresh (silent if possible). */
  refresh: () => Promise<void>;
  /** Request a fresh MFA challenge; resolves after the step-up completes. */
  challengeStepUp: (permission: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Stub cache — replaced by AuthContext (T117) once the provider is wired.
// ---------------------------------------------------------------------------

interface AuthStubState {
  manager: UserManager | null;
  user: User | null;
  permissions: readonly string[];
  listeners: Set<() => void>;
}

const authStub: AuthStubState = (() => ({
  manager: null,
  user: null,
  permissions: [],
  listeners: new Set(),
}))();

function notifyAuthStub(): void {
  for (const listener of authStub.listeners) listener();
}

/**
 * Escape-hatch: lets T117's `AuthContext` provider inject the live
 * UserManager + current user into the stub before it ships the real
 * context. Unit tests can also use it to prime auth state without a
 * provider tree.
 */
export function __setAuthStub(patch: Partial<Pick<AuthStubState, 'manager' | 'user' | 'permissions'>>): void {
  if (patch.manager !== undefined) authStub.manager = patch.manager;
  if (patch.user !== undefined) authStub.user = patch.user;
  if (patch.permissions !== undefined) authStub.permissions = patch.permissions;
  notifyAuthStub();
}

function subscribeAuthStub(listener: () => void): () => void {
  authStub.listeners.add(listener);
  return () => authStub.listeners.delete(listener);
}

/**
 * Return the current Cognito JWT access token, or null if the user is
 * signed out. Synchronous + safe to call from non-React code (e.g., the
 * DICOMweb client's request-time auth callback).
 *
 * IMPORTANT: in production builds this MUST return a non-null token for
 * any PACS / API call. The DICOMweb client adds a runtime guard that
 * throws if this returns null while ``import.meta.env.PROD`` is true —
 * earlier code hardcoded the callback to ``() => null``, which silently
 * sent every QIDO/WADO/STOW request with no Authorization header (audit
 * B-PACS-3).
 */
export function getCurrentAccessToken(): string | null {
  const token = authStub.user?.access_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null;
  const profile = user.profile ?? {};
  return {
    id: String(profile.sub ?? ''),
    email: typeof profile.email === 'string' ? profile.email : null,
    name: typeof profile.name === 'string' ? profile.name : null,
  };
}

function toAuthTenant(user: User | null): AuthTenant | null {
  const claims = decodeAccessToken(user);
  const id = claims?.['custom:tenant_id'];
  return id ? { id: String(id) } : null;
}

/**
 * Primary auth hook. Consumers pattern:
 *
 * ```tsx
 * const { user, permissions, signIn, challengeStepUp } = useAuth();
 * if (!user) return <SignInButton onClick={signIn} />;
 * ```
 */
export function useAuth(): UseAuthResult {
  // T117 will replace this with `useContext(AuthContext)`. Until then we
  // subscribe to the stub; the hook signature remains stable across the swap.
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeAuthStub(() => setTick((t) => t + 1)), []);

  const [isLoading, setIsLoading] = useState<boolean>(!authStub.user);

  useEffect(() => {
    if (authStub.user) setIsLoading(false);
  }, [tick]);

  const userObj = authStub.user;

  const user = useMemo(() => toAuthUser(userObj), [userObj]);
  const tenant = useMemo(() => toAuthTenant(userObj), [userObj]);
  const permissions = authStub.permissions;

  const requireManager = useCallback((): UserManager => {
    const manager = authStub.manager;
    if (!manager) {
      throw new Error(
        'useAuth: UserManager not initialised. AuthContext (T117) must call ' +
          '__setAuthStub({ manager }) before useAuth is used.',
      );
    }
    return manager;
  }, []);

  const signIn = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    await requireManager().signinRedirect();
  }, [requireManager]);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await requireManager().signoutRedirect();
    } finally {
      __setAuthStub({ user: null, permissions: [] });
    }
  }, [requireManager]);

  const refresh = useCallback(async (): Promise<void> => {
    const next = await requireManager().signinSilent();
    if (next) __setAuthStub({ user: next });
  }, [requireManager]);

  const challengeStepUp = useCallback(
    async (_permission: string): Promise<void> => {
      // `max_age=0` forces Cognito to re-issue the MFA challenge regardless
      // of how recently the user signed in. The permission string is
      // forwarded as extra query state so the hosted UI / custom sign-in
      // page can surface context ("Finalise report requires re-auth").
      const manager = requireManager();
      await manager.signinRedirect({
        extraQueryParams: {
          max_age: '0',
          scope: 'openid email profile',
        },
        extraTokenParams: {
          // Non-standard, consumed by the custom sign-in page only.
          liverra_step_up_for: _permission,
        },
      });
    },
    [requireManager],
  );

  return {
    user,
    tenant,
    permissions,
    isLoading,
    signIn,
    signOut,
    refresh,
    challengeStepUp,
  };
}

export default useAuth;
