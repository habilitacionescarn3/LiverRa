// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PDFPreview (T269, T415, T429).
 *
 * Plain-English: a framed window onto the finalized PDF. We render it
 * through a server-proxy endpoint so the PDF bytes are KMS-encrypted at
 * rest and never touch the browser's cache on a shared kiosk.
 *
 * Security notes:
 *   - The iframe's `src` goes through the same-origin `/api/v1/reports/
 *     {id}/pdf` route, which the backend serves with
 *     `Content-Disposition: inline` + `Content-Security-Policy:
 *     frame-ancestors 'none'`. The `sandbox` attribute below layers on
 *     an additional restriction at the browser level.
 *   - We also consume `useRUOClaim()` to ensure the surrounding UI
 *     gate is honored (per FR-028b / T415). If the claim gate says
 *     the user shouldn't see the PDF, we render a disclosure card
 *     instead of the iframe.
 */
import { useMemo } from 'react';
import { Box, Stack, Text } from '@mantine/core';

import { useReport } from '../../hooks/useReport';
import { useRUOClaim } from '../../hooks/useRUOClaim';
import { useTranslation } from '../../contexts/TranslationContext';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export interface PDFPreviewProps {
  reportId: string;
  /** RUO claim key this surface is gated behind (defaults to `report.pdf`). */
  claimKey?: string;
  /** CSS height for the iframe; default 80vh. */
  height?: string;
}

export function PDFPreview({
  reportId,
  claimKey = 'report.pdf',
  height = '80vh',
}: PDFPreviewProps): JSX.Element {
  const { t } = useTranslation();
  const report = useReport(reportId);
  const claim = useRUOClaim(claimKey);

  const iframeSrc = useMemo(() => {
    const base = readApiBaseUrl();
    return `${base}/reports/${encodeURIComponent(reportId)}/pdf`;
  }, [reportId]);

  if (claim.uiGate === 'hidden') {
    return (
      <Box p="md" data-testid="pdf-preview-claim-hidden">
        <Text size="sm" c="dimmed">
          {t('report:pdf.claimHidden') ??
            'PDF preview is restricted for the current RUO claim scope.'}
        </Text>
      </Box>
    );
  }

  if (report.isLoading) {
    return (
      <Box p="md" data-testid="pdf-preview-loading">
        <Text size="sm" c="dimmed">
          {t('report:pdf.loading') ?? 'Loading report…'}
        </Text>
      </Box>
    );
  }

  if (report.error || !report.data) {
    return (
      <Box p="md" data-testid="pdf-preview-error">
        <Text size="sm" c="red">
          {t('report:pdf.error') ?? 'PDF preview unavailable.'}
        </Text>
      </Box>
    );
  }

  if (report.data.status === 'finalizing') {
    return (
      <Box p="md" data-testid="pdf-preview-finalizing">
        <Text size="sm" c="dimmed">
          {t('report:pdf.finalizing') ??
            'The PDF is still being built; this panel will refresh automatically.'}
        </Text>
      </Box>
    );
  }

  return (
    <Stack gap="xs" data-testid="pdf-preview">
      {claim.watermark ? (
        <Text size="xs" c="red.7" fw={600}>
          {claim.disclaimerVariant ?? t('report:pdf.ruoBadge') ?? 'RESEARCH USE ONLY'}
        </Text>
      ) : null}
      <Box
        component="iframe"
        title={t('report:pdf.iframeTitle') ?? 'Finalized Report PDF'}
        src={iframeSrc}
        // frame-ancestors 'none' is enforced server-side by T409 security
        // headers; sandbox hardens the in-page context further.
        sandbox="allow-same-origin"
        style={{
          width: '100%',
          height,
          border: '1px solid var(--mantine-color-gray-3)',
        }}
      />
    </Stack>
  );
}

export default PDFPreview;
