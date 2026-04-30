// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// StudyListFilters (LiverRa)
// ============================================================================
// Compact filter strip above a patient's study list. Free-text search +
// modality chips; everything runs client-side because patient study lists
// stay under ~100 rows. Ported from MediMind verbatim — no Medplum deps.
// ============================================================================

import React, { useMemo } from 'react';
import { Button } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRTextInput, EMRMultiSelect } from '../shared/EMRFormFields';
import type { ImagingStudyListItem } from '../../types/pacs';
import styles from './StudyListFilters.module.css';

// ============================================================================
// Types
// ============================================================================

export interface StudyListFiltersProps {
  /** All studies before filtering — used to derive modality options. */
  studies: ImagingStudyListItem[];
  /** Current search text. */
  searchText: string;
  /** Update search text. */
  onSearchChange: (value: string) => void;
  /** Currently selected modalities. */
  selectedModalities: string[];
  /** Update selected modalities. */
  onModalitiesChange: (value: string[]) => void;
}

// ============================================================================
// Component
// ============================================================================

export function StudyListFilters({
  studies,
  searchText,
  onSearchChange,
  selectedModalities,
  onModalitiesChange,
}: StudyListFiltersProps): React.ReactElement {
  const { t } = useTranslation();

  // Auto-populate modality options from whatever is currently in the list.
  const modalityOptions = useMemo(() => {
    const modalities = new Set<string>();
    for (const study of studies) {
      for (const mod of study.modalities) {
        modalities.add(mod);
      }
    }
    return Array.from(modalities)
      .sort()
      .map((mod) => ({
        value: mod,
        label: mod,
      }));
  }, [studies]);

  const hasFilters = searchText.length > 0 || selectedModalities.length > 0;

  const handleClear = (): void => {
    onSearchChange('');
    onModalitiesChange([]);
  };

  return (
    <div className={styles.filterBar}>
      <EMRTextInput
        placeholder={t('pacs.filters.search')}
        leftSection={<IconSearch size={16} />}
        value={searchText}
        onChange={onSearchChange}
        size="xs"
        fullWidth={false}
        style={{ flex: 1, minWidth: 120 }}
      />
      <EMRMultiSelect
        placeholder={t('pacs.filters.modality')}
        data={modalityOptions}
        value={selectedModalities}
        onChange={onModalitiesChange}
        size="xs"
        clearable
        searchable={false}
        fullWidth={false}
        style={{ flex: 1, minWidth: 120 }}
      />
      {hasFilters && (
        <Button
          className={styles.clearButton}
          variant="subtle"
          size="compact-sm"
          leftSection={<IconX size={14} />}
          onClick={handleClear}
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          styles={{ label: { overflow: 'visible', height: 'auto' } }}
        >
          {t('pacs.filters.clear')}
        </Button>
      )}
    </div>
  );
}
