// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ReportKeyImages — Thumbnail strip of flagged key images
// ============================================================================
// Shows key images that were flagged during the study review. Each thumbnail
// shows the reason it was flagged. On save, these are referenced in the
// DiagnosticReport.media array.
//
// Phase-2 status (LiverRa):
//   Depends on `getKeyImages` from the sibling agent's
//   `services/pacs/keyImageService.ts`. If that module isn't landed yet,
//   this component will throw at import — callers should guard with a
//   lazy import or skip rendering until the sibling port completes.
//
// Ported from MediMind (components/pacs/ReportKeyImages.tsx) with:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - Translation namespace changed from `imaging.report.*` → `pacs.report.*`.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Collapse, Tooltip } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconStar } from '@tabler/icons-react';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import { useTranslation } from '../../contexts/TranslationContext';
// TODO(phase-2-merge): sibling agent will create `services/pacs/keyImageService.ts`
// exporting both `getKeyImages` and the `KeyImage` type used below.
import { getKeyImages, type KeyImage } from '../../services/pacs/keyImageService';
import panelStyles from './ReportPanel.module.css';

export interface ReportKeyImagesProps {
  /** FHIR ImagingStudy resource ID. */
  studyId: string;
}

export function ReportKeyImages({
  studyId,
}: ReportKeyImagesProps): React.ReactElement | null {
  const medplum = useLiverraFhir();
  const { t } = useTranslation();
  const [keyImages, setKeyImages] = useState<KeyImage[]>([]);
  const [expanded, setExpanded] = useState(true);

  // Load key images on mount. React Strict Mode double-mount safe via
  // `cancelled` flag — matches MediMind's pattern.
  useEffect(() => {
    if (!studyId) { return; }
    let cancelled = false;
    void getKeyImages(medplum, studyId)
      .then((ki) => {
        if (!cancelled) {
          setKeyImages(ki);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[ReportKeyImages] Failed to load key images:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [medplum, studyId]);

  // Don't render if no key images
  if (keyImages.length === 0) {
    return null;
  }

  return (
    <div className={panelStyles.sectionDivider}>
      <button
        className={panelStyles.sectionHeader}
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span className={panelStyles.sectionHeaderIcon}>
          <IconStar size={12} />
        </span>
        <span>{t('pacs.report.keyImages')}</span>
        <span className={panelStyles.sectionBadge}>{keyImages.length}</span>
      </button>

      <Collapse in={expanded}>
        <div className={panelStyles.sectionContent}>
          {keyImages.map((ki) => (
            <div key={ki.id} className={panelStyles.keyImageRow}>
              <span className={panelStyles.keyImageId}>
                {ki.sopInstanceUid.slice(-8)}
              </span>
              <Tooltip label={ki.reason} position="top" withArrow multiline maw={200}>
                <span className={panelStyles.keyImageReason}>{ki.reason}</span>
              </Tooltip>
              <span className={panelStyles.keyImageAuthor}>{ki.authorName}</span>
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  );
}
