// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRMainMenu — LiverRa primary navigation (T107).
 *
 * Plain-English: the pill-shaped horizontal menu at the top of the app. On
 * mobile it collapses into a fixed bottom navigation bar with an overflow
 * menu. Items are driven by `nav-registry.ts` (keyed by user role); each
 * item may carry a LiverraPermission that we check via `useHasPermission`.
 *
 * Ported structurally from MediMind's `EMRMainMenu.tsx` but all MediMind
 * menu entries (appointments, billing, MAR, pharmacy queue …) are gone —
 * the list is now solely the nav-registry. This file does not own the
 * registry; sibling coder agent creates `constants/nav-registry.ts`.
 */

import { Box, Menu, Skeleton, Text, UnstyledButton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronDown, IconDotsVertical, type Icon as TablerIcon } from '@tabler/icons-react';
import { memo, useCallback, useMemo, useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { usePermissionContext } from '../../contexts/PermissionContext';
import { useTranslation } from '../../contexts/TranslationContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

import styles from './EMRMainMenu.module.css';

/** Shape of a single menu entry — must match `nav-registry.ts` output. */
export interface NavItem {
  key: string;
  /** Translation key (with namespace, e.g. `nav:cases`). */
  translationKey: string;
  /** Route path. Optional: parents with `children` omit it. */
  path?: string;
  /** Rendered icon element. */
  icon: ReactNode | TablerIcon;
  /** Permission required to see this item. Omit = always visible. */
  permission?: LiverraPermission;
  /** Nested entries — when present this item renders as a Menu dropdown. */
  children?: readonly NavItem[];
  /** Translation key for a Menu.Label section header above this child. */
  groupLabel?: string;
}

export interface EMRMainMenuProps {
  /** Items to render. Typically sourced from `nav-registry.ts` by role. */
  items: NavItem[];
  /** Mobile breakpoint in px (default 768). */
  mobileBreakpointPx?: number;
  /** Number of primary items on mobile (rest go to overflow). */
  mobilePrimaryCount?: number;
}

/** Renders an icon that may be a ReactNode or a Tabler icon component. */
function renderIcon(icon: NavItem['icon']): ReactNode {
  if (typeof icon === 'function') {
    const IconComp = icon as TablerIcon;
    return <IconComp size={20} />;
  }
  return icon;
}

/**
 * EMRMainMenu — desktop horizontal menu / mobile bottom-bar.
 *
 * Filters items by permission (fail-closed: while permissions load, shows
 * skeleton placeholders, not items).
 */
export const EMRMainMenu = memo(function EMRMainMenu({
  items,
  mobileBreakpointPx = 768,
  mobilePrimaryCount = 4,
}: EMRMainMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { loading: permissionsLoading, permissions } = usePermissionContext();

  const isMobile = useMediaQuery(`(max-width: ${mobileBreakpointPx}px)`) ?? false;

  const touchStartX = useRef<number>(0);
  const [swiping, setSwiping] = useState(false);

  // Permission-filter visible items. Read the permission Set once (no
  // hooks-in-loop violation) and filter both the top-level list and any
  // nested children. A parent group with children is dropped only when
  // every child is filtered out — otherwise it stays so the dropdown can
  // still surface its surviving children.
  const hasPerm = useCallback(
    (perm?: LiverraPermission) => !perm || permissions.has(perm),
    [permissions],
  );

  const visibleItems = useMemo(() => {
    return items
      .filter((item) => {
        if (!hasPerm(item.permission)) return false;
        if (item.children && item.children.length > 0) {
          return item.children.some((c) => hasPerm(c.permission));
        }
        return true;
      });
  }, [items, hasPerm]);

  const isActive = useCallback(
    (path: string | undefined) =>
      Boolean(path) && (location.pathname === path || location.pathname.startsWith(path + '/')),
    [location.pathname],
  );

  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    setSwiping(true);
  }, []);

  const handleTouchEnd = useCallback(
    (e: ReactTouchEvent) => {
      if (!swiping) return;
      const deltaX = e.changedTouches[0].clientX - touchStartX.current;
      const threshold = 50;
      const currentIndex = visibleItems.findIndex((i) => isActive(i.path));
      if (Math.abs(deltaX) > threshold) {
        if (deltaX > 0 && currentIndex > 0) {
          const prev = visibleItems[currentIndex - 1];
          if (prev.path) navigate(prev.path);
        } else if (deltaX < 0 && currentIndex < visibleItems.length - 1) {
          const next = visibleItems[currentIndex + 1];
          if (next.path) navigate(next.path);
        }
      }
      setSwiping(false);
    },
    [swiping, navigate, isActive, visibleItems],
  );

  const primary = visibleItems.slice(0, mobilePrimaryCount);
  const overflow = visibleItems.slice(mobilePrimaryCount);

  // Loading skeleton — avoids flash of unauthorized content.
  if (permissionsLoading) {
    if (isMobile) {
      return (
        <Box className={styles.mobileNavBar} data-testid="mobile-nav-bar">
          {Array.from({ length: mobilePrimaryCount }, (_, i) => (
            <Skeleton key={`skel-${i}`} height={40} width={60} radius="sm" style={{ margin: 4 }} />
          ))}
        </Box>
      );
    }
    return (
      <Box className={styles.menuContainer}>
        {Array.from({ length: Math.max(4, items.length) }, (_, i) => (
          <Skeleton key={`skel-${i}`} height={28} width={80} radius="sm" style={{ margin: '0 4px' }} />
        ))}
      </Box>
    );
  }

  /**
   * Render dropdown contents — emits a Menu.Label whenever a child carries
   * a `groupLabel` (introduces a new section header) and a Menu.Item per
   * leaf. Children whose `permission` isn't granted are skipped.
   */
  const renderGroupedChildren = (children: readonly NavItem[]): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const child of children) {
      if (!hasPerm(child.permission)) continue;
      if (child.groupLabel) {
        out.push(
          <Menu.Label key={`label-${child.key}`}>{t(child.groupLabel)}</Menu.Label>,
        );
      }
      const childActive = isActive(child.path);
      out.push(
        <Menu.Item
          key={child.key}
          leftSection={renderIcon(child.icon)}
          onClick={() => child.path && navigate(child.path)}
          className={childActive ? styles.overflowItemActive : ''}
          data-testid={`menu-${child.key}`}
        >
          {t(child.translationKey)}
        </Menu.Item>,
      );
    }
    return out;
  };

  const renderMenuItem = (item: NavItem): ReactNode => {
    // Group dropdown — render as Mantine Menu, not navigable button.
    if (item.children && item.children.length > 0) {
      const visibleChildren = item.children.filter((c) => hasPerm(c.permission));
      if (visibleChildren.length === 0) return null;
      const anyChildActive = visibleChildren.some((c) => isActive(c.path));
      return (
        <Menu key={item.key} position="bottom-end" shadow="lg" width={280} withArrow>
          <Menu.Target>
            <UnstyledButton
              className={`${styles.menuItem} ${anyChildActive ? styles.active : ''}`}
              data-testid={`menu-${item.key}`}
              aria-label={t(item.translationKey)}
              aria-haspopup="menu"
            >
              <span className={styles.menuIcon}>{renderIcon(item.icon)}</span>
              <span className={styles.menuLabel}>{t(item.translationKey)}</span>
              <IconChevronDown size={14} style={{ marginLeft: 4 }} />
              {anyChildActive && <span className={styles.activeIndicator} />}
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown className={styles.overflowDropdown}>
            {renderGroupedChildren(visibleChildren)}
          </Menu.Dropdown>
        </Menu>
      );
    }

    // Plain leaf — original render.
    const active = isActive(item.path);
    return (
      <UnstyledButton
        key={item.key}
        onClick={() => item.path && navigate(item.path)}
        className={`${styles.menuItem} ${active ? styles.active : ''}`}
        data-testid={`menu-${item.key}`}
        aria-label={t(item.translationKey)}
        aria-current={active ? 'page' : undefined}
      >
        <span className={styles.menuIcon}>{renderIcon(item.icon)}</span>
        <span className={styles.menuLabel}>{t(item.translationKey)}</span>
        {active && <span className={styles.activeIndicator} />}
      </UnstyledButton>
    );
  };

  if (isMobile) {
    const overflowActive = overflow.some((i) => isActive(i.path));
    return (
      <Box
        className={styles.mobileNavBar}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        data-testid="mobile-nav-bar"
      >
        {primary.map((item) => {
          // Nested group on mobile — open a Menu instead of navigating.
          if (item.children && item.children.length > 0) {
            const visibleChildren = item.children.filter((c) => hasPerm(c.permission));
            if (visibleChildren.length === 0) return null;
            const anyChildActive = visibleChildren.some((c) => isActive(c.path));
            return (
              <Menu key={item.key} shadow="lg" width={240} position="top-end" withArrow>
                <Menu.Target>
                  <UnstyledButton
                    className={`${styles.mobileNavItem} ${anyChildActive ? styles.active : ''}`}
                    data-testid={`mobile-menu-${item.key}`}
                    aria-label={t(item.translationKey)}
                    aria-haspopup="menu"
                  >
                    <span className={styles.mobileNavIcon}>{renderIcon(item.icon)}</span>
                    <Text className={styles.mobileNavLabel}>{t(item.translationKey)}</Text>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown className={styles.overflowDropdown}>
                  {renderGroupedChildren(visibleChildren)}
                </Menu.Dropdown>
              </Menu>
            );
          }
          const active = isActive(item.path);
          return (
            <UnstyledButton
              key={item.key}
              onClick={() => item.path && navigate(item.path)}
              className={`${styles.mobileNavItem} ${active ? styles.active : ''}`}
              data-testid={`mobile-menu-${item.key}`}
              aria-label={t(item.translationKey)}
              aria-current={active ? 'page' : undefined}
            >
              <span className={styles.mobileNavIcon}>{renderIcon(item.icon)}</span>
              <Text className={styles.mobileNavLabel}>{t(item.translationKey)}</Text>
            </UnstyledButton>
          );
        })}

        {overflow.length > 0 && (
          <Menu shadow="lg" width={220} position="top-end" withArrow>
            <Menu.Target>
              <UnstyledButton
                className={`${styles.mobileNavItem} ${overflowActive ? styles.active : ''}`}
                data-testid="mobile-menu-more"
                aria-label={t('nav:more')}
              >
                <span className={styles.mobileNavIcon}>
                  <IconDotsVertical size={20} />
                </span>
                <Text className={styles.mobileNavLabel}>{t('nav:more')}</Text>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown className={styles.overflowDropdown}>
              {overflow.map((item) => {
                // Nested group inside overflow — emit children as flat items.
                if (item.children && item.children.length > 0) {
                  return renderGroupedChildren(
                    item.children.filter((c) => hasPerm(c.permission)),
                  );
                }
                const active = isActive(item.path);
                return (
                  <Menu.Item
                    key={item.key}
                    leftSection={renderIcon(item.icon)}
                    onClick={() => item.path && navigate(item.path)}
                    className={active ? styles.overflowItemActive : ''}
                  >
                    {t(item.translationKey)}
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
        )}
      </Box>
    );
  }

  return <Box className={styles.menuContainer}>{visibleItems.map(renderMenuItem)}</Box>;
});

export default EMRMainMenu;
