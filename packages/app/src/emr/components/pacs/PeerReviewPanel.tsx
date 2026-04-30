// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PeerReviewPanel — RADPEER 2016 Peer Review Interface
// ============================================================================
// Collapsible panel displayed below signed radiology reports. Lets radiologists
// score each other's reads using the RADPEER 2016 scale and view review history.
//
// Think of it like a "code review" panel — a peer reviews the interpretation,
// picks a score (1 = agree, 2a/2b/3a/3b = various discrepancies), adds a note
// if needed, and submits. Previous reviews are shown in a timeline below.
//
// Only visible when the report status is 'final' (signed).
//
// Ported from MediMind (components/pacs/PeerReviewPanel.tsx) with:
//   - `EMRCollapsibleSection` inlined using Mantine `<Collapse>` — LiverRa
//     doesn't yet ship the full MediMind collapsible component. Swap to the
//     shared component in a later pass when that lands.
//   - `useTranslation()` + translation keys in the `pacs.peerReview.*`
//     namespace (already in use).
// ============================================================================

import type { ReactElement } from 'react';
import { useState, useCallback, useEffect } from 'react';
import {
  Stack,
  Group,
  Text,
  Radio,
  Box,
  Loader,
  Badge,
  Collapse,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconUserCheck,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRTextarea } from '../shared/EMRFormFields';
import { EMRButton } from '../common/EMRButton';
import {
  usePeerReview,
  type RadpeerScore,
} from '../../hooks/pacs/usePeerReview';

// ============================================================================
// Types
// ============================================================================

export interface PeerReviewPanelProps {
  /** DiagnosticReport ID of the signed report */
  reportId: string;
  /** Whether the report is signed (only show panel when true) */
  isSigned: boolean;
}

// ============================================================================
// Score descriptions keyed by score value
// ============================================================================

const SCORE_KEYS: RadpeerScore[] = ['1', '2a', '2b', '3a', '3b'];

// ============================================================================
// Component
// ============================================================================

export function PeerReviewPanel({
  reportId,
  isSigned,
}: PeerReviewPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const {
    submitScore,
    reviews,
    isLoading,
    isSubmitting,
    validationError,
    loadReviews,
  } = usePeerReview();

  const [selectedScore, setSelectedScore] = useState<RadpeerScore | ''>('');
  const [discrepancyNote, setDiscrepancyNote] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  // Load reviews when reportId changes
  useEffect(() => {
    if (reportId && isSigned) {
      void loadReviews(reportId);
    }
  }, [reportId, isSigned, loadReviews]);

  // Whether the note textarea is required (any score other than '1')
  const noteRequired = selectedScore !== '' && selectedScore !== '1';

  const handleSubmit = useCallback(async () => {
    if (!selectedScore) return;

    const success = await submitScore({
      reportId,
      score: selectedScore,
      discrepancyNote: noteRequired ? discrepancyNote : undefined,
    });

    if (success) {
      notifications.show({
        title: t('pacs.peerReview.title'),
        message: t('pacs.peerReview.submit'),
        color: 'green',
        icon: <IconCheck size={16} />,
      });
      // Reset form
      setSelectedScore('');
      setDiscrepancyNote('');
    }
  }, [selectedScore, discrepancyNote, reportId, submitScore, noteRequired, t]);

  // Don't render if report isn't signed
  if (!isSigned) return null;

  return (
    <Box
      style={{
        border: '1px solid var(--emr-border-color)',
        borderRadius: 'var(--mantine-radius-sm)',
        overflow: 'hidden',
      }}
      data-testid="peer-review-panel"
    >
      {/* Header — toggles the collapse */}
      <UnstyledButton
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        style={{
          width: '100%',
          padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-md)',
          background: 'var(--emr-bg-card)',
          borderBottom: isOpen ? '1px solid var(--emr-border-color)' : 'none',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--mantine-spacing-sm)',
        }}
      >
        {isOpen ? (
          <IconChevronDown size={16} color="var(--emr-text-primary)" />
        ) : (
          <IconChevronRight size={16} color="var(--emr-text-primary)" />
        )}
        <IconUserCheck size={18} color="var(--emr-text-primary)" />
        <Text size="sm" fw={600} style={{ color: 'var(--emr-text-primary)' }}>
          {t('pacs.peerReview.title')}
        </Text>
      </UnstyledButton>

      <Collapse in={isOpen}>
        <Box p="md">
          <Stack gap="md">
            {/* Score selection — 5 radio buttons */}
            <Box>
              <Text
                size="sm"
                fw={600}
                mb="xs"
                style={{ color: 'var(--emr-text-primary)' }}
              >
                {t('pacs.peerReview.selectScore')}
              </Text>
              <Radio.Group
                value={selectedScore}
                onChange={(val) => setSelectedScore(val as RadpeerScore)}
              >
                <Stack gap="xs">
                  {SCORE_KEYS.map((score) => (
                    <Radio
                      key={score}
                      value={score}
                      label={t(`pacs.peerReview.score.${score}`)}
                      styles={{
                        root: {
                          minHeight: 44,
                          display: 'flex',
                          alignItems: 'center',
                        },
                        label: {
                          fontSize: 'var(--emr-font-sm)',
                          color: 'var(--emr-text-primary)',
                          cursor: 'pointer',
                        },
                        radio: {
                          cursor: 'pointer',
                        },
                      }}
                      data-testid={`peer-review-score-${score}`}
                    />
                  ))}
                </Stack>
              </Radio.Group>
              {validationError?.field === 'score' && (
                <Text size="xs" c="red" mt={4}>
                  {t('pacs.peerReview.invalidScore')}
                </Text>
              )}
            </Box>

            {/* Discrepancy note — appears when score is not '1' */}
            {noteRequired && (
              <Box>
                <EMRTextarea
                  label={t('pacs.peerReview.discrepancyNote')}
                  placeholder={t('pacs.peerReview.discrepancyNotePlaceholder')}
                  value={discrepancyNote}
                  onChange={setDiscrepancyNote}
                  required
                  rows={3}
                  size="sm"
                  data-testid="peer-review-discrepancy-note"
                />
                {validationError?.field === 'discrepancyNote' && (
                  <Text size="xs" c="red" mt={4}>
                    {t('pacs.peerReview.discrepancyNoteRequired')}
                  </Text>
                )}
              </Box>
            )}

            {/* Submit button */}
            <Group justify="flex-end">
              <EMRButton
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
                disabled={!selectedScore || (noteRequired && !discrepancyNote.trim())}
                icon={IconCheck}
                data-testid="peer-review-submit"
              >
                {t('pacs.peerReview.submit')}
              </EMRButton>
            </Group>

            {/* Previous reviews */}
            <Box>
              <Text
                size="sm"
                fw={600}
                mb="xs"
                style={{ color: 'var(--emr-text-primary)' }}
              >
                {t('pacs.peerReview.previousReviews')}
              </Text>

              {isLoading ? (
                <Group justify="center" py="md">
                  <Loader size="sm" />
                </Group>
              ) : reviews.length === 0 ? (
                <Text
                  size="sm"
                  c="dimmed"
                  ta="center"
                  py="md"
                  data-testid="peer-review-no-reviews"
                >
                  {t('pacs.peerReview.noReviews')}
                </Text>
              ) : (
                <Stack gap="xs">
                  {reviews.map((review) => (
                    <Box
                      key={review.id}
                      style={{
                        padding: 'var(--mantine-spacing-sm)',
                        borderRadius: 'var(--mantine-radius-sm)',
                        border: '1px solid var(--emr-border-color)',
                        backgroundColor: 'var(--emr-bg-card)',
                      }}
                      data-testid={`peer-review-item-${review.id}`}
                    >
                      <Group justify="space-between" wrap="wrap" gap="xs" mb={4}>
                        <Text size="sm" fw={500} style={{ color: 'var(--emr-text-primary)' }}>
                          {review.reviewerDisplay || t('pacs.peerReview.reviewer')}
                        </Text>
                        <Badge
                          variant="light"
                          size="sm"
                          style={{
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {t('pacs.peerReview.scoreLabel')}: {review.score}
                        </Badge>
                      </Group>
                      {review.date && (
                        <Text size="xs" c="dimmed" mb={4}>
                          {new Date(review.date).toLocaleString()}
                        </Text>
                      )}
                      {review.discrepancyNote && (
                        <Text
                          size="sm"
                          style={{
                            color: 'var(--emr-text-secondary)',
                            fontStyle: 'italic',
                          }}
                        >
                          {review.discrepancyNote}
                        </Text>
                      )}
                    </Box>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </Box>
      </Collapse>
    </Box>
  );
}
