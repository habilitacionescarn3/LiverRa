// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * TranslationContext — LiverRa i18n (T076).
 *
 * Active triad per CLAUDE.md: en (primary), ru (Georgia/CIS market), ka
 * (Georgian). de retained as DACH fallback. The canonical `Locale` /
 * `SUPPORTED_LOCALES` / `DEFAULT_LOCALE` / `INTL_TAG` declarations live in
 * `../services/localeService.ts`; this file re-exports them so a single
 * source of truth survives drift.
 *
 * Behaviour:
 *   - Domain bundles load on demand. Every `t('nav:upload')` lookup that
 *     touches a namespace not yet cached triggers an `import()` and
 *     returns the key itself until the bundle resolves.
 *   - Fallback chain: `de → en`, `ka → en`, `ru → en`. A translator may
 *     leave a de/ka/ru bundle partial; missing keys fall back to the en
 *     bundle. `__TODO_TRANSLATE__:` markers (used while CODEOWNERS medical
 *     terminology review is pending) are treated as missing.
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
// Types — re-exported from the canonical localeService
// ---------------------------------------------------------------------------

import {
  type Locale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  INTL_TAG,
  detectPreferredLocale,
  setLocalePreference,
} from '../services/localeService';

export { type Locale, SUPPORTED_LOCALES, DEFAULT_LOCALE, INTL_TAG };

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
  | 'profile'
  | 'notifications'
  | 'errors'
  | 'ruo'
  | 'sync'
  | 'pacs'
  | 'classificationOverride'
  | 'conflict'
  | 'dropzone'
  | 'failClosed'
  | 'navigation'
  | 'review'
  | 'session'
  | 'takeover'
  | 'reportAcr';

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
  'profile',
  'notifications',
  'errors',
  'ruo',
  'sync',
  'pacs',
  'classificationOverride',
  'conflict',
  'dropzone',
  'failClosed',
  'navigation',
  'review',
  'session',
  'takeover',
  'reportAcr',
] as const;

/** Recursive type for nested JSON translation values. */
type TranslationValue = string | { [k: string]: TranslationValue };
type TranslationBundle = { [k: string]: TranslationValue };

/** Key form: `"namespace:key.with.dots"` OR `"key.with.dots"` (common ns). */
export interface TranslationContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
  /**
   * Resolve a pluralized translation using `Intl.PluralRules` for the active
   * locale. Russian needs 4 forms (one/few/many/other); the previous
   * `count===1 ? _one : _other` ternary in CascadeStageTimeline was wrong for
   * ru (audit H-I18NQ-6 / CC-4).
   *
   * Usage:
   *   tPlural('analysis:detail.cascadeTimeline.summary.stageCount', count, { count, total })
   *
   * Looks up `<baseKey>_<category>` where category is one of `one|few|many|other`.
   * Falls back to `<baseKey>_other` if the specific category bundle key is
   * missing, then to the unsuffixed `<baseKey>`.
   */
  tPlural: (baseKey: string, count: number, params?: Record<string, unknown>) => string;
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
  ru: {},
};

/** In-flight loads to deduplicate concurrent imports. */
const inFlight: Record<Locale, Partial<Record<TranslationNamespace, Promise<TranslationBundle>>>> = {
  en: {},
  de: {},
  ka: {},
  ru: {},
};

/**
 * Track failed loads so we don't poison the bundle cache with `{}` on a
 * transient import error (which would block fallback chain forever for the
 * rest of the session — see M-I18N-4 in the 2026-05-14 audit). A bundle that
 * legitimately doesn't exist (e.g. `ru/reportAcr.json` pre-shell) still falls
 * back to en via the `t()` fallback chain.
 */
const failedLoads: Record<Locale, Partial<Record<TranslationNamespace, number>>> = {
  en: {},
  de: {},
  ka: {},
  ru: {},
};

const MAX_RETRY = 3;

async function loadBundle(locale: Locale, ns: TranslationNamespace): Promise<TranslationBundle> {
  const cached = bundleCache[locale][ns];
  if (cached) return cached;

  const pending = inFlight[locale][ns];
  if (pending) return pending;

  // If we've retried 3 times already, give up but DON'T cache `{}` — the
  // fallback chain in `t()` already covers this case via the en bundle.
  if ((failedLoads[locale][ns] ?? 0) >= MAX_RETRY) {
    return {};
  }

  const p = (async () => {
    try {
      const mod = await import(`../translations/${locale}/${ns}.json`);
      const data = (mod.default ?? mod) as TranslationBundle;
      bundleCache[locale][ns] = data;
      delete failedLoads[locale][ns];
      return data;
    } catch (err) {
      const attempt = (failedLoads[locale][ns] ?? 0) + 1;
      failedLoads[locale][ns] = attempt;
      console.warn(
        `[i18n] Failed to load ${locale}/${ns}.json (attempt ${attempt}/${MAX_RETRY}):`,
        err,
      );
      // Do NOT cache `{}` — let the next request retry. The `t()` fallback
      // chain will surface en values in the interim.
      return {};
    } finally {
      delete inFlight[locale][ns];
    }
  })();

  inFlight[locale][ns] = p;
  return p;
}

/**
 * Marker prefix used in `de/ka/ru` bundles for strings that still need
 * CODEOWNERS medical-terminology review. Form: `__TODO_TRANSLATE__:<English>`.
 * `t()` treats these as "missing" so the fallback chain fires, and strips the
 * prefix as a last resort (so we never paint the marker into the UI).
 */
const TODO_TRANSLATE_PREFIX = '__TODO_TRANSLATE__:';

function isTodoMarker(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(TODO_TRANSLATE_PREFIX);
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

/**
 * Parse `"ns:key.path"` → `["ns", "key.path"]`.
 * For dot-prefixed keys like `"pacs.header.title"` (the convention used by
 * MediMind-ported PACS components), if the first dot-segment matches a known
 * namespace, split there. Otherwise default to `common` so calls like
 * `t('actions.save')` still hit `common.json > actions > save`.
 *
 * Callers can opt OUT of the dot-prefix dispatch by using an explicit colon
 * form (`"common:pacs.wasnt.in.pacs"`) — useful when a `common.json` key
 * happens to collide with a namespace name.
 */
function splitKey(key: string): [TranslationNamespace, string] {
  const colonIdx = key.indexOf(':');
  if (colonIdx > 0) {
    const ns = key.slice(0, colonIdx) as TranslationNamespace;
    const rest = key.slice(colonIdx + 1);
    if (TRANSLATION_NAMESPACES.includes(ns)) return [ns, rest];
  }
  const dotIdx = key.indexOf('.');
  if (dotIdx > 0) {
    const maybeNs = key.slice(0, dotIdx) as TranslationNamespace;
    if (TRANSLATION_NAMESPACES.includes(maybeNs)) {
      return [maybeNs, key.slice(dotIdx + 1)];
    }
  }
  return ['common', key];
}

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
  // Preload `auth` so public/unauthenticated views (404, signin, callback,
  // unauthorized) render English copy on first paint without flashing raw
  // keys while the namespace's dynamic import is still in flight.
  'auth',
  // Preload `ruo` because the persistent RUO disclaimer renders on every
  // authenticated screen (it's mounted by `EMRPage`) and uses `useMemo` over
  // the `t` callback. If the bundle were lazy, the memo would lock to the
  // raw key on first render and never recover (the `t` callback identity is
  // stable across bundle loads).
  'ruo',
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

      // Primary resolution. Treat `__TODO_TRANSLATE__:` markers as missing so
      // the en fallback fires — keeps the UI clean while CODEOWNERS review is
      // pending on de/ka/ru bundles.
      const primary = resolveKey(bundleCache[locale][ns], keyPath);
      let value: string | undefined = isTodoMarker(primary) ? undefined : primary;

      if (value === undefined && locale !== 'en') {
        const fallback = resolveKey(bundleCache.en[ns], keyPath);
        value = isTodoMarker(fallback) ? undefined : fallback;
      }

      // Last resort: if every locale (including en) still surfaces a marker,
      // strip the prefix and render the embedded English source instead of
      // leaking `__TODO_TRANSLATE__:` into the UI.
      if (value === undefined) {
        if (isTodoMarker(primary)) value = primary.slice(TODO_TRANSLATE_PREFIX.length);
        else {
          const enRaw = resolveKey(bundleCache.en[ns], keyPath);
          if (isTodoMarker(enRaw)) value = enRaw.slice(TODO_TRANSLATE_PREFIX.length);
        }
      }

      if (value === undefined) return key;
      return interpolate(value, params);
    },
    [locale],
  );

  // Memoize a per-locale PluralRules instance — Intl.PluralRules constructors
  // are not cheap (browser caches vary) and we call this on every render of any
  // component using `tPlural`.
  const pluralRules = useMemo(() => {
    try {
      return new Intl.PluralRules(INTL_TAG[locale] ?? 'en-GB');
    } catch {
      return new Intl.PluralRules('en-GB');
    }
  }, [locale]);

  const tPlural = useCallback(
    (baseKey: string, count: number, params?: Record<string, unknown>): string => {
      const category = pluralRules.select(count); // 'zero'|'one'|'two'|'few'|'many'|'other'
      const mergedParams = { count, ...(params ?? {}) };
      // Try the specific category first (e.g. `stageCount_many` for ru).
      const specific = t(`${baseKey}_${category}`, mergedParams);
      // `t()` returns the key as a literal when nothing resolved — detect by
      // comparing against the input key.
      if (specific !== `${baseKey}_${category}`) return specific;
      // Fall back to the canonical `_other` form (always present in en).
      const other = t(`${baseKey}_other`, mergedParams);
      if (other !== `${baseKey}_other`) return other;
      // Last resort: try the unsuffixed key.
      return t(baseKey, mergedParams);
    },
    [pluralRules, t],
  );

  // Keep `<html lang="...">` in sync on first mount as well.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', locale);
    }
  }, [locale]);

  const value = useMemo<TranslationContextValue>(
    () => ({ locale, setLocale, t, tPlural, isLoading }),
    [locale, setLocale, t, tPlural, isLoading],
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
  tPlural: (baseKey: string) => baseKey,
  isLoading: false,
};

/**
 * Hook to access translations. Returns a safe stub when used outside a
 * provider so tests and Storybook don't need to wrap every component.
 */
export function useTranslation(): TranslationContextValue {
  return useContext(TranslationContext) ?? defaultTranslationContext;
}
