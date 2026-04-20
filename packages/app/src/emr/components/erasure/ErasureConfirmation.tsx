// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ErasureConfirmation (T331, US9).
 *
 * Plain-English:
 *   After a DPO hits "Execute erasure" the wizard's final pane swaps
 *   in this component. It shows:
 *     - A green success banner (erasure completed).
 *     - The tombstone hash (12 hex chars shown; full hash on hover).
 *     - A download button for the WeasyPrint-rendered confirmation PDF.
 *     - A link back to the erasure request list.
 *
 *   The tombstone hash is the cryptographic anchor that ties the
 *   confirmation PDF to the audit log entry — regulators can
 *   independently verify both sides match.
 */

import { Alert, Badge, Code, Group, Stack, Text } from '@mantine/core';
import { IconCircleCheck, IconDownload } from '@tabler/icons-react';
import { Link } from 'react-router-dom';

import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton } from '../common/EMRButton';

export interface ErasureConfirmationProps {
  erasureRequestId: string;
  tombstoneHashHex: string;
  confirmationPdfUrl: string | null;
  /** Seconds taken end-to-end; surfaced in the success alert. */
  elapsedSeconds?: number;
}

export function ErasureConfirmation({
  erasureRequestId,
  tombstoneHashHex,
  confirmationPdfUrl,
  elapsedSeconds,
}: ErasureConfirmationProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <Stack gap="md" p="md" data-testid="erasure-confirmation">
      <Alert
        icon={<IconCircleCheck size={22} />}
        color="teal"
        variant="light"
        title={t('erasure:confirmation.title')}
      >
        <Text fz="sm">
          {t('erasure:confirmation.body')}
          {typeof elapsedSeconds === 'number' ? (
            <>
              {' '}
              <Badge color="teal" variant="light" size="sm" ml={6}>
                {t('erasure:confirmation.elapsed', {
                  seconds: elapsedSeconds.toFixed(1),
                })}
              </Badge>
            </>
          ) : null}
        </Text>
      </Alert>

      <Stack gap={4}>
        <Text fz="xs" c="dimmed">
          {t('erasure:confirmation.erasure_request_id')}
        </Text>
        <Code>{erasureRequestId}</Code>
      </Stack>

      <Stack gap={4}>
        <Text fz="xs" c="dimmed">
          {t('erasure:confirmation.tombstone_hash')}
        </Text>
        <Code
          title={tombstoneHashHex}
          data-testid="erasure-tombstone-hash"
          style={{ wordBreak: 'break-all' }}
        >
          {tombstoneHashHex}
        </Code>
        <Text fz="xs" c="dimmed">
          {t('erasure:confirmation.tombstone_help')}
        </Text>
      </Stack>

      <Group gap="sm" wrap="wrap">
        {confirmationPdfUrl ? (
          <a
            href={confirmationPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: 'none' }}
          >
            <EMRButton
              variant="primary"
              icon={IconDownload}
              data-testid="erasure-download-pdf-btn"
            >
              {t('erasure:confirmation.download_pdf')}
            </EMRButton>
          </a>
        ) : (
          <Badge variant="light" color="yellow">
            {t('erasure:confirmation.pdf_pending')}
          </Badge>
        )}
        <Link to="/erasure" style={{ textDecoration: 'none' }}>
          <EMRButton variant="subtle">
            {t('erasure:confirmation.back_to_list')}
          </EMRButton>
        </Link>
      </Group>
    </Stack>
  );
}

export default ErasureConfirmation;
