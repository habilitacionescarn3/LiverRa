// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useQCA Hook — State machine for the Semi-Automatic QCA workflow
// ============================================================================
// Manages the full QCA interaction cycle: the user activates QCA mode, clicks
// two points on a vessel (proximal → distal), the system runs the analysis
// pipeline, and the results are made available for overlay rendering.
//
// State machine: idle → picking_start → picking_end → processing → results
//                                                                    ↓
//                                                              (reset) → idle
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { metaData } from '@cornerstonejs/core';
import { runQCA } from '../../services/pacs/qcaService';
import type { Point } from '../../services/pacs/qcaCenterline';
import type { QCAResult } from '../../services/pacs/qcaMeasurements';
import { useTranslation } from '../../contexts/TranslationContext';
import type { QCAErrorCode } from '../../services/pacs/qcaService';

// ============================================================================
// Types
// ============================================================================

export type QCAMode = 'idle' | 'picking_start' | 'picking_end' | 'processing' | 'results';

export interface QCACanvasCoords {
  centerline: Point[];
  leftWall: Point[];
  rightWall: Point[];
  mldLine: [Point, Point] | null;
  rvdLineProximal: [Point, Point] | null;
  rvdLineDistal: [Point, Point] | null;
  mldLabel: { position: Point; text: string } | null;
  rvdLabel: { position: Point; text: string } | null;
}

export interface UseQCAReturn {
  mode: QCAMode;
  startPoint: Point | null;
  endPoint: Point | null;
  result: QCAResult | null;
  error: string | null;
  canvasCoords: QCACanvasCoords | null;
  viewportElementId: string | null;
  activateQCA: () => void;
  resetQCA: () => void;
}

type QCAImageData = {
  scalarData: ArrayLike<number>;
  dimensions: [number, number, number] | number[];
  imageData?: {
    indexToWorld?: (index: number[], out?: number[]) => number[];
    worldToIndex?: (world: number[], out?: number[]) => number[];
  };
  indexToWorld?: (index: number[], out?: number[]) => number[];
  worldToIndex?: (world: number[], out?: number[]) => number[];
};

type QCAViewport = {
  getImageData?: () => QCAImageData | undefined;
  getCurrentImageId?: () => string | undefined;
  getCurrentImageIdIndex?: () => number;
  getImageIds?: () => string[];
  getProperties?: () => Record<string, unknown>;
  canvasToWorld?: (canvas: [number, number]) => number[];
  canvasToIndex?: (canvas: [number, number]) => number[];
  worldToCanvas?: (world: number[]) => [number, number] | number[] | undefined;
};

const QCA_ERROR_KEYS: Record<QCAErrorCode, string> = {
  invalidImageDimensions: 'pacs.qca.errors.invalidImageDimensions',
  invalidCalibration: 'pacs.qca.errors.invalidCalibration',
  startPointOutOfBounds: 'pacs.qca.errors.startPointOutOfBounds',
  endPointOutOfBounds: 'pacs.qca.errors.endPointOutOfBounds',
  pathTooShort: 'pacs.qca.errors.pathTooShort',
  pipelineFailed: 'pacs.qca.errors.pipelineFailed',
};

// ============================================================================
// Helpers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberFromRecords(records: (Record<string, unknown> | undefined)[], keys: string[]): number | undefined {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = firstNumber(record[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

function getViewportImageId(viewport: QCAViewport | null | undefined): string | undefined {
  const current = viewport?.getCurrentImageId?.();
  if (current) {
    return current;
  }
  const imageIds = viewport?.getImageIds?.();
  const index = viewport?.getCurrentImageIdIndex?.() ?? 0;
  return imageIds?.[index];
}

function buildDisplayedPixelData(
  pixels: ArrayLike<number>,
  viewport: QCAViewport | null | undefined,
  w: number,
  h: number
): Float32Array {
  const len = Math.max(0, w * h);
  const rescaled = new Float32Array(len);
  const imageId = getViewportImageId(viewport);
  const imagePixelModule = imageId ? metaData.get('imagePixelModule', imageId) as Record<string, unknown> | undefined : undefined;
  const modalityLutModule = imageId ? metaData.get('modalityLutModule', imageId) as Record<string, unknown> | undefined : undefined;
  const voiLutModule = imageId ? metaData.get('voiLutModule', imageId) as Record<string, unknown> | undefined : undefined;
  const viewportProps = viewport?.getProperties?.();
  const voiRange = isRecord(viewportProps?.voiRange) ? viewportProps.voiRange : undefined;
  const slope = numberFromRecords([modalityLutModule, imagePixelModule], ['rescaleSlope', 'slope']) ?? 1;
  const intercept = numberFromRecords([modalityLutModule, imagePixelModule], ['rescaleIntercept', 'intercept']) ?? 0;

  let minValue = Infinity;
  let maxValue = -Infinity;
  for (let i = 0; i < len; i++) {
    const value = (Number(pixels[i] ?? 0) * slope) + intercept;
    rescaled[i] = value;
    if (value < minValue) { minValue = value; }
    if (value > maxValue) { maxValue = value; }
  }

  const lower = numberFromRecords([voiRange], ['lower']) ??
    (() => {
      const center = numberFromRecords([viewportProps, voiLutModule], ['windowCenter', 'center']);
      const width = numberFromRecords([viewportProps, voiLutModule], ['windowWidth', 'width']);
      return center !== undefined && width !== undefined ? center - width / 2 : minValue;
    })();
  const upper = numberFromRecords([voiRange], ['upper']) ??
    (() => {
      const center = numberFromRecords([viewportProps, voiLutModule], ['windowCenter', 'center']);
      const width = numberFromRecords([viewportProps, voiLutModule], ['windowWidth', 'width']);
      return center !== undefined && width !== undefined ? center + width / 2 : maxValue;
    })();
  const range = Math.max(1, upper - lower);
  const photometricValue = imagePixelModule?.photometricInterpretation;
  const photometric = typeof photometricValue === 'string' ? photometricValue.toUpperCase() : '';
  const viewportInvert = viewportProps?.invert === true;
  const invert = (photometric === 'MONOCHROME1') !== viewportInvert;
  const displayed = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    let normalized = Math.min(1, Math.max(0, (rescaled[i] - lower) / range));
    if (invert) {
      normalized = 1 - normalized;
    }
    displayed[i] = normalized * 255;
  }

  return displayed;
}

function imagePointToCanvasPoint(point: Point, viewport: QCAViewport | null | undefined): Point | null {
  const imageData = viewport?.getImageData?.();
  const indexToWorld = imageData?.imageData?.indexToWorld ?? imageData?.indexToWorld;
  if (!viewport || typeof viewport.worldToCanvas !== 'function' || typeof indexToWorld !== 'function') {
    return null;
  }
  const world = indexToWorld([point.x, point.y, 0]);
  const canvas = viewport.worldToCanvas(world);
  if (!canvas || canvas.length < 2 || !Number.isFinite(canvas[0]) || !Number.isFinite(canvas[1])) {
    return null;
  }
  return { x: canvas[0], y: canvas[1] };
}

function samePoint(a: Point | null, b: Point | null): boolean {
  return a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01);
}

/**
 * Build overlay coordinates from a QCA result for the canvas renderer.
 *
 * @param result - QCA result in image/index coordinates.
 * @param viewport - Current Cornerstone viewport used for image-to-canvas projection.
 * @returns Canvas-space coordinates for the SVG overlay.
 */
function buildCanvasCoords(result: QCAResult, viewport: QCAViewport | null | undefined): QCACanvasCoords {
  const toCanvas = (point: Point): Point => imagePointToCanvasPoint(point, viewport) ?? point;
  const centerline = result.centerline.map(toCanvas);
  const leftContour = result.leftContour.map(toCanvas);
  const rightContour = result.rightContour.map(toCanvas);
  const mldLeft = leftContour[result.mldIndex];
  const mldRight = rightContour[result.mldIndex];
  const mldLine: [Point, Point] | null =
    mldLeft && mldRight ? [mldLeft, mldRight] : null;

  // RVD reference lines at proximal (25%) and distal (75%) positions
  const proxIdx = Math.floor(result.centerline.length * 0.25);
  const distIdx = Math.floor(result.centerline.length * 0.75);

  const rvdLineProximal: [Point, Point] | null =
    leftContour[proxIdx] && rightContour[proxIdx]
      ? [leftContour[proxIdx], rightContour[proxIdx]]
      : null;

  const rvdLineDistal: [Point, Point] | null =
    leftContour[distIdx] && rightContour[distIdx]
      ? [leftContour[distIdx], rightContour[distIdx]]
      : null;

  // Labels positioned slightly above the measurement lines
  const mldLabel = mldLine
    ? { position: { x: mldLine[0].x, y: mldLine[0].y - 8 }, text: `MLD ${result.mld.toFixed(2)} mm` }
    : null;

  const rvdLabel = rvdLineProximal
    ? { position: { x: rvdLineProximal[0].x, y: rvdLineProximal[0].y - 8 }, text: `RVD ${result.rvd.toFixed(2)} mm` }
    : null;

  return {
    centerline,
    leftWall: leftContour,
    rightWall: rightContour,
    mldLine,
    rvdLineProximal,
    rvdLineDistal,
    mldLabel,
    rvdLabel,
  };
}

function mapCanvasToImagePoint(canvasPoint: [number, number], viewport: QCAViewport | null | undefined): Point | null {
  const imageData = viewport?.getImageData?.();
  const [width, height] = imageData?.dimensions ?? [0, 0];
  if (!viewport || !imageData || width <= 0 || height <= 0) {
    return null;
  }

  let indexPoint: number[] | undefined;

  if (typeof viewport.canvasToIndex === 'function') {
    indexPoint = viewport.canvasToIndex(canvasPoint);
  } else if (typeof viewport.canvasToWorld === 'function') {
    const world = viewport.canvasToWorld(canvasPoint);
    const worldToIndex = imageData.imageData?.worldToIndex ?? imageData.worldToIndex;
    if (typeof worldToIndex === 'function') {
      indexPoint = worldToIndex(world);
    }
  }

  if (!indexPoint || indexPoint.length < 2) {
    return null;
  }

  const point = { x: Math.round(indexPoint[0]), y: Math.round(indexPoint[1]) };
  if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) {
    return null;
  }
  return point;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for the Semi-Automatic QCA workflow.
 *
 * @param getViewport      - Returns the current Cornerstone viewport (for pixel access)
 * @param viewportElementId - DOM id of the viewport element (for click listeners)
 * @param mmPerPixel       - Calibration factor from the calibration tool
 * @param isActive         - External toggle; when false the hook stays dormant
 * @returns QCA workflow state and controls.
 */
export function useQCA(
  getViewport: () => QCAViewport | null | undefined,
  viewportElementId: string | null,
  mmPerPixel: number | null,
  isActive: boolean
): UseQCAReturn {
  const { t } = useTranslation();
  const [mode, setMode] = useState<QCAMode>('idle');
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [endPoint, setEndPoint] = useState<Point | null>(null);
  const [startCanvasPoint, setStartCanvasPoint] = useState<Point | null>(null);
  const [endCanvasPoint, setEndCanvasPoint] = useState<Point | null>(null);
  const [result, setResult] = useState<QCAResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasCoords, setCanvasCoords] = useState<QCACanvasCoords | null>(null);
  const [analysisViewportElementId, setAnalysisViewportElementId] = useState<string | null>(null);

  // Ref to track current mode inside the click handler without stale closures
  const modeRef = useRef<QCAMode>(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // ---- Reset everything back to idle ----
  const resetQCA = useCallback(() => {
    setMode('idle');
    setStartPoint(null);
    setEndPoint(null);
    setStartCanvasPoint(null);
    setEndCanvasPoint(null);
    setResult(null);
    setError(null);
    setCanvasCoords(null);
    setAnalysisViewportElementId(null);
  }, []);

  // ---- Activate QCA (idle → picking_start) ----
  const activateQCA = useCallback(() => {
    if (!mmPerPixel) {
      setError(t('pacs.qca.errors.calibrationRequired'));
      return;
    }
    setError(null);
    setResult(null);
    setCanvasCoords(null);
    setStartPoint(null);
    setEndPoint(null);
    setStartCanvasPoint(null);
    setEndCanvasPoint(null);
    setAnalysisViewportElementId(viewportElementId);
    setMode('picking_start');
  }, [mmPerPixel, t, viewportElementId]);

  // ---- Reset when external toggle turns off ----
  useEffect(() => {
    if (!isActive && mode !== 'idle') {
      resetQCA();
    }
  }, [isActive, mode, resetQCA]);

  useEffect(() => {
    if (mode !== 'idle' && analysisViewportElementId && viewportElementId && analysisViewportElementId !== viewportElementId) {
      resetQCA();
    }
  }, [analysisViewportElementId, mode, resetQCA, viewportElementId]);

  // ---- Click listener for point picking ----
  useEffect(() => {
    const targetViewportElementId = analysisViewportElementId ?? viewportElementId;
    if (!isActive || !targetViewportElementId) {
      return undefined;
    }
    if (mode !== 'picking_start' && mode !== 'picking_end') {
      return undefined;
    }

    const element = document.getElementById(targetViewportElementId);
    if (!element) {
      return undefined;
    }

    const handleClick = (event: MouseEvent): void => {
      const rect = element.getBoundingClientRect();
      const canvasPoint: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
      const viewport = getViewport();
      const point = mapCanvasToImagePoint(canvasPoint, viewport);
      if (!point) {
        setError(
          t(
            modeRef.current === 'picking_start'
              ? 'pacs.qca.errors.startPointOutOfBounds'
              : 'pacs.qca.errors.endPointOutOfBounds'
          )
        );
        return;
      }
      setError(null);

      if (modeRef.current === 'picking_start') {
        setStartPoint(point);
        setStartCanvasPoint(imagePointToCanvasPoint(point, viewport) ?? { x: canvasPoint[0], y: canvasPoint[1] });
        setMode('picking_end');
      } else if (modeRef.current === 'picking_end') {
        setEndPoint(point);
        setEndCanvasPoint(imagePointToCanvasPoint(point, viewport) ?? { x: canvasPoint[0], y: canvasPoint[1] });
        setMode('processing');
      }
    };

    element.addEventListener('mousedown', handleClick);
    return () => {
      element.removeEventListener('mousedown', handleClick);
    };
  }, [analysisViewportElementId, isActive, viewportElementId, mode, getViewport, t]);

  // ---- Run QCA pipeline when entering 'processing' ----
  useEffect(() => {
    if (mode !== 'processing' || !startPoint || !endPoint || !mmPerPixel) {
      return;
    }

    const viewport = getViewport();
    const imageData = viewport?.getImageData?.();
    const pixels = imageData?.scalarData;
    const [w, h] = imageData?.dimensions ?? [0, 0];

    if (!pixels || w <= 0 || h <= 0) {
      setError(t('pacs.qca.errors.viewportPixelDataUnavailable'));
      setMode('idle');
      return;
    }

    const displayedPixels = buildDisplayedPixelData(pixels, viewport, w, h);
    // `buildDisplayedPixelData` already folds DICOM PhotometricInterpretation
    // (MONOCHROME1) and the viewport invert state into screen space, so the
    // lumen of a standard angiogram stays DARK here regardless of the source
    // polarity — the centerline cost map must therefore reward dark pixels.
    const qcaResult = runQCA(displayedPixels, w, h, startPoint, endPoint, mmPerPixel, false);

    if ('success' in qcaResult && !qcaResult.success) {
      setError(t(QCA_ERROR_KEYS[qcaResult.code]));
      setMode('idle');
      return;
    }

    const successResult = qcaResult as QCAResult;
    setResult(successResult);
    setCanvasCoords(buildCanvasCoords(successResult, viewport));
    setError(null);
    setMode('results');
  }, [mode, startPoint, endPoint, mmPerPixel, getViewport, t]);

  useEffect(() => {
    if (!isActive || mode === 'idle') {
      return undefined;
    }

    const refreshProjection = (): void => {
      const viewport = getViewport();
      if (startPoint) {
        const next = imagePointToCanvasPoint(startPoint, viewport);
        if (next) {
          setStartCanvasPoint((prev) => samePoint(prev, next) ? prev : next);
        }
      }
      if (endPoint) {
        const next = imagePointToCanvasPoint(endPoint, viewport);
        if (next) {
          setEndCanvasPoint((prev) => samePoint(prev, next) ? prev : next);
        }
      }
      if (result) {
        setCanvasCoords(buildCanvasCoords(result, viewport));
      }
    };

    refreshProjection();
    const timer = window.setInterval(refreshProjection, 150);
    return () => window.clearInterval(timer);
  }, [endPoint, getViewport, isActive, mode, result, startPoint]);

  return {
    mode,
    startPoint: startCanvasPoint,
    endPoint: endCanvasPoint,
    result,
    error,
    canvasCoords,
    viewportElementId: analysisViewportElementId,
    activateQCA,
    resetQCA,
  };
}
