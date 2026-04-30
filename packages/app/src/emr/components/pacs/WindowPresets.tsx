// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// WindowPresets — Window/Level Preset Buttons
// ============================================================================
// A row of buttons for quickly switching between predefined Window/Level
// settings. Think of these like Instagram filters but for CT scans:
// each preset adjusts contrast to highlight specific body tissues.
//
// - Liver: hepatic parenchyma contrast window (LiverRa default)
// - Lung: air-filled spaces (dark lungs stand out)
// - Bone: skeletal structures (bright white bones)
// - Brain: subtle gray matter differences
// - Soft Tissue: muscles and organs
// - Abdomen: abdominal organs with moderate contrast
//
// Uses WINDOW_LEVEL_PRESETS from cornerstoneInit.ts for the actual values.
// LiverRa's `liver` preset ({ center: 90, width: 150 }) is already defined
// in cornerstoneInit.ts; a button for it is added here as the first entry
// since LiverRa is a liver-focused application.
// All buttons are 44x44px minimum for mobile tap targets.
// ============================================================================

import React from 'react';
import { Tooltip } from '@mantine/core';
import {
  IconLungs,
  IconBone,
  IconBrain,
  IconUser,
  IconBodyScan,
  IconMeat,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { WINDOW_LEVEL_PRESETS } from '../../services/pacs/cornerstoneInit';
import './WindowPresets.css';

// ============================================================================
// Types
// ============================================================================

export interface WindowPresetsProps {
  /** Currently active preset key (e.g., 'lung', 'bone'), or null if custom */
  activePreset: string | null;
  /** Called when user clicks a preset button */
  onPresetChange: (presetKey: string, center: number, width: number) => void;
  /** Disable all buttons (e.g., during loading) */
  disabled?: boolean;
}

// ============================================================================
// Configuration — maps preset keys to icons and translation keys
// ============================================================================

interface PresetConfig {
  key: string;
  icon: React.ReactNode;
  translationKey: string;
}

const PRESET_BUTTONS: PresetConfig[] = [
  // LiverRa-specific: hepatic parenchyma preset surfaced first for the primary use case.
  // Tabler doesn't ship a liver icon; IconMeat is the closest organic-tissue glyph.
  { key: 'liver', icon: <IconMeat size={18} />, translationKey: 'pacs.wlPresets.liver' },
  { key: 'abdomen', icon: <IconBodyScan size={18} />, translationKey: 'pacs.wlPresets.abdomen' },
  { key: 'softTissue', icon: <IconUser size={18} />, translationKey: 'pacs.wlPresets.softTissue' },
  { key: 'lung', icon: <IconLungs size={18} />, translationKey: 'pacs.wlPresets.lung' },
  { key: 'bone', icon: <IconBone size={18} />, translationKey: 'pacs.wlPresets.bone' },
  { key: 'brain', icon: <IconBrain size={18} />, translationKey: 'pacs.wlPresets.brain' },
];

// ============================================================================
// Component
// ============================================================================

export function WindowPresets({
  activePreset,
  onPresetChange,
  disabled = false,
}: WindowPresetsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className="window-presets"
      role="radiogroup"
      aria-label={t('pacs.wlPresets.title')}
      data-testid="window-presets"
    >
      {PRESET_BUTTONS.map(({ key, icon, translationKey }) => {
        const preset = WINDOW_LEVEL_PRESETS[key];
        if (!preset) {
          return null;
        }

        const isActive = activePreset === key;
        const label = t(translationKey);
        const tooltipLabel = `${label} (W:${preset.width} L:${preset.center})`;

        return (
          <Tooltip
            key={key}
            label={tooltipLabel}
            position="bottom"
            withArrow
          >
            <button
              className={`window-preset-btn ${isActive ? 'active' : ''}`}
              onClick={() => onPresetChange(key, preset.center, preset.width)}
              disabled={disabled}
              aria-label={label}
              aria-pressed={isActive}
              role="radio"
              aria-checked={isActive}
              data-testid={`window-preset-${key}`}
              data-preset={key}
            >
              {icon}
              <span className="window-preset-label">{label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export default React.memo(WindowPresets);
