// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * SigninView — LiverRa sign-in surface.
 *
 * Plain-English: this is the page that hospital staff land on when they
 * click "Sign in" anywhere in the app. It looks like a serious medical
 * tool (centered glass-style card, brand wordmark, trust signals, subtle
 * aurora behind it) rather than a consumer signup screen. Two ways to
 * authenticate:
 *
 *   - Cognito SSO (real prod path) — calls `useAuth().signIn()` which
 *     starts the OIDC redirect. Only available when env vars are set.
 *   - Staging credentials gate — when VITE_LIVERRA_STAGING_EMAIL +
 *     PASSWORD are baked in, the form accepts those creds and writes the
 *     staging-auth marker to localStorage; AuthContext picks it up on the
 *     next mount and primes the dev user.
 *   - Dev bypass — when `VITE_LIVERRA_DEV_BYPASS=true` AND no staging
 *     gate, AuthContext auto-primes a fake user; we redirect to `returnTo`.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Center, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCircleCheck,
  IconLock,
  IconMail,
  IconShieldCheck,
  IconShieldLock,
  IconWorldPin,
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

/**
 * Tiny inline pill used for trust signals (HIPAA, GDPR, encryption).
 * Stays light — `var(--emr-bg-card)` background with a subtle ring.
 */
function TrustChip({
  icon: Icon,
  label,
}: {
  icon: typeof IconShieldCheck;
  label: string;
}): JSX.Element {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      style={{
        flexShrink: 0,
        padding: '6px 12px',
        borderRadius: 999,
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        boxShadow: 'var(--emr-shadow-sm)',
        color: 'var(--emr-text-secondary)',
      }}
    >
      <Box
        component={Icon}
        aria-hidden
        size={14}
        stroke={1.8}
        style={{ color: 'var(--emr-success)', flexShrink: 0 }}
      />
      <Text
        style={{
          fontSize: 'var(--emr-font-xs)',
          fontWeight: 'var(--emr-font-medium)',
          color: 'var(--emr-text-secondary)',
          whiteSpace: 'nowrap',
          lineHeight: 1,
        }}
      >
        {label}
      </Text>
    </Group>
  );
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

  // Staging credentials gate. Reads VITE_LIVERRA_STAGING_EMAIL +
  // VITE_LIVERRA_STAGING_PASSWORD baked into the bundle at build time.
  // When configured, the gate suppresses dev-bypass so local dev mirrors
  // the deployed staging flow (must type credentials).
  const stagingEmail = meta.VITE_LIVERRA_STAGING_EMAIL ?? '';
  const stagingPassword = meta.VITE_LIVERRA_STAGING_PASSWORD ?? '';
  const stagingGateActive =
    stagingEmail.length > 0 && stagingPassword.length > 0;
  const devBypassActive =
    !stagingGateActive && isDev && meta.VITE_LIVERRA_DEV_BYPASS === 'true';

  // Pre-fill last-used email from localStorage (set on successful signin).
  // Speeds up re-signin during staging testing; password field stays blank.
  const lastEmail =
    typeof window !== 'undefined'
      ? window.localStorage.getItem('liverra:last-email') ?? ''
      : '';
  const [email, setEmail] = useState(lastEmail);
  const [password, setPassword] = useState('');
  const [credError, setCredError] = useState<string | null>(null);
  const justSignedOut = params.get('signedOut') === '1';

  // Refs for autofocus — focus password if email is pre-filled, else email.
  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!stagingGateActive) return;
    const target = lastEmail ? passwordRef.current : emailRef.current;
    target?.focus();
    // Run once on mount; lastEmail + stagingGateActive don't change post-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignIn = (): void => {
    signIn().catch((err) => {
      console.error('[SigninView] signIn failed:', err);
    });
  };

  const handleStagingSubmit = (): void => {
    setCredError(null);
    const emailMatch = email.trim().toLowerCase() === stagingEmail.toLowerCase();
    const pwMatch = password === stagingPassword;
    if (!emailMatch || !pwMatch) {
      setCredError(t('auth:signin.credErrorInvalid'));
      return;
    }
    window.localStorage.setItem('liverra:staging-auth', 'ok');
    // Remember the email for the next signin (e.g., after a future signout).
    window.localStorage.setItem('liverra:last-email', email.trim());
    // AuthContext re-reads this on next mount; full reload primes the
    // dev-bypass user without any oidc-client side effects.
    window.location.assign(returnTo);
  };

  const handleFormSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (stagingGateActive) {
      handleStagingSubmit();
      return;
    }
    if (oidcConfigured) handleSignIn();
  };

  return (
    <Box
      data-testid="signin-view"
      style={{
        minHeight: '100vh',
        width: '100%',
        position: 'relative',
        background: 'var(--emr-bg-page)',
        padding: 'clamp(20px, 5vw, 48px) 16px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Aurora halo (top) — soft brand-tinted glow framing the card */}
      <Box
        aria-hidden
        style={{
          position: 'absolute',
          top: '-25%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(1100px, 140vw)',
          height: 'min(900px, 110vh)',
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse 50% 45% at 50% 30%, var(--emr-secondary-alpha-10) 0%, transparent 70%), radial-gradient(ellipse 35% 35% at 30% 70%, var(--emr-accent-alpha-08) 0%, transparent 65%), radial-gradient(ellipse 30% 30% at 75% 25%, var(--emr-light-accent-alpha-10) 0%, transparent 65%)',
        }}
      />

      {/* Anatomical grid mesh — purely decorative */}
      <Box
        aria-hidden
        style={{
          position: 'absolute',
          inset: '0 0 auto 0',
          height: 420,
          pointerEvents: 'none',
          opacity: 0.5,
          backgroundImage:
            'linear-gradient(var(--emr-primary-alpha-04) 1px, transparent 1px), linear-gradient(90deg, var(--emr-primary-alpha-04) 1px, transparent 1px)',
          backgroundSize: '52px 52px',
          maskImage:
            'radial-gradient(ellipse 65% 70% at 50% 30%, var(--emr-text-primary) 0%, transparent 78%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 65% 70% at 50% 30%, var(--emr-text-primary) 0%, transparent 78%)',
        }}
      />

      <Center style={{ flex: 1, width: '100%', position: 'relative', zIndex: 1 }}>
        <Stack gap="lg" style={{ width: '100%', maxWidth: 460 }} align="center">
          {/* Brand block */}
          <Stack gap={10} align="center" style={{ width: '100%' }}>
            <Box
              aria-hidden
              style={{
                width: 60,
                height: 60,
                borderRadius: 18,
                background: 'var(--emr-gradient-primary)',
                color: 'var(--emr-text-inverse)',
                display: 'grid',
                placeItems: 'center',
                boxShadow:
                  '0 10px 24px var(--emr-secondary-alpha-25), 0 2px 6px var(--emr-primary-alpha-16), inset 0 1px 0 var(--emr-white-alpha-20)',
              }}
            >
              <IconShieldLock size={30} stroke={1.8} />
            </Box>

            <Text
              style={{
                fontSize: 'clamp(30px, 4vw, 36px)',
                fontWeight: 'var(--emr-font-bold)',
                letterSpacing: '-0.025em',
                lineHeight: 1.05,
                marginTop: 6,
                backgroundImage:
                  'linear-gradient(135deg, var(--emr-text-primary) 0%, var(--emr-secondary) 60%, var(--emr-accent) 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              LiverRa
            </Text>

            {/* Inline trust badge under brand */}
            <Group gap={6} wrap="nowrap" align="center" style={{ marginTop: -2 }}>
              <Box
                component={IconShieldCheck}
                aria-hidden
                size={14}
                stroke={2}
                style={{ color: 'var(--emr-success)', flexShrink: 0 }}
              />
              <Text
                style={{
                  fontSize: 'var(--emr-font-sm)',
                  fontWeight: 'var(--emr-font-semibold)',
                  color: 'var(--emr-text-secondary)',
                  letterSpacing: '0.01em',
                }}
              >
                {t('auth:signin.trustBadge')}
              </Text>
            </Group>

            <Text
              style={{
                fontSize: 'var(--emr-font-md)',
                color: 'var(--emr-text-secondary)',
                textAlign: 'center',
                lineHeight: 1.55,
                maxWidth: 360,
                marginTop: 2,
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
              width: '100%',
              background: 'var(--emr-bg-card)',
              border: '1px solid var(--emr-border-color)',
              borderRadius: 18,
              boxShadow:
                '0 1px 0 var(--emr-white-alpha-50) inset, 0 24px 48px -16px var(--emr-primary-alpha-12), 0 8px 20px -8px var(--emr-primary-alpha-08), 0 1px 2px var(--emr-primary-alpha-04)',
              padding: 'clamp(22px, 4vw, 32px)',
              position: 'relative',
            }}
          >
            {/* Subtle inner ring highlight */}
            <Box
              aria-hidden
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 18,
                pointerEvents: 'none',
                background:
                  'linear-gradient(180deg, var(--emr-white-alpha-30) 0%, transparent 30%)',
                opacity: 0.6,
              }}
            />

            <Stack gap="lg" style={{ position: 'relative' }}>
              {/* Post-signout success banner — only shows when arriving with
                  ?signedOut=1, which AuthContext.signOut() appends. */}
              {justSignedOut && (
                <EMRAlert
                  variant="success"
                  icon={IconCircleCheck}
                  data-testid="signin-signedout-banner"
                >
                  {t('auth:signin.signedOutBanner')}
                </EMRAlert>
              )}

              {/* Welcome heading */}
              <Stack gap={4}>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-xl)',
                    fontWeight: 'var(--emr-font-bold)',
                    color: 'var(--emr-text-primary)',
                    letterSpacing: '-0.01em',
                    lineHeight: 1.2,
                  }}
                >
                  {t('auth:signin.welcomeBack')}
                </Text>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-sm)',
                    color: 'var(--emr-text-secondary)',
                    lineHeight: 1.5,
                  }}
                >
                  {t('auth:signin.welcomeBackDescription')}
                </Text>
              </Stack>

              {/* Dev-only: shown when DEV_BYPASS=true AND staging gate is OFF.
                  Wrapped in import.meta.env.DEV so Vite tree-shakes it from
                  the production bundle entirely. */}
              {import.meta.env.DEV && devBypassActive && (
                <EMRAlert variant="info" data-testid="signin-dev-bypass">
                  {t('auth:signin.devBypassActive')}
                </EMRAlert>
              )}

              <Stack gap="md">
                <EMRTextInput
                  ref={emailRef}
                  label={t('auth:signin.emailLabel')}
                  placeholder={t('auth:signin.emailPlaceholder')}
                  type="email"
                  autoComplete="email"
                  leftSection={<IconMail size={16} />}
                  value={email}
                  onChange={setEmail}
                  disabled={!stagingGateActive}
                  data-testid="signin-email"
                  description={
                    stagingGateActive ? undefined : t('auth:signin.emailHelper')
                  }
                />

                <EMRTextInput
                  ref={passwordRef}
                  label={t('auth:signin.passwordLabel')}
                  placeholder={t('auth:signin.passwordPlaceholder')}
                  type="password"
                  autoComplete="current-password"
                  leftSection={<IconLock size={16} />}
                  value={password}
                  onChange={setPassword}
                  disabled={!stagingGateActive}
                  data-testid="signin-password"
                />
              </Stack>

              {credError && (
                <EMRAlert
                  variant="error"
                  icon={IconAlertTriangle}
                  data-testid="signin-error"
                >
                  {credError}
                </EMRAlert>
              )}

              <Tooltip
                label={
                  stagingGateActive
                    ? t('auth:signin.ctaStaging')
                    : oidcConfigured
                      ? t('auth:signin.cta')
                      : t('auth:signin.notConfiguredHint')
                }
                disabled={stagingGateActive || oidcConfigured}
                withArrow
                position="top"
              >
                <Box style={{ flexShrink: 0 }}>
                  <EMRButton
                    type="submit"
                    variant="primary"
                    size="lg"
                    onClick={() => {
                      if (stagingGateActive) handleStagingSubmit();
                      else handleSignIn();
                    }}
                    disabled={!stagingGateActive && !oidcConfigured}
                    fullWidth
                    icon={IconShieldLock}
                    data-testid="signin-cta"
                  >
                    {stagingGateActive
                      ? t('auth:signin.ctaStaging')
                      : t('auth:signin.cta')}
                  </EMRButton>
                </Box>
              </Tooltip>

              {import.meta.env.DEV && isDev && !oidcConfigured && !devBypassActive && !stagingGateActive && (
                <EMRAlert
                  variant="warning"
                  icon={IconAlertTriangle}
                  data-testid="signin-dev-hint"
                >
                  <Stack gap={4}>
                    <Text
                      style={{
                        fontSize: 'var(--emr-font-sm)',
                        fontWeight: 'var(--emr-font-semibold)',
                      }}
                    >
                      {t('auth:signin.devHintTitle')}
                    </Text>
                    <Text
                      style={{
                        fontSize: 'var(--emr-font-xs)',
                        lineHeight: 1.55,
                      }}
                    >
                      {t('auth:signin.devHintBody')}
                    </Text>
                  </Stack>
                </EMRAlert>
              )}

              {/* Divider with help link */}
              <Box
                style={{
                  marginTop: 4,
                  paddingTop: 16,
                  borderTop: '1px solid var(--emr-border-color)',
                }}
              >
                <Group gap={6} justify="center" wrap="wrap">
                  <Text
                    style={{
                      fontSize: 'var(--emr-font-xs)',
                      color: 'var(--emr-text-tertiary)',
                    }}
                  >
                    {t('auth:signin.helpPrefix')}
                  </Text>
                  <a
                    href="mailto:support@liverra.ai"
                    style={{
                      fontSize: 'var(--emr-font-xs)',
                      color: 'var(--emr-secondary)',
                      textDecoration: 'none',
                      fontWeight: 'var(--emr-font-semibold)',
                    }}
                  >
                    {t('auth:signin.helpLink')}
                  </a>
                </Group>
              </Box>
            </Stack>
          </Box>

          {/* Trust chip row — only renders on wider viewports via wrap */}
          <Group
            gap={8}
            justify="center"
            wrap="wrap"
            style={{ width: '100%', marginTop: 4 }}
          >
            <TrustChip icon={IconLock} label={t('auth:signin.trustEncryption')} />
            <TrustChip icon={IconShieldCheck} label={t('auth:signin.trustHipaa')} />
            <TrustChip icon={IconShieldCheck} label={t('auth:signin.trustGdpr')} />
            <TrustChip icon={IconWorldPin} label={t('auth:signin.regionBadge')} />
          </Group>

          {/* Back to home */}
          <Box style={{ marginTop: 4 }}>
            <Link
              to={LIVERRA_ROUTES.LANDING}
              style={{
                textDecoration: 'none',
                color: 'var(--emr-text-tertiary)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 'var(--emr-font-xs)',
                fontWeight: 'var(--emr-font-medium)',
                padding: '6px 10px',
                borderRadius: 8,
                transition: 'color 0.2s ease, background 0.2s ease',
              }}
            >
              <IconArrowLeft size={14} stroke={2} />
              {t('auth:signin.backToHome')}
            </Link>
          </Box>
        </Stack>
      </Center>
    </Box>
  );
}
