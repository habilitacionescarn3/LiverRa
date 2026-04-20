// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC client wrapper for Cognito (T046).
 *
 * Thin facade over `oidc-client-ts` that:
 *   - Preconfigures a `UserManager` for Authorization Code + PKCE against
 *     Cognito.
 *   - Enables silent renew via a hidden iframe (no user visible re-prompt).
 *   - Exposes `extractAuthTime()` so the step-up flow can decide whether a
 *     sensitive action (report finalize, erasure) needs a fresh MFA challenge.
 *
 * Callers (`useAuth()` + `AuthContext`) should treat this module as the only
 * place that talks to the OIDC library — swapping providers later is then a
 * single-file change.
 *
 * Spec reference: T046, research.md §A.1, plan.md §Authentication.
 */

import { UserManager, WebStorageStateStore, type UserManagerSettings, type User } from 'oidc-client-ts';
import { jwtDecode } from 'jwt-decode';

/** Options accepted by {@link createOidcClient}. */
export interface CreateOidcClientOptions {
  /** Cognito issuer URL, e.g. `https://cognito-idp.eu-central-1.amazonaws.com/<pool-id>`. */
  authority: string;
  /** Cognito app client ID. */
  client_id: string;
  /** Callback URL registered with the Cognito app client. */
  redirect_uri: string;
  /** Where Cognito should send the user after logout. */
  post_logout_redirect_uri?: string;
  /** Override the default OAuth scopes (`openid email profile`). */
  scope?: string;
  /** Override the silent-renew callback path (default: `${origin}/auth/silent-callback.html`). */
  silent_redirect_uri?: string;
}

/**
 * JWT claim shape we care about. Cognito adds `cognito:groups`,
 * `custom:tenant_id`, and the standard `auth_time`.
 */
export interface CognitoAccessTokenClaims {
  sub: string;
  iss: string;
  client_id?: string;
  exp: number;
  iat: number;
  /** Unix seconds — timestamp of the last successful MFA challenge. */
  auth_time?: number;
  token_use?: 'access' | 'id';
  'cognito:groups'?: string[];
  'custom:tenant_id'?: string;
}

/**
 * Build a configured `UserManager`. Settings enforce silent-renew, PKCE
 * (implicit is never allowed), and web-local storage for the user state
 * (session tokens are kept in sessionStorage so they clear on tab close).
 */
export function createOidcClient(options: CreateOidcClientOptions): UserManager {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const settings: UserManagerSettings = {
    authority: options.authority,
    client_id: options.client_id,
    redirect_uri: options.redirect_uri,
    post_logout_redirect_uri:
      options.post_logout_redirect_uri ?? `${origin}/auth/logout`,
    silent_redirect_uri:
      options.silent_redirect_uri ?? `${origin}/auth/silent-callback.html`,
    response_type: 'code',
    scope: options.scope ?? 'openid email profile',

    // Silent renew in a hidden iframe — no user-visible prompt when
    // refreshing tokens while the tab is open.
    automaticSilentRenew: true,
    silentRequestTimeoutInSeconds: 10,

    // sessionStorage: cleared on tab close → single-session semantics.
    // Matches the "short access token, sliding refresh" posture in
    // deploy/terraform/cognito.tf (1h access / 30d refresh).
    userStore: new WebStorageStateStore({
      store: typeof window !== 'undefined' ? window.sessionStorage : undefined,
    }),
    stateStore: new WebStorageStateStore({
      store: typeof window !== 'undefined' ? window.sessionStorage : undefined,
    }),

    // Defensive: reject tokens where `auth_time` is missing so the step-up
    // gate can never silently succeed.
    loadUserInfo: false,
    monitorSession: false,
  };

  return new UserManager(settings);
}

/**
 * Extract `auth_time` (Unix seconds) from an OIDC `User`'s access token.
 * Used by `useAuth().challengeStepUp(...)` to decide whether a fresh MFA
 * challenge is needed before a sensitive action.
 *
 * Returns `null` if the token is missing, unparseable, or does not carry
 * an `auth_time` claim.
 */
export function extractAuthTime(user: User | null | undefined): number | null {
  const token = user?.access_token;
  if (!token) {
    return null;
  }
  try {
    const claims = jwtDecode<CognitoAccessTokenClaims>(token);
    if (typeof claims.auth_time === 'number') {
      return claims.auth_time;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Helper: decode the access token into the shape the API middleware sees.
 * Returns `null` when decoding fails — callers should treat that as
 * "not authenticated".
 */
export function decodeAccessToken(
  user: User | null | undefined,
): CognitoAccessTokenClaims | null {
  const token = user?.access_token;
  if (!token) return null;
  try {
    return jwtDecode<CognitoAccessTokenClaims>(token);
  } catch {
    return null;
  }
}
