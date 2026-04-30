// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ColorBar — Window/Level Gradient Strip with HU Tick Marks
// ============================================================================
// A vertical gradient strip that sits alongside the PACS viewport and shows
// how Hounsfield Unit (HU) values map to display brightness under the current
// Window/Level settings. Think of it like a thermometer next to an image —
// it tells radiologists "this shade of gray means this tissue density."
//
// The gradient goes from black (bottom = lowest visible HU) to white (top =
// highest visible HU). Tick marks show key HU values like 0 (water),
// -1000 (air), +1000 (bone), and the current window center.
//
// Props:
//   windowCenter — current brightness center value
//   windowWidth  — current contrast range
// ============================================================================

import { memo, useMemo } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import './ColorBar.css';

// ============================================================================
// Types
// ============================================================================

export interface ColorBarProps {
  /** Current window center (brightness midpoint in HU) */
  windowCenter: number;
  /** Current window width (contrast range in HU) */
  windowWidth: number;
}

// ============================================================================
// Tick Mark Definitions
// ============================================================================

/** Well-known HU reference values shown as tick marks when they fall within range */
const HU_REFERENCE_TICKS = [
  { hu: -1000, i18nKey: 'pacs.colorbar.air' },
  { hu: -500, i18nKey: '' },
  { hu: 0, i18nKey: 'pacs.colorbar.water' },
  { hu: 40, i18nKey: 'pacs.colorbar.tissue' },
  { hu: 300, i18nKey: '' },
  { hu: 1000, i18nKey: 'pacs.colorbar.bone' },
  { hu: 2000, i18nKey: '' },
  { hu: 3000, i18nKey: 'pacs.colorbar.metal' },
];

// ============================================================================
// Component
// ============================================================================

export const ColorBar = memo(function ColorBar({
  windowCenter,
  windowWidth,
}: ColorBarProps) {
  const { t } = useTranslation();

  // Calculate the HU range currently visible
  const lowerHU = windowCenter - windowWidth / 2;
  const upperHU = windowCenter + windowWidth / 2;

  // Build tick marks that fall within the current window range
  const ticks = useMemo(() => {
    if (upperHU <= lowerHU) return [];

    const visible: { hu: number; i18nKey: string; pct: number }[] = [];

    for (const ref of HU_REFERENCE_TICKS) {
      if (ref.hu >= lowerHU && ref.hu <= upperHU) {
        // Position as percentage from bottom (0%) to top (100%)
        const pct = ((ref.hu - lowerHU) / (upperHU - lowerHU)) * 100;
        visible.push({ hu: ref.hu, i18nKey: ref.i18nKey, pct });
      }
    }

    // Always add center tick if not already covered by a reference
    const centerPct = 50; // center is always at 50% by definition
    const hasCenterTick = visible.some(
      (tick) => Math.abs(tick.pct - centerPct) < 5
    );
    if (!hasCenterTick) {
      visible.push({
        hu: Math.round(windowCenter),
        i18nKey: '',
        pct: centerPct,
      });
    }

    return visible;
  }, [lowerHU, upperHU, windowCenter]);

  return (
    <div
      className="pacs-colorbar"
      data-testid="pacs-colorbar"
      aria-label={`${t('pacs.colorbar.ariaLabel')}: Window ${Math.round(windowWidth)}, Level ${Math.round(windowCenter)}`}
    >
      {/* Gradient strip — black at bottom (low HU) to white at top (high HU) */}
      <div className="pacs-colorbar-gradient" data-testid="pacs-colorbar-gradient" />

      {/* HU tick marks */}
      {ticks.map((tick) => (
        <div
          key={tick.hu}
          className="pacs-colorbar-tick"
          data-testid={`pacs-colorbar-tick-${tick.hu}`}
          style={{ bottom: `${tick.pct}%` }}
        >
          <span className="pacs-colorbar-tick-line" />
          <span className="pacs-colorbar-tick-label">
            {tick.i18nKey ? `${tick.hu} ${t(tick.i18nKey)}` : `${tick.hu}${tick.pct === 50 ? ' C' : ''}`}
          </span>
        </div>
      ))}

      {/* Range labels at top and bottom */}
      <div className="pacs-colorbar-range-top" data-testid="pacs-colorbar-range-top">
        {Math.round(upperHU)}
      </div>
      <div className="pacs-colorbar-range-bottom" data-testid="pacs-colorbar-range-bottom">
        {Math.round(lowerHU)}
      </div>
    </div>
  );
});

export default ColorBar;
