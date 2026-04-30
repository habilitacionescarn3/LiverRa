// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ViewportOverlay — Metadata HUD for PACS Viewport
// ============================================================================
// A transparent overlay that sits on top of a Cornerstone3D viewport and shows
// patient/study metadata in the four corners — like a heads-up display (HUD)
// in a video game or flight simulator.
//
// Layout:
//   TL = Patient name, study date
//   TR = Modality, series description
//   BL = Image index (e.g., "3 / 120"), Window/Level values
//   BR = Zoom level, rotation (if non-zero)
//
// Design decisions:
//   - White text with dark shadow for readability on any image background
//   - Monospace font for numeric values (W/L, zoom, image index) so they
//     don't "jump" as digits change
//   - pointer-events: none so clicks pass through to the viewport beneath
//   - No background color — fully transparent
// ============================================================================

import { memo } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import './ViewportOverlay.css';

// ============================================================================
// Props
// ============================================================================

export interface ViewportOverlayProps {
  /** Patient display name (TL corner) */
  patientName?: string;
  /** Study date in displayable format (TL corner) */
  studyDate?: string;
  /** Imaging modality, e.g. "CT", "MR" (TR corner) */
  modality?: string;
  /** Series description from DICOM metadata (TR corner) */
  seriesDescription?: string;
  /** Current image index within the series (1-based for display) */
  imageIndex?: number;
  /** Total images in the active series */
  totalImages?: number;
  /** Window width (contrast) value */
  windowWidth?: number;
  /** Window center (brightness) value */
  windowCenter?: number;
  /** Current zoom factor (1.0 = no zoom) */
  zoom?: number;
  /** Current rotation in degrees (only displayed when non-zero) */
  rotation?: number;
}

// ============================================================================
// Component
// ============================================================================

export const ViewportOverlay = memo(function ViewportOverlay({
  patientName,
  studyDate,
  modality,
  seriesDescription,
  imageIndex,
  totalImages,
  windowWidth,
  windowCenter,
  zoom,
  rotation,
}: ViewportOverlayProps) {
  const { t } = useTranslation();

  return (
    <div className="viewport-overlay" data-testid="viewport-overlay" aria-hidden="true">
      {/* ---- Top-Left: Patient name + study date ---- */}
      <div className="viewport-overlay-tl" data-testid="overlay-tl">
        {patientName && (
          <div className="viewport-overlay-text">{patientName}</div>
        )}
        {studyDate && (
          <div className="viewport-overlay-text">{studyDate}</div>
        )}
      </div>

      {/* ---- Top-Right: Modality + series description ---- */}
      <div className="viewport-overlay-tr" data-testid="overlay-tr">
        {modality && (
          <div className="viewport-overlay-text">{modality}</div>
        )}
        {seriesDescription && (
          <div className="viewport-overlay-text">{seriesDescription}</div>
        )}
      </div>

      {/* ---- Bottom-Left: Image index + W/L ---- */}
      <div className="viewport-overlay-bl" data-testid="overlay-bl">
        {imageIndex != null && totalImages != null && (
          <div className="viewport-overlay-mono">
            {imageIndex} / {totalImages}
          </div>
        )}
        {windowWidth != null && windowCenter != null && (
          <div className="viewport-overlay-mono">
            {t('pacs.overlay.window')}: {Math.round(windowWidth)}{' '}
            {t('pacs.overlay.level')}: {Math.round(windowCenter)}
          </div>
        )}
      </div>

      {/* ---- Bottom-Right: Zoom + rotation ---- */}
      <div className="viewport-overlay-br" data-testid="overlay-br">
        {zoom != null && (
          <div className="viewport-overlay-mono">
            {t('pacs.overlay.zoom')}: {zoom.toFixed(1)}x
          </div>
        )}
        {rotation != null && rotation !== 0 && (
          <div className="viewport-overlay-mono">
            {t('pacs.overlay.rotation')}: {rotation}°
          </div>
        )}
      </div>
    </div>
  );
});

export default ViewportOverlay;
