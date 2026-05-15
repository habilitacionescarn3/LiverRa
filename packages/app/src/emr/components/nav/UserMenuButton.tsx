// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * UserMenuButton — top-bar avatar dropdown.
 *
 * Plain-English: the round little circle on the top-right of the app. Click
 * it to see who you're signed in as, jump to your profile / notification
 * preferences, switch the UI language, or sign out. One component, no
 * subroutes — pure dropdown.
 *
 * Auth comes from `useAuth()` (see services/auth/index.ts) and locale from
 * `useTranslation()`. Both already exist; this component is just the UI.
 */

import { Avatar, Box, Group, Loader, Menu, Skeleton, Stack, Text, UnstyledButton } from '@mantine/core';
import {
  IconBell,
  IconCheck,
  IconChevronDown,
  IconLanguage,
  IconLogout,
  IconUser,
} from '@tabler/icons-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { LIVERRA_ROUTES } from '../../constants/routes';
import { SUPPORTED_LOCALES, useTranslation, type Locale } from '../../contexts/TranslationContext';
// Pull signOut from the React context (not the stub-backed services/auth hook).
// The context's signOut clears all three auth stores + localStorage flag and
// hard-navigates to /signin?signedOut=1. The stub-backed signOut delegates to
// the OIDC UserManager which doesn't exist on the staging deploy, so calling
// it leaves the staging-auth flag in place and causes auto-re-signin on refresh.
import { useAuthContext } from '../../contexts/AuthContext';

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  ka: 'ქართული',
  ru: 'Русский',
};

/**
 * Compute initials from the user's display name (preferred) or email
 * local-part (fallback). Always uppercase, max 2 chars.
 */
function computeInitials(name: string | null, email: string | null): string {
  const source = (name && name.trim()) || (email && email.split('@')[0]) || '';
  if (!source) return '?';
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const UserMenuButton = memo(function UserMenuButton() {
  const navigate = useNavigate();
  const { t, locale, setLocale } = useTranslation();
  const { user, signOut } = useAuthContext();

  const initials = useMemo(
    () => computeInitials(user?.name ?? null, user?.email ?? null),
    [user?.name, user?.email],
  );

  const [isSigningOut, setIsSigningOut] = useState(false);
  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      // signOut hard-navigates to /signin?signedOut=1 (or OIDC redirect),
      // so we don't unset the flag — the page is about to unmount anyway.
    } catch {
      // If the redirect ever fails, let the user retry.
      setIsSigningOut(false);
    }
  }, [signOut, isSigningOut]);

  if (!user) {
    return <Skeleton circle width={32} height={32} />;
  }

  const displayName = user.name || user.email || 'User';

  return (
    <Menu position="bottom-end" shadow="lg" width={260} withArrow offset={4}>
      <Menu.Target>
        <UnstyledButton
          aria-label={t('nav:profile')}
          data-testid="user-menu-button"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 6px',
            borderRadius: 999,
            transition: 'background 0.15s ease',
            minHeight: 40,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'var(--emr-bg-hover)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <Avatar
            size={32}
            radius="xl"
            color="liverraPrimary"
            style={{
              background: 'var(--emr-gradient-primary)',
              color: 'var(--emr-text-inverse)',
              fontWeight: 600,
              fontSize: 'var(--emr-font-sm)',
            }}
          >
            {initials}
          </Avatar>
          <IconChevronDown size={14} color="var(--emr-text-secondary)" />
        </UnstyledButton>
      </Menu.Target>

      <Menu.Dropdown>
        {/* Header — non-clickable identity block */}
        <Box
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--emr-border-color)',
          }}
        >
          <Group gap={10} wrap="nowrap" align="center">
            <Avatar
              size={36}
              radius="xl"
              style={{
                background: 'var(--emr-gradient-primary)',
                color: 'var(--emr-text-inverse)',
                fontWeight: 600,
                fontSize: 'var(--emr-font-sm)',
                flexShrink: 0,
              }}
            >
              {initials}
            </Avatar>
            <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
              <Text
                fz="var(--emr-font-sm)"
                fw={600}
                c="var(--emr-text-primary)"
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {displayName}
              </Text>
              {user.email && user.email !== displayName && (
                <Text
                  fz="var(--emr-font-xs)"
                  c="var(--emr-text-secondary)"
                  style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {user.email}
                </Text>
              )}
            </Stack>
          </Group>
        </Box>

        <Menu.Item
          leftSection={<IconUser size={16} />}
          onClick={() => navigate(LIVERRA_ROUTES.PROFILE)}
          data-testid="user-menu-profile"
        >
          {t('nav:profile')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconBell size={16} />}
          onClick={() => navigate(LIVERRA_ROUTES.SETTINGS_NOTIFICATIONS)}
          data-testid="user-menu-notifications"
        >
          {t('nav:notifications')}
        </Menu.Item>

        <Menu.Divider />
        <Menu.Label>{t('nav:user_menu_language')}</Menu.Label>
        {SUPPORTED_LOCALES.map((loc) => (
          <Menu.Item
            key={loc}
            leftSection={<IconLanguage size={16} />}
            rightSection={loc === locale ? <IconCheck size={14} /> : null}
            onClick={() => setLocale(loc)}
            data-testid={`user-menu-locale-${loc}`}
          >
            {LOCALE_LABELS[loc]}
          </Menu.Item>
        ))}

        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={
            isSigningOut ? <Loader size={14} color="red" /> : <IconLogout size={16} />
          }
          onClick={handleSignOut}
          disabled={isSigningOut}
          closeMenuOnClick={false}
          data-testid="user-menu-signout"
        >
          {isSigningOut ? t('nav:user_menu_signing_out') : t('nav:user_menu_signout')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
});

export default UserMenuButton;
