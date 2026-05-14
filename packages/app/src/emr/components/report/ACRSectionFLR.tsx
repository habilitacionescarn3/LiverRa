// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionFLR — thin wrapper over ACRGenericSection (H-ACR-4).
 *
 * Keeps the `flr-percent` testid the e2e spec relies on.
 */

import { ACRGenericSection, DefaultRowItem } from './ACRGenericSection';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';

export interface ACRSectionFLRProps {
  section: ReadoutSection;
}

export function ACRSectionFLR({ section }: ACRSectionFLRProps): JSX.Element {
  return (
    <ACRGenericSection
      section={section}
      testId="acr-section-flr"
      renderRow={(row) =>
        row.key === 'flr-value' ? (
          <DefaultRowItem row={row} testId="flr-percent" />
        ) : null
      }
    />
  );
}

export default ACRSectionFLR;
