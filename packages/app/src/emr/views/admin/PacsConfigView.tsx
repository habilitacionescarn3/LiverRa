// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * PacsConfigView (T288, T436).
 *
 * Plain-English: the form where the admin enters the hospital's PACS
 * destination (AE title + host + port + optional TLS cert) and clicks
 * "Test with C-ECHO" to confirm reachability before saving. The backend
 * re-runs the C-ECHO on PUT and rejects invalid destinations.
 */
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Box, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  IconActivity,
  IconCheck,
  IconDeviceFloppy,
  IconLock,
  IconPlug,
  IconShieldLock,
  IconX,
} from '@tabler/icons-react';
import {
  EMRAlert,
  EMRButton,
  EMRCard,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import {
  EMRNumberInput,
  EMRSwitch,
  EMRTextInput,
} from '../../components/shared/EMRFormFields';
import { usePacsConfig, type PacsDestination, type CEchoResult } from '../../hooks/usePacsConfig';
import { useTranslation } from '../../contexts/TranslationContext';

function SectionHeader({
  title,
  helper,
  icon: Icon,
}: {
  title: string;
  helper?: string;
  icon: React.ComponentType<{ size?: number }>;
}): React.ReactElement {
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="nowrap">
        <Icon size={16} />
        <Text fz="var(--emr-font-md)" fw={600}>
          {title}
        </Text>
      </Group>
      {helper && (
        <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
          {helper}
        </Text>
      )}
    </Stack>
  );
}

function EchoBanner({
  result,
  defaultMsg,
}: {
  result: CEchoResult | null;
  defaultMsg: string;
}): React.ReactElement {
  const { t } = useTranslation();
  if (!result) {
    return (
      <Box
        role="status"
        style={{
          padding: '10px 14px',
          borderRadius: 'var(--emr-border-radius-md)',
          border: '1px dashed var(--emr-gray-300)',
          background: 'var(--emr-bg-page)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          color: 'var(--emr-text-secondary)',
          fontSize: 'var(--emr-font-sm)',
        }}
      >
        <IconActivity size={14} />
        <span>{defaultMsg}</span>
      </Box>
    );
  }
  const ok = result.reachable;
  const Icon = ok ? IconCheck : IconX;
  return (
    <Box
      role={ok ? 'status' : 'alert'}
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--emr-border-radius-md)',
        border: `1px solid ${ok ? 'var(--emr-success)' : 'var(--emr-error)'}`,
        background: ok
          ? 'rgba(56,161,105,0.08)'
          : 'rgba(229,62,62,0.08)',
        color: ok ? 'var(--emr-success)' : 'var(--emr-error)',
      }}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Icon size={18} aria-hidden="true" />
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text fz="var(--emr-font-sm)" fw={600}>
            {ok
              ? t('admin:pacs.echoOk') || 'C-ECHO succeeded'
              : t('admin:pacs.echoFail') || 'C-ECHO failed'}
          </Text>
          <Text fz="var(--emr-font-xs)">
            {ok
              ? `${t('admin:pacs.roundTrip') || 'Round-trip'}: ${result.round_trip_ms} ms · ${result.scanner_ae_responded ?? '—'}`
              : result.error ?? 'unreachable'}
          </Text>
        </Stack>
      </Group>
    </Box>
  );
}

function PacsConfigInner(): React.ReactElement {
  const { t } = useTranslation();
  const { tenant, loading, error, save, testEcho } = usePacsConfig();
  const [form, setForm] = useState<PacsDestination>({
    ae_title: '',
    host: '',
    port: 104,
    use_tls: false,
    cert_fingerprint: null,
  });
  const [echoResult, setEchoResult] = useState<CEchoResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testingEcho, setTestingEcho] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<Error | null>(null);

  useEffect(() => {
    if (tenant?.pacs_destination) {
      setForm(tenant.pacs_destination);
    }
  }, [tenant]);

  const update = (patch: Partial<PacsDestination>): void => {
    setForm((f) => ({ ...f, ...patch }));
    // Invalidate the C-ECHO result whenever the form changes.
    setEchoResult(null);
    setSavedMsg(null);
  };

  const runEcho = async (): Promise<void> => {
    setTestingEcho(true);
    setFormError(null);
    setEchoResult(null);
    try {
      const r = await testEcho(form);
      setEchoResult(r);
    } catch (e) {
      setFormError(e as Error);
    } finally {
      setTestingEcho(false);
    }
  };

  const runSave = async (): Promise<void> => {
    setSubmitting(true);
    setFormError(null);
    setSavedMsg(null);
    try {
      const r = await save(form);
      setSavedMsg(
        (t('admin:pacs.saved') || 'PACS destination saved.') +
          ` (RTT ${r.cecho_round_trip_ms} ms)`,
      );
    } catch (e) {
      setFormError(e as Error);
    } finally {
      setSubmitting(false);
    }
  };

  const canSave = useMemo(
    () => Boolean(form.ae_title && form.host && form.port > 0 && !submitting && !testingEcho),
    [form, submitting, testingEcho],
  );

  if (loading && !tenant) return <EMRTableSkeleton rows={6} columns={2} />;

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconPlug}
        title={t('admin:pacs.title') || 'PACS destination'}
        subtitle={t('admin:pacs.subtitle') || 'Configure where finalized studies are pushed back to your hospital PACS.'}
      />

      {error && (
        <EMRAlert variant="error" title={t('common:error') || 'Error'}>
          {error.message}
        </EMRAlert>
      )}

      <EMRCard padding="lg">
        <Stack gap="lg">
          <SectionHeader
            icon={IconPlug}
            title={t('admin:pacs.section.endpoint') || 'DICOM endpoint'}
            helper={t('admin:pacs.section.endpointHelp') || 'The AE title, host, and port your PACS listens on for C-STORE.'}
          />

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <EMRTextInput
              label={t('admin:pacs.aeTitle') || 'AE title'}
              description={t('admin:pacs.aeTitleHelp') || undefined}
              value={form.ae_title}
              onChange={(v) => update({ ae_title: String(v).toUpperCase() })}
              required
              maxLength={16}
              placeholder="e.g. LIVERRA"
            />
            <EMRTextInput
              label={t('admin:pacs.host') || 'Host / IP'}
              description={t('admin:pacs.hostHelp') || undefined}
              value={form.host}
              onChange={(v) => update({ host: String(v) })}
              required
              placeholder="pacs.hospital.local"
            />
            <EMRNumberInput
              label={t('admin:pacs.port') || 'Port'}
              description={t('admin:pacs.portHelp') || undefined}
              value={form.port}
              onChange={(v) => update({ port: Number(v ?? 104) })}
              min={1}
              max={65535}
              required
            />
          </SimpleGrid>

          <Box
            style={{
              height: 1,
              background: 'var(--emr-gray-200)',
            }}
          />

          <SectionHeader
            icon={IconShieldLock}
            title={t('admin:pacs.section.security') || 'Transport security'}
            helper={t('admin:pacs.section.securityHelp') || 'Pin a certificate fingerprint to detect MITM tampering.'}
          />

          <EMRSwitch
            label={t('admin:pacs.useTls') || 'Use DICOM-TLS'}
            checked={form.use_tls}
            onChange={(checked) => update({ use_tls: checked })}
          />

          {form.use_tls && (
            <EMRTextInput
              label={t('admin:pacs.certFingerprint') || 'Certificate SHA-256 fingerprint'}
              value={form.cert_fingerprint ?? ''}
              onChange={(v) => update({ cert_fingerprint: String(v) || null })}
              placeholder="aa:bb:cc:dd:..."
              leftSection={<IconLock size={14} />}
            />
          )}

          <EchoBanner
            result={echoResult}
            defaultMsg={t('admin:pacs.echoIdle') || 'Run a C-ECHO before saving to verify the destination is reachable.'}
          />

          {formError && <EMRAlert variant="error">{formError.message}</EMRAlert>}
          {savedMsg && <EMRAlert variant="success">{savedMsg}</EMRAlert>}

          <Group justify="flex-end" gap="sm" wrap="wrap">
            <EMRButton
              variant="secondary"
              icon={IconActivity}
              onClick={runEcho}
              disabled={!form.ae_title || !form.host || testingEcho || submitting}
              loading={testingEcho}
            >
              {t('admin:pacs.testEcho') || 'Test with C-ECHO'}
            </EMRButton>
            <EMRButton
              variant="primary"
              icon={IconDeviceFloppy}
              onClick={runSave}
              disabled={!canSave}
              loading={submitting}
            >
              {t('common:save') || 'Save'}
            </EMRButton>
          </Group>
        </Stack>
      </EMRCard>
    </Stack>
  );
}

export default function PacsConfigView(): React.ReactElement {
  return (
    <EMRErrorBoundary>
      <Suspense fallback={<EMRTableSkeleton rows={6} columns={2} />}>
        <PacsConfigInner />
      </Suspense>
    </EMRErrorBoundary>
  );
}
