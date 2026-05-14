// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionLiver — thin wrapper over ACRGenericSection (H-ACR-4).
 *
 * Keeps the `steatosis-grade` testid that the e2e spec relies on.
 */

import { ACRGenericSection, DefaultRowItem } from './ACRGenericSection';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';

export interface ACRSectionLiverProps {
  section: ReadoutSection;
}

export function ACRSectionLiver({ section }: ACRSectionLiverProps): JSX.Element {
  return (
    <ACRGenericSection
      section={section}
      testId="acr-section-liver"
      renderRow={(row) =>
        row.key === 'steatosis' ? (
          <DefaultRowItem row={row} testId="steatosis-grade" />
        ) : null
      }
    />
  );
}

export default ACRSectionLiver;
