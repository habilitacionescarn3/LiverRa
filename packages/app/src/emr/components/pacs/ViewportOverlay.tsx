// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ViewportOverlay — Metadata HUD for PACS Viewport
// ============================================================================
// A transparent overlay that sits on top of a Cornerstone3D viewport and shows
// patient/study metadata in the four corners — like a heads-up display (HUD)
// in a video game or flight simulator.
//
// PHI safety (H-PACS-3): by default the PatientName field renders as
// initials only (e.g., "Müller, Hans" → "M. H."). A "Reveal" gesture
// emits a break-glass AuditEvent and shows the full name for the
// remainder of the session. This means screen-shares, screenshots,
// and over-the-shoulder readouts never expose pre-anonymized identity
// without an explicit, audit-logged action.
//
// Layout:
//   TL = Patient name (initials by default), study date
//   TR = Modality, series description
//   BL = Image index (e.g., "3 / 120"), Window/Level values
//   BR = Zoom level, rotation (if non-zero)
//
// Design decisions:
//   - White text with dark shadow for readability on any image background
//   - Monospace font for numeric values (W/L, zoom, image index) so they
//     don't "jump" as digits change
//   - pointer-events: none everywhere EXCEPT the Reveal button so clicks
//     pass through to the viewport for tools
//   - No background color — fully transparent
// ============================================================================

import { memo, useState, useCallback } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import { logBreakGlass } from '../../services/pacs/auditService';
import './ViewportOverlay.css';

/**
 * Compress a DICOM Person Name (Family^Given^...) or display form ("Müller,
 * Hans") to initials with periods. Examples:
 *   "Müller, Hans"           → "M. H."
 *   "Smith^John^Q"           → "S. J. Q."
 *   "Mononym"                → "M."
 *   ""                       → ""
 *
 * Kept pure / synchronous so the overlay re-renders are cheap.
 */
function toInitials(name: string): string {
  if (!name) return '';
  // Normalize DICOM PN separator ^ to a comma so we can split uniformly.
  const tokens = name
    .replace(/\^/g, ', ')
    .split(/[\s,]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `${t[0].toUpperCase()}.`).join(' ');
}

// ============================================================================
// Props
// ============================================================================

export interface ViewportOverlayProps {
  /** Patient display name (TL corner) — rendered initials-only by default. */
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
  /**
   * Optional study ID. When present, clicking "Reveal" emits a break-
   * glass AuditEvent referencing this study so the access is durable.
   * Omit to disable the Reveal action entirely (initials remain forever).
   */
  studyId?: string;
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
  studyId,
}: ViewportOverlayProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);

  const canReveal = Boolean(patientName) && Boolean(studyId);
  const displayedName = patientName
    ? revealed
      ? patientName
      : toInitials(patientName)
    : '';

  const handleReveal = useCallback(() => {
    if (!studyId || !patientName) return;
    // Prompt for a break-glass reason. We deliberately use the native
    // browser prompt (a) so the gesture is impossible to fake by
    // accidental click and (b) because Mantine modals from a third-party
    // overlay would steal focus from the underlying Cornerstone canvas.
    const reason = window.prompt(
      t('pacs.overlay.breakGlassPrompt') ??
        'Reveal patient name. Enter break-glass reason (required):',
    );
    if (!reason || reason.trim().length < 3) {
      return;
    }
    logBreakGlass({
      studyId,
      description: `pacs_viewer_reveal: ${reason.trim().slice(0, 200)}`,
    });
    setRevealed(true);
  }, [studyId, patientName, t]);

  return (
    <div className="viewport-overlay" data-testid="viewport-overlay">
      {/* ---- Top-Left: Patient name (initials) + study date ---- */}
      <div className="viewport-overlay-tl" data-testid="overlay-tl">
        {displayedName && (
          <div
            className="viewport-overlay-text"
            data-phi={revealed ? 'true' : 'false'}
          >
            {displayedName}
          </div>
        )}
        {canReveal && !revealed && (
          <button
            type="button"
            onClick={handleReveal}
            className="viewport-overlay-reveal-btn"
            data-testid="viewport-overlay-reveal"
            style={{
              pointerEvents: 'auto',
              fontSize: 'var(--emr-font-xs)',
              padding: '2px 6px',
              marginTop: 4,
              background: 'var(--emr-bg-hover, rgba(0,0,0,0.4))',
              color: 'white',
              border: '1px solid rgba(255,255,255,0.4)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
            aria-label={t('pacs.overlay.revealPatientName') ?? 'Reveal patient name (break-glass)'}
          >
            {t('pacs.overlay.reveal') ?? 'Reveal'}
          </button>
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
