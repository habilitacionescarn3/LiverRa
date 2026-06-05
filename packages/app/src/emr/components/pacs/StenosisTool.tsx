// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// StenosisTool Results Panel
// ============================================================================
// Displays stenosis measurement results calculated from calibrated length
// measurements on angiography (XA) images.
//
// Stenosis formula: %DS = ((RVD - MLD) / RVD) × 100
//   - RVD = Reference Vessel Diameter (normal segment, in mm)
//   - MLD = Minimum Lumen Diameter (narrowest point, in mm)
//   - %DS = Percent Diameter Stenosis
//
// Severity classification follows ACC/AHA guidelines:
//   0–24% → Minimal (green)
//   25–49% → Mild (yellow)
//   50–69% → Moderate (orange)
//   70–89% → Severe (red)
//   90–99% → Critical (dark red)
//   100%   → Total Occlusion (black)
// ============================================================================

import { Text, Group, Badge, Loader } from '@mantine/core';
import { IconHeartbeat, IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { STENOSIS_SEVERITY_COLORS } from '../../constants/theme-colors';
import type { QCAResult } from '../../services/pacs/qcaMeasurements';
import './StenosisTool.css';

// ============================================================================
// Types
// ============================================================================

export interface StenosisToolProps {
  /** Reference Vessel Diameter in mm (normal segment) */
  referenceVesselDiameter: number | null;
  /** Minimum Lumen Diameter in mm (narrowest point) */
  minimumLumenDiameter: number | null;
  /** Whether the image has been calibrated (mm vs pixels) */
  isCalibrated: boolean;
  /** Optional QCA result — when provided, shows semi-auto mode with extra metrics */
  qcaResult?: QCAResult | null;
  /** Current QCA mode for status display */
  qcaMode?: 'idle' | 'picking_start' | 'picking_end' | 'processing' | 'results';
  /** Error message from QCA analysis */
  qcaError?: string | null;
}

/** Severity tier with display info */
interface SeverityInfo {
  labelKey: string;
  color: string;
  bgColor: string;
}

// ============================================================================
// Stenosis Calculation
// ============================================================================

/**
 * Calculate percent diameter stenosis.
 * Returns null if inputs are invalid.
 */
export function calculateStenosis(rvd: number | null, mld: number | null): number | null {
  if (rvd === null || mld === null || rvd <= 0 || mld < 0 || mld > rvd) {
    return null;
  }
  const pct = ((rvd - mld) / rvd) * 100;
  return pct;
}

/**
 * Classify stenosis severity into 6 tiers based on ACC/AHA guidelines.
 */
export function classifySeverity(percentDS: number): SeverityInfo {
  if (percentDS >= 100) {
    return { labelKey: 'pacs.stenosis.severityOcclusion', ...STENOSIS_SEVERITY_COLORS.occlusion };
  }
  if (percentDS >= 90) {
    return { labelKey: 'pacs.stenosis.severityCritical', ...STENOSIS_SEVERITY_COLORS.critical };
  }
  if (percentDS >= 70) {
    return { labelKey: 'pacs.stenosis.severitySevere', ...STENOSIS_SEVERITY_COLORS.severe };
  }
  if (percentDS >= 50) {
    return { labelKey: 'pacs.stenosis.severityModerate', ...STENOSIS_SEVERITY_COLORS.moderate };
  }
  if (percentDS >= 25) {
    return { labelKey: 'pacs.stenosis.severityMild', ...STENOSIS_SEVERITY_COLORS.mild };
  }
  return { labelKey: 'pacs.stenosis.severityMinimal', ...STENOSIS_SEVERITY_COLORS.minimal };
}

// ============================================================================
// Component
// ============================================================================

export function StenosisTool({
  referenceVesselDiameter,
  minimumLumenDiameter,
  isCalibrated,
  qcaResult,
  qcaMode,
  qcaError,
}: StenosisToolProps): JSX.Element {
  const { t } = useTranslation();

  // When QCA result is available, use its values; otherwise use manual props
  const rvd = qcaResult ? qcaResult.rvd : referenceVesselDiameter;
  const mld = qcaResult ? qcaResult.mld : minimumLumenDiameter;
  const percentDS = qcaResult ? qcaResult.percentDS : calculateStenosis(referenceVesselDiameter, minimumLumenDiameter);
  const severity = percentDS !== null ? classifySeverity(percentDS) : null;
  const unit = isCalibrated ? 'mm' : 'px';

  return (
    <div className="stenosis-panel" data-testid="stenosis-panel">
      {/* Header */}
      <Group className="stenosis-panel-header" gap="xs">
        <IconHeartbeat size={16} style={{ color: 'var(--emr-accent)', flexShrink: 0 }} />
        <Text fw="var(--emr-font-semibold)" size="sm">
          {t('pacs.stenosis.button')}
        </Text>
        {qcaResult && (
          <Badge
            size="xs"
            variant="light"
            color="blue"
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            data-testid="stenosis-qca-badge"
          >
            {t('pacs.qca.semiAutoLabel')}
          </Badge>
        )}
      </Group>

      {/* QCA mode status messages */}
      {qcaMode === 'picking_start' && (
        <Text size="xs" c="dimmed" style={{ padding: '4px 0' }} data-testid="qca-instruction">
          {t('pacs.qca.pickProximal')}
        </Text>
      )}
      {qcaMode === 'picking_end' && (
        <Text size="xs" c="dimmed" style={{ padding: '4px 0' }} data-testid="qca-instruction">
          {t('pacs.qca.pickDistal')}
        </Text>
      )}
      {qcaMode === 'processing' && (
        <Group gap="xs" style={{ padding: '4px 0' }}>
          <Loader size={12} />
          <Text size="xs" c="dimmed">
            {t('pacs.qca.analyzing')}
          </Text>
        </Group>
      )}
      {qcaError && (
        <div className="stenosis-warning" data-testid="qca-error">
          <IconAlertTriangle size={14} style={{ color: 'var(--emr-error)', flexShrink: 0 }} />
          <Text size="xs" c="red">
            {qcaError}
          </Text>
        </div>
      )}

      {/* Uncalibrated warning */}
      {!isCalibrated && (
        <div className="stenosis-warning" data-testid="stenosis-uncalibrated-warning">
          <IconAlertTriangle size={14} style={{ color: 'var(--emr-warning)', flexShrink: 0 }} />
          <Text size="xs" c="dimmed">
            {t('pacs.calibration.warningUncalibrated')}
          </Text>
        </div>
      )}

      {/* Measurement rows */}
      <div className="stenosis-rows">
        {/* Reference Vessel Diameter */}
        <div className="stenosis-row">
          <Text size="xs" c="dimmed" className="stenosis-row-label">
            {t('pacs.stenosis.referenceDiameter')}
          </Text>
          <Text size="xs" fw="var(--emr-font-semibold)" className="stenosis-row-value">
            {rvd !== null
              ? `${rvd.toFixed(1)} ${unit}`
              : '—'}
          </Text>
        </div>

        {/* Minimum Lumen Diameter */}
        <div className="stenosis-row">
          <Text size="xs" c="dimmed" className="stenosis-row-label">
            {t('pacs.stenosis.mld')}
          </Text>
          <Text size="xs" fw="var(--emr-font-semibold)" className="stenosis-row-value">
            {mld !== null
              ? `${mld.toFixed(1)} ${unit}`
              : '—'}
          </Text>
        </div>

        {/* Percent Diameter Stenosis with severity badge */}
        <div className="stenosis-row stenosis-result-row">
          <Text size="xs" c="dimmed" className="stenosis-row-label">
            {t('pacs.stenosis.percentDS')}
          </Text>
          <Group gap="xs" style={{ flexShrink: 0 }}>
            <Text size="sm" fw="var(--emr-font-bold)" className="stenosis-row-value">
              {percentDS !== null ? `${percentDS.toFixed(1)}%` : '—'}
            </Text>
            {severity && (
              <Badge
                size="sm"
                variant="filled"
                styles={{
                  root: {
                    backgroundColor: severity.bgColor,
                    color: severity.color,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  },
                }}
                data-testid="stenosis-severity-badge"
              >
                {t(severity.labelKey)}
              </Badge>
            )}
          </Group>
        </div>

        {/* QCA-only rows: Lesion Length and Area Stenosis */}
        {qcaResult && (
          <>
            <div className="stenosis-row">
              <Text size="xs" c="dimmed" className="stenosis-row-label">
                {t('pacs.qca.lesionLength')}
              </Text>
              <Text size="xs" fw="var(--emr-font-semibold)" className="stenosis-row-value">
                {`${qcaResult.lesionLength.toFixed(1)} mm`}
              </Text>
            </div>
            <div className="stenosis-row">
              <Text size="xs" c="dimmed" className="stenosis-row-label">
                {t('pacs.qca.areaStenosis')}
              </Text>
              <Text size="xs" fw="var(--emr-font-semibold)" className="stenosis-row-value">
                {`${qcaResult.percentAS.toFixed(1)}%`}
              </Text>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
