// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// KeyImageGallery Component
// ============================================================================
// A sidebar panel that shows all "flagged" important images from a study as
// a thumbnail grid. Think of it like a Pinterest board for medical images —
// doctors can star the most critical images so anyone reviewing the case
// later can instantly find what matters.
//
// Features:
// - Thumbnail grid with reason, author, and timestamp
// - Click a thumbnail to navigate the viewport to that image
// - "Flag Current Image" button to bookmark what's on screen
// - Unflag button (only for the author or admin)
// - Count badge showing total flagged images
// - Empty state when no images have been flagged yet
//
// Ported from MediMind. `useMedplum()` → `useLiverraFhir()`. The
// `currentUserId` is resolved from a local stub today; Phase 4 swaps to
// the real authenticated session identity.
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import {
  Text,
  Group,
  Badge,
  ActionIcon,
  Tooltip,
  TextInput,
  Loader,
  SimpleGrid,
} from '@mantine/core';
import {
  IconStar,
  IconStarFilled,
  IconPhoto,
  IconStarOff,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
// Direct imports avoid a `services/pacs/index.ts` barrel (per port constraints).
import {
  flagKeyImage,
  getKeyImages,
  unflagKeyImage,
} from '../../services/pacs/keyImageService';
import type { KeyImage } from '../../services/pacs/keyImageService';
import './KeyImageGallery.css';

// ============================================================================
// Types
// ============================================================================

export interface KeyImageGalleryProps {
  /** FHIR ImagingStudy resource ID */
  studyId: string;
  /** Patient ID (for audit logging) */
  patientId?: string;
  /** SOP Instance UID of the image currently displayed in the viewport */
  currentSopInstanceUid?: string;
  /** Frame number of the currently displayed frame (for multi-frame) */
  currentFrameNumber?: number;
  /** Callback when user clicks a key image — navigate the viewport to it */
  onNavigate?: (sopInstanceUid: string, frameNumber?: number) => void;
}

// TODO(phase-4): read the authenticated user's Practitioner id from the
// session context once it lands. For now we match the stub in keyImageService.
const LOCAL_CURRENT_USER_ID = 'local-user';

// ============================================================================
// Component
// ============================================================================

export function KeyImageGallery({
  studyId,
  patientId,
  currentSopInstanceUid,
  currentFrameNumber,
  onNavigate,
}: KeyImageGalleryProps): JSX.Element {
  const fhirClient = useLiverraFhir();
  const { t } = useTranslation();
  const [keyImages, setKeyImages] = useState<KeyImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [showFlagInput, setShowFlagInput] = useState(false);

  const currentUserId = LOCAL_CURRENT_USER_ID;

  // --------------------------------------------------------------------------
  // Load key images on mount and when studyId changes
  // --------------------------------------------------------------------------
  const loadKeyImages = useCallback(async () => {
    try {
      setLoading(true);
      const images = await getKeyImages(fhirClient, studyId);
      setKeyImages(images);
    } catch (err) {
      console.warn('[KeyImageGallery] Failed to load key images:', err);
    } finally {
      setLoading(false);
    }
  }, [fhirClient, studyId]);

  useEffect(() => {
    // Strict-mode safe: `cancelled` flag keeps a double-mount from setting
    // state after unmount.
    let cancelled = false;
    (async () => {
      try {
        const images = await getKeyImages(fhirClient, studyId);
        if (!cancelled) {
          setKeyImages(images);
        }
      } catch (err) {
        console.warn('[KeyImageGallery] Failed to load key images:', err);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fhirClient, studyId]);

  // --------------------------------------------------------------------------
  // Flag the current image
  // --------------------------------------------------------------------------
  const handleFlag = useCallback(async () => {
    if (!currentSopInstanceUid || !flagReason.trim()) {
      return;
    }

    try {
      setFlagging(true);
      await flagKeyImage(fhirClient, {
        studyId,
        sopInstanceUid: currentSopInstanceUid,
        reason: flagReason.trim(),
        frameNumber: currentFrameNumber,
        patientId,
      });
      setFlagReason('');
      setShowFlagInput(false);
      await loadKeyImages(); // Refresh the list
    } catch (err) {
      console.warn('[KeyImageGallery] Failed to flag key image:', err);
    } finally {
      setFlagging(false);
    }
  }, [fhirClient, studyId, currentSopInstanceUid, currentFrameNumber, flagReason, patientId, loadKeyImages]);

  // --------------------------------------------------------------------------
  // Unflag a key image
  // --------------------------------------------------------------------------
  const handleUnflag = useCallback(async (keyImageId: string) => {
    try {
      await unflagKeyImage(fhirClient, keyImageId);
      await loadKeyImages(); // Refresh the list
    } catch (err) {
      console.warn('[KeyImageGallery] Failed to unflag key image:', err);
    }
  }, [fhirClient, loadKeyImages]);

  // --------------------------------------------------------------------------
  // Check if the current image is already flagged
  // --------------------------------------------------------------------------
  const isCurrentImageFlagged = keyImages.some(
    (ki) =>
      ki.sopInstanceUid === currentSopInstanceUid &&
      (currentFrameNumber === undefined || ki.frameNumber === currentFrameNumber)
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="key-image-gallery" data-testid="key-image-gallery">
      {/* Header with count badge */}
      <Group className="key-image-gallery-header" justify="space-between">
        <Group gap="xs">
          <IconStarFilled size={16} style={{ color: 'var(--emr-warning)' }} />
          <Text fw="var(--emr-font-semibold)" size="sm">
            {t('pacs.keyImages')}
          </Text>
          {keyImages.length > 0 && (
            <Badge
              size="sm"
              variant="filled"
              className="key-image-count-badge"
            >
              {keyImages.length}
            </Badge>
          )}
        </Group>

        {/* Flag current image button */}
        {currentSopInstanceUid && !isCurrentImageFlagged && (
          <Tooltip label={t('pacs.flagCurrentImage')}>
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => setShowFlagInput(!showFlagInput)}
              aria-label={t('pacs.flagCurrentImage')}
            >
              <IconStar size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {/* Flag input (appears when user clicks the flag button) */}
      {showFlagInput && (
        <div className="key-image-flag-input">
          <TextInput
            size="xs"
            placeholder={t('pacs.flagReason')}
            value={flagReason}
            onChange={(e) => setFlagReason(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleFlag();
              }
              if (e.key === 'Escape') {
                setShowFlagInput(false);
                setFlagReason('');
              }
            }}
            rightSection={
              flagging ? (
                <Loader size={14} />
              ) : (
                <ActionIcon
                  size="xs"
                  variant="filled"
                  onClick={handleFlag}
                  disabled={!flagReason.trim()}
                  aria-label={t('pacs.confirmFlag')}
                  style={{ background: 'var(--emr-gradient-primary)' }}
                >
                  <IconStarFilled size={12} />
                </ActionIcon>
              )
            }
            autoFocus
          />
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="key-image-gallery-loading">
          <Loader size="sm" />
        </div>
      )}

      {/* Empty state */}
      {!loading && keyImages.length === 0 && (
        <div className="key-image-gallery-empty">
          <IconPhoto size={32} style={{ color: 'var(--emr-text-secondary)', opacity: 0.5 }} />
          <Text size="xs" c="dimmed" ta="center">
            {t('pacs.noKeyImages')}
          </Text>
          {currentSopInstanceUid && (
            <Text size="xs" c="dimmed" ta="center">
              {t('pacs.flagHint')}
            </Text>
          )}
        </div>
      )}

      {/* Thumbnail grid */}
      {!loading && keyImages.length > 0 && (
        <SimpleGrid cols={2} spacing="xs" className="key-image-grid">
          {keyImages.map((ki) => (
            <KeyImageCard
              key={ki.id}
              keyImage={ki}
              isCurrentUser={ki.authorId === currentUserId}
              onNavigate={onNavigate}
              onUnflag={handleUnflag}
            />
          ))}
        </SimpleGrid>
      )}
    </div>
  );
}

// ============================================================================
// KeyImageCard — Individual thumbnail card
// ============================================================================

interface KeyImageCardProps {
  keyImage: KeyImage;
  isCurrentUser: boolean;
  onNavigate?: (sopInstanceUid: string, frameNumber?: number) => void;
  onUnflag: (keyImageId: string) => void;
}

function KeyImageCard({
  keyImage,
  isCurrentUser,
  onNavigate,
  onUnflag,
}: KeyImageCardProps): JSX.Element {
  const { t } = useTranslation();

  const handleClick = useCallback(() => {
    onNavigate?.(keyImage.sopInstanceUid, keyImage.frameNumber);
  }, [onNavigate, keyImage.sopInstanceUid, keyImage.frameNumber]);

  const handleUnflag = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger navigation
    onUnflag(keyImage.id);
  }, [onUnflag, keyImage.id]);

  // Format the timestamp to a readable short form
  const flaggedDate = keyImage.flaggedAt
    ? new Date(keyImage.flaggedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  return (
    <div
      className="key-image-card"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleClick();
        }
      }}
      aria-label={`${t('pacs.keyImage')}: ${keyImage.reason}`}
    >
      {/* Thumbnail placeholder (actual thumbnail would come from DICOMweb) */}
      <div className="key-image-thumbnail">
        <IconPhoto size={24} style={{ color: 'var(--emr-text-secondary)', opacity: 0.4 }} />
        {keyImage.frameNumber !== undefined && (
          <Badge
            size="xs"
            className="key-image-frame-badge"
          >
            F{keyImage.frameNumber}
          </Badge>
        )}
      </div>

      {/* Info section */}
      <div className="key-image-info">
        <Text size="xs" fw="var(--emr-font-semibold)" lineClamp={1} title={keyImage.reason}>
          {keyImage.reason}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {keyImage.authorName}
        </Text>
        <Text size="xs" c="dimmed" style={{ fontSize: 'var(--emr-font-xs)' }}>
          {flaggedDate}
        </Text>
      </div>

      {/* Unflag button (only for author) */}
      {isCurrentUser && (
        <Tooltip label={t('pacs.unflagImage')}>
          <ActionIcon
            size="xs"
            variant="subtle"
            className="key-image-unflag"
            onClick={handleUnflag}
            aria-label={t('pacs.unflagImage')}
          >
            <IconStarOff size={12} />
          </ActionIcon>
        </Tooltip>
      )}
    </div>
  );
}
