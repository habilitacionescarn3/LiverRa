// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// ComparisonView (LiverRa)
// ============================================================================
// Side-by-side study comparison. Current study on the left, a prior on the
// right. Uses Cornerstone3D synchronizers for scroll + VOI (window/level)
// linking, and the LiverRa DICOMweb client to fetch image ids.
//
// Ported from MediMind. Adaptations:
//   - `useMedplum()` dropped (auth is threaded through the DICOMweb client
//     via `useDicomWebClient`, which already knows how to get a token).
//   - `DicomWebClient.searchSeries / searchInstances / getInstanceUrl` →
//     LiverRa's `qidoSeries / qidoInstances / wadoInstance`.
//   - The engine id is rebranded from `medimind-pacs-engine` →
//     `liverra-pacs-engine` to match `services/pacs/cornerstoneInit.ts`.
// ============================================================================

import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from 'react';
import {
  Group,
  Text,
  ActionIcon,
  Tooltip,
  Select,
  Switch,
  Stack,
  Loader,
} from '@mantine/core';
import { IconArrowLeft, IconLink, IconLinkOff } from '@tabler/icons-react';
import { Enums as csEnums, type Types as csTypes } from '@cornerstonejs/core';
import {
  synchronizers as csSynchronizers,
  SynchronizerManager,
  Synchronizer,
} from '@cornerstonejs/tools';
import { useTranslation } from '../../contexts/TranslationContext';
import { toLocaleDateForPacs } from '../../services/pacs/dateFormatHelpers';
import type { Locale } from '../../services/localeService';
import type { ImagingStudyListItem } from '../../types/pacs';
import {
  initCornerstone,
  getOrCreateRenderingEngine,
  getOrCreateToolGroup,
  activateToolOnGroup,
  RENDERING_ENGINE_ID,
} from '../../services/pacs/cornerstoneInit';
import { useDicomWebClient } from '../../hooks/useDicomWebClient';
import type { DicomWebClientHandle } from '../../services/pacs/dicomwebClient';
import './ComparisonView.css';

// ============================================================================
// Props
// ============================================================================

export interface ComparisonViewProps {
  /** Primary study. */
  currentStudy: ImagingStudyListItem;
  /** Prior study for comparison (auto-selected or user-picked). */
  comparisonStudy?: ImagingStudyListItem;
  /** All patient studies (for the picker dropdown). */
  availableStudies: ImagingStudyListItem[];
  /** Called when the user clicks "back" to single-study mode. */
  onBack: () => void;
  /** Called when the user picks a different prior study. */
  onComparisonChange?: (study: ImagingStudyListItem) => void;
}

// ============================================================================
// Constants (Cornerstone synchronizer ids + viewport ids)
// ============================================================================

/**
 * LiverRa's rendering-engine id (see `services/pacs/cornerstoneInit.ts`).
 * Must match or synchronizers won't find the viewports.
 */
// RENDERING_ENGINE_ID now imported from cornerstoneInit (R2: a local
// literal silently desyncs if the canonical id ever changes).

const SERIES_INSTANCE_UID_TAG = '0020000E';
const SOP_INSTANCE_UID_TAG = '00080018';

const VIEWPORT_CURRENT = 'comparison-current';
const VIEWPORT_PRIOR = 'comparison-prior';

const SCROLL_SYNC_ID = 'comparison-scroll-sync';
const VOI_SYNC_ID = 'comparison-voi-sync';

// ============================================================================
// Helpers
// ============================================================================

function formatStudyDate(dateStr: string | undefined, locale: Locale): string {
  return toLocaleDateForPacs(dateStr, locale);
}

/**
 * Extract a tag value from a QIDO-RS JSON object:
 * `{ "0020000E": { "vr": "UI", "Value": ["1.2.3"] } }`.
 */
function getDicomTagValue(
  obj: Record<string, unknown>,
  tag: string
): string | undefined {
  const entry = obj[tag] as { Value?: Array<unknown> } | undefined;
  if (entry?.Value?.[0] != null) {
    return String(entry.Value[0]);
  }
  return undefined;
}

/**
 * Fetch every wadors: image id for a given Orthanc study id through QIDO-RS.
 * Returns an array of wadors: URLs Cornerstone3D can load.
 */
async function fetchStudyImageIds(
  client: DicomWebClientHandle,
  studyUid: string
): Promise<string[]> {
  const seriesList = await client.qidoSeries(studyUid);

  // Parallel fetch across series (avoids N+1 requests).
  const nestedImageIds = await Promise.all(
    seriesList.map(async (seriesObj) => {
      const seriesUid = getDicomTagValue(
        seriesObj as Record<string, unknown>,
        SERIES_INSTANCE_UID_TAG
      );
      if (!seriesUid) return [];

      const instances = await client.qidoInstances(studyUid, seriesUid);
      const ids: string[] = [];
      for (const inst of instances) {
        const sopUid = getDicomTagValue(
          inst as Record<string, unknown>,
          SOP_INSTANCE_UID_TAG
        );
        if (sopUid) {
          ids.push(client.wadoInstance(studyUid, seriesUid, sopUid));
        }
      }
      return ids;
    })
  );

  return nestedImageIds.flat();
}

// ============================================================================
// Component
// ============================================================================

export function ComparisonView({
  currentStudy,
  comparisonStudy,
  availableStudies,
  onBack,
  onComparisonChange,
}: ComparisonViewProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const client = useDicomWebClient();

  const [isLoading, setIsLoading] = useState(true);

  const [syncScroll, setSyncScroll] = useState(true);
  const [syncWL, setSyncWL] = useState(false);

  const scrollSyncRef = useRef<InstanceType<typeof Synchronizer> | null>(null);
  const voiSyncRef = useRef<InstanceType<typeof Synchronizer> | null>(null);

  const viewportInfoCurrent = useMemo(
    () => ({
      renderingEngineId: RENDERING_ENGINE_ID,
      viewportId: VIEWPORT_CURRENT,
    }),
    []
  );
  const viewportInfoPrior = useMemo(
    () => ({
      renderingEngineId: RENDERING_ENGINE_ID,
      viewportId: VIEWPORT_PRIOR,
    }),
    []
  );

  // ------------------------------------------------------------------
  // Scroll synchronization
  // ------------------------------------------------------------------
  useEffect(() => {
    if (syncScroll && comparisonStudy) {
      try {
        if (scrollSyncRef.current) {
          scrollSyncRef.current.destroy();
        }
        const sync = csSynchronizers.createImageSliceSynchronizer(SCROLL_SYNC_ID);
        sync.add(viewportInfoCurrent);
        sync.add(viewportInfoPrior);
        scrollSyncRef.current = sync;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ComparisonView] Scroll sync setup failed:', err);
      }
    } else if (scrollSyncRef.current) {
      try {
        scrollSyncRef.current.destroy();
      } catch {
        // Already destroyed.
      }
      scrollSyncRef.current = null;
    }

    return () => {
      if (scrollSyncRef.current) {
        try {
          scrollSyncRef.current.destroy();
        } catch {
          // Best-effort cleanup.
        }
        scrollSyncRef.current = null;
      }
    };
  }, [syncScroll, comparisonStudy, viewportInfoCurrent, viewportInfoPrior]);

  // ------------------------------------------------------------------
  // VOI (W/L) synchronization
  // ------------------------------------------------------------------
  useEffect(() => {
    if (syncWL && comparisonStudy) {
      try {
        if (voiSyncRef.current) {
          voiSyncRef.current.destroy();
        }
        const sync = csSynchronizers.createVOISynchronizer(VOI_SYNC_ID, {
          syncInvertState: true,
          syncColormap: false,
        });
        sync.add(viewportInfoCurrent);
        sync.add(viewportInfoPrior);
        voiSyncRef.current = sync;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ComparisonView] VOI sync setup failed:', err);
      }
    } else if (voiSyncRef.current) {
      try {
        voiSyncRef.current.destroy();
      } catch {
        // Already destroyed.
      }
      voiSyncRef.current = null;
    }

    return () => {
      if (voiSyncRef.current) {
        try {
          voiSyncRef.current.destroy();
        } catch {
          // Best-effort cleanup.
        }
        voiSyncRef.current = null;
      }
    };
  }, [syncWL, comparisonStudy, viewportInfoCurrent, viewportInfoPrior]);

  // ------------------------------------------------------------------
  // Master cleanup on unmount
  // ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      try {
        SynchronizerManager.destroySynchronizer(SCROLL_SYNC_ID);
      } catch {
        // Already destroyed.
      }
      try {
        SynchronizerManager.destroySynchronizer(VOI_SYNC_ID);
      } catch {
        // Already destroyed.
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Viewport init + image load
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!currentStudy.orthancStudyId) return;

    let cancelled = false;
    setIsLoading(true);

    const setupViewports = async (): Promise<void> => {
      try {
        await initCornerstone();
        const renderingEngine = getOrCreateRenderingEngine();

        const currentEl = document.getElementById('cs3d-comparison-current');
        if (!currentEl || cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const viewportInputs: any[] = [
          {
            viewportId: VIEWPORT_CURRENT,
            type: csEnums.ViewportType.STACK,
            element: currentEl,
          },
        ];

        const priorEl = document.getElementById('cs3d-comparison-prior');
        if (priorEl && comparisonStudy?.orthancStudyId) {
          viewportInputs.push({
            viewportId: VIEWPORT_PRIOR,
            type: csEnums.ViewportType.STACK,
            element: priorEl,
          });
        }

        renderingEngine.setViewports(viewportInputs);

        const toolGroup = getOrCreateToolGroup();
        for (const vpInput of viewportInputs) {
          try {
            toolGroup.addViewport(vpInput.viewportId, renderingEngine.id);
          } catch {
            // Viewport already in the group — ignore.
          }
        }
        activateToolOnGroup('WindowLevel');

        if (cancelled) return;

        const currentImageIds = await fetchStudyImageIds(
          client,
          currentStudy.orthancStudyId
        );
        if (cancelled) return;

        if (currentImageIds.length > 0) {
          const viewport = renderingEngine.getViewport(VIEWPORT_CURRENT);
          if (viewport && 'setStack' in viewport) {
            // L-DEP-1 fix: narrow to ``IStackViewport`` (which exposes
            // ``setStack``) rather than the prior ``as any`` escape.
            await (viewport as csTypes.IStackViewport).setStack(currentImageIds);
            viewport.resetCamera();
            viewport.render();
          }
        }

        if (comparisonStudy?.orthancStudyId && priorEl) {
          const priorImageIds = await fetchStudyImageIds(
            client,
            comparisonStudy.orthancStudyId
          );
          if (cancelled) return;

          if (priorImageIds.length > 0) {
            const viewport = renderingEngine.getViewport(VIEWPORT_PRIOR);
            if (viewport && 'setStack' in viewport) {
              // L-DEP-1 fix: narrow to ``IStackViewport``.
              await (viewport as csTypes.IStackViewport).setStack(priorImageIds);
              viewport.resetCamera();
              viewport.render();
            }
          }
        }
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.warn('[ComparisonView] Viewport init failed:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    const timer = setTimeout(setupViewports, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);

      try {
        const renderingEngine = getOrCreateRenderingEngine();
        const toolGroup = getOrCreateToolGroup();
        for (const vpId of [VIEWPORT_CURRENT, VIEWPORT_PRIOR]) {
          try {
            toolGroup.removeViewports(renderingEngine.id, vpId);
          } catch {
            // Not registered — ignore.
          }
          try {
            renderingEngine.disableElement(vpId);
          } catch {
            // Not registered — ignore.
          }
        }
      } catch {
        // Engine torn down already.
      }
    };
  }, [currentStudy.orthancStudyId, comparisonStudy?.orthancStudyId, client]);

  // Dropdown options — every patient study except the current one.
  const studyOptions = useMemo(() => {
    return availableStudies
      .filter((s) => s.id !== currentStudy.id && !!s.orthancStudyId)
      .map((s) => ({
        value: s.id,
        label: `${formatStudyDate(s.date, locale)} — ${s.modalities.join(', ') || '?'} ${
          s.description || ''
        }`.trim(),
      }));
  }, [availableStudies, currentStudy.id]);

  const handleStudyPickerChange = useCallback(
    (value: string | null) => {
      if (!value || !onComparisonChange) return;
      const selected = availableStudies.find((s) => s.id === value);
      if (selected) {
        onComparisonChange(selected);
      }
    },
    [availableStudies, onComparisonChange]
  );

  return (
    <div className="comparison-view" data-testid="comparison-view">
      {/* ---- Top toolbar ---- */}
      <div className="comparison-toolbar" data-testid="comparison-toolbar">
        <Group gap="sm" wrap="wrap" align="center">
          <Tooltip
            label={t('pacs.comparison.backToSingle')}
            position="bottom"
            withArrow
          >
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={onBack}
              aria-label={t('pacs.comparison.backToSingle')}
              data-testid="comparison-back-button"
              style={{ color: 'var(--emr-text-inverse)' }}
            >
              <IconArrowLeft size={20} />
            </ActionIcon>
          </Tooltip>

          <Text
            size="sm"
            fw={600}
            style={{
              color: 'var(--emr-text-inverse)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('pacs.comparison.title')}
          </Text>

          <Select
            data={studyOptions}
            value={comparisonStudy?.id ?? null}
            onChange={handleStudyPickerChange}
            placeholder={t('pacs.comparison.selectPrior')}
            size="xs"
            clearable={false}
            searchable
            data-testid="comparison-study-selector"
            style={{ minWidth: 220, maxWidth: 360 }}
            styles={{
              input: {
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderColor: 'rgba(255,255,255,0.2)',
                color: 'var(--emr-text-inverse)',
                fontSize: 'var(--emr-font-xs)',
              },
              dropdown: {
                backgroundColor: 'var(--emr-viewer-bg)',
                borderColor: 'rgba(255,255,255,0.2)',
              },
              option: {
                fontSize: 'var(--emr-font-xs)',
              },
            }}
          />
        </Group>

        <Group gap="md" wrap="wrap" align="center">
          <Group gap={6} wrap="nowrap">
            <Tooltip
              label={
                syncScroll
                  ? t('pacs.comparison.syncScrollOn')
                  : t('pacs.comparison.syncScrollOff')
              }
              position="bottom"
              withArrow
            >
              <ActionIcon
                variant={syncScroll ? 'filled' : 'subtle'}
                size="sm"
                onClick={() => setSyncScroll((v) => !v)}
                aria-label={t('pacs.comparison.syncScroll')}
                data-testid="sync-scroll-toggle"
                style={{
                  background: syncScroll ? 'var(--emr-accent)' : 'transparent',
                  color: 'var(--emr-text-inverse)',
                }}
              >
                {syncScroll ? <IconLink size={16} /> : <IconLinkOff size={16} />}
              </ActionIcon>
            </Tooltip>
            <Text
              size="xs"
              style={{
                color: 'var(--emr-text-inverse)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('pacs.comparison.syncScroll')}
            </Text>
          </Group>

          <Switch
            label={t('pacs.comparison.syncWL')}
            checked={syncWL}
            onChange={(e) => setSyncWL(e.currentTarget.checked)}
            size="xs"
            data-testid="sync-wl-toggle"
            styles={{
              label: {
                color: 'var(--emr-text-inverse)',
                fontSize: 'var(--emr-font-xs)',
              },
            }}
          />
        </Group>
      </div>

      {/* ---- Viewport grid ---- */}
      <div
        className="comparison-grid"
        data-testid="comparison-grid"
        style={{ position: 'relative' }}
      >
        {isLoading && (
          <div
            data-testid="comparison-loading"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              background: 'rgba(0, 0, 0, 0.5)',
            }}
          >
            <Loader color="var(--emr-accent)" size="lg" />
          </div>
        )}

        <div
          className="comparison-viewport"
          data-testid="comparison-viewport-current"
        >
          <div
            className="comparison-viewport-label"
            data-testid="viewport-label-current"
          >
            <Text
              size="xs"
              fw={600}
              style={{ color: 'var(--emr-text-inverse)' }}
            >
              {t('pacs.comparison.current')}
            </Text>
            <Text size="xs" style={{ color: 'var(--emr-text-secondary)' }}>
              {formatStudyDate(currentStudy.date, locale)}
              {currentStudy.description ? ` — ${currentStudy.description}` : ''}
            </Text>
          </div>
          <div
            id="cs3d-comparison-current"
            className="comparison-viewport-canvas"
            data-viewport-id="comparison-current"
            data-study-id={currentStudy.orthancStudyId}
            data-sync-scroll={syncScroll ? 'true' : 'false'}
            data-sync-wl={syncWL ? 'true' : 'false'}
          />
        </div>

        <div
          className="comparison-viewport"
          data-testid="comparison-viewport-prior"
        >
          <div
            className="comparison-viewport-label"
            data-testid="viewport-label-prior"
          >
            <Text
              size="xs"
              fw={600}
              style={{ color: 'var(--emr-text-inverse)' }}
            >
              {t('pacs.comparison.prior')}
            </Text>
            {comparisonStudy ? (
              <Text size="xs" style={{ color: 'var(--emr-text-secondary)' }}>
                {formatStudyDate(comparisonStudy.date, locale)}
                {comparisonStudy.description
                  ? ` — ${comparisonStudy.description}`
                  : ''}
              </Text>
            ) : (
              <Text size="xs" style={{ color: 'var(--emr-text-secondary)' }}>
                {t('pacs.comparison.noPriorSelected')}
              </Text>
            )}
          </div>

          {comparisonStudy ? (
            <div
              id="cs3d-comparison-prior"
              className="comparison-viewport-canvas"
              data-viewport-id="comparison-prior"
              data-study-id={comparisonStudy.orthancStudyId}
              data-sync-scroll={syncScroll ? 'true' : 'false'}
              data-sync-wl={syncWL ? 'true' : 'false'}
            />
          ) : (
            <div
              className="comparison-viewport-empty"
              data-testid="comparison-empty-prior"
            >
              <Stack align="center" gap="xs">
                <Text size="sm" style={{ color: 'var(--emr-text-secondary)' }}>
                  {t('pacs.comparison.selectPriorPrompt')}
                </Text>
              </Stack>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ComparisonView;
