// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useMediaQuery — tiny native replacement for `@mantine/hooks`'s
 * `useMediaQuery`. Returns `true` when the supplied CSS media query matches.
 *
 * Plain English: "tell me if the screen is small / large / dark mode".
 * It listens to `window.matchMedia` so the value flips as the user resizes
 * or rotates the device.
 *
 * SSR-safe: returns `defaultValue` (default `false`) when `window` is
 * undefined, then upgrades to the real result on mount.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return defaultValue;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent): void => setMatches(e.matches);
    // Sync once in case the value changed between render and effect.
    setMatches(mq.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    // Legacy Safari < 14 fallback
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, [query]);

  return matches;
}

export default useMediaQuery;
