// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// CalibrationOverlay Component
// ============================================================================
// Floating overlay shown during the calibration workflow. After the user draws
// a line across a catheter in the viewport, this overlay lets them select the
// French catheter size to complete the calibration calculation.
//
// Workflow:
//   1. User clicks "Calibrate" in toolbar → isCalibrating = true
//   2. User draws a line across the catheter (Length tool)
//   3. This overlay appears with French size buttons
//   4. User selects the French size → onComplete(frenchSize, pixelLength)
//   5. Calibration factor is calculated and stored
//
// When calibration is active (mmPerPixel available), shows the status with
// a "Clear" button to reset.
// ============================================================================

import { Text, Group, Button, Badge } from '@mantine/core';
import { IconRuler2, IconX } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type { CalibrationResult } from '../../services/pacs/calibrationService';
import { FRENCH_SIZES } from '../../services/pacs/calibrationService';
import './CalibrationOverlay.css';

// ============================================================================
// Types
// ============================================================================

export interface CalibrationOverlayProps {
  /** Whether the user is currently in calibration mode (drawing a line) */
  isCalibrating: boolean;
  /** Active calibration result (null if not calibrated) */
  calibration: CalibrationResult | null;
  /** Called when user selects a French size to complete calibration */
  onComplete: (frenchSize: number, pixelLength: number) => void;
  /** Called when user cancels calibration mode */
  onCancel: () => void;
  /** Called when user clears the existing calibration */
  onClear: () => void;
  /** The pixel length of the drawn line (available after user finishes drawing) */
  pixelLength?: number | null;
}

// ============================================================================
// Component
// ============================================================================

export function CalibrationOverlay({
  isCalibrating,
  calibration,
  onComplete,
  onCancel,
  onClear,
  pixelLength,
}: CalibrationOverlayProps): JSX.Element | null {
  const { t } = useTranslation();

  // If not calibrating and no calibration exists, don't render
  if (!isCalibrating && !calibration) {
    return null;
  }

  // Show calibrated status
  if (calibration && !isCalibrating) {
    return (
      <div className="calibration-overlay calibration-overlay-status" data-testid="calibration-status">
        <Group gap="xs" align="center">
          <IconRuler2 size={14} style={{ color: 'var(--emr-success)', flexShrink: 0 }} />
          <Badge size="sm" variant="filled" color="green" style={{ flexShrink: 0 }}>
            {calibration.frenchSize}F
          </Badge>
          <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
            {calibration.mmPerPixel.toFixed(4)} mm/px
          </Text>
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={onClear}
            styles={{ label: { overflow: 'visible', height: 'auto' } }}
            leftSection={<IconX size={12} />}
            style={{ flexShrink: 0 }}
          >
            {t('pacs.calibration.clear')}
          </Button>
        </Group>
      </div>
    );
  }

  // Show calibrating instruction + French size selection
  return (
    <div className="calibration-overlay calibration-overlay-active" data-testid="calibration-overlay">
      <Text size="xs" fw="var(--emr-font-semibold)" style={{ color: 'var(--emr-warning)' }}>
        {t('pacs.calibration.instruction')}
      </Text>

      {/* French size buttons — only enabled when a line has been drawn */}
      <Group gap="xs" style={{ marginTop: 6 }}>
        {Object.keys(FRENCH_SIZES).map((size) => (
          <Button
            key={size}
            size="compact-sm"
            variant="light"
            color="blue"
            disabled={!pixelLength || pixelLength <= 0}
            onClick={() => onComplete(Number(size), pixelLength ?? 0)}
            styles={{ label: { overflow: 'visible', height: 'auto' } }}
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {t(`pacs.calibration.size${size}F`)}
          </Button>
        ))}
      </Group>

      <Button
        size="compact-sm"
        variant="subtle"
        color="gray"
        onClick={onCancel}
        styles={{ label: { overflow: 'visible', height: 'auto' } }}
        style={{ marginTop: 4, flexShrink: 0 }}
      >
        {t('pacs.calibration.cancel')}
      </Button>
    </div>
  );
}
