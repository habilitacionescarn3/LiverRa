// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// usePacsImageExport — viewport PNG export + tag-level anonymized DICOM export
// ============================================================================
// Behavior-preserving extraction from PACSViewer.tsx (audit finding
// EMR-PACS-IMAGING-AUDIT-009, D11 code-scale). These two handlers + the
// `isAnonymizing` busy flag are a self-contained "export" concern that closes
// over NO render-orchestration refs — only inputs (viewer state, study
// metadata, the translation fn). They were moved verbatim; the useCallback
// dependency arrays are unchanged, so identity/behavior is identical.
// PACSViewer.tsx consumes the returned callbacks directly.
//
// LiverRa adaptation: MediMind passed a MedplumClient solely to read the
// access token for the per-instance WADO fetches. LiverRa reads the live
// Cognito token via getCurrentAccessToken() instead, so the `medplum`
// parameter is gone.
//
// PACS-H2 invariants preserved exactly: burned-in-PHI modality block (CR/DX/US),
// the explicit pixel-PHI user confirm, per-instance fetch+anonymize+download
// over the full image-id list, and the audit-trail logStudyDownload calls.
// ============================================================================

import { useCallback, useState } from 'react';
import { notifications } from '@mantine/notifications';
import { getCurrentAccessToken } from '../../services/auth';
import { logStudyDownload } from '../../services/pacs/auditService';
import type { TranslationContextValue } from '../../contexts/TranslationContext';
import type { PACSViewerState, ImagingStudyListItem } from '../../types/pacs';
import type { ExtractedSeriesItem } from './usePACSViewer.dicom';

type TranslateFn = TranslationContextValue['t'];

export interface UsePacsImageExportParams {
  viewerContainerRef: React.RefObject<HTMLDivElement | null>;
  viewerState: PACSViewerState | null;
  studyInstanceUid: string;
  fhirStudyId: string;
  studyInfo?: ImagingStudyListItem;
  seriesItems: ExtractedSeriesItem[];
  t: TranslateFn;
}

export interface UsePacsImageExportReturn {
  handleExportImage: () => void;
  handleAnonymizeExport: () => Promise<void>;
  isAnonymizing: boolean;
}

export function usePacsImageExport({
  viewerContainerRef,
  viewerState,
  studyInstanceUid,
  fhirStudyId,
  studyInfo,
  seriesItems,
  t,
}: UsePacsImageExportParams): UsePacsImageExportReturn {
  const handleExportImage = useCallback(() => {
    try {
      const burnedInPhiModalities = new Set(['CR', 'DX', 'US', 'MG']);
      const modalityCode = (studyInfo?.modalities?.[0] || seriesItems?.[0]?.modality || '').toUpperCase();
      const warning = burnedInPhiModalities.has(modalityCode)
        ? t('pacs.viewer.exportImageBurnedInPhiWarning', { modality: modalityCode })
        : t('pacs.viewer.exportImagePhiWarning');
      const proceed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(warning)
        : false;
      if (!proceed) {
        return;
      }
      const container = viewerContainerRef.current;
      if (!container) {
        notifications.show({ title: t('pacs.viewer.exportImage'), message: t('pacs.viewer.exportImageFailed'), color: 'red' });
        return;
      }
      const activeViewportId = viewerState?.activeViewportId || 'viewport-0';
      const viewportHost = container.querySelector<HTMLElement>(`[data-viewport-id="${activeViewportId}"]`);
      const canvases = Array.from(viewportHost?.querySelectorAll<HTMLCanvasElement>('canvas') ?? [])
        .filter((layer) => {
          const style = window.getComputedStyle(layer);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
      const baseCanvas = canvases[0];
      if (!baseCanvas) {
        notifications.show({ title: t('pacs.viewer.exportImage'), message: t('pacs.viewer.exportImageFailed'), color: 'red' });
        return;
      }
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = baseCanvas.width;
      exportCanvas.height = baseCanvas.height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) {
        notifications.show({ title: t('pacs.viewer.exportImage'), message: t('pacs.viewer.exportImageFailed'), color: 'red' });
        return;
      }
      for (const layer of canvases) {
        ctx.drawImage(layer, 0, 0, exportCanvas.width, exportCanvas.height);
      }
      const dataUrl = exportCanvas.toDataURL('image/png');
      const link = document.createElement('a');
      const date = new Date().toISOString().slice(0, 10);
      const uidSuffix = studyInstanceUid.slice(-8);
      const filename = `study_${uidSuffix}_${date}.png`;
      link.download = filename;
      link.href = dataUrl;
      link.click();
      notifications.show({
        title: t('pacs.viewer.exportImage'),
        message: t('pacs.viewer.exportImageSuccess', { filename }),
        color: 'green',
      });
      // Log the download in the audit trail
      if (fhirStudyId || studyInfo?.patientId) {
        logStudyDownload({
          studyId: fhirStudyId || undefined,
          patientId: studyInfo?.patientId,
          description: `Confirmed identifiable PNG export for study ${studyInstanceUid} modality=${modalityCode || 'unknown'}`,
        });
      }
    } catch (err) {
      console.warn('Failed to export image:', err);
      notifications.show({ title: t('pacs.viewer.exportImage'), message: t('pacs.viewer.exportImageFailed'), color: 'red' });
    }
    // viewerContainerRef is a stable ref object — including it is behavior-identical
    // to the original (which omitted it as an in-component useRef) and satisfies
    // exhaustive-deps now that the ref is passed in as a hook parameter.
  }, [viewerContainerRef, viewerState?.activeViewportId, fhirStudyId, studyInfo?.patientId, studyInfo?.modalities, seriesItems, studyInstanceUid, t]);

  // Anonymize & download the current DICOM instance
  const [isAnonymizing, setIsAnonymizing] = useState(false);
  const handleAnonymizeExport = useCallback(async () => {
    try {
      setIsAnonymizing(true);
      // Get the current viewport's image IDs to fetch a DICOM instance
      const imageIds = viewerState?.imageIds ?? [];
      if (imageIds.length === 0) {
        notifications.show({ title: t('pacs.anonymize.button'), message: t('pacs.anonymize.noData'), color: 'yellow' });
        return;
      }

      const anonymizedExport = await import('../../services/pacs/dicomParserService');
      if (!anonymizedExport.isTagLevelAnonymizedExportEnabled()) {
        notifications.show({
          title: t('pacs.anonymize.button'),
          message: t('pacs.anonymize.disabledUntilServerDeid'),
          color: 'red',
          autoClose: 8000,
        });
        return;
      }

      // PACS-H2: refuse to export anonymized DICOM for modalities with known
      // burned-in pixel-level PHI risk (CR / DX / US) until a pixel-scrubber
      // is implemented. DICOM Supplement 142 Basic Profile only strips tags.
      const burnedInPhiModalities = new Set(['CR', 'DX', 'US']);
      const modalityCode = (studyInfo?.modalities?.[0] || seriesItems?.[0]?.modality || '').toUpperCase();
      if (burnedInPhiModalities.has(modalityCode)) {
        notifications.show({
          title: t('pacs.anonymize.button'),
          message: t('pacs.anonymize.burnedInPhiBlocked', { modality: modalityCode }),
          color: 'red',
          autoClose: 8000,
        });
        return;
      }

      // PACS-H2: explicit user warning that pixel-burned PHI is NOT removed.
      // Confirm before continuing — if the user declines, abort the export.
      const proceed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(t('pacs.anonymize.pixelPhiWarning'))
        : true;
      if (!proceed) {
        return;
      }

      // PACS-H2: iterate the full image-id list rather than only the first
      // frame/series. Each instance-URL is fetched, anonymized, and downloaded
      // individually (zip bundling deferred — JSZip not yet a dep).
      const seenInstanceUrls = new Set<string>();
      const { downloadAnonymizedDicom } = anonymizedExport;
      const accessToken = getCurrentAccessToken();
      let exported = 0;
      let failed = 0;

      for (const id of imageIds) {
        const rawUrl = id.startsWith('wadors:') ? id.slice('wadors:'.length) : id;
        const instanceUrl = rawUrl.replace(/\/frames\/\d+$/, '');
        if (seenInstanceUrls.has(instanceUrl)) continue;
        seenInstanceUrls.add(instanceUrl);
        try {
          const response = await fetch(instanceUrl, {
            headers: { Accept: 'application/dicom', Authorization: `Bearer ${accessToken}` },
          });
          if (!response.ok) {
            failed++;
            continue;
          }
          const arrayBuffer = await response.arrayBuffer();
          downloadAnonymizedDicom(studyInstanceUid, arrayBuffer);
          exported++;
        } catch (err) {
          console.warn('[PACSViewer] anonymized DICOM instance export failed:', err);
          failed++;
        }
      }

      if (fhirStudyId || studyInfo?.patientId) {
        logStudyDownload({
          studyId: fhirStudyId || undefined,
          patientId: studyInfo?.patientId,
          description: `Anonymized DICOM export: exported=${exported} failed=${failed} modality=${modalityCode || 'unknown'}`,
        });
      }

      if (exported === 0) {
        throw new Error(t('pacs.anonymize.allFailed'));
      }
    } catch (err) {
      console.warn('[PACSViewer] anonymize failed:', err instanceof Error ? err.message : String(err));
      notifications.show({
        title: t('pacs.anonymize.button'),
        message: t('pacs.viewer.anonymizeFailed'),
        color: 'red',
      });
    } finally {
      setIsAnonymizing(false);
    }
  }, [fhirStudyId, studyInfo?.patientId, studyInstanceUid, viewerState?.imageIds, t, studyInfo?.modalities, seriesItems]);

  return { handleExportImage, handleAnonymizeExport, isAnonymizing };
}
