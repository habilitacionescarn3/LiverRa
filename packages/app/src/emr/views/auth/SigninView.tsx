// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SigninView — LiverRa sign-in surface.
 *
 * Minimal non-designer implementation so the landing-page "Sign in" CTA
 * lands on something useful instead of `<div>TODO</div>`. The polished,
 * translated, brand-aligned version is a separate frontend-designer task.
 *
 * Two paths:
 *   - Cognito (real): calls `useAuth().signIn()` → OIDC redirect. Only
 *     enabled when the relevant `VITE_LIVERRA_OIDC_*` env vars are set.
 *   - Dev bypass: if the user is already primed (AuthContext dev branch),
 *     we auto-redirect to `returnTo` — no extra click required.
 */

import { useEffect } from 'react';
import { Paper, Title, Text, Stack, Container, Alert } from '@mantine/core';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../../services/auth';
import { LIVERRA_ROUTES } from '../../constants/routes';
import { EMRButton } from '../../components/common';

function readMeta(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

export default function SigninView(): JSX.Element {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const returnTo = params.get('returnTo') ?? LIVERRA_ROUTES.CASES_LIST;

  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, returnTo, navigate]);

  const meta = readMeta();
  const oidcConfigured = Boolean(
    meta.VITE_LIVERRA_OIDC_AUTHORITY && meta.VITE_LIVERRA_OIDC_CLIENT_ID,
  );
  const isDev = Boolean(import.meta.env.DEV);
  const devBypassActive = isDev && meta.VITE_LIVERRA_DEV_BYPASS === 'true';

  const handleSignIn = (): void => {
    signIn().catch((err) => {
      console.error('[SigninView] signIn failed:', err);
    });
  };

  return (
    <Container size="xs" py="xl">
      <Paper withBorder p="xl" radius="md" shadow="sm">
        <Stack gap="md">
          <Stack gap={4}>
            <Title order={2}>Sign in to LiverRa</Title>
            <Text size="sm" c="dimmed">
              Research Use Only — not for clinical use
            </Text>
          </Stack>

          <EMRButton size="md" onClick={handleSignIn} disabled={!oidcConfigured} fullWidth>
            Sign in with Cognito
          </EMRButton>

          {isDev && !oidcConfigured && !devBypassActive && (
            <Alert color="yellow" variant="light" title="Dev mode">
              <Text size="xs">
                Cognito is not configured. To click through the app locally, add
                <br />
                <code>VITE_LIVERRA_DEV_BYPASS=true</code>
                <br />
                to <code>packages/app/.env.local</code> and restart the dev
                server. You&apos;ll be signed in automatically as a dev user
                with all permissions.
              </Text>
            </Alert>
          )}

          {devBypassActive && (
            <Alert color="blue" variant="light" title="Dev bypass active">
              <Text size="xs">
                Signing you in as the local dev user…
              </Text>
            </Alert>
          )}
        </Stack>
      </Paper>
    </Container>
  );
}
