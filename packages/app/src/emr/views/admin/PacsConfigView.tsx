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
import { Suspense, useEffect, useState } from 'react';
import { Box, Group, Stack, Switch, Text } from '@mantine/core';
import { IconPlug, IconDeviceFloppy, IconActivity } from '@tabler/icons-react';
import {
  EMRAlert,
  EMRButton,
  EMRErrorBoundary,
  EMRPageHeader,
  EMRTableSkeleton,
} from '../../components/common';
import {
  EMRTextInput,
  EMRNumberInput,
} from '../../components/shared/EMRFormFields';
import { usePacsConfig, type PacsDestination, type CEchoResult } from '../../hooks/usePacsConfig';
import { useTranslation } from '../../contexts/TranslationContext';

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
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<Error | null>(null);

  useEffect(() => {
    if (tenant?.pacs_destination) {
      setForm(tenant.pacs_destination);
    }
  }, [tenant]);

  const update = (patch: Partial<PacsDestination>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };

  const runEcho = async (): Promise<void> => {
    setSubmitting(true);
    setFormError(null);
    setEchoResult(null);
    try {
      const r = await testEcho(form);
      setEchoResult(r);
    } catch (e) {
      setFormError(e as Error);
    } finally {
      setSubmitting(false);
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

  if (loading && !tenant) return <EMRTableSkeleton rows={6} columns={2} />;

  return (
    <Stack gap="lg" p={{ base: 'sm', md: 'lg' } as unknown as string}>
      <EMRPageHeader
        icon={IconPlug}
        title={t('admin:pacs.title') || 'PACS destination'}
        subtitle={t('admin:pacs.subtitle') || 'Configure where finalized studies are pushed.'}
      />

      {error && (
        <EMRAlert variant="error" title={t('common:error') || 'Error'}>
          {error.message}
        </EMRAlert>
      )}

      <Box
        style={{
          padding: 16,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-bg-card)',
          border: '1px solid var(--emr-gray-200)',
        }}
      >
        <Stack gap="md">
          <EMRTextInput
            label={t('admin:pacs.aeTitle') || 'AE title'}
            value={form.ae_title}
            onChange={(v) => update({ ae_title: String(v) })}
            required
            maxLength={16}
          />
          <EMRTextInput
            label={t('admin:pacs.host') || 'Host / IP'}
            value={form.host}
            onChange={(v) => update({ host: String(v) })}
            required
          />
          <EMRNumberInput
            label={t('admin:pacs.port') || 'Port'}
            value={form.port}
            onChange={(v) => update({ port: Number(v ?? 104) })}
            min={1}
            max={65535}
            required
          />
          <Group justify="space-between" wrap="wrap">
            <Text fz="var(--emr-font-sm)">{t('admin:pacs.useTls') || 'Use DICOM-TLS'}</Text>
            <Switch
              checked={form.use_tls}
              onChange={(e) => update({ use_tls: e.currentTarget.checked })}
            />
          </Group>
          {form.use_tls && (
            <EMRTextInput
              label={t('admin:pacs.certFingerprint') || 'Cert fingerprint'}
              value={form.cert_fingerprint ?? ''}
              onChange={(v) => update({ cert_fingerprint: String(v) || null })}
            />
          )}

          {echoResult && (
            <EMRAlert
              variant={echoResult.reachable ? 'success' : 'error'}
              icon={IconActivity}
              title={
                echoResult.reachable
                  ? (t('admin:pacs.echoOk') || 'C-ECHO succeeded')
                  : (t('admin:pacs.echoFail') || 'C-ECHO failed')
              }
            >
              {echoResult.reachable
                ? `${t('admin:pacs.roundTrip') || 'Round-trip'}: ${echoResult.round_trip_ms} ms (${echoResult.scanner_ae_responded ?? '—'})`
                : `${echoResult.error ?? 'unreachable'}`}
            </EMRAlert>
          )}

          {formError && <EMRAlert variant="error">{formError.message}</EMRAlert>}
          {savedMsg && <EMRAlert variant="success">{savedMsg}</EMRAlert>}

          <Group justify="flex-end" gap="sm" wrap="wrap">
            <EMRButton
              variant="secondary"
              icon={IconActivity}
              onClick={runEcho}
              disabled={submitting}
              loading={submitting && !savedMsg}
            >
              {t('admin:pacs.testEcho') || 'Test with C-ECHO'}
            </EMRButton>
            <EMRButton
              variant="primary"
              icon={IconDeviceFloppy}
              onClick={runSave}
              disabled={submitting || !form.ae_title || !form.host}
              loading={submitting}
            >
              {t('common:save') || 'Save'}
            </EMRButton>
          </Group>
        </Stack>
      </Box>
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
