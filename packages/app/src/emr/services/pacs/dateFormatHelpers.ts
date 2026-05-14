// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Locale-aware date helpers for PACS components.
 *
 * Replaces the 15-site `new Date(x).toLocaleDateString()` pattern that was
 * picking up the browser's default locale instead of the LiverRa user locale
 * (audit M-I18NQ-2 in 2026-05-14 EMR audit). Each PACS component already has
 * a `useTranslation()` call — grab `locale`, pipe it through
 * {@link toLocaleDateForPacs}, and the rendered date matches the user's
 * chosen language.
 *
 * Why a thin wrapper instead of calling `formatDate` from `localeService`
 * directly? `formatDate` uses `Intl.DateTimeFormat` with `dateStyle: 'medium'`
 * which produces a verbose form ("May 14, 2026") for en. The PACS card grid
 * wants the compact form ("14.05.2026" / "5/14/2026"), so we delegate to
 * `toLocaleDateString` with the BCP-47 tag.
 */

import { INTL_TAG, type Locale } from './../localeService';

/**
 * Convert a date-like value to the locale-aware short date string. Returns
 * an empty string when the input is falsy or invalid.
 */
export function toLocaleDateForPacs(
  value: string | number | Date | null | undefined,
  locale: Locale,
): string {
  if (value === null || value === undefined || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const tag = INTL_TAG[locale] ?? 'en-GB';
  return d.toLocaleDateString(tag);
}
