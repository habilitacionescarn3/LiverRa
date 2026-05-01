// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SigninView — LiverRa sign-in surface.
 *
 * Plain-English: this is the page that hospital staff land on when they
 * click "Sign in" anywhere in the app. It looks like a serious medical
 * tool (centered glass-style card, brand wordmark, subtle aurora behind
 * it) rather than a consumer signup screen. Two ways to authenticate:
 *
 *   - Cognito SSO (real prod path) — calls `useAuth().signIn()` which
 *     starts the OIDC redirect. Only available when env vars are set.
 *   - Dev bypass — when `VITE_LIVERRA_DEV_BYPASS=true`, AuthContext
 *     auto-primes a fake user; we just redirect to `returnTo`.
 *
 * The email + password fields are intentionally non-functional today —
 * Cognito handles credentials on the hosted UI side. We render them
 * disabled with a "Use SSO" hint so the layout is review-ready for the
 * password-gate feature shipping in parallel.
 */

import { useEffect } from 'react';
import {
  Box,
  Center,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconLock,
  IconMail,
  IconShieldLock,
} from '@tabler/icons-react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';

import { useAuth } from '../../services/auth';
import { LIVERRA_ROUTES } from '../../constants/routes';
import { EMRAlert, EMRButton } from '../../components/common';
import { EMRTextInput } from '../../components/shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';

function readMeta(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

export default function SigninView(): JSX.Element {
  const { t } = useTranslation();
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

  const handleFormSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (oidcConfigured) handleSignIn();
  };

  return (
    <Box
      data-testid="signin-view"
      style={{
        minHeight: '100vh',
        width: '100%',
        position: 'relative',
        background:
          'radial-gradient(ellipse 90% 60% at 50% 0%, var(--emr-primary-alpha-08) 0%, transparent 60%), var(--emr-bg-page)',
        padding: 'clamp(24px, 6vw, 48px) 16px',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* anatomical grid mesh — purely decorative */}
      <Box
        aria-hidden
        style={{
          position: 'absolute',
          inset: '0 0 auto 0',
          height: 360,
          pointerEvents: 'none',
          opacity: 0.4,
          backgroundImage:
            'linear-gradient(var(--emr-primary-alpha-04) 1px, transparent 1px), linear-gradient(90deg, var(--emr-primary-alpha-04) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage:
            'radial-gradient(ellipse 60% 60% at 50% 30%, #000 0%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 60% 60% at 50% 30%, #000 0%, transparent 75%)',
        }}
      />

      <Center style={{ flex: 1, width: '100%', position: 'relative' }}>
        <Stack gap="lg" style={{ width: '100%', maxWidth: 440 }}>
          {/* Brand */}
          <Stack gap={6} align="center">
            <Box
              aria-hidden
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: 'var(--emr-gradient-primary)',
                color: 'var(--emr-text-inverse)',
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 8px 20px var(--emr-secondary-alpha-25)',
              }}
            >
              <IconShieldLock size={28} stroke={1.8} />
            </Box>
            <Text
              style={{
                fontSize: 'clamp(28px, 4vw, 34px)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.05,
                marginTop: 8,
                backgroundImage:
                  'linear-gradient(135deg, var(--emr-text-primary) 0%, var(--emr-secondary) 60%, var(--emr-accent) 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              LiverRa
            </Text>
            <Text
              size="sm"
              style={{
                color: 'var(--emr-text-secondary)',
                textAlign: 'center',
                lineHeight: 1.5,
                maxWidth: 340,
              }}
            >
              {t('auth:signin.subtitle')}
            </Text>
          </Stack>

          {/* Card */}
          <Box
            component="form"
            onSubmit={handleFormSubmit}
            style={{
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
              borderRadius: 16,
              boxShadow: 'var(--emr-shadow-md)',
              padding: 'clamp(20px, 4vw, 32px)',
            }}
          >
            <Stack gap="md">
              <Text
                style={{
                  fontSize: 'var(--emr-font-lg)',
                  fontWeight: 'var(--emr-font-semibold)',
                  color: 'var(--emr-text-primary)',
                }}
              >
                {t('auth:signin.title')}
              </Text>

              {devBypassActive && (
                <EMRAlert variant="info" data-testid="signin-dev-bypass">
                  {t('auth:signin.devBypassActive')}
                </EMRAlert>
              )}

              <EMRTextInput
                label={t('auth:signin.emailLabel')}
                placeholder={t('auth:signin.emailPlaceholder')}
                type="email"
                autoComplete="email"
                leftSection={<IconMail size={16} />}
                disabled
                data-testid="signin-email"
                description={t('auth:signin.emailHelper')}
              />

              <EMRTextInput
                label={t('auth:signin.passwordLabel')}
                placeholder={t('auth:signin.passwordPlaceholder')}
                type="password"
                autoComplete="current-password"
                leftSection={<IconLock size={16} />}
                disabled
                data-testid="signin-password"
              />

              <Tooltip
                label={
                  oidcConfigured
                    ? t('auth:signin.cta')
                    : t('auth:signin.notConfiguredHint')
                }
                disabled={oidcConfigured}
                withArrow
                position="top"
              >
                <Box>
                  <EMRButton
                    type="submit"
                    variant="primary"
                    size="md"
                    onClick={handleSignIn}
                    disabled={!oidcConfigured}
                    fullWidth
                    icon={IconShieldLock}
                    data-testid="signin-cta"
                  >
                    {t('auth:signin.cta')}
                  </EMRButton>
                </Box>
              </Tooltip>

              {isDev && !oidcConfigured && !devBypassActive && (
                <EMRAlert
                  variant="warning"
                  icon={IconAlertTriangle}
                  data-testid="signin-dev-hint"
                >
                  <Stack gap={4}>
                    <Text size="sm" fw={600}>
                      {t('auth:signin.devHintTitle')}
                    </Text>
                    <Text size="xs" style={{ lineHeight: 1.5 }}>
                      {t('auth:signin.devHintBody')}
                    </Text>
                  </Stack>
                </EMRAlert>
              )}

              <Group gap={4} justify="center" wrap="wrap">
                <Text size="xs" style={{ color: 'var(--emr-text-tertiary)' }}>
                  {t('auth:signin.helpPrefix')}
                </Text>
                <a
                  href="mailto:support@liverra.ai"
                  style={{
                    fontSize: 'var(--emr-font-xs)',
                    color: 'var(--emr-secondary)',
                    textDecoration: 'none',
                    fontWeight: 500,
                  }}
                >
                  {t('auth:signin.helpLink')}
                </a>
              </Group>
            </Stack>
          </Box>

          {/* RUO disclaimer footer */}
          <Group
            gap={8}
            justify="center"
            wrap="nowrap"
            align="center"
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              background: 'var(--emr-warning-alpha-10)',
              border: '1px solid var(--emr-warning-alpha-20)',
              color: 'var(--emr-warning)',
              alignSelf: 'center',
              maxWidth: '100%',
            }}
          >
            <IconAlertTriangle size={14} stroke={2.2} />
            <Text
              size="xs"
              style={{
                fontWeight: 'var(--emr-font-semibold)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: 'inherit',
              }}
            >
              {t('common:ruo.notice')}
            </Text>
          </Group>

          <Text
            size="xs"
            style={{
              color: 'var(--emr-text-tertiary)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}
          >
            <Link
              to={LIVERRA_ROUTES.LANDING}
              style={{
                color: 'var(--emr-text-tertiary)',
                textDecoration: 'none',
              }}
            >
              {t('auth:signin.backToHome')}
            </Link>
          </Text>
        </Stack>
      </Center>
    </Box>
  );
}
