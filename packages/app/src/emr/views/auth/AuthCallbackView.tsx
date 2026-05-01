// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AuthCallbackView — OIDC redirect target.
 *
 * Plain-English: after Cognito finishes the hosted-UI flow, the browser
 * lands on `/auth/callback?code=…&state=…`. AuthContext (T117) is the
 * one that actually exchanges the code for tokens — this view just
 * gives the user a friendly "Completing sign-in…" while that happens
 * and forwards them once `useAuth().user` becomes non-null.
 *
 * Three render states:
 *   - LOADING (default): spinner + "Completing sign-in…"
 *   - ERROR (URL contains `?error=…`): humanized error + retry CTA
 *   - SUCCESS (user resolves): silently redirects via `<Navigate>`
 *
 * If the exchange takes longer than 8 s we surface a "still working…"
 * helper so users don't think the page froze.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Center,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconLogin2,
  IconShieldLock,
} from '@tabler/icons-react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { ReactElement } from 'react';

import { useAuth } from '../../services/auth';
import { LIVERRA_ROUTES } from '../../constants/routes';
import { EMRAlert, EMRButton } from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';

export default function AuthCallbackView(): ReactElement {
  const { t } = useTranslation();
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const oidcError = params.get('error');
  const oidcErrorDescription = params.get('error_description');
  const returnTo = params.get('returnTo') ?? LIVERRA_ROUTES.CASES_LIST;

  // After 8 seconds of waiting, surface a "still working" message so users
  // don't feel like the page hung. Cleared if user/error resolves first.
  const [slowExchange, setSlowExchange] = useState(false);
  useEffect(() => {
    if (oidcError || user) return;
    const timer = window.setTimeout(() => setSlowExchange(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [oidcError, user]);

  // Successful auth: hand control back to the route the user was trying
  // to reach (or /cases as the fallback home).
  if (user) {
    return <Navigate to={returnTo} replace />;
  }

  return (
    <Box
      data-testid="auth-callback-view"
      style={{
        minHeight: '100vh',
        width: '100%',
        position: 'relative',
        background:
          'radial-gradient(ellipse 90% 60% at 50% 0%, var(--emr-primary-alpha-08) 0%, transparent 60%), var(--emr-bg-page)',
        padding: 'clamp(24px, 6vw, 48px) 16px',
        display: 'flex',
      }}
    >
      <Center style={{ flex: 1, width: '100%' }}>
        <Stack gap="lg" align="center" style={{ width: '100%', maxWidth: 460 }}>
          <Box
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: oidcError
                ? 'var(--emr-error-alpha-10)'
                : 'var(--emr-gradient-primary)',
              color: oidcError ? 'var(--emr-error)' : 'var(--emr-text-inverse)',
              display: 'grid',
              placeItems: 'center',
              boxShadow: oidcError
                ? 'none'
                : '0 8px 20px var(--emr-secondary-alpha-25)',
            }}
          >
            {oidcError ? (
              <IconAlertTriangle size={28} stroke={1.8} />
            ) : (
              <IconShieldLock size={28} stroke={1.8} />
            )}
          </Box>

          {oidcError ? (
            // -------------------- ERROR STATE --------------------
            <Stack gap="md" align="center" style={{ width: '100%' }}>
              <Stack gap={6} align="center" style={{ textAlign: 'center' }}>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-xl)',
                    fontWeight: 'var(--emr-font-semibold)',
                    color: 'var(--emr-text-primary)',
                    lineHeight: 1.25,
                  }}
                >
                  {t('auth:callback.errorTitle')}
                </Text>
                <Text
                  size="sm"
                  style={{
                    color: 'var(--emr-text-secondary)',
                    lineHeight: 1.5,
                    maxWidth: 380,
                  }}
                >
                  {t('auth:callback.errorBody')}
                </Text>
              </Stack>

              <EMRAlert variant="error" data-testid="auth-callback-error">
                <Stack gap={4}>
                  <Text size="sm" fw={600}>
                    {oidcError}
                  </Text>
                  {oidcErrorDescription && (
                    <Text size="xs" style={{ lineHeight: 1.5 }}>
                      {oidcErrorDescription}
                    </Text>
                  )}
                </Stack>
              </EMRAlert>

              <Group gap="sm" wrap="wrap" justify="center">
                <EMRButton
                  variant="primary"
                  icon={IconLogin2}
                  onClick={() => {
                    signIn().catch((err) => {
                      console.error('[AuthCallback] retry signIn failed:', err);
                    });
                  }}
                  data-testid="auth-callback-retry"
                >
                  {t('auth:callback.retryCta')}
                </EMRButton>
                <EMRButton
                  variant="secondary"
                  onClick={() => navigate(LIVERRA_ROUTES.LANDING)}
                  data-testid="auth-callback-home"
                >
                  {t('auth:callback.homeCta')}
                </EMRButton>
              </Group>
            </Stack>
          ) : (
            // -------------------- LOADING STATE --------------------
            <Stack gap="md" align="center" style={{ textAlign: 'center' }}>
              <Group gap="xs" align="center" justify="center">
                <Loader
                  size="sm"
                  color="var(--emr-secondary)"
                  data-testid="auth-callback-spinner"
                />
                <Text
                  style={{
                    fontSize: 'var(--emr-font-lg)',
                    fontWeight: 'var(--emr-font-semibold)',
                    color: 'var(--emr-text-primary)',
                  }}
                >
                  {t('auth:callback.title')}
                </Text>
              </Group>
              <Text
                size="sm"
                style={{
                  color: 'var(--emr-text-secondary)',
                  lineHeight: 1.5,
                  maxWidth: 380,
                }}
              >
                {t('auth:callback.body')}
              </Text>

              {slowExchange && (
                <EMRAlert variant="warning" data-testid="auth-callback-slow">
                  <Text size="xs">{t('auth:callback.slow')}</Text>
                </EMRAlert>
              )}
            </Stack>
          )}
        </Stack>
      </Center>
    </Box>
  );
}
