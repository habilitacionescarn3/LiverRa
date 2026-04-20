// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ThemeContext (T113).
 *
 * Plain-English: this context controls light/dark/auto mode. "Auto"
 * follows the OS — if the user flips macOS into dark mode at 6pm, the
 * app flips with it. The only DOM side-effect is writing
 * `data-mantine-color-scheme="light|dark"` on `<html>`; Mantine + the
 * `theme.css` variables handle everything else.
 *
 * Source of truth for the user preference is `User.theme_preference`
 * (data-model §2) — loaded by AuthContext and passed here via
 * `initialMode`. Changes via `setMode()` must be persisted back to the
 * server by the calling UI (PATCH `/users/me`); this context is purely
 * the client-side renderer.
 *
 * Spec references: T113, plan.md §641-648.
 */

import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  /** User preference, including `auto`. */
  mode: ThemeMode;
  /** `auto` resolved to `light` / `dark` via `prefers-color-scheme`. */
  resolvedMode: ResolvedThemeMode;
  /** Setter — caller is responsible for persisting to the backend. */
  setMode: (next: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function getOsPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DARK_QUERY).matches;
}

interface ThemeProviderProps {
  children: ReactNode;
  /** Initial mode — defaults to `auto`; pass the user's saved preference once auth resolves. */
  initialMode?: ThemeMode;
}

export function ThemeProvider({ children, initialMode = 'auto' }: ThemeProviderProps): JSX.Element {
  const [mode, setMode] = useState<ThemeMode>(initialMode);
  const [osDark, setOsDark] = useState<boolean>(() => getOsPrefersDark());

  // Subscribe to OS preference changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_QUERY);
    const handler = (e: MediaQueryListEvent): void => setOsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Keep `mode` in sync if the parent changes `initialMode` post-mount
  // (happens once when AuthContext resolves the user's saved preference).
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  const resolvedMode: ResolvedThemeMode = mode === 'auto' ? (osDark ? 'dark' : 'light') : mode;

  // Write the Mantine color-scheme attribute on `<html>`.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-mantine-color-scheme', resolvedMode);
  }, [resolvedMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedMode, setMode }),
    [mode, resolvedMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
