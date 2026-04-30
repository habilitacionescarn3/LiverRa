// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useSegmentation Hook
// ============================================================================
// Manages segmentation state — segment CRUD, active tool selection, visibility
// toggling, and volume calculation from labelmaps. Think of it like a paint
// palette: you pick a color (segment), choose a brush (tool), and paint on the
// medical image. Each "segment" is a labeled region (e.g., "Tumor", "Liver").
//
// This hook manages the React state that drives the SegmentationPanel UI.
// It calls into Cornerstone3D's segmentation API to sync state with the
// rendering engine (labelmaps, active segment index, visibility).
//
// Scope: general-purpose segmentation (brush / threshold / eraser). No
// cardiology-specific modes — LiverRa's hepatobiliary flow doesn't need
// vessel-lumen tracking.
//
// Ported from MediMind (hooks/pacs/useSegmentation.ts). Verbatim — MediMind
// never added cardiology paths here so nothing to strip.
// ============================================================================

import { useState, useCallback, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

// ============================================================================
// Types
// ============================================================================

/** Available segmentation tools the user can paint with */
export type SegmentationTool = 'brush' | 'threshold' | 'eraser';

/** A single segment (labeled region) in the segmentation */
export interface Segment {
  /** Unique ID for this segment (matches segmentIndex in CS3D) */
  id: number;
  /** Human-readable name (e.g., "Tumor", "Liver") */
  name: string;
  /** Display color as CSS hex string (e.g., "#ff0000") */
  color: string;
  /** Whether this segment is visible on the viewport */
  visible: boolean;
  /** Calculated volume in mm³, null if not yet calculated */
  volumeMm3: number | null;
}

/** Return type of the useSegmentation hook */
export interface UseSegmentationReturn {
  /** All segments in the current segmentation */
  segments: Segment[];
  /** ID of the currently active segment (new painting goes here) */
  activeSegmentId: number | null;
  /** Currently selected tool, null if none */
  activeTool: SegmentationTool | null;
  /** The segmentation ID used with CS3D */
  segmentationId: string;
  /** Add a new segment with a name and color */
  createSegment: (name: string, color: string) => void;
  /** Remove a segment by its ID */
  deleteSegment: (segmentId: number) => void;
  /** Set which segment is active for painting */
  setActiveSegment: (segmentId: number) => void;
  /** Toggle a segment's visibility on/off */
  toggleVisibility: (segmentId: number) => void;
  /** Select which tool to paint with (brush, threshold, eraser) */
  setActiveTool: (tool: SegmentationTool | null) => void;
  /** Calculate the volume (in mm³) of a segment from its labelmap data */
  calculateVolume: (segmentId: number) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Default segmentation ID used for CS3D state management */
const DEFAULT_SEGMENTATION_ID = 'liverra-segmentation-1';

/** Default colors for new segments (cycles through these) */
const DEFAULT_SEGMENT_COLORS = [
  '#ef4444', // red
  '#22c55e', // green
  '#3182ce', // blue (--emr-accent)
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse a hex color string (e.g., "#ff0000") into an RGBA array [r, g, b, a]
 * with values 0–255. CS3D expects colors in this format for labelmaps.
 */
function hexToRgba(hex: string): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  return [r, g, b, 255];
}

/**
 * Try to set the color for a segment in CS3D's color LUT.
 * Requires a viewportId because CS3D v4 manages colors per-viewport.
 * Fails silently if CS3D segmentation state isn't set up yet.
 */
export function setSegmentColorOnViewport(
  viewportId: string,
  segmentationId: string,
  segmentIndex: number,
  color: string
): void {
  try {
    const rgba = hexToRgba(color);
    cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
      viewportId,
      segmentationId,
      segmentIndex,
      rgba as cornerstone.Types.Color
    );
  } catch {
    // CS3D segmentation not initialized — will be set when viewer mounts
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useSegmentation(
  segmentationId: string = DEFAULT_SEGMENTATION_ID
): UseSegmentationReturn {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<number | null>(null);
  const [activeTool, setActiveToolState] = useState<SegmentationTool | null>(null);

  // Ref to always have the latest segments — avoids stale closures in callbacks
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Auto-increment counter for segment IDs (1-based to match CS3D convention)
  // Uses useRef instead of useState to avoid stale closure in createSegment
  const nextIdRef = useRef(1);

  // --------------------------------------------------------------------------
  // createSegment — add a new labeled region
  // --------------------------------------------------------------------------
  const createSegment = useCallback(
    (name: string, color: string) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;

      const newSegment: Segment = {
        id,
        name,
        color,
        visible: true,
        volumeMm3: null,
      };

      setSegments((prev) => [...prev, newSegment]);
      setActiveSegmentId(id);

      // Tell CS3D which segment index is active for painting
      try {
        cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, id);
      } catch {
        // CS3D not ready
      }
    },
    [segmentationId]
  );

  // --------------------------------------------------------------------------
  // deleteSegment — remove a segment and its labelmap data
  // --------------------------------------------------------------------------
  const deleteSegment = useCallback(
    (segmentId: number) => {
      setSegments((prev) => prev.filter((s) => s.id !== segmentId));

      // If deleting the active segment, reset to the first remaining segment
      // Uses segmentsRef to read latest state (avoids stale closure on rapid deletes)
      setActiveSegmentId((prev) => {
        if (prev !== segmentId) {
          return prev;
        }
        const remaining = segmentsRef.current.filter((s) => s.id !== segmentId);
        return remaining.length > 0 ? remaining[0].id : null;
      });

      // Remove segment data from CS3D labelmap
      try {
        cornerstoneTools.segmentation.removeSegment(segmentationId, segmentId);
      } catch {
        // CS3D not ready or segment doesn't exist
      }
    },
    [segmentationId]
  );

  // --------------------------------------------------------------------------
  // setActiveSegment — change which segment receives new paint strokes
  // --------------------------------------------------------------------------
  const setActiveSegment = useCallback(
    (segmentId: number) => {
      setActiveSegmentId(segmentId);

      try {
        cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, segmentId);
      } catch {
        // CS3D not ready
      }
    },
    [segmentationId]
  );

  // --------------------------------------------------------------------------
  // toggleVisibility — show/hide a segment on the viewport
  // --------------------------------------------------------------------------
  const toggleVisibility = useCallback(
    (segmentId: number) => {
      setSegments((prev) =>
        prev.map((s) => (s.id === segmentId ? { ...s, visible: !s.visible } : s))
      );

      // CS3D visibility toggling is handled at the representation level,
      // which requires a viewportId. The SegmentationPanel component will
      // call the CS3D API directly with the viewport context it has access to.
    },
    []
  );

  // --------------------------------------------------------------------------
  // setActiveTool — select brush, threshold brush, or eraser
  // --------------------------------------------------------------------------
  const setActiveTool = useCallback(
    (tool: SegmentationTool | null) => {
      setActiveToolState(tool);

      // In CS3D v4, BrushTool handles painting AND erasing (via active segment
      // index 0 = erase). Threshold painting also uses BrushTool with a
      // different strategy. We activate BrushTool for all segmentation modes.
      try {
        const toolGroupId = 'liverra-pacs-toolgroup';
        const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup(toolGroupId);
        if (!toolGroup) {
          return;
        }

        if (tool === null) {
          // Deactivate BrushTool, revert to WindowLevel
          try {
            toolGroup.setToolPassive('Brush');
          } catch {
            // Not registered
          }
          try {
            toolGroup.setToolActive('WindowLevel', {
              bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
            });
          } catch {
            // Not available
          }
          return;
        }

        // Activate BrushTool for all segmentation operations
        toolGroup.setToolActive('Brush', {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });

        // For eraser mode, set active segment index to 0 (which erases)
        if (tool === 'eraser') {
          cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, 0);
        } else if (activeSegmentId !== null) {
          // Restore the real active segment for brush/threshold modes
          cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex(
            segmentationId,
            activeSegmentId
          );
        }
      } catch {
        // CS3D tools not registered yet
      }
    },
    [segmentationId, activeSegmentId]
  );

  // --------------------------------------------------------------------------
  // calculateVolume — count labeled voxels and multiply by voxel spacing
  // --------------------------------------------------------------------------
  const calculateVolume = useCallback(
    (segmentId: number) => {
      try {
        // Get the labelmap image IDs for this segmentation
        const labelmapImageIds = cornerstoneTools.segmentation.getLabelmapImageIds(segmentationId);
        if (!labelmapImageIds || labelmapImageIds.length === 0) {
          return;
        }

        let voxelCount = 0;
        let voxelVolume = 0;

        // For each slice in the labelmap, count pixels matching this segment
        for (const imageId of labelmapImageIds) {
          const cachedImage = cornerstone.cache.getImage(imageId);
          if (!cachedImage) {
            continue;
          }

          const voxelManager = cachedImage.voxelManager;
          if (!voxelManager) {
            continue;
          }

          // Count voxels belonging to this segment using voxelManager
          const scalarData = voxelManager.getScalarData();
          if (!scalarData) {
            continue;
          }

          for (let i = 0; i < scalarData.length; i++) {
            if (scalarData[i] === segmentId) {
              voxelCount++;
            }
          }

          // Calculate voxel volume from spacing (only need to do this once)
          if (voxelVolume === 0) {
            // CRITICAL: Use actual voxel spacing, not assume isotropic
            const spacing = cachedImage.spacing || [1, 1, 1];
            voxelVolume = spacing[0] * spacing[1] * (spacing[2] ?? 1);
          }
        }

        const volumeMm3 = voxelCount * voxelVolume;

        setSegments((prev) =>
          prev.map((s) => (s.id === segmentId ? { ...s, volumeMm3 } : s))
        );
      } catch {
        // Volume calculation failed — labelmap may not be available
      }
    },
    [segmentationId]
  );

  return {
    segments,
    activeSegmentId,
    activeTool,
    segmentationId,
    createSegment,
    deleteSegment,
    setActiveSegment,
    toggleVisibility,
    setActiveTool,
    calculateVolume,
  };
}

/** Exported constant for default segment colors */
export { DEFAULT_SEGMENT_COLORS };
