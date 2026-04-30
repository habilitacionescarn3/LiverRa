// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ImageFilterControls — Dropdown for sharpen/smooth image filters
// ============================================================================
// A dropdown menu button that lets radiologists apply image processing filters
// to the current viewport. Think of it like the "Enhance" menu in a photo editor:
//   - Sharpen: makes edges crisper (helpful for fractures, fine structures)
//   - Smooth: reduces noise (helpful for noisy low-dose CT)
// Each filter has three strengths (light/medium/strong).
//
// The dropdown follows the same Mantine Menu pattern used in PACSToolbar for
// tool groups, protocol menu, etc. Active filter shows a checkmark.
// ============================================================================

import { Menu, Tooltip } from '@mantine/core';
import {
  IconAdjustmentsAlt,
  IconCheck,
  IconX,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';

// ============================================================================
// Types
// ============================================================================

// TODO(phase-4): Import FilterType/FilterStrength/ActiveFilter from
// `../../hooks/pacs/useImageFilters` once that hook (and its sibling
// `services/pacs/imageFilterService`) are ported. Types are inlined here so
// this presentational control can ship before the hook lands.
export type FilterType = 'sharpen' | 'smooth';
export type FilterStrength = 'light' | 'medium' | 'strong';
export interface ActiveFilter {
  type: FilterType;
  strength: FilterStrength;
}

export interface ImageFilterControlsProps {
  /** Currently active filter, or null if none applied */
  activeFilter: ActiveFilter | null;
  /** Called when user selects a filter option */
  onApplyFilter: (type: FilterType, strength: FilterStrength) => void;
  /** Called when user clicks "Clear Filter" */
  onClearFilter: () => void;
  /** Disable the control (e.g., during loading) */
  disabled?: boolean;
}

// ============================================================================
// Filter Options Config
// ============================================================================

interface FilterOption {
  type: FilterType;
  strength: FilterStrength;
  labelKey: string;
}

const SHARPEN_OPTIONS: FilterOption[] = [
  { type: 'sharpen', strength: 'light', labelKey: 'pacs.filters.sharpenLight' },
  { type: 'sharpen', strength: 'medium', labelKey: 'pacs.filters.sharpenMedium' },
  { type: 'sharpen', strength: 'strong', labelKey: 'pacs.filters.sharpenStrong' },
];

const SMOOTH_OPTIONS: FilterOption[] = [
  { type: 'smooth', strength: 'light', labelKey: 'pacs.filters.smoothLight' },
  { type: 'smooth', strength: 'medium', labelKey: 'pacs.filters.smoothMedium' },
  { type: 'smooth', strength: 'strong', labelKey: 'pacs.filters.smoothStrong' },
];

// ============================================================================
// Helpers
// ============================================================================

/** Check if a filter option matches the currently active filter */
function isActive(option: FilterOption, activeFilter: ActiveFilter | null): boolean {
  if (!activeFilter) {
    return false;
  }
  return activeFilter.type === option.type && activeFilter.strength === option.strength;
}

// ============================================================================
// Component
// ============================================================================

export function ImageFilterControls({
  activeFilter,
  onApplyFilter,
  onClearFilter,
  disabled = false,
}: ImageFilterControlsProps): JSX.Element {
  const { t } = useTranslation();
  const hasActiveFilter = activeFilter !== null;

  return (
    <Menu shadow="md" width={220} position="bottom" withArrow styles={{ item: { minHeight: 44 } }}>
      <Menu.Target>
        <Tooltip label={t('pacs.filters.title')} position="bottom" withArrow>
          <button
            className={`pacs-toolbar-btn${hasActiveFilter ? ' active' : ''}`}
            disabled={disabled}
            aria-label={t('pacs.filters.title')}
          >
            <IconAdjustmentsAlt size={20} />
          </button>
        </Tooltip>
      </Menu.Target>

      <Menu.Dropdown>
        {/* Sharpen section */}
        <Menu.Label>{t('pacs.filters.sharpenSection')}</Menu.Label>
        {SHARPEN_OPTIONS.map((option) => (
          <Menu.Item
            key={`${option.type}-${option.strength}`}
            onClick={() => onApplyFilter(option.type, option.strength)}
            rightSection={
              isActive(option, activeFilter) ? (
                <IconCheck size={14} style={{ color: 'var(--emr-success)' }} />
              ) : null
            }
          >
            {t(option.labelKey)}
          </Menu.Item>
        ))}

        {/* Smooth section */}
        <Menu.Label>{t('pacs.filters.smoothSection')}</Menu.Label>
        {SMOOTH_OPTIONS.map((option) => (
          <Menu.Item
            key={`${option.type}-${option.strength}`}
            onClick={() => onApplyFilter(option.type, option.strength)}
            rightSection={
              isActive(option, activeFilter) ? (
                <IconCheck size={14} style={{ color: 'var(--emr-success)' }} />
              ) : null
            }
          >
            {t(option.labelKey)}
          </Menu.Item>
        ))}

        {/* Separator + Clear */}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconX size={16} />}
          onClick={onClearFilter}
          disabled={!hasActiveFilter}
          color={hasActiveFilter ? 'red' : undefined}
        >
          {t('pacs.filters.clear')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
