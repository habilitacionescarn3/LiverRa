// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AuditChainVerifier (T347).
 *
 * Plain-English: the server returns an audit-chain slice plus a
 * verdict: `chain_valid: true` (every seal lines up) or
 * `chain_first_invalid_sequence_no: N` (the chain broke at row N).
 * This component renders a compact status summary:
 *
 *   - All good → a green "chain valid" badge + Merkle root + anchor links.
 *   - Tampered → a red warning highlighting the first invalid sequence
 *                number + a link to the adjacent S3 Merkle anchor so
 *                the reviewer can cross-check against the Object-Lock
 *                copy.
 *
 * This is a pure presentational component — it consumes an
 * `AuditSummaryResponse` and emits no side-effects. Data loading lives
 * in the sibling view (`AuditSummaryView`).
 *
 * Spec refs: SC-010, research.md §A.3.
 */

import type { ReactElement } from 'react';
import { Alert, Anchor, Badge, Code, Group, Stack, Text } from '@mantine/core';
import {
  IconShieldCheck,
  IconShieldX,
  IconExternalLink,
} from '@tabler/icons-react';

import { useTranslation } from '../../contexts/TranslationContext';
import type { AuditSummaryResponse } from '../../hooks/useAuditSummary';

export interface AuditChainVerifierProps {
  summary: AuditSummaryResponse | null;
  isLoading?: boolean;
}

export function AuditChainVerifier({
  summary,
  isLoading = false,
}: AuditChainVerifierProps): ReactElement {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <Alert
        data-testid="audit-chain-verifier-loading"
        color="gray"
        title={t('compliance:chain.verifying')}
        variant="light"
      >
        <Text size="sm">{t('compliance:chain.verifyingDetail')}</Text>
      </Alert>
    );
  }

  if (!summary) {
    return (
      <Alert
        data-testid="audit-chain-verifier-empty"
        color="gray"
        variant="light"
        title={t('compliance:chain.empty')}
      >
        <Text size="sm">{t('compliance:chain.emptyDetail')}</Text>
      </Alert>
    );
  }

  const anchors = summary.s3_anchor_uris ?? [];

  if (summary.chain_valid) {
    return (
      <Alert
        data-testid="audit-chain-verifier-valid"
        color="green"
        variant="light"
        icon={<IconShieldCheck size={20} aria-hidden="true" />}
        title={
          <Group gap="xs">
            <Text fw={700}>{t('compliance:chain.validTitle')}</Text>
            <Badge color="green" variant="light" size="sm">
              {t('compliance:chain.validBadge')}
            </Badge>
          </Group>
        }
      >
        <Stack gap="xs" mt={4}>
          <Text size="sm">{t('compliance:chain.validDetail')}</Text>
          <Text size="xs" c="var(--emr-text-secondary)">
            {t('compliance:chain.merkleRoot')}:{' '}
            <Code style={{ wordBreak: 'break-all' }}>
              {summary.merkle_root_for_window || t('compliance:chain.rootEmpty')}
            </Code>
          </Text>
          {anchors.length > 0 && (
            <Stack gap={2}>
              <Text size="xs" fw={600} c="var(--emr-text-secondary)">
                {t('compliance:chain.s3Anchors')} ({anchors.length})
              </Text>
              {anchors.slice(0, 7).map((uri) => (
                <Anchor
                  key={uri}
                  href={uri}
                  target="_blank"
                  rel="noreferrer"
                  size="xs"
                  style={{ wordBreak: 'break-all' }}
                >
                  <Group gap={4} wrap="nowrap">
                    <IconExternalLink size={12} aria-hidden="true" />
                    <span>{uri}</span>
                  </Group>
                </Anchor>
              ))}
              {anchors.length > 7 && (
                <Text size="xs" c="var(--emr-text-tertiary)">
                  {t('compliance:chain.moreAnchors', { count: anchors.length - 7 })}
                </Text>
              )}
            </Stack>
          )}
        </Stack>
      </Alert>
    );
  }

  const invalidAt = summary.chain_first_invalid_sequence_no ?? -1;

  return (
    <Alert
      data-testid="audit-chain-verifier-invalid"
      color="red"
      variant="filled"
      icon={<IconShieldX size={20} aria-hidden="true" />}
      title={t('compliance:chain.invalidTitle')}
      style={{
        backgroundColor: 'var(--emr-error)',
        color: 'var(--emr-text-inverse)',
      }}
    >
      <Stack gap="xs" mt={4}>
        <Text size="sm" fw={600} c="inherit">
          {t('compliance:chain.invalidDetail', { seq: String(invalidAt) })}
        </Text>
        <Text size="xs" c="inherit" style={{ opacity: 0.9 }}>
          {t('compliance:chain.invalidGuidance')}
        </Text>
        {anchors.length > 0 && (
          <Stack gap={2}>
            <Text size="xs" fw={700} c="inherit">
              {t('compliance:chain.s3AnchorsCompare')}
            </Text>
            {anchors.map((uri) => (
              <Anchor
                key={uri}
                href={uri}
                target="_blank"
                rel="noreferrer"
                size="xs"
                c="var(--emr-text-inverse)"
                style={{ wordBreak: 'break-all', textDecoration: 'underline' }}
                data-testid="audit-chain-s3-anchor"
              >
                <Group gap={4} wrap="nowrap">
                  <IconExternalLink size={12} aria-hidden="true" />
                  <span>{uri}</span>
                </Group>
              </Anchor>
            ))}
          </Stack>
        )}
      </Stack>
    </Alert>
  );
}

export default AuditChainVerifier;
