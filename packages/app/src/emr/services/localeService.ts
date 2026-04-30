// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Locale service (T077).
 *
 * Ports MediMind's localeService with LiverRa's locale set
 * (`en | de | ka`, dropping `ru`). Provides:
 *   - {@link SUPPORTED_LOCALES} — readonly list used for validation.
 *   - {@link detectPreferredLocale} — the storage → navigator fallback
 *     chain used by `<TranslationProvider>`.
 *   - {@link getLocalePreference} / {@link setLocalePreference} —
 *     persistence helpers that also migrate the legacy `emrLanguage`
 *     localStorage key written by MediMind-era code.
 *   - Formatting helpers for dates, numbers, and currency that pick the
 *     right Intl locale tag.
 */

export type Locale = 'en' | 'de' | 'ka' | 'ru';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'de', 'ka', 'ru'] as const;
export const DEFAULT_LOCALE: Locale = 'en';

/** Canonical storage key; legacy MediMind key migrated transparently. */
const STORAGE_KEY = 'liverra.locale';
const LEGACY_STORAGE_KEY = 'emrLanguage';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    // Private-mode Safari + sandboxed iframes throw on access.
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore — localeService must never throw from a setter.
  }
}

/**
 * Return the persisted locale, or `null` if none is set / the value is
 * outside {@link SUPPORTED_LOCALES}. Transparently migrates the legacy
 * MediMind `emrLanguage` key.
 */
export function getLocalePreference(): Locale | null {
  const canonical = readLocalStorage(STORAGE_KEY);
  if (isLocale(canonical)) return canonical;

  const legacy = readLocalStorage(LEGACY_STORAGE_KEY);
  if (isLocale(legacy)) {
    writeLocalStorage(STORAGE_KEY, legacy);
    return legacy;
  }

  return null;
}

/** Persist the user's locale choice. No-op if `locale` is unsupported. */
export function setLocalePreference(locale: Locale): void {
  if (!isLocale(locale)) return;
  writeLocalStorage(STORAGE_KEY, locale);
}

// ---------------------------------------------------------------------------
// Detection (storage → navigator → default)
// ---------------------------------------------------------------------------

/**
 * Resolve the preferred locale using the following priority chain:
 *   1. Persisted preference (`localStorage.liverra.locale`, or legacy
 *      `emrLanguage`).
 *   2. `navigator.language` primary subtag (e.g. `de-AT` → `de`).
 *   3. `navigator.languages` (first supported entry, in order).
 *   4. {@link DEFAULT_LOCALE}.
 */
export function detectPreferredLocale(): Locale {
  const stored = getLocalePreference();
  if (stored) return stored;

  if (typeof navigator !== 'undefined') {
    const primary = (navigator.language || '').split('-')[0]?.toLowerCase();
    if (isLocale(primary)) return primary;

    const list = Array.isArray(navigator.languages) ? navigator.languages : [];
    for (const raw of list) {
      const code = (raw || '').split('-')[0]?.toLowerCase();
      if (isLocale(code)) return code;
    }
  }

  return DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Intl tag mapping
// ---------------------------------------------------------------------------

const INTL_TAG: Record<Locale, string> = {
  en: 'en-GB',
  de: 'de-DE',
  ka: 'ka-GE',
  ru: 'ru-RU',
};

/** Return the BCP 47 language tag used for `Intl.*` formatters. */
export function intlTag(locale: Locale = detectPreferredLocale()): string {
  return INTL_TAG[locale] ?? 'en-GB';
}

// ---------------------------------------------------------------------------
// Formatting helpers (thin wrappers around Intl)
// ---------------------------------------------------------------------------

export interface FormatDateOptions {
  locale?: Locale;
  dateStyle?: 'short' | 'medium' | 'long' | 'full';
  timeStyle?: 'short' | 'medium' | 'long';
  timeZone?: string;
}

export function formatDate(value: Date | string | number, opts: FormatDateOptions = {}): string {
  const d = value instanceof Date ? value : new Date(value);
  const tag = intlTag(opts.locale);
  return new Intl.DateTimeFormat(tag, {
    dateStyle: opts.dateStyle ?? 'medium',
    timeStyle: opts.timeStyle,
    timeZone: opts.timeZone,
  }).format(d);
}

export interface FormatNumberOptions {
  locale?: Locale;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
}

export function formatNumber(value: number, opts: FormatNumberOptions = {}): string {
  return new Intl.NumberFormat(intlTag(opts.locale), {
    minimumFractionDigits: opts.minimumFractionDigits,
    maximumFractionDigits: opts.maximumFractionDigits,
    useGrouping: opts.useGrouping ?? true,
  }).format(value);
}

export interface FormatCurrencyOptions extends FormatNumberOptions {
  currency?: string;
}

export function formatCurrency(
  value: number,
  { currency = 'EUR', locale, ...rest }: FormatCurrencyOptions = {},
): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'currency',
    currency,
    ...rest,
  }).format(value);
}

/**
 * Format a past Date/timestamp as a short relative-time string
 * (e.g. "5m ago", "2h ago", "3d ago"). Falls back to a formatted
 * date for values older than ~30 days. Uses `Intl.RelativeTimeFormat`
 * with the resolved locale tag.
 */
export function formatRelativeTime(
  value: Date | string | number,
  locale?: Locale,
): string {
  const tag = intlTag(locale);
  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  const then = typeof value === 'number' ? value : new Date(value).getTime();
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;

  if (abs < MIN) return rtf.format(Math.round(diffMs / 1000), 'second');
  if (abs < HOUR) return rtf.format(Math.round(diffMs / MIN), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diffMs / HOUR), 'hour');
  if (abs < WEEK) return rtf.format(Math.round(diffMs / DAY), 'day');
  if (abs < MONTH) return rtf.format(Math.round(diffMs / WEEK), 'week');
  // Older than a month → formatted date fallback
  return formatDate(value, { locale, dateStyle: 'medium' });
}
