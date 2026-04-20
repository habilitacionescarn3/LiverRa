// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AccessibilityContext (T115).
 *
 * Plain-English: a11y helpers in one place. Two jobs:
 *
 *   1. Watch `prefers-reduced-motion` so components can skip framer
 *      animations / CSS transitions for users who've opted out of
 *      vestibular-triggering motion.
 *   2. Provide a single ARIA live region that any component can call
 *      `announceToSR('Report finalized')` into. Screen readers
 *      (NVDA / JAWS / VoiceOver) read changes to `aria-live` regions
 *      aloud without stealing focus.
 *
 * Analogy: `announceToSR` is the PA system in an airport. Anyone with a
 * microphone (any component) can call the PA (live region) and the
 * passengers (screen readers) hear it — but nobody has to walk over to
 * the announcer's booth and learn how the PA works.
 *
 * Two live regions are maintained:
 *   - `polite` — non-urgent (toasts, "draft saved")
 *   - `assertive` — urgent (errors, audit failures)
 *   - `setBusy(true)` toggles `aria-busy` on the polite region while a
 *     long-running action is in flight.
 *
 * Spec references: T115, plan.md §401, §650-663.
 */

import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type AnnouncePriority = 'polite' | 'assertive';

interface AccessibilityContextValue {
  /** `true` when the OS is set to reduce motion. Updates live. */
  prefersReducedMotion: boolean;
  /** Write `text` into the polite (default) or assertive live region. */
  announceToSR: (text: string, priority?: AnnouncePriority) => void;
  /** Toggle `aria-busy` on the polite region while long operations run. */
  setBusy: (busy: boolean) => void;
}

const AccessibilityContext = createContext<AccessibilityContextValue | null>(null);

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

interface AccessibilityProviderProps {
  children: ReactNode;
}

export function AccessibilityProvider({ children }: AccessibilityProviderProps): JSX.Element {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => getReducedMotion());
  const [politeMessage, setPoliteMessage] = useState<string>('');
  const [assertiveMessage, setAssertiveMessage] = useState<string>('');
  const [busy, setBusyState] = useState<boolean>(false);

  // Monotonic counters so identical consecutive announcements still fire.
  // Screen readers dedupe identical text in the same tick; the counter is
  // appended as a hidden ZWSP so the text *changes* from the DOM's POV.
  const politeTickRef = useRef(0);
  const assertiveTickRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const handler = (e: MediaQueryListEvent): void => setPrefersReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const announceToSR = useCallback((text: string, priority: AnnouncePriority = 'polite'): void => {
    const zwsp = '\u200B';
    if (priority === 'assertive') {
      assertiveTickRef.current += 1;
      setAssertiveMessage(text + zwsp.repeat(assertiveTickRef.current % 2));
    } else {
      politeTickRef.current += 1;
      setPoliteMessage(text + zwsp.repeat(politeTickRef.current % 2));
    }
  }, []);

  const setBusy = useCallback((next: boolean): void => setBusyState(next), []);

  const value = useMemo<AccessibilityContextValue>(
    () => ({ prefersReducedMotion, announceToSR, setBusy }),
    [prefersReducedMotion, announceToSR, setBusy],
  );

  // Visually hidden style — keeps the region in the DOM (so screen readers
  // index it) while being invisible to sighted users.
  const srOnly: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: 0,
  };

  return (
    <AccessibilityContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={busy ? 'true' : 'false'}
        style={srOnly}
      >
        {politeMessage}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" style={srOnly}>
        {assertiveMessage}
      </div>
    </AccessibilityContext.Provider>
  );
}

export function useAccessibility(): AccessibilityContextValue {
  const ctx = useContext(AccessibilityContext);
  if (!ctx) {
    throw new Error('useAccessibility must be used inside <AccessibilityProvider>');
  }
  return ctx;
}
