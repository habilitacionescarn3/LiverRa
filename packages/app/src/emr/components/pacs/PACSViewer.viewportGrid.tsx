// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { ImagingStudyListItem, RenderingMode, ViewportLayout, ViewportState } from '../../types/pacs';
import type { UseCalibrationReturn } from '../../hooks/pacs/useCalibration';
import type { UseCinePlaybackReturn } from '../../hooks/pacs/useCinePlayback';
import type { UseQCAReturn } from '../../hooks/pacs/useQCA';
import { cancelArrowAnnotateText, submitArrowAnnotateText } from '../../services/pacs/cornerstoneInit';
import { ArrowAnnotateTextInput } from './ArrowAnnotateTextInput';
import { CalibrationOverlay } from './CalibrationOverlay';
import { CineControls } from './CineControls';
import { ColorBar } from './ColorBar';
import { PACSErrorBoundary } from './PACSErrorBoundary';
import { QCAOverlay } from './QCAOverlay';
import { ViewportOverlay } from './ViewportOverlay';
import { ViewportStateOverlay } from './ViewportStateOverlay';
import { FLEX_COLUMN_STYLE, FLEX_ROW_MIN_HEIGHT_STYLE } from './PACSViewer.helpers';

// LiverRa adaptation: the target useTranslation().t takes (key, params?) — no
// string-fallback second arg — so the prop type mirrors that exact signature.
type Translate = (key: string, params?: Record<string, unknown>) => string;

type Vr3DBuildStatus = 'idle' | 'building' | 'ready' | 'error';

/**
 * Build the VR projection label (BL corner of the VR HUD) from the current
 * rendering mode + slab thickness. Mirrors the toolbar's "{n}mm" formatting.
 * 'default' has no slab → "Default".
 *
 * @param t - Translation function.
 * @param renderingMode - Active projection mode (default | mip | minip).
 * @param slabThickness - Slab thickness in mm (only meaningful for mip/minip).
 * @returns A display string like "MIP 8mm" / "MinIP 8mm" / "Default".
 */
function buildProjectionLabel(
  t: Translate,
  renderingMode?: RenderingMode,
  slabThickness?: number,
): string | undefined {
  if (!renderingMode || renderingMode === 'default') {
    return t('pacs.mip.default');
  }
  const name = renderingMode === 'mip' ? t('pacs.mip.title') : t('pacs.minip.title');
  return slabThickness !== null && slabThickness !== undefined ? `${name} ${slabThickness}mm` : name;
}

interface PACSViewportGridProps {
  t: Translate;
  layout: ViewportLayout;
  viewports?: Map<string, ViewportState>;
  activeViewportId?: string;
  onViewportClick: (viewportId: string) => void;
  cine: UseCinePlaybackReturn;
  studyInfo?: ImagingStudyListItem;
  formattedStudyDate?: string;
  activeSeriesDescription?: string;
  studyModality?: string;
  calibrationHook: UseCalibrationReturn;
  calibrationPixelLength: number | null;
  isStenosisActive: boolean;
  stenosisSubMode: 'manual' | 'qca';
  qca: UseQCAReturn;
  showColorBar: boolean;
  showArrowTextInput: boolean;
  onArrowTextClose: () => void;
  onExportCineVideo: () => void;
  /** Per-viewport 3D (VR) build status — drives the building/error/empty overlay. */
  volume3dBuildStatus?: Map<string, Vr3DBuildStatus>;
  /** Re-trigger the VR build for a given viewport (error-overlay retry). */
  onRetryVolume3d?: (vpId: string) => void;
  /** Current projection mode (default | mip | minip) for the VR HUD label. */
  renderingMode?: RenderingMode;
  /** Slab thickness in mm for MIP/MinIP — used in the VR HUD projection label. */
  slabThickness?: number;
}

export function PACSViewportGrid({
  t,
  layout,
  viewports,
  activeViewportId,
  onViewportClick,
  cine,
  studyInfo,
  formattedStudyDate,
  activeSeriesDescription,
  studyModality,
  calibrationHook,
  calibrationPixelLength,
  isStenosisActive,
  stenosisSubMode,
  qca,
  showColorBar,
  showArrowTextInput,
  onArrowTextClose,
  onExportCineVideo,
  volume3dBuildStatus,
  onRetryVolume3d,
  renderingMode,
  slabThickness,
}: PACSViewportGridProps): JSX.Element {
  const activeViewport = activeViewportId ? viewports?.get(activeViewportId) : undefined;

  return (
    <div style={FLEX_COLUMN_STYLE}>
      <div style={FLEX_ROW_MIN_HEIGHT_STYLE}>
        <div className="pacs-viewport-grid" data-layout={layout}>
          {viewports &&
            Array.from(viewports.entries()).map(([vpId, vpState]) => {
              const isVr = vpState.type === 'volume3d';
              // VR panes default to 'building' (a freshly-mounted VR pane has no map entry
              // yet → show a spinner, not an unexplained black canvas). Non-VR panes show
              // the overlay ONLY when a status was explicitly set (e.g. 'error' from a
              // failed build) — no entry = no overlay during a normal load.
              const paneStatus = isVr
                ? volume3dBuildStatus?.get(vpId) ?? 'building'
                : volume3dBuildStatus?.get(vpId);
              const qcaContainer = typeof document !== 'undefined'
                ? document.getElementById(`cs3d-${vpId}`)
                : null;
              const qcaBounds = qcaContainer?.getBoundingClientRect();
              const qcaContainerWidth = qcaBounds?.width || qcaContainer?.clientWidth || 0;
              const qcaContainerHeight = qcaBounds?.height || qcaContainer?.clientHeight || 0;
              const isQcaViewport = qca.viewportElementId === `cs3d-${vpId}`;
              return (
              <div
                key={vpId}
                className="pacs-viewport-cell"
                data-active={vpId === activeViewportId ? 'true' : 'false'}
                data-cine-active={cine.isMultiFrame ? 'true' : undefined}
                onClick={() => onViewportClick(vpId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    onViewportClick(vpId);
                  }
                }}
                aria-label={`${t('pacs.viewport')} ${vpId}`}
              >
                {/* Cornerstone3D will render into this div */}
                <div
                  className="pacs-viewport-canvas"
                  id={`cs3d-${vpId}`}
                  data-viewport-id={vpId}
                />

                <PACSErrorBoundary t={t}>
                  <ViewportOverlay
                    variant={isVr ? 'vr' : 'image'}
                    presetName={isVr ? vpState.volume3DPreset : undefined}
                    projectionLabel={isVr ? buildProjectionLabel(t, renderingMode, slabThickness) : undefined}
                    patientName={studyInfo?.patientName}
                    studyDate={formattedStudyDate}
                    modality={studyInfo?.modalities?.join(', ')}
                    seriesDescription={activeSeriesDescription}
                    imageIndex={
                      cine.isMultiFrame
                        ? (cine.isPlaying ? cine.currentFrame : vpState.imageIndex) + 1
                        : undefined
                    }
                    totalImages={cine.isMultiFrame ? cine.totalFrames : undefined}
                    windowWidth={vpState.windowLevel.width}
                    windowCenter={vpState.windowLevel.center}
                    zoom={vpState.zoom}
                    rotation={vpState.rotation}
                  />
                </PACSErrorBoundary>

                {/* Per-pane lifecycle overlay — building / error+retry over the black canvas.
                    Shown for ANY pane with a status: VR builds always; MPR/stack/axial only
                    on a failed build → a clean Retry instead of a garbled/blank square. */}
                {paneStatus && (
                  <PACSErrorBoundary t={t}>
                    <ViewportStateOverlay
                      status={paneStatus}
                      variant={isVr ? 'vr' : 'image'}
                      onRetry={() => onRetryVolume3d?.(vpId)}
                    />
                  </PACSErrorBoundary>
                )}

                {studyModality?.toUpperCase() === 'XA' && (
                  <CalibrationOverlay
                    isCalibrating={calibrationHook.isCalibrating}
                    calibration={calibrationHook.calibration}
                    onComplete={calibrationHook.completeCalibration}
                    onCancel={() => calibrationHook.clearCalibration()}
                    onClear={() => calibrationHook.clearCalibration()}
                    pixelLength={calibrationPixelLength}
                  />
                )}

                {isStenosisActive && stenosisSubMode === 'qca' && qca.mode !== 'idle' && isQcaViewport && (
                  <QCAOverlay
                    mode={qca.mode}
                    startPoint={qca.startPoint}
                    endPoint={qca.endPoint}
                    canvasCoords={qca.canvasCoords}
                    containerWidth={qcaContainerWidth}
                    containerHeight={qcaContainerHeight}
                  />
                )}

                <CineControls
                  isMultiFrame={cine.isMultiFrame}
                  isPlaying={cine.isPlaying}
                  currentFrame={cine.currentFrame}
                  totalFrames={cine.totalFrames}
                  fps={cine.fps}
                  playbackMode={cine.playbackMode}
                  speedMultiplier={cine.speedMultiplier}
                  nativeFrameRate={cine.nativeFrameRate}
                  onTogglePlay={cine.togglePlayPause}
                  onStepForward={cine.stepForward}
                  onStepBackward={cine.stepBackward}
                  onSeek={cine.seekToFrame}
                  onFpsChange={cine.setFps}
                  onPlaybackModeChange={cine.setPlaybackMode}
                  onSpeedMultiplierChange={cine.setSpeedMultiplier}
                  isWebCodecsSupported={cine.isWebCodecsSupported}
                  isExporting={cine.isExporting}
                  exportProgress={cine.exportProgress}
                  onExportVideo={onExportCineVideo}
                />
              </div>
              );
            })}
        </div>

        {showColorBar && activeViewport && (
          <ColorBar
            windowCenter={activeViewport.windowLevel.center}
            windowWidth={activeViewport.windowLevel.width}
          />
        )}
      </div>

      <ArrowAnnotateTextInput
        opened={showArrowTextInput}
        onSubmit={(text) => {
          submitArrowAnnotateText(text);
          onArrowTextClose();
        }}
        onCancel={() => {
          cancelArrowAnnotateText();
          onArrowTextClose();
        }}
      />
    </div>
  );
}
