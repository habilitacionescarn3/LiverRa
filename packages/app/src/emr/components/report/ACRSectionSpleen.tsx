// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionSpleen — thin wrapper over ACRGenericSection (H-ACR-4).
 */

import { ACRGenericSection } from './ACRGenericSection';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';

export interface ACRSectionSpleenProps {
  section: ReadoutSection;
}

export function ACRSectionSpleen({ section }: ACRSectionSpleenProps): JSX.Element {
  return <ACRGenericSection section={section} testId="acr-section-spleen" />;
}

export default ACRSectionSpleen;
