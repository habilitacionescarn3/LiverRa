// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionLesions — thin wrapper over ACRGenericSection (H-ACR-4).
 *
 * The FIRST per-lesion row (rows with `itemId`) gets
 * `data-testid="primary-lesion-size"` so the end-to-end spec can assert
 * the primary lesion is surfaced at the top of the section.
 */

import { useMemo } from 'react';

import { ACRGenericSection, DefaultRowItem } from './ACRGenericSection';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';

export interface ACRSectionLesionsProps {
  section: ReadoutSection;
}

export function ACRSectionLesions({ section }: ACRSectionLesionsProps): JSX.Element {
  const firstLesionIdx = useMemo(
    () => section.rows.findIndex((r) => !!r.itemId),
    [section.rows],
  );

  return (
    <ACRGenericSection
      section={section}
      testId="acr-section-lesions"
      skeletonRows={3}
      renderRow={(row, idx) =>
        idx === firstLesionIdx ? (
          <DefaultRowItem row={row} testId="primary-lesion-size" />
        ) : null
      }
    />
  );
}

export default ACRSectionLesions;
