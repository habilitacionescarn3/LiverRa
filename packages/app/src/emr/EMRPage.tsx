// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRPage — LiverRa application layout shell (T112).
 *
 * Plain-English: the persistent chrome that surrounds every authenticated
 * route — top bar (with breadcrumbs + language), optional left sidebar,
 * mobile hamburger / bottom nav bar, session-recovery banner, persistent
 * RUO disclaimer overlay, and a mounted-once StepUpAuthModal that listens
 * for the `liverra:step-up-required` DOM event.
 *
 * Structure (desktop):
 * ┌──────────────────────────────────────────┐
 * │ Top bar: logo • breadcrumbs • profile     │ 56 px
 * ├──────────────────────────────────────────┤
 * │ [SessionRecoveryBanner — conditional]     │ sticky
 * ├──────────────────────────────────────────┤
 * │ Row 1: EMRMainMenu                        │ 48 px
 * ├──────────────────────────────────────────┤
 * │ Row 2: HorizontalSubMenu (conditional)    │ 44 px
 * ├──────────────────────────────────────────┤
 * │ Row 3: <Outlet /> — route content          │ flex: 1
 * ├──────────────────────────────────────────┤
 * │ RUO disclaimer overlay (persistent)       │ FR-028
 * └──────────────────────────────────────────┘
 *
 * Nav items (`EMRMainMenu.items`) + section-to-sub-menu mapping come from
 * `constants/nav-registry.ts` (sibling coder agent, T106). Until the
 * registry lands, we pass an empty `items` array so the shell still
 * renders — no menu items, but the page does not crash.
 */

import { useMediaQuery } from '@mantine/hooks';
import { Box, Burger, Group, Text, UnstyledButton } from '@mantine/core';
import { IconHome } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LIVERRA_ROUTES } from './constants/routes';
import { EMRIconButton } from './components/common';

import {
  Breadcrumbs,
  EMRMainMenu,
  HorizontalSubMenu,
  SessionRecoveryBanner,
  UserMenuButton,
  type NavItem,
  type SubMenuItem,
} from './components/nav';
import { StepUpAuthModal } from './components/access-control';
import { FULL_MENU_ITEMS } from './constants/nav-registry';
import { useTranslation } from './contexts/TranslationContext';

/**
 * Placeholder persistent RUO disclaimer — final impl lives in T178 (Phase 3).
 * Renders a subtle bottom-right pill so every authenticated screen satisfies
 * FR-028 ("Research Use Only" must be persistently visible) during pre-T178
 * development. Replace with the real component when T178 ships.
 */
function RUODisclaimer(): ReactElement {
  const { t } = useTranslation();
  return (
    <Box
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 50,
        pointerEvents: 'none',
        padding: '6px 12px',
        borderRadius: 999,
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-border-color)',
        boxShadow: 'var(--emr-shadow-sm)',
        color: 'var(--emr-text-secondary)',
        fontSize: 'var(--emr-font-xs)',
        fontWeight: 600,
        letterSpacing: '0.04em',
      }}
    >
      {t('ruo:badge')}
    </Box>
  );
}

export interface EMRPageProps {
  /**
   * Main-menu items — wire from `nav-registry.ts` keyed by user role.
   * Defaults to empty so the shell still renders before T106 ships.
   */
  navItems?: NavItem[];
  /**
   * Sub-menu items for the currently active section. Defaults to empty.
   * Sibling T106 exposes `getSubMenuForSection(pathname)` — call that and
   * pass the result in.
   */
  subMenuItems?: SubMenuItem[];
  /** Optional custom RUO disclaimer override. */
  ruoDisclaimer?: ReactElement;
}

/**
 * Layout shell. Authentication / role checks belong to ProtectedRoute (T102)
 * + the context providers in `main.tsx` — this component assumes the user is
 * already authenticated when it mounts.
 */
export function EMRPage({
  navItems = FULL_MENU_ITEMS as NavItem[],
  subMenuItems = [],
  ruoDisclaimer,
}: EMRPageProps): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isMobile = useMediaQuery('(max-width: 768px)') ?? false;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const goHome = useCallback(() => {
    navigate(LIVERRA_ROUTES.LANDING);
  }, [navigate]);

  const effectiveNavItems = navItems;

  // Imaging viewer takes the full viewport — skip the main content scroll.
  const isImagingRoute = location.pathname.includes('/imaging');

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((s) => !s);
  }, []);

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        minHeight: '100vh',
        overflow: 'hidden',
        background: 'var(--emr-bg-page)',
      }}
    >
      {/* ===== Top bar ===== */}
      <Box
        component="header"
        role="banner"
        style={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 16px',
          background: 'var(--emr-bg-card)',
          borderBottom: '1px solid var(--emr-border-color)',
          boxShadow: 'var(--emr-shadow-sm)',
        }}
      >
        {isMobile && (
          <Burger
            opened={sidebarOpen}
            onClick={toggleSidebar}
            aria-label="Toggle navigation"
            size="sm"
          />
        )}
        {/* Logo doubles as Home — industry-standard click-target. */}
        <UnstyledButton
          onClick={goHome}
          aria-label={t('common.goHome') || 'Go to home page'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 8px',
            borderRadius: 'var(--emr-border-radius)',
            transition: 'background var(--emr-transition-base)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--emr-bg-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <Text fw={700} size="lg" c="var(--emr-primary)">
            LiverRa
          </Text>
        </UnstyledButton>
        {/* Dedicated Home button — explicit secondary affordance. */}
        <EMRIconButton
          icon={IconHome}
          onClick={goHome}
          aria-label={t('common.goHome') || 'Go to home page'}
          size="md"
          variant="subtle"
          data-testid="nav-home-button"
        />
        <Box style={{ flex: 1 }}>
          <Breadcrumbs />
        </Box>
        <UserMenuButton />
      </Box>

      {/* ===== Session recovery banner (sticky) ===== */}
      <SessionRecoveryBanner />

      {/* ===== Main menu (Row 1) — hidden on mobile (moved to bottom bar) ===== */}
      {!isMobile && effectiveNavItems.length > 0 && (
        <Box
          style={{
            height: 48,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            background: 'var(--emr-bg-page)',
            borderBottom: '1px solid var(--emr-border-color)',
          }}
          data-testid="main-menu-row"
        >
          <EMRMainMenu items={effectiveNavItems} />
        </Box>
      )}

      {/* ===== Sub menu (Row 2) — conditional ===== */}
      {subMenuItems.length > 0 && <HorizontalSubMenu items={subMenuItems} />}

      {/* ===== Content (Row 3) =====
          `display: flex; flex-direction: column` + the inner wrapper's
          `min-height: 100%` ensure the route content always fills the
          scroll viewport. Without this, short pages (or pages whose own
          flex tree doesn't fully claim vertical space) leave a visible
          empty band at the bottom of the scroll area. Safe for tall
          pages — they overflow as before and scroll normally. */}
      <Box
        component="main"
        role="main"
        data-testid="content-area"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: isImagingRoute ? 'hidden' : 'auto',
          overscrollBehavior: 'none',
          paddingBottom: isMobile ? 'calc(64px + env(safe-area-inset-bottom))' : undefined,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          style={{
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
            flex: '1 0 auto',
          }}
        >
          <Outlet />
        </Box>
      </Box>

      {/* ===== Mobile bottom nav ===== */}
      {isMobile && effectiveNavItems.length > 0 && <EMRMainMenu items={effectiveNavItems} />}

      {/* ===== Persistent RUO disclaimer (FR-028) ===== */}
      {ruoDisclaimer ?? <RUODisclaimer />}

      {/* ===== Step-up modal mounted once at shell root ===== */}
      <StepUpAuthModal />
    </Box>
  );
}

export default EMRPage;
