// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * DemoCaseRunnerView (T305, T440).
 *
 * Plain-English: the re-runnable demo entry point exposed under the
 * Help menu per SC-013. Clicking "Run demo" invokes the idempotent
 * sample-case seed endpoint and redirects to the resulting analysis.
 * Subsequent clicks just re-open the existing demo case.
 *
 * Polished landing: hero card, inviting CTA, three feature highlights,
 * "what's in the demo" list. Falls back to the pre-seeded analysis ID
 * (`83dad428-…`) when the onboarding endpoint is unavailable so the
 * demo is reachable in offline / dev mode.
 */
import { Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  IconArrowRight,
  IconBrain,
  IconChartPie,
  IconFlask,
  IconShieldCheck,
} from '@tabler/icons-react';
import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import SampleDataBadge from '../../components/onboarding/SampleDataBadge';
import { useTranslation } from '../../contexts/TranslationContext';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

/**
 * Resolve a real analysis id to navigate to. Strategy:
 *   1. Ask `/auth/me/onboarding-status` for `sample_case_analysis_id`.
 *   2. If absent, list `/analyses` and pick the first `completed` one
 *      (instant gratification — no 25s wait).
 *   3. If none completed, pick the first available analysis at all.
 *   4. Last resort: trigger a fresh cascade via `/analyses/from-orthanc`
 *      using the first available DICOM study.
 *
 * This replaces the previous hardcoded `SEEDED_DEMO_ANALYSIS_ID` constant
 * which broke whenever the dev DB was reseeded.
 */
async function resolveDemoAnalysisId(baseUrl: string): Promise<string> {
  // 1. Onboarding-status probe (cheap; preferred).
  try {
    const r = await fetch(`${baseUrl}/auth/me/onboarding-status`, { credentials: 'include' });
    if (r.ok) {
      const data = (await r.json()) as { sample_case_analysis_id?: string };
      if (data.sample_case_analysis_id) return data.sample_case_analysis_id;
    }
  } catch {
    /* fall through */
  }

  // 2 & 3. List existing analyses; prefer completed.
  const list = await fetch(`${baseUrl}/analyses?limit=20`, { credentials: 'include' });
  if (list.ok) {
    const body = (await list.json()) as {
      items?: Array<{ id: string; status: string }>;
    };
    const items = body.items ?? [];
    const completed = items.find((it) => it.status === 'completed');
    if (completed) return completed.id;
    if (items[0]) return items[0].id;
  }

  // 4. Trigger a fresh run from the first ingested DICOM study.
  const studies = await fetch(`${baseUrl}/ingest/studies?limit=1`, { credentials: 'include' });
  if (!studies.ok) throw new Error('Demo unavailable: no studies ingested.');
  const sBody = (await studies.json()) as {
    items?: Array<{ study_instance_uid: string; patient_ref?: string | null }>;
  };
  const first = sBody.items?.[0];
  if (!first) throw new Error('Demo unavailable: no DICOM studies in PACS.');
  const trigger = await fetch(`${baseUrl}/analyses/from-orthanc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      study_instance_uid: first.study_instance_uid,
      patient_ref: first.patient_ref ?? null,
    }),
  });
  if (!trigger.ok) throw new Error(`Demo trigger failed: HTTP ${trigger.status}`);
  const tBody = (await trigger.json()) as { analysis_id: string };
  return tBody.analysis_id;
}

interface FeatureHighlight {
  icon: typeof IconFlask;
  titleKey: string;
  bodyKey: string;
  fallbackTitle: string;
  fallbackBody: string;
}

const FEATURES: readonly FeatureHighlight[] = [
  {
    icon: IconBrain,
    titleKey: 'onboarding:demo.feature.segmentation.title',
    bodyKey: 'onboarding:demo.feature.segmentation.body',
    fallbackTitle: 'AI segmentation',
    fallbackBody: 'Liver parenchyma, 8 Couinaud segments, vessels, and lesions.',
  },
  {
    icon: IconChartPie,
    titleKey: 'onboarding:demo.feature.flr.title',
    bodyKey: 'onboarding:demo.feature.flr.body',
    fallbackTitle: 'FLR & volumetry',
    fallbackBody: 'Future Liver Remnant calculation with surgical-grade volumes.',
  },
  {
    icon: IconShieldCheck,
    titleKey: 'onboarding:demo.feature.ruo.title',
    bodyKey: 'onboarding:demo.feature.ruo.body',
    fallbackTitle: 'Research Use Only',
    fallbackBody: 'Synthetic data, watermarked outputs, PACS push disabled.',
  },
] as const;

function tr(
  t: (key: string, params?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
): string {
  const v = t(key);
  return v === key || !v ? fallback : v;
}

function DemoInner(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const id = await resolveDemoAnalysisId(readApiBaseUrl());
      navigate(`/cases/${encodeURIComponent(id)}`);
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
        title={tr(t, 'onboarding:demo.title', 'Demo case')}
        subtitle={tr(
          t,
          'onboarding:demo.subtitle',
          'Explore the full pipeline on synthetic data. Re-open any time from the Help menu.',
        )}
      />

      <SampleDataBadge />

      {/* Hero card with primary CTA */}
      <Box
        style={{
          padding: 'clamp(20px, 4vw, 32px)',
          borderRadius: 'var(--emr-border-radius-lg, 12px)',
          background:
            'linear-gradient(135deg, var(--emr-bg-card) 0%, var(--emr-bg-hover) 100%)',
          border: '1px solid var(--emr-border-color)',
          boxShadow: 'var(--emr-shadow-card)',
          position: 'relative',
          overflow: 'hidden',
        }}
        data-testid="demo-hero-card"
      >
        {/* Decorative accent */}
        <Box
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -40,
            right: -40,
            width: 160,
            height: 160,
            borderRadius: '50%',
            background:
              'radial-gradient(circle, var(--emr-secondary-alpha-12, rgba(43,108,176,0.12)) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />
        <Stack gap="md" style={{ position: 'relative' }}>
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Box
              aria-hidden="true"
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--emr-border-radius-md, 8px)',
                background: 'var(--emr-gradient-primary)',
                color: 'var(--emr-text-inverse)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                boxShadow:
                  '0 4px 12px var(--emr-secondary-alpha-30, rgba(43,108,176,0.30))',
              }}
            >
              <IconFlask size={26} stroke={1.8} />
            </Box>
            <Stack gap={4} style={{ minWidth: 0, flexGrow: 1 }}>
              <Text
                style={{
                  fontSize: 'var(--emr-font-lg)',
                  fontWeight: 'var(--emr-font-semibold)',
                  color: 'var(--emr-text-primary)',
                  lineHeight: 'var(--emr-line-height-1-2)',
                }}
              >
                {tr(t, 'onboarding:demo.heroTitle', 'See LiverRa end to end in 30 seconds')}
              </Text>
              <Text
                style={{
                  fontSize: 'var(--emr-font-sm)',
                  color: 'var(--emr-text-secondary)',
                  lineHeight: 'var(--emr-line-height-1-5)',
                }}
              >
                {tr(
                  t,
                  'onboarding:demo.body',
                  'The demo case has no real patient data. PACS push is disabled; outputs are watermarked "Sample data".',
                )}
              </Text>
            </Stack>
          </Group>

          {error && <EMRAlert variant="error">{error}</EMRAlert>}

          <Group justify="flex-end" wrap="wrap" gap="sm">
            <EMRButton
              variant="primary"
              icon={IconArrowRight}
              onClick={run}
              disabled={busy}
              loading={busy}
              data-testid="demo-run-btn"
            >
              {tr(t, 'onboarding:demo.open', 'Open demo case')}
            </EMRButton>
          </Group>
        </Stack>
      </Box>

      {/* Feature highlights */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <Box
              key={f.titleKey}
              style={{
                padding: 16,
                borderRadius: 'var(--emr-border-radius-md, 8px)',
                background: 'var(--emr-bg-card)',
                border: '1px solid var(--emr-border-color)',
                height: '100%',
              }}
            >
              <Stack gap="xs">
                <Box
                  aria-hidden="true"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 'var(--emr-border-radius-sm, 6px)',
                    background: 'var(--emr-bg-hover)',
                    color: 'var(--emr-secondary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon size={20} stroke={1.8} />
                </Box>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-md)',
                    fontWeight: 'var(--emr-font-semibold)',
                    color: 'var(--emr-text-primary)',
                  }}
                >
                  {tr(t, f.titleKey, f.fallbackTitle)}
                </Text>
                <Text
                  style={{
                    fontSize: 'var(--emr-font-sm)',
                    color: 'var(--emr-text-secondary)',
                    lineHeight: 'var(--emr-line-height-1-5)',
                  }}
                >
                  {tr(t, f.bodyKey, f.fallbackBody)}
                </Text>
              </Stack>
            </Box>
          );
        })}
      </SimpleGrid>
    </Stack>
  );
}

export default function DemoCaseRunnerView(): React.ReactElement {
  return (
    <EMRErrorBoundary componentName="DemoCaseRunnerView">
      <Suspense fallback={<EMRTableSkeleton rows={4} columns={1} />}>
        <DemoInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
