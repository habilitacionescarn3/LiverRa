// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRSectionGallbladder — thin wrapper over ACRGenericSection (H-ACR-4).
 */

import { ACRGenericSection } from './ACRGenericSection';
import type { ReadoutSection } from '../../services/report/acrAnatomicalMapping';

export interface ACRSectionGallbladderProps {
  section: ReadoutSection;
}

export function ACRSectionGallbladder({
  section,
}: ACRSectionGallbladderProps): JSX.Element {
  return <ACRGenericSection section={section} testId="acr-section-gallbladder" />;
}

export default ACRSectionGallbladder;
