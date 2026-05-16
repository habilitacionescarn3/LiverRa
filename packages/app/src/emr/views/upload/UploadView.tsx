// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * UploadView — cloud-native DICOM intake page.
 *
 * Plain-English: this is the page hospital staff land on when they click
 * "New upload" from the Cases list. It mounts the DicomDropzone widget
 * which handles drag-and-drop of either a single DICOM file, a whole
 * folder of slices, or a ZIP archive — and uploads via the resumable tus
 * protocol to `POST/PATCH /api/v1/ingest/uploads`.
 *
 * Why this exists separately from `/pacs/studies`: the PACS Studies page
 * uploads via DICOMweb STOW-RS directly to an on-prem Orthanc server. On
 * the cloud staging deploy there's no Orthanc, so STOW-RS 404s. This
 * page hits the Fly.io FastAPI backend directly which handles ingest
 * via tus → Supabase Storage → cascade dispatch.
 *
 * After the upload finishes, useDropzoneUpload's onComplete navigates to
 * `/cases/{studyId}` where the analysis detail view lives.
 */

import { Box, Stack, Text } from '@mantine/core';
import { IconCloudUpload } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { DicomDropzone } from '../../components/upload/DicomDropzone';
import { EMRPageHeader } from '../../components/common';
import { useTranslation } from '../../contexts/TranslationContext';
import { LIVERRA_ROUTES } from '../../constants/routes';
import { getCurrentAccessToken } from '../../services/auth';

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export default function UploadView(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const ingestBaseUrl = useMemo(() => `${readApiBaseUrl()}/ingest`, []);
  // getCurrentAccessToken is sync. On staging the stub primes a placeholder
  // token; on production OIDC it returns the live Cognito JWT. The dropzone
  // pumps it into the Authorization: Bearer header for every chunk PATCH.
  const authToken = getCurrentAccessToken() ?? undefined;

  const handleComplete = useCallback(
    (studyId: string) => {
      navigate(`${LIVERRA_ROUTES.CASES_LIST}/${encodeURIComponent(studyId)}`);
    },
    [navigate],
  );

  return (
    <Stack gap="lg" style={{ padding: 'clamp(16px, 3vw, 24px)' }}>
      <EMRPageHeader
        icon={IconCloudUpload}
        title={t('upload:page.title', 'Upload DICOM study')}
        subtitle={t(
          'upload:page.subtitle',
          'Drag and drop a folder of DICOM slices, a single file, or a ZIP archive. Upload is resumable; you can close the tab and resume on the next visit.',
        )}
      />

      <Box style={{ maxWidth: 880 }}>
        <DicomDropzone
          onComplete={handleComplete}
          ingestBaseUrl={ingestBaseUrl}
          authToken={authToken}
          data-testid="cloud-upload-dropzone"
        />
      </Box>

      <Text
        size="xs"
        style={{ color: 'var(--emr-text-tertiary)', maxWidth: 720, lineHeight: 1.6 }}
      >
        {t(
          'upload:page.helper',
          'Supported: single .dcm files, folders of slices (drag the parent folder), or .zip archives up to 2 GB. The upload is automatically de-identified server-side before the cascade runs.',
        )}
      </Text>
    </Stack>
  );
}
