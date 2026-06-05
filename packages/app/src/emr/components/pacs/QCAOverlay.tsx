// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// QCA SVG Overlay Component
// ============================================================================
// Draws vessel analysis results on top of the PACS viewport as an SVG overlay.
// Think of it like drawing with a highlighter on an X-ray — after QCA analysis,
// this component renders:
//
//   - Blue lines tracing the vessel walls (left and right contours)
//   - White dashed line along the vessel center
//   - Red line at the narrowest point (MLD — Minimum Lumen Diameter)
//   - Green lines at the reference points (RVD — Reference Vessel Diameter)
//   - Crosshair markers at clicked points during picking
//   - "Analyzing..." text during processing
//
// The SVG is pointer-events: none so clicks pass through to the viewport.
// Follows the same overlay pattern as CalibrationOverlay.
// ============================================================================

import { useTranslation } from '../../contexts/TranslationContext';
import type { Point } from '../../services/pacs/qcaCenterline';
import './QCAOverlay.css';

// ============================================================================
// Types
// ============================================================================

type QCAMode = 'idle' | 'picking_start' | 'picking_end' | 'processing' | 'results';

interface QCACanvasCoords {
  centerline: Point[];
  leftWall: Point[];
  rightWall: Point[];
  mldLine: [Point, Point] | null;
  rvdLineProximal: [Point, Point] | null;
  rvdLineDistal: [Point, Point] | null;
  mldLabel: { position: Point; text: string } | null;
  rvdLabel: { position: Point; text: string } | null;
}

export interface QCAOverlayProps {
  mode: QCAMode;
  startPoint: Point | null;
  endPoint: Point | null;
  canvasCoords: QCACanvasCoords | null;
  containerWidth: number;
  containerHeight: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert an array of Points to a space-separated "x,y x,y ..." string for <polyline>. */
function toPolylinePoints(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** Render a crosshair marker at a point (two perpendicular lines + small circle). */
function renderCrosshair(p: Point, key: string): JSX.Element {
  return (
    <g key={key}>
      <line x1={p.x - 8} y1={p.y} x2={p.x + 8} y2={p.y} stroke="var(--emr-warning)" strokeWidth={1.5} />
      <line x1={p.x} y1={p.y - 8} x2={p.x} y2={p.y + 8} stroke="var(--emr-warning)" strokeWidth={1.5} />
      <circle cx={p.x} cy={p.y} r={3} fill="none" stroke="var(--emr-warning)" strokeWidth={1.5} />
    </g>
  );
}

// ============================================================================
// Component
// ============================================================================

export function QCAOverlay({
  mode,
  startPoint,
  endPoint,
  canvasCoords,
  containerWidth,
  containerHeight,
}: QCAOverlayProps): JSX.Element | null {
  const { t } = useTranslation();

  // Nothing to draw when idle
  if (mode === 'idle') {
    return null;
  }

  return (
    <svg
      className="qca-overlay"
      viewBox={`0 0 ${containerWidth} ${containerHeight}`}
      data-testid="qca-overlay"
    >
      {/* --- Picking phase: crosshairs at clicked points --- */}
      {(mode === 'picking_start' || mode === 'picking_end') && (
        <>
          {startPoint && renderCrosshair(startPoint, 'start')}
          {endPoint && renderCrosshair(endPoint, 'end')}
        </>
      )}

      {/* --- Processing phase: "Analyzing..." text at midpoint --- */}
      {mode === 'processing' && startPoint && endPoint && (
        <text
          x={(startPoint.x + endPoint.x) / 2}
          y={(startPoint.y + endPoint.y) / 2 - 12}
          className="qca-overlay-analyzing"
        >
          {t('pacs.qca.analyzing')}
        </text>
      )}

      {/* Keep crosshairs visible during processing */}
      {mode === 'processing' && (
        <>
          {startPoint && renderCrosshair(startPoint, 'start-proc')}
          {endPoint && renderCrosshair(endPoint, 'end-proc')}
        </>
      )}

      {/* --- Results phase: full contour overlay --- */}
      {mode === 'results' && canvasCoords && (
        <>
          {/* Vessel wall contours (blue) */}
          {canvasCoords.leftWall.length > 1 && (
            <polyline
              points={toPolylinePoints(canvasCoords.leftWall)}
              fill="none"
              stroke="var(--emr-accent)"
              strokeWidth={1.5}
              data-testid="qca-left-wall"
            />
          )}
          {canvasCoords.rightWall.length > 1 && (
            <polyline
              points={toPolylinePoints(canvasCoords.rightWall)}
              fill="none"
              stroke="var(--emr-accent)"
              strokeWidth={1.5}
              data-testid="qca-right-wall"
            />
          )}

          {/* Centerline (white dashed) */}
          {canvasCoords.centerline.length > 1 && (
            <polyline
              points={toPolylinePoints(canvasCoords.centerline)}
              fill="none"
              stroke="white"
              strokeWidth={1}
              strokeDasharray="4 2"
              data-testid="qca-centerline"
            />
          )}

          {/* MLD measurement line (red) */}
          {canvasCoords.mldLine && (
            <line
              x1={canvasCoords.mldLine[0].x}
              y1={canvasCoords.mldLine[0].y}
              x2={canvasCoords.mldLine[1].x}
              y2={canvasCoords.mldLine[1].y}
              stroke="var(--emr-error)"
              strokeWidth={2}
              data-testid="qca-mld-line"
            />
          )}

          {/* Proximal RVD line (green) */}
          {canvasCoords.rvdLineProximal && (
            <line
              x1={canvasCoords.rvdLineProximal[0].x}
              y1={canvasCoords.rvdLineProximal[0].y}
              x2={canvasCoords.rvdLineProximal[1].x}
              y2={canvasCoords.rvdLineProximal[1].y}
              stroke="var(--emr-success)"
              strokeWidth={2}
              data-testid="qca-rvd-proximal"
            />
          )}

          {/* Distal RVD line (green) */}
          {canvasCoords.rvdLineDistal && (
            <line
              x1={canvasCoords.rvdLineDistal[0].x}
              y1={canvasCoords.rvdLineDistal[0].y}
              x2={canvasCoords.rvdLineDistal[1].x}
              y2={canvasCoords.rvdLineDistal[1].y}
              stroke="var(--emr-success)"
              strokeWidth={2}
              data-testid="qca-rvd-distal"
            />
          )}

          {/* MLD label */}
          {canvasCoords.mldLabel && (
            <text
              x={canvasCoords.mldLabel.position.x}
              y={canvasCoords.mldLabel.position.y}
              fill="var(--emr-error)"
              className="qca-overlay-label"
            >
              {canvasCoords.mldLabel.text}
            </text>
          )}

          {/* RVD label */}
          {canvasCoords.rvdLabel && (
            <text
              x={canvasCoords.rvdLabel.position.x}
              y={canvasCoords.rvdLabel.position.y}
              fill="var(--emr-success)"
              className="qca-overlay-label"
            >
              {canvasCoords.rvdLabel.text}
            </text>
          )}
        </>
      )}
    </svg>
  );
}
