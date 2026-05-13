// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ACRHeroCopyButton — compact "Copy readout" CTA for the analysis-detail
 * hero action bar (FR-009: Copy MUST be visible without scrolling on a
 * 13" laptop screen).
 *
 * The full readout panel below the workspace remains the canonical
 * surface for reviewing each section. This thin proxy ensures the
 * action itself stays one click away regardless of viewport height.
 *
 * Both this component and `ACRStructuredReadout` route through
 * `useAcrCopyAction` so the audit + telemetry shape is identical.
 */
import { IconClipboard } from '@tabler/icons-react';

import { useAcrCopyAction } from '../../hooks/useAcrCopyAction';
import { EMRButton } from '../common';

export interface ACRHeroCopyButtonProps {
  analysisId: string;
}

export function ACRHeroCopyButton({
  analysisId,
}: ACRHeroCopyButtonProps): JSX.Element | null {
  const { ready, copying, copy, buttonLabel, ariaLabel } =
    useAcrCopyAction(analysisId);

  // Hide until the snapshot is built — avoids surfacing a button that
  // would no-op on click. The full panel below shows skeleton meanwhile.
  if (!ready) return null;

  return (
    <EMRButton
      variant="secondary"
      size="sm"
      icon={IconClipboard}
      loading={copying}
      onClick={() => void copy()}
      data-testid="acr-hero-copy-button"
      aria-label={ariaLabel}
    >
      {buttonLabel}
    </EMRButton>
  );
}

export default ACRHeroCopyButton;
