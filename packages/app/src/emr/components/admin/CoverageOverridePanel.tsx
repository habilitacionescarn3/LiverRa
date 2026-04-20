// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * CoverageOverridePanel (T437).
 *
 * Plain-English: FR-006a's admin console tab. When a study was rejected
 * for `coverage_insufficient`, the tenant-admin can override it here:
 *   1. flip the tenant-wide toggle ``allow_partial_coverage_override``
 *   2. for a specific analysis, post a typed justification — gated by
 *      step-up MFA on the server side.
 * A persistent warning banner is rendered on the resulting analysis
 * (consumed by AnalysisDetailView).
 */
import { useState } from 'react';
import { Box, Group, Stack, Switch, Text } from '@mantine/core';
import { IconAlertTriangle, IconShieldCheck } from '@tabler/icons-react';
import { EMRButton } from '../common/EMRButton';
import { EMRAlert } from '../common/EMRAlert';
import { EMRTextarea } from '../shared/EMRFormFields';
import { useTranslation } from '../../contexts/TranslationContext';

export interface CoverageOverridePanelProps {
  /** Current tenant-wide override flag. */
  allowPartialCoverageOverride: boolean;
  /** Optional analysis-id for per-case override. */
  analysisId?: string;
  /** Toggle tenant flag. */
  onToggleTenantFlag: (next: boolean) => Promise<void>;
  /** Per-analysis override. Typically triggers a step-up MFA prompt. */
  onOverrideAnalysis?: (analysisId: string, reason: string) => Promise<void>;
  /** Whether the signed-in user has ``admin.coverage_override``. */
  hasPermission: boolean;
}

export function CoverageOverridePanel({
  allowPartialCoverageOverride,
  analysisId,
  onToggleTenantFlag,
  onOverrideAnalysis,
  hasPermission,
}: CoverageOverridePanelProps): React.ReactElement {
  const { t } = useTranslation();
  const [flag, setFlag] = useState(allowPartialCoverageOverride);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (!hasPermission) {
    return (
      <EMRAlert variant="info" title={t('admin:coverageOverride.noPermission') || 'Insufficient permission'}>
        {t('admin:coverageOverride.noPermissionBody') ||
          'You do not have the admin.coverage_override permission.'}
      </EMRAlert>
    );
  }

  const toggleFlag = async (next: boolean): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await onToggleTenantFlag(next);
      setFlag(next);
      setOk(t('admin:coverageOverride.flagSaved') || 'Tenant flag updated.');
    } catch (e) {
      setError(e as Error);
    } finally {
      setSubmitting(false);
    }
  };

  const override = async (): Promise<void> => {
    if (!onOverrideAnalysis || !analysisId || reason.trim().length < 10) return;
    setSubmitting(true);
    setError(null);
    try {
      await onOverrideAnalysis(analysisId, reason.trim());
      setOk(t('admin:coverageOverride.analysisSaved') || 'Analysis override applied.');
      setReason('');
    } catch (e) {
      setError(e as Error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      style={{
        padding: 16,
        borderRadius: 'var(--emr-border-radius-lg)',
        background: 'var(--emr-bg-card)',
        border: '1px solid var(--emr-gray-200)',
      }}
    >
      <Stack gap="md">
        <Group gap="sm" wrap="wrap">
          <IconShieldCheck size={20} color="var(--emr-primary)" />
          <Text fw={600} fz="var(--emr-font-md)">
            {t('admin:coverageOverride.title') || 'Coverage override (FR-006a)'}
          </Text>
        </Group>

        <EMRAlert variant="warning" icon={IconAlertTriangle}>
          {t('admin:coverageOverride.warning') ||
            'Overrides weaken phase-coverage safety checks. Every override is audited and stamped on downstream FHIR events.'}
        </EMRAlert>

        <Group justify="space-between" wrap="wrap" gap="sm">
          <Text fz="var(--emr-font-sm)">
            {t('admin:coverageOverride.tenantFlag') || 'Allow partial-coverage override (tenant-wide)'}
          </Text>
          <Switch
            checked={flag}
            onChange={(e) => toggleFlag(e.currentTarget.checked)}
            disabled={submitting}
          />
        </Group>

        {analysisId && onOverrideAnalysis && (
          <Stack gap="sm">
            <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
              {t('admin:coverageOverride.perCase') || 'Per-analysis override'}
            </Text>
            <EMRTextarea
              label={t('admin:coverageOverride.reason') || 'Reason (min 10 chars)'}
              value={reason}
              onChange={(v) => setReason(String(v))}
              minRows={3}
              required
            />
            <Group justify="flex-end">
              <EMRButton
                variant="primary"
                onClick={override}
                disabled={submitting || reason.trim().length < 10}
                loading={submitting}
              >
                {t('admin:coverageOverride.submit') || 'Override with step-up MFA'}
              </EMRButton>
            </Group>
          </Stack>
        )}

        {error && <EMRAlert variant="error">{error.message}</EMRAlert>}
        {ok && <EMRAlert variant="success">{ok}</EMRAlert>}
      </Stack>
    </Box>
  );
}

export default CoverageOverridePanel;
