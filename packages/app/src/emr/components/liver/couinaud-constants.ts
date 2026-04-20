// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Couinaud + vessel shared constants — single source of truth for the
 * 8 Roman numerals, the CSS colour tokens, and the helper that maps
 * label → token name. Keeping this in a small neutral module means
 * SegmentsLayer, CouinaudLegend, SegmentVolumeCard, and the e2e tests
 * all reference the same symbols.
 *
 * Colour tokens live in packages/app/src/emr/styles/theme.css lines
 * 4049-4087 and were CVD-verified by T411 palette-cvd-check.
 */

export const COUINAUD_LABELS = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
] as const;

export type CouinaudLabel = typeof COUINAUD_LABELS[number];

/** CSS variable name for a given Couinaud label. */
export function getCouinaudColorVar(label: CouinaudLabel): string {
  return `var(--liverra-seg-couinaud-${label})`;
}

export const VESSEL_COLOR_VARS = {
  portal: 'var(--liverra-vessel-portal)',
  hepatic: 'var(--liverra-vessel-hepatic)',
} as const;

export type VesselKind = keyof typeof VESSEL_COLOR_VARS;

/**
 * Which lobe each segment belongs to — used by SegmentVolumeCard to
 * show "Left lobe" / "Right lobe" at a glance, per surgical taxonomy
 * (Couinaud 1957; confirmed with Prof. Schlitt review in research/).
 *
 * Segment I (caudate) straddles both lobes clinically; convention is
 * to show it as its own category.
 */
export const COUINAUD_LOBE: Record<CouinaudLabel, 'caudate' | 'left' | 'right'> = {
  I: 'caudate',
  II: 'left',
  III: 'left',
  IV: 'left', // Segment IV is strictly left-medial
  V: 'right',
  VI: 'right',
  VII: 'right',
  VIII: 'right',
};
