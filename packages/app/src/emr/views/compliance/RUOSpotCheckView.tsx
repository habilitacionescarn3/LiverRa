// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RUOSpotCheckView (T348, T449).
 *
 * Plain-English: this is the SC-009 review workbench. The reviewer
 * clicks "Sample 20 artifacts", the server returns N random export
 * URLs + the bounding box where the RUO watermark should appear. The
 * UI renders each artifact as a thumbnail with the bbox highlighted,
 * and the reviewer flips pass / fail on each one. When every item has
 * a verdict, a summary line at the top shows "N/N passing".
 *
 * Thumbnails: PDFs render as the first page in an `<iframe>`; DICOM
 * derivatives show a placeholder with the filename (OHIF preview is
 * out of scope for this module). The overlay rectangle uses the
 * server-returned `watermark_bbox` in pixel coordinates.
 *
 * Spec refs: SC-009, research.md §B.7.
 */

import type { ReactElement } from 'react';
import { useMemo } from 'react';
import {
  Alert,
  Badge,
  Box,
  Group,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconX,
  IconCamera,
  IconShieldCheck,
} from '@tabler/icons-react';

import {
  EMRButton,
  EMRCard,
  EMREmptyState,
  EMRErrorBoundary,
  EMRPageHeader,
} from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { useRUOSpotCheck, type SpotCheckItem } from '../../hooks/useRUOSpotCheck';

function ArtifactThumbnail({
  item,
  onMark,
  t,
}: {
  item: SpotCheckItem;
  onMark: (pass: boolean) => void;
  t: (k: string) => string;
}): ReactElement {
  const [x, y, w, h] = item.watermark_bbox.length >= 4 ? item.watermark_bbox : [0, 0, 0, 0];
  const isPdf = /\.pdf($|\?)/i.test(item.artifact_url);

  return (
    <EMRCard
      data-testid="ruo-spot-check-item"
      data-artifact-id={item.artifact_id}
      data-pass={item.pass === null ? 'pending' : String(item.pass)}
      style={{
        borderColor:
          item.pass === true
            ? 'var(--emr-success)'
            : item.pass === false
              ? 'var(--emr-error)'
              : 'var(--emr-border-color)',
        borderWidth: 2,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <IconCamera size={14} aria-hidden="true" />
            <Text size="sm" fw={600} style={{ wordBreak: 'break-all' }}>
              {item.artifact_kind || t('compliance:spotCheck.artifact')}
            </Text>
          </Group>
          {item.pass !== null && (
            <Badge
              color={item.pass ? 'green' : 'red'}
              variant="filled"
              size="sm"
              leftSection={
                item.pass ? (
                  <IconCheck size={12} aria-hidden="true" />
                ) : (
                  <IconX size={12} aria-hidden="true" />
                )
              }
            >
              {item.pass ? t('compliance:spotCheck.pass') : t('compliance:spotCheck.fail')}
            </Badge>
          )}
        </Group>

        <Box
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: '3 / 4',
            background: 'var(--emr-bg-hover)',
            borderRadius: 'var(--emr-border-radius-md, 6px)',
            overflow: 'hidden',
          }}
        >
          {isPdf ? (
            <iframe
              src={item.artifact_url}
              title={item.artifact_id || item.artifact_url}
              style={{ width: '100%', height: '100%', border: 0 }}
            />
          ) : (
            <Stack
              justify="center"
              align="center"
              style={{ width: '100%', height: '100%' }}
              gap={4}
            >
              <IconCamera size={32} aria-hidden="true" />
              <Text size="xs" c="var(--emr-text-secondary)">
                {t('compliance:spotCheck.nonPdfPlaceholder')}
              </Text>
            </Stack>
          )}

          {/* Watermark bbox overlay — shows reviewer where to look. */}
          {w > 0 && h > 0 && (
            <Box
              aria-hidden="true"
              data-testid="ruo-watermark-bbox"
              style={{
                position: 'absolute',
                left: x,
                top: y,
                width: w,
                height: h,
                border: '2px dashed var(--emr-warning)',
                background: 'var(--emr-warning-alpha-12)',
                pointerEvents: 'none',
              }}
            />
          )}
        </Box>

        <Group grow gap="xs">
          <EMRButton
            size="compact-sm"
            color="green"
            onClick={() => onMark(true)}
            leftSection={<IconCheck size={14} aria-hidden="true" />}
            data-testid="ruo-spot-check-pass"
          >
            {t('compliance:spotCheck.pass')}
          </EMRButton>
          <EMRButton
            size="compact-sm"
            variant="outline"
            color="red"
            onClick={() => onMark(false)}
            leftSection={<IconX size={14} aria-hidden="true" />}
            data-testid="ruo-spot-check-fail"
          >
            {t('compliance:spotCheck.fail')}
          </EMRButton>
        </Group>
      </Stack>
    </EMRCard>
  );
}

function RUOSpotCheckInner(): ReactElement {
  const { t } = useTranslation();
  const { items, isLoading, isError, error, sample, setPassFlag, reset } =
    useRUOSpotCheck();

  const { passCount, failCount, reviewedCount } = useMemo(() => {
    let pass = 0;
    let fail = 0;
    for (const it of items) {
      if (it.pass === true) pass++;
      else if (it.pass === false) fail++;
    }
    return { passCount: pass, failCount: fail, reviewedCount: pass + fail };
  }, [items]);

  return (
    <Stack gap="md" p="md" data-testid="ruo-spot-check-view">
      <EMRPageHeader
        icon={IconShieldCheck}
        title={t('compliance:spotCheck.title')}
        subtitle={t('compliance:spotCheck.subtitle')}
      />

      {isError && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} />}
          title={t('compliance:spotCheck.errorTitle')}
        >
          {error?.message ?? t('common:genericError')}
        </Alert>
      )}

      <EMRCard>
        <Group justify="space-between" wrap="wrap" gap="md">
          <Group gap="md" wrap="wrap">
            <EMRButton
              onClick={() => sample(20)}
              loading={isLoading}
              data-testid="ruo-spot-check-sample"
            >
              {t('compliance:spotCheck.sampleButton', { n: '20' })}
            </EMRButton>
            {items.length > 0 && (
              <EMRButton
                variant="outline"
                onClick={reset}
                data-testid="ruo-spot-check-reset"
              >
                {t('compliance:spotCheck.resetButton')}
              </EMRButton>
            )}
          </Group>
          {items.length > 0 && (
            <Group gap="sm">
              <Badge color="green" variant="light" size="lg">
                {t('compliance:spotCheck.passCount', {
                  n: String(passCount),
                  total: String(items.length),
                })}
              </Badge>
              <Badge color="red" variant="light" size="lg">
                {t('compliance:spotCheck.failCount', { n: String(failCount) })}
              </Badge>
              <Badge color="gray" variant="light" size="lg">
                {t('compliance:spotCheck.reviewed', {
                  n: String(reviewedCount),
                  total: String(items.length),
                })}
              </Badge>
            </Group>
          )}
        </Group>
      </EMRCard>

      {items.length === 0 ? (
        <EMRCard>
          <EMREmptyState
            title={t('compliance:spotCheck.emptyTitle')}
            description={t('compliance:spotCheck.emptyDescription')}
          />
        </EMRCard>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3, lg: 4 }} spacing="md">
          {items.map((item) => (
            <ArtifactThumbnail
              key={item.artifact_id || item.artifact_url}
              item={item}
              onMark={(pass) =>
                setPassFlag(item.artifact_id || item.artifact_url, pass)
              }
              t={t}
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

export default function RUOSpotCheckView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="RUOSpotCheckView">
      <RUOSpotCheckInner />
    </EMRErrorBoundary>
  );
}
