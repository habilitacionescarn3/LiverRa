// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * MobileContext (T114).
 *
 * Plain-English: tells components which screen size we're on without
 * every component re-running `window.matchMedia` listeners. Think of it
 * as the weather service for layout decisions — "it's xs outside, bring
 * a touch keyboard".
 *
 * Breakpoints mirror Mantine defaults (CLAUDE.md §Mobile-First):
 *   xs  < 576 px   | sm  ≥ 576 px   | md ≥ 768 px
 *   lg  ≥ 992 px   | xl  ≥ 1200 px  | (anything ≥ 1400 is also xl here)
 *
 * `isTouch` is a one-time detection (pointer hardware doesn't change at
 * runtime on any real device) using both `ontouchstart` and
 * `navigator.maxTouchPoints` to handle hybrid devices (Surface, iPad
 * with Magic Keyboard, etc.).
 *
 * Spec references: T114, plan.md §400, §650-663, CLAUDE.md §Mobile-First.
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface MobileContextValue {
  breakpoint: Breakpoint;
  isTouch: boolean;
  /** Convenience: `true` on xs + sm. */
  isMobile: boolean;
  /** Convenience: `true` on md. */
  isTablet: boolean;
  /** Convenience: `true` on lg + xl. */
  isDesktop: boolean;
}

const MobileContext = createContext<MobileContextValue | null>(null);

// Mantine default breakpoint thresholds (px).
const BP_SM = 576;
const BP_MD = 768;
const BP_LG = 992;
const BP_XL = 1200;

function widthToBreakpoint(w: number): Breakpoint {
  if (w >= BP_XL) return 'xl';
  if (w >= BP_LG) return 'lg';
  if (w >= BP_MD) return 'md';
  if (w >= BP_SM) return 'sm';
  return 'xs';
}

function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  const hasOnTouchStart = 'ontouchstart' in window;
  const maxPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return hasOnTouchStart || maxPoints > 0;
}

interface MobileProviderProps {
  children: ReactNode;
}

export function MobileProvider({ children }: MobileProviderProps): JSX.Element {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    typeof window === 'undefined' ? 'md' : widthToBreakpoint(window.innerWidth),
  );
  const [isTouch] = useState<boolean>(() => detectTouch());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    // Listen at each threshold. A single resize listener would also work,
    // but `matchMedia` + `change` events fire far less often than raw
    // `resize`, which matters on mobile where browser UI shrink/expand
    // can fire dozens of resize events per second.
    const queries = [
      window.matchMedia(`(min-width: ${BP_SM}px)`),
      window.matchMedia(`(min-width: ${BP_MD}px)`),
      window.matchMedia(`(min-width: ${BP_LG}px)`),
      window.matchMedia(`(min-width: ${BP_XL}px)`),
    ];

    const handler = (): void => setBreakpoint(widthToBreakpoint(window.innerWidth));
    for (const q of queries) q.addEventListener('change', handler);

    // Seed + catch any missed change from the initial render.
    handler();

    return () => {
      for (const q of queries) q.removeEventListener('change', handler);
    };
  }, []);

  const value = useMemo<MobileContextValue>(
    () => ({
      breakpoint,
      isTouch,
      isMobile: breakpoint === 'xs' || breakpoint === 'sm',
      isTablet: breakpoint === 'md',
      isDesktop: breakpoint === 'lg' || breakpoint === 'xl',
    }),
    [breakpoint, isTouch],
  );

  return <MobileContext.Provider value={value}>{children}</MobileContext.Provider>;
}

export function useMobile(): MobileContextValue {
  const ctx = useContext(MobileContext);
  if (!ctx) {
    throw new Error('useMobile must be used inside <MobileProvider>');
  }
  return ctx;
}
