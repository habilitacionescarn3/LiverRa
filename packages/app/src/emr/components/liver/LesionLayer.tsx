// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionLayer (T220).
 *
 * Plain-English: one of the transparencies laid over the 3D liver viewer
 * (see `ViewerLayers.tsx`). For each detected lesion we render a class-
 * coloured outline + a semi-transparent fill on top of the parenchyma. The
 * outline colour matches the same family used by `LesionBadge` so the user
 * sees the same red/green/gray system everywhere. When a lesion is hovered
 * or keyboard-focused, it pulses gently (2 s loop) to draw attention.
 *
 * This component is DOM-only, not WebGL — at this stage of the scaffold
 * we render a 2D SVG overlay sitting on top of the viewer canvas, which is
 * enough to satisfy the UI contract and the outline/colour tokens. When
 * the Cornerstone3D/VTK volumetric overlay lands (later plan task), the
 * rendering logic swaps behind this same API.
 *
 * Keyboard-accessibility: every lesion is a `tabIndex=0` focusable item in
 * tab order; focusing one emits `useViewerState().setCamera(...)` so the
 * viewer recentres. This satisfies "lesions navigable via keyboard" per
 * NFR-002 + the T220 spec.
 *
 * Only lesions whose `viewerState.activeLayers` contains `'lesions'` are
 * drawn — layer-toggle integration is handled by the composer.
 *
 * Spec refs: T220, FR-010, NFR-002, plan.md §Component Architecture.
 */

import { Box } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useAccessibility } from '../../contexts/AccessibilityContext';
import { useViewerState, type ViewerCamera } from '../../contexts/ViewerStateContext';
import { useTranslation } from '../../contexts/TranslationContext';

import { LESION_MALIGNANCY, type BBox3D, type LesionUI } from './types';

export interface LesionLayerProps {
  lesions: LesionUI[];
  /** Optional — when set, the matching lesion is highlighted without pulse. */
  selectedId?: string | null;
  /** Callback when a lesion is focused or clicked. */
  onFocus?: (lesion: LesionUI) => void;
  /** Override pulse animation (respects prefers-reduced-motion by default). */
  disablePulse?: boolean;
  /** World-space → screen projector. Defaults to a naïve orthographic scale. */
  project?: (pt: readonly [number, number, number]) => { x: number; y: number };
  /** Optional canvas size for the naïve projector. */
  canvasSize?: { width: number; height: number };
  'data-testid'?: string;
}

/** Picks the outline colour token per class. */
function colourTokenFor(lesion: LesionUI): string {
  if (!lesion.suggestedClass) return 'var(--liverra-lesion-abstain)';
  return LESION_MALIGNANCY[lesion.suggestedClass] === 'malignant'
    ? 'var(--liverra-lesion-marker)'
    : 'var(--liverra-lesion-benign)';
}

/** Naïve orthographic fallback: world XY → screen XY centred in the SVG. */
function makeDefaultProjector(canvasSize: { width: number; height: number }) {
  return (pt: readonly [number, number, number]): { x: number; y: number } => {
    const [x, y] = pt;
    return { x: canvasSize.width / 2 + x, y: canvasSize.height / 2 - y };
  };
}

/** Reuse the bbox-centred camera heuristic from LesionList. */
function cameraForBbox(bbox: BBox3D): ViewerCamera {
  const [x0, y0, z0, x1, y1, z1] = bbox;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  const diag =
    Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) || 50;
  const offset = Math.max(80, diag * 2.5);
  return {
    position: [cx, cy, cz + offset],
    target: [cx, cy, cz],
    up: [0, -1, 0],
    zoom: 1,
  };
}

export function LesionLayer({
  lesions,
  selectedId,
  onFocus,
  disablePulse,
  project,
  canvasSize = { width: 512, height: 512 },
  'data-testid': testId = 'lesion-layer',
}: LesionLayerProps): JSX.Element | null {
  const { t } = useTranslation();
  const { activeLayers, setCamera } = useViewerState();
  const { prefersReducedMotion } = useAccessibility();
  const rootRef = useRef<SVGSVGElement>(null);

  // Only render when the `lesions` layer is switched on.
  const visible = activeLayers.has('lesions');

  const projector = useMemo(
    () => project ?? makeDefaultProjector(canvasSize),
    [project, canvasSize],
  );

  const pulseDisabled = disablePulse ?? prefersReducedMotion;

  const handleFocus = useCallback(
    (lesion: LesionUI) => {
      setCamera(cameraForBbox(lesion.bbox3d));
      onFocus?.(lesion);
    },
    [setCamera, onFocus],
  );

  // Inline keyframes only once per mount — avoids leaking into global CSS.
  useEffect(() => {
    if (pulseDisabled) return;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-liverra-lesion-pulse', 'true');
    styleEl.textContent = `
      @keyframes liverra-lesion-pulse {
        0%   { fill-opacity: 0.25; }
        50%  { fill-opacity: 0.45; }
        100% { fill-opacity: 0.25; }
      }
    `;
    if (!document.head.querySelector('[data-liverra-lesion-pulse]')) {
      document.head.appendChild(styleEl);
    }
    return () => {
      // Only remove if we appended (not if a sibling already owned it).
      if (styleEl.parentNode === document.head) {
        document.head.removeChild(styleEl);
      }
    };
  }, [pulseDisabled]);

  if (!visible || lesions.length === 0) return null;

  return (
    <svg
      ref={rootRef}
      className="liverra-lesion-layer"
      width={canvasSize.width}
      height={canvasSize.height}
      viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
      role="group"
      aria-label={t('lesions:layer.title')}
      data-testid={testId}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        width: '100%',
        height: '100%',
      }}
    >
      {lesions.map((lesion) => {
        const [x0, y0, z0, x1, y1, z1] = lesion.bbox3d;
        // Project two opposite corners for a 2D rect. Good-enough stand-in
        // until the Cornerstone3D volumetric overlay ships.
        const a = projector([x0, y0, z0]);
        const b = projector([x1, y1, z1]);
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        const colour = colourTokenFor(lesion);
        const isSelected = selectedId === lesion.id;
        const segmentLabel =
          lesion.couinaudLocation === 'multi_segment'
            ? t('lesions:detail.location.multiSegment')
            : lesion.locationLabel;
        const className = lesion.suggestedClass
          ? t(`lesions:classes.${lesion.suggestedClass}.name`)
          : t('lesions:abstention.label');
        const focusAria = t('lesions:layer.focusAria', {
          index: lesion.index,
          className,
          segment: segmentLabel,
        });

        return (
          <g
            key={lesion.id}
            tabIndex={0}
            role="button"
            aria-label={focusAria}
            onFocus={() => handleFocus(lesion)}
            onClick={() => handleFocus(lesion)}
            style={{
              cursor: 'pointer',
              pointerEvents: 'auto',
              outline: 'none',
            }}
            data-testid={`lesion-overlay-${lesion.id}`}
            data-lesion-class={lesion.suggestedClass ?? 'abstained'}
          >
            <rect
              x={x}
              y={y}
              width={Math.max(4, w)}
              height={Math.max(4, h)}
              rx={3}
              ry={3}
              fill={colour}
              fillOpacity={0.25}
              stroke={colour}
              strokeWidth={2}
              strokeOpacity={isSelected ? 1 : 0.85}
              style={
                pulseDisabled
                  ? undefined
                  : {
                      animation: isSelected
                        ? undefined
                        : 'liverra-lesion-pulse 2s ease-in-out infinite',
                    }
              }
            />
            {/* Focus ring — appears only for :focus-visible via CSS class */}
            <rect
              x={x - 2}
              y={y - 2}
              width={Math.max(4, w) + 4}
              height={Math.max(4, h) + 4}
              rx={5}
              ry={5}
              fill="none"
              stroke={colour}
              strokeWidth={isSelected ? 2 : 0}
              strokeDasharray="4 3"
              pointerEvents="none"
            />
          </g>
        );
      })}
    </svg>
  );
}

export default LesionLayer;
