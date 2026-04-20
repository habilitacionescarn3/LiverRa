// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * DemoCaseRunnerView (T305, T440).
 *
 * Plain-English: the re-runnable demo entry point exposed under the
 * Help menu per SC-013. Clicking "Run demo" invokes the idempotent
 * sample-case seed endpoint and redirects to the resulting analysis.
 * Subsequent clicks just re-open the existing demo case.
 */
import { Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Group, Stack, Text } from '@mantine/core';
import { IconFlask, IconArrowRight } from '@tabler/icons-react';
import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import SampleDataBadge from '../../components/onboarding/SampleDataBadge';
import { useTranslation } from '../../contexts/TranslationContext';

function DemoInner(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/v1/auth/me/onboarding-status', {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const data = (await r.json()) as { sample_case_analysis_id?: string };
      if (data.sample_case_analysis_id) {
        navigate(`/cases/${data.sample_case_analysis_id}`);
      } else {
        navigate('/cases');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconFlask}
        title={t('onboarding:demo.title') || 'Demo case'}
        subtitle={
          t('onboarding:demo.subtitle') ||
          'Explore the full pipeline on synthetic data. Re-open any time from the Help menu.'
        }
      />
      <SampleDataBadge />
      <Box
        style={{
          padding: 20,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-gray-200)',
        }}
      >
        <Stack gap="md">
          <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)">
            {t('onboarding:demo.body') ||
              'The demo case has no real patient data. PACS push is disabled; outputs are watermarked "Sample data".'}
          </Text>
          {error && <EMRAlert variant="error">{error}</EMRAlert>}
          <Group justify="flex-end">
            <EMRButton
              variant="primary"
              icon={IconArrowRight}
              onClick={run}
              disabled={busy}
              loading={busy}
            >
              {t('onboarding:demo.open') || 'Open demo case'}
            </EMRButton>
          </Group>
        </Stack>
      </Box>
    </Stack>
  );
}

export default function DemoCaseRunnerView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<EMRTableSkeleton rows={4} columns={1} />}>
        <DemoInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
