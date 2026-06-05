// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * PacsStudyViewerView.
 *
 * Plain-English: opens an Orthanc-hosted DICOM study in the full advanced
 * PACS viewer (MPR layouts with crosshairs, 3D volume rendering, the
 * complete measurement/annotation toolbar, cine, hanging protocols).
 *
 * History: until the 2026-06 advanced-viewer port this view embedded its
 * own single-stack Cornerstone3D viewer (~575 lines: series walk, metadata
 * pre-registration, one stack viewport). That implementation lives in git
 * history (`git log -- packages/app/src/emr/views/pacs/PacsStudyViewerView.tsx`).
 * It is now a thin route wrapper around <PACSViewer> — the ported MediMind
 * orchestrator — which manages Cornerstone init, engine refcounting
 * (H-PACS-1 via usePACSViewer), DICOM auth incl. the B-PACS-3 PROD
 * fail-loud token guard, series selection, and layout internally.
 *
 * Route contract (pinned by useStowUpload.test): /pacs/studies/:studyInstanceUid
 */

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Box } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import { EMRAlert } from '../../components/common';
import { PACSErrorBoundary } from '../../components/pacs/PACSErrorBoundary';
import { PACSViewer } from '../../components/pacs/PACSViewer';
import { useTranslation } from '../../contexts/TranslationContext';

/**
 * Full-height flex column so `.pacs-viewer` (flex: 1) fills the route
 * outlet. The viewer chrome owns its own dark reading-room background.
 */
const SHELL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

export default function PacsStudyViewerView(): JSX.Element {
  const { studyInstanceUid } = useParams<{ studyInstanceUid: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Document title — surfaces a recognisable string in the browser tab strip.
  useEffect(() => {
    const base = t('pacs.header.title') ?? 'PACS viewer';
    const short = studyInstanceUid ? studyInstanceUid.slice(-12) : '';
    document.title = short ? `${base} · ${short} · LiverRa` : `${base} · LiverRa`;
  }, [t, studyInstanceUid]);

  if (!studyInstanceUid) {
    return (
      <Box p="md">
        <EMRAlert
          variant="error"
          icon={IconAlertTriangle}
          title={t('pacs.viewer.loadError')}
        >
          {t('pacs.viewer.noStudySelected')}
        </EMRAlert>
      </Box>
    );
  }

  return (
    <Box style={SHELL_STYLE}>
      <PACSErrorBoundary t={t}>
        <PACSViewer
          studyInstanceUid={studyInstanceUid}
          onClose={() => navigate('/pacs/studies')}
        />
      </PACSErrorBoundary>
    </Box>
  );
}
