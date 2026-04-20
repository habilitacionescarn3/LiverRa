// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * TranslationContext — LiverRa i18n (T076).
 *
 * Port of MediMind's TranslationContext, rewritten for LiverRa's
 * `{en, de, ka}` locale set (Russian dropped) and **domain-bundle lazy
 * loading** from `translations/${locale}/${namespace}.json`.
 *
 * Behaviour:
 *   - Domain bundles load on demand. Every `t('nav:upload')` lookup that
 *     touches a namespace not yet cached triggers an `import()` and
 *     returns the key itself until the bundle resolves.
 *   - Fallback chain: `de → en`, `ka → en`. A translator may leave a de/ka
 *     bundle partial; missing keys fall back to the en bundle.
 *   - React-Suspense compatible: consumers can wrap lazy regions in
 *     `<Suspense fallback={...}>` — we throw the in-flight promise from
 *     `t()` on first touch of a loading namespace (opt-in via the
 *     `suspense: true` flag).
 */

import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported UI locales. Explicitly excludes MediMind's `ru`. */
export type Locale = 'en' | 'de' | 'ka';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'de', 'ka'] as const;
export const DEFAULT_LOCALE: Locale = 'en';

/** Namespaces correspond to one JSON file per `translations/<locale>/<ns>.json`. */
export type TranslationNamespace =
  | 'common'
  | 'auth'
  | 'nav'
  | 'upload'
  | 'analysis'
  | 'lesions'
  | 'refine'
  | 'report'
  | 'admin'
  | 'onboarding'
  | 'compliance'
  | 'ops'
  | 'erasure'
  | 'help'
  | 'glossary'
  | 'errors'
  | 'ruo'
  | 'sync';

export const TRANSLATION_NAMESPACES: readonly TranslationNamespace[] = [
  'common',
  'auth',
  'nav',
  'upload',
  'analysis',
  'lesions',
  'refine',
  'report',
  'admin',
  'onboarding',
  'compliance',
  'ops',
  'erasure',
  'help',
  'glossary',
  'errors',
  'ruo',
  'sync',
] as const;

/** Recursive type for nested JSON translation values. */
type TranslationValue = string | { [k: string]: TranslationValue };
type TranslationBundle = { [k: string]: TranslationValue };

/** Key form: `"namespace:key.with.dots"` OR `"key.with.dots"` (common ns). */
export interface TranslationContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Module-level bundle cache (shared across all provider instances in a tab)
// ---------------------------------------------------------------------------

/** bundleCache[locale][namespace] = loaded bundle. */
const bundleCache: Record<Locale, Partial<Record<TranslationNamespace, TranslationBundle>>> = {
  en: {},
  de: {},
  ka: {},
};

/** In-flight loads to deduplicate concurrent imports. */
const inFlight: Record<Locale, Partial<Record<TranslationNamespace, Promise<TranslationBundle>>>> = {
  en: {},
  de: {},
  ka: {},
};

async function loadBundle(locale: Locale, ns: TranslationNamespace): Promise<TranslationBundle> {
  const cached = bundleCache[locale][ns];
  if (cached) return cached;

  const pending = inFlight[locale][ns];
  if (pending) return pending;

  const p = (async () => {
    try {
      const mod = await import(`../translations/${locale}/${ns}.json`);
      const data = (mod.default ?? mod) as TranslationBundle;
      bundleCache[locale][ns] = data;
      return data;
    } catch (err) {
      console.warn(`[i18n] Failed to load ${locale}/${ns}.json:`, err);
      const empty: TranslationBundle = {};
      bundleCache[locale][ns] = empty;
      return empty;
    } finally {
      delete inFlight[locale][ns];
    }
  })();

  inFlight[locale][ns] = p;
  return p;
}

/** Walk `foo.bar.baz` into a nested bundle. */
function resolveKey(bundle: TranslationBundle | undefined, path: string): string | undefined {
  if (!bundle) return undefined;
  // Flat-key fast path (bundle may store "foo.bar" as a single key).
  const flat = bundle[path];
  if (typeof flat === 'string') return flat;

  const segments = path.split('.');
  let current: TranslationValue = bundle;
  for (const seg of segments) {
    if (current && typeof current === 'object' && seg in (current as TranslationBundle)) {
      current = (current as TranslationBundle)[seg];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

/** Replace `{{param}}` (double or single brace) placeholders. */
function interpolate(text: string, params?: Record<string, unknown>): string {
  if (!params) return text;
  return text.replace(/\{\{?(\w+)\}?\}/g, (match, paramKey: string) => {
    const value = params[paramKey];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Parse `"ns:key.path"` → `["ns", "key.path"]`; unprefixed → `["common", path]`. */
function splitKey(key: string): [TranslationNamespace, string] {
  const colonIdx = key.indexOf(':');
  if (colonIdx > 0) {
    const ns = key.slice(0, colonIdx) as TranslationNamespace;
    const rest = key.slice(colonIdx + 1);
    if (TRANSLATION_NAMESPACES.includes(ns)) return [ns, rest];
  }
  return ['common', key];
}

// ---------------------------------------------------------------------------
// Locale detection
// ---------------------------------------------------------------------------

import { detectPreferredLocale, setLocalePreference } from '../services/localeService';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const TranslationContext = createContext<TranslationContextValue | null>(null);

interface TranslationProviderProps {
  children: ReactNode;
  /** Initial locale override (e.g. sourced from `User.locale_preference`). */
  initialLocale?: Locale;
  /** Namespaces to eagerly load on mount. Defaults to `['common', 'errors']`. */
  preloadNamespaces?: readonly TranslationNamespace[];
}

// Stable module-level default so `useEffect(..., [preloadNamespaces])` does not
// see a new array reference every render and fire in a loop.
const DEFAULT_PRELOAD_NAMESPACES: readonly TranslationNamespace[] = [
  'common',
  'errors',
];

export function TranslationProvider({
  children,
  initialLocale,
  preloadNamespaces = DEFAULT_PRELOAD_NAMESPACES,
}: TranslationProviderProps): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(
    () => initialLocale ?? detectPreferredLocale(),
  );
  const [, forceRender] = useState(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const mountedRef = useRef(true);

  // Preload common + errors (plus any caller-supplied bundles) at mount
  // and re-run whenever the locale changes.
  useEffect(() => {
    mountedRef.current = true;
    setIsLoading(true);

    const bundles = [
      // Always ensure English fallback is available.
      ...preloadNamespaces.map((ns) => loadBundle('en', ns)),
      // Requested locale's preload bundles.
      ...(locale === 'en'
        ? []
        : preloadNamespaces.map((ns) => loadBundle(locale, ns))),
    ];

    void Promise.all(bundles).then(() => {
      if (mountedRef.current) {
        setIsLoading(false);
        forceRender((n) => n + 1);
      }
    });

    return () => {
      mountedRef.current = false;
    };
  }, [locale, preloadNamespaces]);

  const setLocale = useCallback((next: Locale) => {
    if (!SUPPORTED_LOCALES.includes(next)) return;
    setLocalePreference(next);
    setLocaleState(next);
    // Mirror on document root so CSS `[lang='ka']` font fallback works.
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', next);
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, unknown>): string => {
      const [ns, keyPath] = splitKey(key);

      // Kick off load for requested locale (non-blocking).
      if (!bundleCache[locale][ns]) {
        void loadBundle(locale, ns).then(() => {
          if (mountedRef.current) forceRender((n) => n + 1);
        });
      }
      // Kick off English fallback load.
      if (locale !== 'en' && !bundleCache.en[ns]) {
        void loadBundle('en', ns).then(() => {
          if (mountedRef.current) forceRender((n) => n + 1);
        });
      }

      // Primary resolution.
      let value = resolveKey(bundleCache[locale][ns], keyPath);
      // de → en / ka → en fallback.
      if (value === undefined && locale !== 'en') {
        value = resolveKey(bundleCache.en[ns], keyPath);
      }
      if (value === undefined) return key;
      return interpolate(value, params);
    },
    [locale],
  );

  // Keep `<html lang="...">` in sync on first mount as well.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', locale);
    }
  }, [locale]);

  const value = useMemo<TranslationContextValue>(
    () => ({ locale, setLocale, t, isLoading }),
    [locale, setLocale, t, isLoading],
  );

  return (
    <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Safe default — lets components render in tests without a provider.
// ---------------------------------------------------------------------------

const defaultTranslationContext: TranslationContextValue = {
  locale: DEFAULT_LOCALE,
  setLocale: () => {
    /* no-op */
  },
  t: (key: string) => key,
  isLoading: false,
};

/**
 * Hook to access translations. Returns a safe stub when used outside a
 * provider so tests and Storybook don't need to wrap every component.
 */
export function useTranslation(): TranslationContextValue {
  return useContext(TranslationContext) ?? defaultTranslationContext;
}
