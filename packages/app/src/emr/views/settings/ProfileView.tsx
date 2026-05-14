// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ProfileView (T105) — signed-in user's account, preferences, security, and
 * RUO compliance surfaces, stacked in four cards.
 *
 * Plain-English: the "me" page. Anything a user might want to check or
 * tweak about their own account lives here — with intentional asymmetry:
 *
 *   - Account  — read-only identity + role chip + last-active tile
 *   - Preferences — display name, language, theme (the only editable form)
 *   - Security — MFA status, password placeholder, active-sessions placeholder
 *   - Compliance — RUO acceptance with step-up re-accept (rare) + RUO footer pill
 *
 * All raw Mantine form primitives have been replaced with EMR wrappers:
 *   • `EMRTextInput` for display name
 *   • `EMRSelect`    for language
 *   • Custom three-button pill for theme (Light / Dark / System)
 *   • Inline badge helper using theme tokens (StatusBadge wrapper not yet
 *     ported to LiverRa)
 */

import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Group, SimpleGrid, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconDeviceDesktop,
  IconDevices,
  IconKey,
  IconLanguage,
  IconMail,
  IconMoon,
  IconPencil,
  IconShield,
  IconSparkles,
  IconSun,
  IconUser,
  IconUserCircle,
} from '@tabler/icons-react';

import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRSkeleton,
} from '../../components/common';
import { EMRSelect, EMRTextInput } from '../../components/shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';
import { useAuth, getCurrentAccessToken } from '../../services/auth';
import { formatDate, formatRelativeTime, type Locale } from '../../services/localeService';
import { useProfileUpdate } from '../../hooks/useProfileUpdate';
import { LIVERRA_ERROR_EVENTS } from '../../services/errorClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThemePreference = 'light' | 'dark' | 'system';

interface ProfileUser {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string | null;
  locale_preference: Locale;
  theme_preference: ThemePreference;
  last_active_at: string | null;
  mfa_enrolled_at: string | null;
  ruo_accepted_at: string | null;
}

interface MfaResetResponse {
  request_id: string;
  admin_contact: string;
  message?: string;
}

interface RuoAcceptResponse {
  accepted_at: string;
  signature_hash: string;
}

type BadgeTone = 'primary' | 'success' | 'warning' | 'error' | 'secondary';

/**
 * L-AUTH-1: typed role → i18n-key mapping. Replaces the previous
 * `t(\`profile:role.${user.role}\`)` pattern which (a) could not be
 * statically verified and (b) leaked the raw key onto the page when the
 * role enum drifted ahead of the translation bundle (e.g. ``ops`` vs.
 * ``operations``). Roles not in this map fall back to
 * ``profile:header.roleUnassigned`` rather than printing the raw key.
 */
const ROLE_TRANSLATION_KEYS: Record<string, string> = {
  hpb_surgeon: 'profile:role.hpb_surgeon',
  radiologist: 'profile:role.radiologist',
  fellow: 'profile:role.fellow',
  admin: 'profile:role.admin',
  ops: 'profile:role.operations',
  operations: 'profile:role.operations',
  compliance: 'profile:role.compliance',
  dpo: 'profile:role.dpo',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readApiBase(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

const LOCALE_OPTIONS: readonly Locale[] = ['en', 'de', 'ka', 'ru'] as const;
const THEME_OPTIONS: readonly ThemePreference[] = ['light', 'dark', 'system'] as const;

const THEME_ICONS: Record<ThemePreference, typeof IconSun> = {
  light: IconSun,
  dark: IconMoon,
  system: IconDeviceDesktop,
};

const DISPLAY_NAME_MAX = 80;

/** Map a role slug to a badge tone so the Role chip reads at a glance. */
function roleTone(role: string | null): BadgeTone {
  switch (role) {
    case 'admin':
      return 'primary';
    case 'compliance':
    case 'dpo':
      return 'warning';
    case 'hpb_surgeon':
    case 'radiologist':
      return 'success';
    case 'fellow':
    case 'operations':
      return 'secondary';
    default:
      return 'secondary';
  }
}

/** Pull one or two initials from a name or email for the header avatar. */
function deriveInitials(name: string | null, email: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').trim();
  if (!source) return '—';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function ProfileViewInner(): ReactElement {
  const { t, locale } = useTranslation();
  const auth = useAuth();
  const authUser = auth.user as unknown as ProfileUser | null;
  const { update, isLoading: savingNetwork, error: saveError } = useProfileUpdate();

  if (auth.isLoading || !authUser) {
    return (
      <Stack gap="md" data-testid="profile-loading">
        <EMRSkeleton height={140} radius="lg" />
        <EMRSkeleton height={220} radius="lg" />
        <EMRSkeleton height={260} radius="lg" />
        <EMRSkeleton height={200} radius="lg" />
        <EMRSkeleton height={140} radius="lg" />
      </Stack>
    );
  }

  return <ProfileViewLoaded user={authUser} save={update} saving={savingNetwork} saveError={saveError} t={t} />;
}

interface LoadedProps {
  user: ProfileUser;
  save: ReturnType<typeof useProfileUpdate>['update'];
  saving: boolean;
  saveError: (Error & { slug?: string }) | null;
  t: ReturnType<typeof useTranslation>['t'];
}

function ProfileViewLoaded({ user, save, saving, saveError, t }: LoadedProps): ReactElement {
  // -------- Editable form state ------------------------------------------

  const [displayName, setDisplayName] = useState(user.display_name ?? '');
  const [locale, setLocale] = useState<Locale>(user.locale_preference);
  const [theme, setTheme] = useState<ThemePreference>(user.theme_preference);
  const preferencesAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDisplayName(user.display_name ?? '');
    setLocale(user.locale_preference);
    setTheme(user.theme_preference);
  }, [user.display_name, user.locale_preference, user.theme_preference]);

  // -------- Success banner (auto-dismiss after 3s) ------------------------

  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // -------- Validation ---------------------------------------------------

  const trimmedName = displayName.trim();
  const nameError: string | null = useMemo(() => {
    if (trimmedName.length === 0) return t('profile:errors.displayNameRequired');
    if (displayName.length > DISPLAY_NAME_MAX) return t('profile:errors.displayNameTooLong');
    return null;
  }, [trimmedName, displayName.length, t]);

  const isDirty =
    trimmedName !== (user.display_name ?? '').trim() ||
    locale !== user.locale_preference ||
    theme !== user.theme_preference;

  const canSave = isDirty && !nameError && !saving;

  // -------- Handlers -----------------------------------------------------

  const handleCancel = useCallback((): void => {
    setDisplayName(user.display_name ?? '');
    setLocale(user.locale_preference);
    setTheme(user.theme_preference);
  }, [user]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    try {
      await save({
        display_name: trimmedName,
        locale_preference: locale,
        theme_preference: theme,
      });
      setSavedFlash(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setSavedFlash(false), 3_000);
    } catch {
      // `saveError` is already set by the hook; nothing extra to do here.
    }
  }, [canSave, save, trimmedName, locale, theme]);

  const handleEditProfile = useCallback((): void => {
    preferencesAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // -------- MFA reset ----------------------------------------------------

  const [mfaState, setMfaState] = useState<
    | { phase: 'idle' }
    | { phase: 'sending' }
    | { phase: 'sent'; adminContact: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  /**
   * H-AUTH-3: clamp `admin_contact` to a known-safe shape (email or phone)
   * before rendering. A tenant-admin who controlled the API response could
   * otherwise inject a free-text "Call 555-PHISH at this URL" string into
   * the success banner.
   */
  const sanitizeAdminContact = (raw: unknown): string => {
    if (typeof raw !== 'string') return 'your tenant administrator';
    const trimmed = raw.trim();
    // Permit one email-address-shaped value OR one E.164-ish phone. Anything
    // else falls back to the neutral label so phishing strings cannot reach
    // the rendered banner.
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    const isPhone = /^\+?[0-9 ()\-]{6,20}$/.test(trimmed);
    if ((isEmail || isPhone) && trimmed.length <= 80) {
      return trimmed;
    }
    return 'your tenant administrator';
  };

  const requestMfaReset = useCallback(async (): Promise<void> => {
    setMfaState({ phase: 'sending' });
    try {
      // C-AUTH-4: do NOT include cookies — rely on bearer token for auth.
      // This eliminates the CSRF surface for the state-changing POST.
      const accessToken = getCurrentAccessToken();
      const res = await fetch(`${readApiBase()}/auth/me/mfa-reset-request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`MFA reset failed: ${res.status}`);
      const body = (await res.json()) as MfaResetResponse;
      setMfaState({ phase: 'sent', adminContact: sanitizeAdminContact(body.admin_contact) });
    } catch (e) {
      // H-AUTH-5: surface failure via event bus + structured log so ops gets
      // a signal. Previously the catch silently set local state.
      const message = e instanceof Error ? e.message : String(e);
      console.error('[ProfileView] mfa-reset-request failed:', e);
      window.dispatchEvent(
        new CustomEvent(LIVERRA_ERROR_EVENTS.OperationFailed, {
          detail: { operation: 'mfa-reset-request', message },
        }),
      );
      setMfaState({ phase: 'error', message });
    }
  }, []);

  // -------- RUO re-accept ------------------------------------------------

  const [ruoState, setRuoState] = useState<
    | { phase: 'idle' }
    | { phase: 'sending' }
    | { phase: 'accepted'; acceptedAt: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });

  const performRuoAccept = useCallback(async (): Promise<void> => {
    setRuoState({ phase: 'sending' });
    try {
      // C-AUTH-4: bearer-token auth, no cookies. Eliminates CSRF surface.
      const accessToken = getCurrentAccessToken();
      const res = await fetch(`${readApiBase()}/auth/me/ruo-accept`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
      if (res.status === 401 || res.status === 403) {
        window.dispatchEvent(
          new CustomEvent(LIVERRA_ERROR_EVENTS.StepUpRequired, {
            detail: { action: t('profile:ruo.reAccept') },
          }),
        );
        setRuoState({ phase: 'idle' });
        return;
      }
      if (!res.ok) throw new Error(`RUO accept failed: ${res.status}`);
      const body = (await res.json()) as RuoAcceptResponse;
      setRuoState({ phase: 'accepted', acceptedAt: body.accepted_at });
    } catch (e) {
      // H-AUTH-5: structured telemetry + event-bus dispatch.
      const message = e instanceof Error ? e.message : String(e);
      console.error('[ProfileView] ruo-accept failed:', e);
      window.dispatchEvent(
        new CustomEvent(LIVERRA_ERROR_EVENTS.OperationFailed, {
          detail: { operation: 'ruo-accept', message },
        }),
      );
      setRuoState({ phase: 'error', message });
    }
  }, [t]);

  const handleRuoClick = useCallback((): void => {
    window.dispatchEvent(
      new CustomEvent(LIVERRA_ERROR_EVENTS.StepUpRequired, {
        detail: { action: t('profile:ruo.reAccept') },
      }),
    );
    void performRuoAccept();
  }, [performRuoAccept, t]);

  // -------- Render -------------------------------------------------------

  const roleKey = user.role ? ROLE_TRANSLATION_KEYS[user.role] : undefined;
  const roleLabel = roleKey ? t(roleKey) : t('profile:header.roleUnassigned');
  const fullName = (user.display_name ?? '').trim() || (user.email ?? '').split('@')[0] || '—';
  const initials = deriveInitials(user.display_name, user.email);

  const lastActiveAbsolute = user.last_active_at
    ? new Date(user.last_active_at).toLocaleString()
    : null;

  return (
    <Stack gap="lg" data-testid="profile-view">
      <EMRPageHeader
        icon={IconUser}
        title={t('profile:page.title')}
        subtitle={t('profile:page.subtitle')}
        actions={
          <EMRButton
            variant="ghost"
            icon={IconPencil}
            onClick={handleEditProfile}
            data-testid="profile-edit-cta"
          >
            {t('profile:header.editProfile')}
          </EMRButton>
        }
      />

      {/* -------------------- 0. Identity hero ------------------------- */}
      <Box
        data-testid="profile-identity"
        style={{
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-border-color)',
          borderRadius: 'var(--emr-border-radius-xl)',
          boxShadow: 'var(--emr-shadow-card)',
          padding: '20px 24px',
        }}
      >
        <Group gap="lg" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
          <Box
            aria-hidden
            style={{
              width: 64,
              height: 64,
              flexShrink: 0,
              borderRadius: 'var(--emr-border-radius-xl)',
              background: 'var(--emr-gradient-primary)',
              color: 'var(--emr-text-inverse)',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 'var(--emr-font-bold)',
              fontSize: 22,
              letterSpacing: '0.02em',
              boxShadow: '0 8px 20px var(--emr-secondary-alpha-25)',
            }}
          >
            {initials}
          </Box>
          <Box style={{ flex: '1 1 auto', minWidth: 0 }}>
            <Text
              style={{
                fontSize: 'var(--emr-font-xl)',
                fontWeight: 'var(--emr-font-semibold)',
                color: 'var(--emr-text-primary)',
                lineHeight: 1.25,
                wordBreak: 'break-word',
              }}
            >
              {fullName}
            </Text>
            <Group gap="xs" wrap="wrap" mt={6}>
              <InlineBadge tone={roleTone(user.role)} icon={IconUserCircle}>
                {roleLabel}
              </InlineBadge>
              <InlineBadge
                tone={user.email ? 'secondary' : 'warning'}
                icon={IconMail}
              >
                {user.email ?? t('profile:header.emailUnavailable')}
              </InlineBadge>
            </Group>
          </Box>
        </Group>
      </Box>

      {/* -------------------- 1. Account (read-only) ------------------- */}
      <SectionCard title={t('profile:sections.account')} testId="profile-card-account">
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
          <InfoTile
            icon={IconMail}
            label={t('profile:fields.email')}
            helper={t('profile:fields.emailReadonly')}
            testId="profile-field-email"
          >
            <Text
              size="sm"
              fw={500}
              style={{ color: 'var(--emr-text-primary)', wordBreak: 'break-word' }}
            >
              {user.email ?? '—'}
            </Text>
          </InfoTile>

          <InfoTile icon={IconUserCircle} label={t('profile:fields.role')}>
            <InlineBadge tone={roleTone(user.role)} testId="profile-field-role">
              {roleLabel}
            </InlineBadge>
          </InfoTile>

          <InfoTile
            icon={IconClock}
            label={t('profile:fields.lastActive')}
            helper={
              user.last_active_at ? undefined : t('profile:fields.lastActiveFirstSession')
            }
            testId="profile-field-last-active"
          >
            {user.last_active_at ? (
              <Tooltip
                label={lastActiveAbsolute ?? ''}
                disabled={!lastActiveAbsolute}
                withArrow
                position="top"
              >
                <Text
                  size="sm"
                  fw={500}
                  style={{ color: 'var(--emr-text-primary)', cursor: 'help' }}
                >
                  {formatRelativeTime(user.last_active_at)}
                </Text>
              </Tooltip>
            ) : (
              <Group gap={6} align="center">
                <IconSparkles size={14} color="var(--emr-secondary)" />
                <Text
                  size="sm"
                  fw={500}
                  style={{ color: 'var(--emr-text-primary)' }}
                >
                  {t('profile:fields.lastActiveNever')}
                </Text>
              </Group>
            )}
          </InfoTile>
        </SimpleGrid>
      </SectionCard>

      {/* -------------------- 2. Preferences (editable) ---------------- */}
      <Box ref={preferencesAnchorRef}>
        <SectionCard title={t('profile:sections.preferences')} testId="profile-card-preferences">
          <Stack gap="md">
            {saveError && (
              <EMRAlert variant="error" data-testid="profile-save-error">
                {saveError.message ?? t('profile:toast.saveError')}
              </EMRAlert>
            )}
            {savedFlash && (
              <EMRAlert
                variant="success"
                icon={IconCheck}
                data-testid="profile-save-success"
              >
                {t('profile:toast.saved')}
              </EMRAlert>
            )}

            <EMRTextInput
              label={t('profile:fields.displayName')}
              placeholder={t('profile:fields.displayNamePlaceholder')}
              description={
                displayName.length > 0
                  ? `${displayName.length}/${DISPLAY_NAME_MAX}`
                  : t('profile:fields.displayNameHelper')
              }
              value={displayName}
              onChange={(value) => setDisplayName(value)}
              error={isDirty && nameError ? nameError : undefined}
              maxLength={DISPLAY_NAME_MAX + 20}
              required
              data-testid="profile-input-display-name"
            />

            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              <EMRSelect
                label={t('profile:fields.locale')}
                leftSection={<IconLanguage size={16} />}
                data={LOCALE_OPTIONS.map((code) => ({
                  value: code,
                  label: t(`profile:locale.${code}`),
                }))}
                value={locale}
                onChange={(value) => {
                  if (value && LOCALE_OPTIONS.includes(value as Locale)) {
                    setLocale(value as Locale);
                  }
                }}
                allowDeselect={false}
                data-testid="profile-select-locale"
              />

              <Box>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-sm)',
                    fontWeight: 'var(--emr-font-semibold)',
                    color: 'var(--emr-text-primary)',
                    marginBottom: 6,
                  }}
                >
                  {t('profile:fields.theme')}
                </Text>
                <ThemeSwitcher
                  value={theme}
                  onChange={setTheme}
                  label={(value) => t(`profile:theme.${value}`)}
                />
              </Box>
            </SimpleGrid>

            {isDirty && (
              <Group gap="sm" justify="flex-end" wrap="wrap">
                <EMRButton
                  variant="ghost"
                  onClick={handleCancel}
                  disabled={saving}
                  data-testid="profile-cancel-button"
                >
                  {t('profile:actions.cancel')}
                </EMRButton>
                <EMRButton
                  variant="primary"
                  onClick={handleSave}
                  disabled={!canSave}
                  loading={saving}
                  data-testid="profile-save-button"
                >
                  {saving
                    ? t('profile:actions.saving')
                    : t('profile:actions.save')}
                </EMRButton>
              </Group>
            )}
          </Stack>
        </SectionCard>
      </Box>

      {/* -------------------- 3. Security ------------------------------ */}
      <SectionCard title={t('profile:sections.security')} testId="profile-card-security">
        <Stack gap="md">
          {/* MFA row ------------------------------------------------ */}
          <SecurityRow
            icon={IconShield}
            title={t('profile:fields.mfaStatus')}
            description={
              user.mfa_enrolled_at
                ? t('profile:mfa.enrolledAt', {
                    date: formatDate(user.mfa_enrolled_at, { locale, dateStyle: 'medium' }),
                  })
                : t('profile:mfa.resetBody')
            }
            right={
              <InlineBadge
                tone={user.mfa_enrolled_at ? 'success' : 'warning'}
                testId="profile-mfa-badge"
              >
                {user.mfa_enrolled_at
                  ? t('profile:mfa.enrolled')
                  : t('profile:mfa.notEnrolled')}
              </InlineBadge>
            }
          />

          {mfaState.phase === 'sent' ? (
            <EMRAlert
              variant="success"
              icon={IconCheck}
              data-testid="profile-mfa-sent"
            >
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  {t('profile:mfa.resetSent')}
                </Text>
                <Text size="xs">
                  {t('profile:mfa.resetAdmin', { admin: mfaState.adminContact })}
                </Text>
              </Stack>
            </EMRAlert>
          ) : (
            <Group gap="sm" wrap="wrap">
              <EMRButton
                variant="secondary"
                onClick={() => void requestMfaReset()}
                loading={mfaState.phase === 'sending'}
                disabled={mfaState.phase === 'sending'}
                data-testid="profile-mfa-reset-button"
              >
                {t('profile:mfa.resetCta')}
              </EMRButton>
              {mfaState.phase === 'error' && (
                <Text
                  size="sm"
                  style={{ color: 'var(--emr-error)' }}
                  data-testid="profile-mfa-error"
                >
                  {mfaState.message}
                </Text>
              )}
            </Group>
          )}

          <Divider />

          {/* Change password row ------------------------------------ */}
          <SecurityRow
            icon={IconKey}
            title={t('profile:password.title')}
            description={t('profile:password.description')}
            right={<InlineBadge tone="secondary">{t('profile:comingSoon')}</InlineBadge>}
            testId="profile-password-row"
          />

          <Divider />

          {/* Active sessions row ------------------------------------ */}
          <SecurityRow
            icon={IconDevices}
            title={t('profile:sessions.title')}
            description={t('profile:sessions.description')}
            right={<InlineBadge tone="secondary">{t('profile:comingSoon')}</InlineBadge>}
            testId="profile-sessions-row"
          />
        </Stack>
      </SectionCard>

      {/* -------------------- 4. Compliance (RUO) ---------------------- */}
      <SectionCard title={t('profile:sections.compliance')} testId="profile-card-compliance">
        <Stack gap="md">
          <Group gap="xs" wrap="wrap" align="center">
            <IconAlertCircle size={16} color="var(--emr-secondary)" />
            <Text
              size="sm"
              style={{ color: 'var(--emr-text-secondary)' }}
              data-testid="profile-ruo-date"
            >
              {user.ruo_accepted_at
                ? t('profile:ruo.acceptedAt', {
                    date: formatDate(user.ruo_accepted_at, { locale, dateStyle: 'medium' }),
                  })
                : t('profile:ruo.neverAccepted')}
            </Text>
          </Group>

          <Text size="sm" style={{ color: 'var(--emr-text-secondary)' }}>
            {t('profile:ruo.reAcceptBody')}
          </Text>

          {ruoState.phase === 'accepted' ? (
            <EMRAlert
              variant="success"
              icon={IconCheck}
              data-testid="profile-ruo-accepted"
            >
              {t('profile:ruo.reAccepted')}
            </EMRAlert>
          ) : (
            <Group gap="sm" wrap="wrap">
              <EMRButton
                variant="secondary"
                onClick={handleRuoClick}
                loading={ruoState.phase === 'sending'}
                disabled={ruoState.phase === 'sending'}
                data-testid="profile-ruo-reaccept-button"
              >
                {t('profile:ruo.reAcceptCta')}
              </EMRButton>
              {ruoState.phase === 'error' && (
                <Text
                  size="sm"
                  style={{ color: 'var(--emr-error)' }}
                  data-testid="profile-ruo-error"
                >
                  {ruoState.message}
                </Text>
              )}
            </Group>
          )}
        </Stack>
      </SectionCard>

      {/* -------------------- RUO compliance footer pill --------------- */}
      <Group justify="center" mt="xs">
        <Box
          data-testid="profile-ruo-footer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            borderRadius: 999,
            background: 'var(--emr-warning-alpha-10)',
            border: '1px solid var(--emr-warning-alpha-20)',
            color: 'var(--emr-warning)',
            fontSize: 'var(--emr-font-xs)',
            fontWeight: 'var(--emr-font-semibold)',
            letterSpacing: '0.02em',
          }}
        >
          <IconAlertCircle size={14} />
          {t('profile:ruo.footerPill')}
        </Box>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// SectionCard — shared card container for every section.
// ---------------------------------------------------------------------------

interface SectionCardProps {
  title: string;
  testId?: string;
  children: ReactNode;
}

function SectionCard({ title, testId, children }: SectionCardProps): ReactElement {
  return (
    <Box
      data-testid={testId}
      style={{
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        borderRadius: 'var(--emr-border-radius-xl)',
        boxShadow: 'var(--emr-shadow-card)',
        padding: '20px 24px',
      }}
    >
      <Text
        style={{
          fontSize: 'var(--emr-font-lg)',
          fontWeight: 'var(--emr-font-semibold)',
          color: 'var(--emr-text-primary)',
          lineHeight: 1.2,
          marginBottom: 16,
        }}
      >
        {title}
      </Text>
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InfoTile — labelled read-only field with icon + optional helper footnote.
// ---------------------------------------------------------------------------

interface InfoTileProps {
  icon: typeof IconMail;
  label: string;
  children: ReactNode;
  helper?: string;
  testId?: string;
}

function InfoTile({ icon: Icon, label, children, helper, testId }: InfoTileProps): ReactElement {
  return (
    <Box
      data-testid={testId}
      style={{
        padding: 14,
        background: 'var(--emr-secondary-alpha-03)',
        border: '1px solid var(--emr-secondary-alpha-08)',
        borderRadius: 10,
        minHeight: 88,
      }}
    >
      <Group gap={6} align="center" mb={4}>
        <Icon size={14} color="var(--emr-secondary)" />
        <Text
          size="xs"
          style={{
            color: 'var(--emr-text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontWeight: 'var(--emr-font-semibold)',
          }}
        >
          {label}
        </Text>
      </Group>
      {children}
      {helper && (
        <Text
          size="xs"
          style={{ color: 'var(--emr-text-secondary)', marginTop: 6, lineHeight: 1.4 }}
        >
          {helper}
        </Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InlineBadge — local StatusBadge stand-in using the same theme tokens as
// EMRPageHeader. Replace with `StatusBadge` once ported from MediMind.
// ---------------------------------------------------------------------------

interface InlineBadgeProps {
  tone: BadgeTone;
  children: ReactNode;
  icon?: typeof IconMail;
  testId?: string;
}

function inlineBadgeStyles(tone: BadgeTone): React.CSSProperties {
  const palette: Record<BadgeTone, { bg: string; border: string; fg: string }> = {
    primary: {
      bg: 'var(--emr-primary-alpha-08)',
      border: 'var(--emr-primary-alpha-20)',
      fg: 'var(--emr-primary)',
    },
    secondary: {
      bg: 'var(--emr-secondary-alpha-08)',
      border: 'var(--emr-secondary-alpha-20)',
      fg: 'var(--emr-secondary)',
    },
    success: {
      bg: 'var(--emr-success-alpha-10)',
      border: 'var(--emr-success-alpha-20)',
      fg: 'var(--emr-success)',
    },
    warning: {
      bg: 'var(--emr-warning-alpha-10)',
      border: 'var(--emr-warning-alpha-20)',
      fg: 'var(--emr-warning)',
    },
    error: {
      bg: 'var(--emr-error-alpha-10)',
      border: 'var(--emr-error-alpha-20)',
      fg: 'var(--emr-error)',
    },
  };
  const p = palette[tone];
  return {
    background: p.bg,
    border: `1px solid ${p.border}`,
    color: p.fg,
  };
}

function InlineBadge({ tone, children, icon: Icon, testId }: InlineBadgeProps): ReactElement {
  return (
    <Box
      component="span"
      data-testid={testId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        fontSize: 'var(--emr-font-xs)',
        fontWeight: 'var(--emr-font-semibold)',
        lineHeight: 1.2,
        maxWidth: '100%',
        ...inlineBadgeStyles(tone),
      }}
    >
      {Icon && <Icon size={12} />}
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 260,
        }}
      >
        {children}
      </span>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// SecurityRow — shared layout for the security section rows.
// ---------------------------------------------------------------------------

interface SecurityRowProps {
  icon: typeof IconShield;
  title: string;
  description: string;
  right?: ReactNode;
  testId?: string;
}

function SecurityRow({ icon: Icon, title, description, right, testId }: SecurityRowProps): ReactElement {
  return (
    <Group
      gap="md"
      wrap="nowrap"
      align="flex-start"
      data-testid={testId}
      style={{ minWidth: 0 }}
    >
      <Box
        aria-hidden
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: 10,
          background: 'var(--emr-secondary-alpha-08)',
          color: 'var(--emr-secondary)',
          display: 'grid',
          placeItems: 'center',
          marginTop: 2,
        }}
      >
        <Icon size={18} />
      </Box>
      <Box style={{ flex: '1 1 auto', minWidth: 0 }}>
        <Text
          size="sm"
          fw={600}
          style={{ color: 'var(--emr-text-primary)' }}
        >
          {title}
        </Text>
        <Text
          size="xs"
          style={{ color: 'var(--emr-text-secondary)', marginTop: 2, lineHeight: 1.45 }}
        >
          {description}
        </Text>
      </Box>
      {right && <Box style={{ flexShrink: 0 }}>{right}</Box>}
    </Group>
  );
}

function Divider(): ReactElement {
  return (
    <Box
      aria-hidden
      style={{ height: 1, background: 'var(--emr-border-color)', width: '100%' }}
    />
  );
}

// ---------------------------------------------------------------------------
// ThemeSwitcher — a 3-pill selector (Light / Dark / System) used instead of
// a raw dropdown. Built from Mantine layout primitives + theme tokens only.
// ---------------------------------------------------------------------------

interface ThemeSwitcherProps {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
  label: (value: ThemePreference) => string;
}

function ThemeSwitcher({ value, onChange, label }: ThemeSwitcherProps): ReactElement {
  return (
    <Group
      gap={4}
      wrap="nowrap"
      role="radiogroup"
      aria-label={label(value)}
      data-testid="profile-theme-switcher"
      style={{
        padding: 4,
        background: 'var(--emr-secondary-alpha-05)',
        border: '1px solid var(--emr-border-color)',
        borderRadius: 10,
        width: '100%',
        minHeight: 44,
      }}
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = THEME_ICONS[option];
        const active = option === value;
        return (
          <UnstyledButton
            key={option}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            data-testid={`profile-theme-${option}`}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              height: 36,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: 'var(--emr-font-sm)',
              fontWeight: 'var(--emr-font-semibold)',
              color: active ? 'var(--emr-text-inverse)' : 'var(--emr-text-secondary)',
              background: active ? 'var(--emr-gradient-primary)' : 'transparent',
              boxShadow: active ? '0 4px 12px var(--emr-secondary-alpha-25)' : 'none',
              transition: 'all 0.18s ease',
              cursor: 'pointer',
            }}
          >
            <Icon size={16} />
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {label(option)}
            </span>
          </UnstyledButton>
        );
      })}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Exported default — wrapped in EMRErrorBoundary.
// ---------------------------------------------------------------------------

export default function ProfileView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="ProfileView">
      <ProfileViewInner />
    </EMRErrorBoundary>
  );
}
