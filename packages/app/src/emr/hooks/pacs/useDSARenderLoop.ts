// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useDSARenderLoop — apply pixel subtraction when DSA is active
// ============================================================================
// When DSA is active and showOriginal is false, we intercept the rendered
// frame and apply subtractFrames() from dsaService. The mask frame's pixel
// data is cached and subtracted from each live frame to highlight vessels.
//
// Note: This effect reads pixel data from the active Cornerstone3D viewport,
// performs CPU-based subtraction, and paints the result into a separate overlay
// canvas. The visible Cornerstone canvas is WebGL-backed, so drawing 2D pixels
// directly into it is unreliable.
//
// Extracted from PACSViewer.tsx (PACS-H10).
// ============================================================================

import { useEffect } from 'react';
import { getOrCreateRenderingEngine } from '../../services/pacs';
import { subtractFrames, applyWindowLevel, validateFrameDimensions } from '../../services/pacs/dsaService';
import type { DsaPixelMetadata } from '../../services/pacs/dsaService';
import { silentLog } from '../../utils/silentLog';

interface CS3DStackViewport {
  getImageData: () => { scalarData: Float32Array | Int16Array | Uint16Array; dimensions: number[] } | undefined;
}

interface CS3DCachedImage {
  getPixelData: () => Float32Array | Int16Array | Uint16Array | Uint8Array | undefined;
  rows?: number;
  columns?: number;
  width?: number;
  height?: number;
}

interface CS3DCache {
  getImage: (imageId: string) => CS3DCachedImage | undefined;
}

interface DicomPlane {
  imageOrientationPatient: number[];
  imagePositionPatient: number[];
  frameOfReferenceUID: string;
}

interface ViewerStateLike {
  activeViewportId?: string;
  imageIds?: string[];
  viewports?: Map<string, { windowLevel: { center: number; width: number } }>;
}

function isStackViewport(value: unknown): value is CS3DStackViewport {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { getImageData?: unknown }).getImageData === 'function';
}

function isImageCache(value: unknown): value is CS3DCache {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { getImage?: unknown }).getImage === 'function';
}

export interface UseDSARenderLoopOptions {
  isActive: boolean;
  showOriginal: boolean;
  maskFrameIndex: number | undefined;
  shiftX: number;
  shiftY: number;
  currentFrame: number;
  ready: boolean;
  viewerState: ViewerStateLike | undefined | null;
  activeStackImageIdsRef?: { current: string[] | undefined };
}

function parseWadoImageIdPath(imageId: string): { studyUid?: string; seriesUid?: string; sopInstanceUid?: string; frameNumber?: number } {
  const match = imageId.match(/(?:\/studies\/([^/?#]+))?\/series\/([^/?#]+)\/instances\/([^/?#]+)(?:\/frames\/([^/?#]+))?/);
  if (!match) {
    return {};
  }
  const frameNumber = match[4] ? Number.parseInt(decodeURIComponent(match[4]), 10) : undefined;
  return {
    studyUid: decodeURIComponent(match[1]),
    seriesUid: decodeURIComponent(match[2]),
    sopInstanceUid: decodeURIComponent(match[3]),
    frameNumber: Number.isFinite(frameNumber) ? frameNumber : undefined,
  };
}

function sameStackContext(maskImageId: string, activeImageId: string): boolean {
  const mask = parseWadoImageIdPath(maskImageId);
  const active = parseWadoImageIdPath(activeImageId);
  if (!mask.seriesUid || !active.seriesUid) {
    return true;
  }
  if (mask.studyUid !== active.studyUid || mask.seriesUid !== active.seriesUid) {
    return false;
  }
  if (mask.frameNumber !== undefined && active.frameNumber !== undefined) {
    return mask.sopInstanceUid === active.sopInstanceUid;
  }
  return true;
}

function sameNumberArray(a?: number[], b?: number[], tolerance = 0.001): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

function isNumberArray(value: unknown, expectedLength: number): value is number[] {
  return Array.isArray(value) &&
    value.length === expectedLength &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function getDicomPlane(
  metadata: { get?: (type: string, imageId: string) => unknown } | undefined,
  imageId: string
): DicomPlane | undefined {
  const raw = metadata?.get?.('imagePlaneModule', imageId) as Record<string, unknown> | undefined;
  const frameOfReferenceUID = raw?.frameOfReferenceUID;
  const imageOrientationPatient = raw?.imageOrientationPatient;
  const imagePositionPatient = raw?.imagePositionPatient;
  if (
    typeof frameOfReferenceUID !== 'string' ||
    frameOfReferenceUID.trim() === '' ||
    !isNumberArray(imageOrientationPatient, 6) ||
    !isNumberArray(imagePositionPatient, 3)
  ) {
    return undefined;
  }
  return { frameOfReferenceUID, imageOrientationPatient, imagePositionPatient };
}

function readNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  let parsed = Number.NaN;
  if (typeof raw === 'number') {
    parsed = raw;
  } else if (typeof raw === 'string') {
    parsed = Number.parseFloat(raw);
  }
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getDsaPixelMetadata(
  metadata: { get?: (type: string, imageId: string) => unknown } | undefined,
  imageId: string
): DsaPixelMetadata | undefined {
  const imagePixel = metadata?.get?.('imagePixelModule', imageId) as Record<string, unknown> | undefined;
  const modalityLut = metadata?.get?.('modalityLutModule', imageId) as Record<string, unknown> | undefined;
  const bitsStored = readNumber(imagePixel?.bitsStored ?? imagePixel?.BitsStored);
  const pixelRepresentation = readNumber(imagePixel?.pixelRepresentation ?? imagePixel?.PixelRepresentation);
  if (bitsStored === undefined || pixelRepresentation === undefined) {
    return undefined;
  }
  return {
    bitsStored,
    pixelRepresentation: pixelRepresentation === 1 ? 1 : 0,
    rescaleSlope: readNumber(modalityLut?.rescaleSlope ?? modalityLut?.RescaleSlope),
    rescaleIntercept: readNumber(modalityLut?.rescaleIntercept ?? modalityLut?.RescaleIntercept),
  };
}

function removeDsaOverlay(canvas?: HTMLCanvasElement | null): void {
  const parent = canvas?.parentElement;
  const overlay = parent?.querySelector<HTMLCanvasElement>('canvas[data-liverra-dsa-overlay="true"]');
  overlay?.remove();
}

function getOrCreateDsaOverlay(
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): HTMLCanvasElement | null {
  const parent = canvas.parentElement;
  if (!parent) return null;

  if (parent instanceof HTMLElement && getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  let overlay = parent.querySelector<HTMLCanvasElement>('canvas[data-liverra-dsa-overlay="true"]');
  if (!overlay) {
    overlay = document.createElement('canvas');
    overlay.dataset.liverraDsaOverlay = 'true';
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2';
    parent.appendChild(overlay);
  }

  overlay.width = width;
  overlay.height = height;
  return overlay;
}

export function useDSARenderLoop({
  isActive,
  showOriginal,
  maskFrameIndex,
  shiftX,
  shiftY,
  currentFrame,
  ready,
  viewerState,
  activeStackImageIdsRef,
}: UseDSARenderLoopOptions): void {
  const activeViewportId = viewerState?.activeViewportId ?? 'viewport-0';
  const imageIds = viewerState?.imageIds;
  const activeWindowLevel = viewerState?.viewports?.get(activeViewportId)?.windowLevel;
  const windowCenter = activeWindowLevel?.center ?? 2048;
  const windowWidth = activeWindowLevel?.width ?? 4096;

  useEffect(() => {
    if (!isActive || showOriginal || !ready) {
      removeDsaOverlay(document.querySelector<HTMLCanvasElement>('#cs3d-viewport-0 canvas'));
      return;
    }
    let cancelled = false;
    let overlayBaseCanvas: HTMLCanvasElement | null = null;

    const renderIfLive = (viewport: { render: () => void }): void => {
      if (!cancelled) {
        viewport.render();
      }
    };

    const applyDSA = async (): Promise<void> => {
      try {
        const renderingEngine = getOrCreateRenderingEngine();
        const viewport = renderingEngine.getViewport(activeViewportId);
        if (!viewport || !isStackViewport(viewport)) return;
        if (cancelled) return;

        // Read live frame pixel data from the viewport
        const imageData = viewport.getImageData();
        if (!imageData?.scalarData) {
          renderIfLive(viewport);
          return;
        }

        const { dimensions } = imageData;
        const width = dimensions?.[0] ?? 0;
        const height = dimensions?.[1] ?? 0;
        if (width === 0 || height === 0) {
          renderIfLive(viewport);
          return;
        }

        const livePixelData = imageData.scalarData;

        // Get the mask frame's image ID
        const maskIndex = maskFrameIndex ?? 0;
        const stackImageIds = activeStackImageIdsRef?.current?.length ? activeStackImageIdsRef.current : imageIds ?? [];
        if (maskIndex >= stackImageIds.length) {
          renderIfLive(viewport);
          return;
        }

        const maskImageId = stackImageIds[maskIndex];
        const activeImageId = stackImageIds[currentFrame] ?? stackImageIds[0];
        if (!maskImageId) {
          renderIfLive(viewport);
          return;
        }
        if (activeImageId && !sameStackContext(maskImageId, activeImageId)) {
          console.warn('[useDSARenderLoop] DSA mask rejected: mask image is not from the active stack context');
          renderIfLive(viewport);
          return;
        }

        // Get mask pixel data from Cornerstone's image cache
        const cornerstone = await import('@cornerstonejs/core');
        if (cancelled) return;
        const maskImage = isImageCache(cornerstone.cache) ? cornerstone.cache.getImage(maskImageId) : undefined;
        if (!maskImage) {
          renderIfLive(viewport);
          return;
        }

        // LiverRa: pin to the CS3DCachedImage contract above — TS otherwise
        // resolves getPixelData via the intersected Cornerstone `Cache` type
        // and widens to PixelDataTypedArray, which dsaService doesn't accept.
        const maskPixelData = maskImage.getPixelData?.() as
          | Float32Array
          | Int16Array
          | Uint16Array
          | Uint8Array
          | undefined;
        if (!maskPixelData) {
          renderIfLive(viewport);
          return;
        }
        const validateDimensions = validateFrameDimensions as unknown as
          | ((mask: typeof maskPixelData, live: typeof livePixelData, frameWidth: number, frameHeight: number) => boolean)
          | undefined;
        if (validateDimensions && !validateDimensions(maskPixelData, livePixelData, width, height)) {
          console.warn('[useDSARenderLoop] DSA mask rejected: frame dimensions do not match active viewport');
          renderIfLive(viewport);
          return;
        }
        const maskPlane = getDicomPlane(cornerstone.metaData, maskImageId);
        const livePlane = activeImageId ? getDicomPlane(cornerstone.metaData, activeImageId) : undefined;
        if (
          !maskPlane ||
          !livePlane ||
          (
            maskPlane.frameOfReferenceUID !== livePlane.frameOfReferenceUID ||
            !sameNumberArray(maskPlane.imageOrientationPatient, livePlane.imageOrientationPatient) ||
            !sameNumberArray(maskPlane.imagePositionPatient, livePlane.imagePositionPatient)
          )
        ) {
          console.warn('[useDSARenderLoop] DSA mask rejected: DICOM geometry does not match active frame');
          renderIfLive(viewport);
          return;
        }

        const subtracted = subtractFrames(
          maskPixelData,
          livePixelData,
          width,
          height,
          shiftX,
          shiftY,
          activeImageId ? getDsaPixelMetadata(cornerstone.metaData, activeImageId) : undefined
        );

        // Apply window/level to get displayable 8-bit values
        const display = applyWindowLevel(subtracted, windowCenter, windowWidth);
        if (cancelled) return;

        // Write subtracted image to a dedicated overlay canvas. Cornerstone's
        // visible viewport canvas is WebGL-backed, so getContext('2d') usually
        // returns null there.
        const canvas = (viewport as { canvas?: HTMLCanvasElement }).canvas;
        if (canvas) {
          overlayBaseCanvas = canvas;
          const overlay = getOrCreateDsaOverlay(canvas, width, height);
          const ctx = overlay?.getContext('2d');
          if (ctx) {
            const imgData = ctx.createImageData(width, height);
            for (let i = 0; i < display.length; i++) {
              const val = display[i];
              imgData.data[i * 4] = val;     // R
              imgData.data[i * 4 + 1] = val; // G
              imgData.data[i * 4 + 2] = val; // B
              imgData.data[i * 4 + 3] = 255; // A
            }
            ctx.putImageData(imgData, 0, 0);
          }
        }
      } catch (err) {
        silentLog('PACSViewer', 'viewportImageData', err);
        console.warn('[useDSARenderLoop] best-effort PACS operation failed:', err);
        // Viewport or image data may not be ready — silently ignore
      }
    };

    void applyDSA();
    return () => {
      cancelled = true;
      removeDsaOverlay(overlayBaseCanvas);
    };
  }, [
    isActive,
    showOriginal,
    maskFrameIndex,
    shiftX,
    shiftY,
    currentFrame,
    ready,
    activeViewportId,
    imageIds,
    windowCenter,
    windowWidth,
    activeStackImageIdsRef,
  ]);
}
