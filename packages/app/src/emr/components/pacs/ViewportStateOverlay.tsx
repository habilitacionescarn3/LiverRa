// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ViewportStateOverlay — Centered lifecycle overlay for a PACS viewport cell
// ============================================================================
// Sits INSIDE a `.pacs-viewport-cell`, filling it, above the black Cornerstone
// canvas. It surfaces the per-viewport state so a 3D (VR) pane is never just
// silently black while its volume builds, or dead-black when a build fails.
//
// States:
//   building → spinner + "Building volume…"
//   error    → warning icon + message + Retry button
//   empty    → EMREmptyState prompting series selection
//   ready / idle → render nothing (let the canvas show through)
//
// Interaction model:
//   - The container is `pointer-events: none` so mouse/scroll/click pass
//     straight through to the Cornerstone canvas beneath (zoom, pan, scroll).
//   - ONLY the Retry button re-enables `pointer-events: auto` for itself.
//
// Colors: the cell background is always #000 regardless of light/dark mode, so
// a neutral translucent scrim (rgba black) is used — not a theme surface var.
// Text/icons use theme semantic vars that read on dark.
// ============================================================================

import { Loader } from '@mantine/core';
import { IconAlertTriangle, IconCube } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton, EMREmptyState } from '../common';
import './ViewportStateOverlay.css';

// ============================================================================
// Props
// ============================================================================

export type ViewportOverlayStatus = 'idle' | 'building' | 'ready' | 'error' | 'empty';

export interface ViewportStateOverlayProps {
  /** Current lifecycle state of the viewport (drives which state is shown). */
  status: ViewportOverlayStatus;
  /** Retry handler — wired to the error-state button. */
  onRetry?: () => void;
  /** 'vr' = 3D-volume wording (default); 'image' = generic 2D/MPR/stack wording. */
  variant?: 'vr' | 'image';
}

// ============================================================================
// Component
// ============================================================================

export function ViewportStateOverlay({ status, onRetry, variant = 'vr' }: ViewportStateOverlayProps): JSX.Element | null {
  const { t } = useTranslation();

  // Nothing to overlay when the pane is live or simply unmounted-idle.
  if (status === 'ready' || status === 'idle') {
    return null;
  }

  // VR panes use 3D-volume wording; generic (MPR/stack/axial) panes use neutral copy.
  const isVr = variant === 'vr';
  const buildingText = isVr ? t('pacs.vr.building') : t('pacs.viewport.loading');
  const failedText = isVr
    ? t('pacs.vr.buildFailed')
    : t('pacs.viewport.loadFailed');
  const emptyText = isVr ? t('pacs.vr.selectSeries') : t('pacs.viewport.selectSeries');

  return (
    <div className="viewport-state-overlay" data-testid="viewport-state-overlay" data-status={status}>
      <div className="viewport-state-overlay-inner">
        {status === 'building' && (
          <>
            <Loader size="lg" color="var(--emr-accent)" />
            <div className="viewport-state-overlay-label">{buildingText}</div>
          </>
        )}

        {status === 'error' && (
          <>
            <IconAlertTriangle size={40} className="viewport-state-overlay-error-icon" aria-hidden="true" />
            <div className="viewport-state-overlay-message">{failedText}</div>
            {onRetry && (
              <div className="viewport-state-overlay-action">
                <EMRButton variant="light" size="sm" onClick={onRetry} data-testid="viewport-state-retry">
                  {t('pacs.vr.retry')}
                </EMRButton>
              </div>
            )}
          </>
        )}

        {status === 'empty' && (
          <EMREmptyState
            icon={IconCube}
            size="sm"
            title={emptyText}
          />
        )}
      </div>
    </div>
  );
}

export default ViewportStateOverlay;
