// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * HorizontalSubMenu — LiverRa sub-navigation tabs (T108).
 *
 * Plain-English: the second row of navigation — sub-tabs scoped to the
 * currently active top-level section. Horizontally scrollable with snap
 * points on mobile; active tab has an underline indicator.
 *
 * This file is the structural port; tab contents are passed in as
 * `items`, not hardcoded, because LiverRa's section-to-subtab mapping is
 * defined in `constants/nav-registry.ts` (sibling agent).
 */

import { Box, UnstyledButton } from '@mantine/core';
import { useMediaQuery, useDebouncedCallback } from '@mantine/hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useHasPermission } from '../../contexts/PermissionContext';
import { useTranslation } from '../../contexts/TranslationContext';
import type { LiverraPermission } from '../../constants/permissions.gen';

import styles from './HorizontalSubMenu.module.css';

export interface SubMenuItem {
  key: string;
  translationKey: string;
  path: string;
  /** Optional permission required to see this sub-tab. */
  permission?: LiverraPermission;
}

export interface HorizontalSubMenuProps {
  /** Sub-menu entries for the currently active section. */
  items: SubMenuItem[];
  /** Mobile breakpoint in px (default 768). */
  mobileBreakpointPx?: number;
}

export function HorizontalSubMenu({
  items,
  mobileBreakpointPx = 768,
}: HorizontalSubMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useMediaQuery(`(max-width: ${mobileBreakpointPx}px)`) ?? false;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [activeScrollIndex, setActiveScrollIndex] = useState(0);
  const [showScrollIndicator, setShowScrollIndicator] = useState(false);

  // Permission filter — stable hook order across renders.
  const grantedMask = items.map((i) => (i.permission ? useHasPermission(i.permission) : true));
  const visibleItems = useMemo(
    () => items.filter((_, idx) => grantedMask[idx]),
    [items, grantedMask.join(',')],
  );

  // Longest-prefix-match active detection (prevents index tab being false-active).
  const activeItem = useMemo(() => {
    let best: SubMenuItem | undefined;
    for (const item of visibleItems) {
      const matches =
        location.pathname === item.path || location.pathname.startsWith(item.path + '/');
      if (matches && (!best || item.path.length > best.path.length)) {
        best = item;
      }
    }
    return best;
  }, [visibleItems, location.pathname]);

  const isActive = (path: string): boolean => activeItem?.path === path;

  const handleScroll = useDebouncedCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollLeft = container.scrollLeft;
    const scrollWidth = container.scrollWidth - container.clientWidth;
    const itemWidth = container.scrollWidth / Math.max(visibleItems.length, 1);
    const visibleCount = Math.max(1, Math.floor(container.clientWidth / itemWidth));
    const totalPages = Math.max(1, Math.ceil(visibleItems.length / visibleCount));
    const currentPage =
      scrollWidth > 0 ? Math.round(scrollLeft / (scrollWidth / Math.max(totalPages - 1, 1))) : 0;

    setActiveScrollIndex(Math.min(currentPage, totalPages - 1));
    setShowScrollIndicator(scrollWidth > 0);
  }, 50);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const activeTab = container.querySelector(`[data-testid="submenu-${activeItem?.key}"]`);
    if (activeTab) {
      const tabRect = activeTab.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (tabRect.left < containerRect.left || tabRect.right > containerRect.right) {
        activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
    handleScroll();
  }, [activeItem?.key, handleScroll]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const calculateIndicatorDots = (): number => {
    const container = scrollContainerRef.current;
    if (!container) return 1;
    const itemWidth = container.scrollWidth / Math.max(visibleItems.length, 1);
    const visibleCount = Math.max(1, Math.floor(container.clientWidth / itemWidth));
    return Math.max(1, Math.ceil(visibleItems.length / visibleCount));
  };

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <Box className={styles.container} data-testid="submenu">
      <Box
        ref={scrollContainerRef}
        className={`${styles.scrollContainer} ${isMobile ? styles.scrollSnap : ''}`}
      >
        <Box className={styles.tabContainer}>
          {visibleItems.map((item) => {
            const active = isActive(item.path);
            return (
              <UnstyledButton
                key={item.key}
                onClick={() => navigate(item.path)}
                className={`${styles.tab} ${active ? styles.active : ''}`}
                data-testid={`submenu-${item.key}`}
                aria-label={t(item.translationKey)}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.tabLabel}>{t(item.translationKey)}</span>
                {active && <span className={styles.activeBar} />}
              </UnstyledButton>
            );
          })}
        </Box>
      </Box>

      {isMobile && showScrollIndicator && (
        <Box className={styles.scrollIndicator} aria-hidden="true">
          {Array.from({ length: calculateIndicatorDots() }, (_, i) => (
            <span
              key={`indicator-dot-${i}`}
              className={`${styles.indicatorDot} ${i === activeScrollIndex ? styles.activeDot : ''}`}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default HorizontalSubMenu;
