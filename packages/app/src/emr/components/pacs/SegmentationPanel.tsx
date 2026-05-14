// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// SegmentationPanel Component
// ============================================================================
// Side panel for managing segmentation segments (label map regions).
// Think of it like the "layers panel" in Photoshop — each segment is a
// colored region drawn on top of the medical image.
//
// This panel shows:
// - Tool row: Brush / Threshold Brush / Eraser buttons
// - Threshold HU range inputs (visible only when Threshold Brush is active)
// - Segment list with color swatch, name, volume, visibility, delete
// - "Add Segment" with inline name/color form
//
// Scope: general-purpose segmentation tools. No cardiology-specific modes —
// LiverRa is hepatobiliary, so cardiology-lab panels from MediMind are not
// needed and never existed in this file.
//
// Ported from MediMind (components/pacs/SegmentationPanel.tsx) with:
//   - Translation namespace `imaging:segmentation.*` → `pacs.segmentation.*`.
//   - `t()` second-argument fallback dropped — LiverRa's `t()` treats it as
//     params. Fallback is now just the translation file's English value.
// ============================================================================

import type { JSX } from 'react';
import { useState, useCallback } from 'react';
import {
  Text,
  Button,
  Stack,
  Group,
  ColorSwatch,
  ActionIcon,
  NumberInput,
  TextInput,
  ColorInput,
  Tooltip,
} from '@mantine/core';
import {
  IconPlus,
  IconTrash,
  IconEye,
  IconEyeOff,
  IconBrush,
  IconEraser,
  IconAdjustmentsHorizontal,
  IconX,
  IconCheck,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type { SegmentationTool } from '../../hooks/pacs/useSegmentation';
import { DEFAULT_SEGMENT_COLORS } from '../../hooks/pacs/useSegmentation';
import './SegmentationPanel.css';

// ============================================================================
// Types
// ============================================================================

export interface Segment {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  volumeMm3: number | null;
}

export interface SegmentationPanelProps {
  /** List of current segments */
  segments: Segment[];
  /** ID of the currently active segment */
  activeSegmentId: number | null;
  /** Currently selected tool */
  activeTool: SegmentationTool | null;
  /** Called when user selects a tool */
  onSetActiveTool: (tool: SegmentationTool | null) => void;
  /** Called when user creates a new segment */
  onCreateSegment: (name: string, color: string) => void;
  /** Called when user deletes a segment */
  onDeleteSegment: (segmentId: number) => void;
  /** Called when user clicks a segment row to select it */
  onSetActiveSegment: (segmentId: number) => void;
  /** Called when user toggles segment visibility */
  onToggleVisibility: (segmentId: number) => void;
  /** Current threshold range min (HU) */
  thresholdMin?: number;
  /** Current threshold range max (HU) */
  thresholdMax?: number;
  /** Called when threshold range changes */
  onThresholdChange?: (min: number, max: number) => void;
}

// ============================================================================
// Component
// ============================================================================

export function SegmentationPanel({
  segments,
  activeSegmentId,
  activeTool,
  onSetActiveTool,
  onCreateSegment,
  onDeleteSegment,
  onSetActiveSegment,
  onToggleVisibility,
  thresholdMin = -1000,
  thresholdMax = 3000,
  onThresholdChange,
}: SegmentationPanelProps): JSX.Element {
  const { t } = useTranslation();

  // Local state for threshold HU range inputs
  const [localMin, setLocalMin] = useState(thresholdMin);
  const [localMax, setLocalMax] = useState(thresholdMax);

  // Inline "Add Segment" form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSegmentName, setNewSegmentName] = useState('');
  const [newSegmentColor, setNewSegmentColor] = useState(
    DEFAULT_SEGMENT_COLORS[0]
  );

  // Delete confirmation state
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  // ---- Threshold handlers ----
  const handleMinChange = useCallback(
    (val: number | string) => {
      const num = typeof val === 'string' ? parseInt(val, 10) : val;
      if (!isNaN(num)) {
        setLocalMin(num);
        onThresholdChange?.(num, localMax);
      }
    },
    [localMax, onThresholdChange]
  );

  const handleMaxChange = useCallback(
    (val: number | string) => {
      const num = typeof val === 'string' ? parseInt(val, 10) : val;
      if (!isNaN(num)) {
        setLocalMax(num);
        onThresholdChange?.(localMin, num);
      }
    },
    [localMin, onThresholdChange]
  );

  // ---- Add segment form handlers ----
  const handleOpenAddForm = useCallback(() => {
    // Pick next color from the palette based on segment count
    const nextColor =
      DEFAULT_SEGMENT_COLORS[segments.length % DEFAULT_SEGMENT_COLORS.length];
    setNewSegmentColor(nextColor);
    setNewSegmentName('');
    setShowAddForm(true);
  }, [segments.length]);

  const handleConfirmAdd = useCallback(() => {
    const name = newSegmentName.trim();
    if (!name) {
      return;
    }
    onCreateSegment(name, newSegmentColor);
    setShowAddForm(false);
    setNewSegmentName('');
  }, [newSegmentName, newSegmentColor, onCreateSegment]);

  const handleCancelAdd = useCallback(() => {
    setShowAddForm(false);
    setNewSegmentName('');
  }, []);

  // ---- Delete handlers ----
  const handleDeleteClick = useCallback((segmentId: number) => {
    setPendingDeleteId(segmentId);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (pendingDeleteId !== null) {
      onDeleteSegment(pendingDeleteId);
      setPendingDeleteId(null);
    }
  }, [pendingDeleteId, onDeleteSegment]);

  const handleCancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  // ---- Tool button helper ----
  const handleToolClick = useCallback(
    (tool: SegmentationTool) => {
      // Toggle: clicking the active tool deselects it
      onSetActiveTool(activeTool === tool ? null : tool);
    },
    [activeTool, onSetActiveTool]
  );

  // ---- Format volume for display ----
  const formatVolume = (mm3: number): string => {
    if (mm3 >= 1000) {
      return `${(mm3 / 1000).toFixed(1)} cm³`;
    }
    return `${mm3.toFixed(0)} mm³`;
  };

  return (
    <div className="segmentation-panel">
      {/* Header */}
      <div className="segmentation-panel-header">
        <Text fw="var(--emr-font-semibold)" size="sm">
          {t('pacs.segmentation.title')}
        </Text>
      </div>

      {/* Tool row: Brush / Threshold Brush / Eraser */}
      <Group gap="xs" className="segmentation-panel-tools">
        <Tooltip label={t('pacs.segmentation.brush')}>
          <ActionIcon
            variant={activeTool === 'brush' ? 'filled' : 'subtle'}
            color={activeTool === 'brush' ? 'blue' : 'gray'}
            size="lg"
            onClick={() => handleToolClick('brush')}
            aria-label={t('pacs.segmentation.brush')}
            className="segmentation-tool-btn"
          >
            <IconBrush size={18} />
          </ActionIcon>
        </Tooltip>

        <Tooltip label={t('pacs.segmentation.threshold')}>
          <ActionIcon
            variant={activeTool === 'threshold' ? 'filled' : 'subtle'}
            color={activeTool === 'threshold' ? 'blue' : 'gray'}
            size="lg"
            onClick={() => handleToolClick('threshold')}
            aria-label={t('pacs.segmentation.threshold')}
            className="segmentation-tool-btn"
          >
            <IconAdjustmentsHorizontal size={18} />
          </ActionIcon>
        </Tooltip>

        <Tooltip label={t('pacs.segmentation.eraser')}>
          <ActionIcon
            variant={activeTool === 'eraser' ? 'filled' : 'subtle'}
            color={activeTool === 'eraser' ? 'blue' : 'gray'}
            size="lg"
            onClick={() => handleToolClick('eraser')}
            aria-label={t('pacs.segmentation.eraser')}
            className="segmentation-tool-btn"
          >
            <IconEraser size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* Threshold HU range — shown only when Threshold Brush is active */}
      {activeTool === 'threshold' && (
        <div className="segmentation-panel-threshold">
          <Text size="xs" fw="var(--emr-font-medium)" mb={4}>
            {t('pacs.segmentation.thresholdRange')}
          </Text>
          <Group gap="xs" grow>
            <NumberInput
              size="xs"
              label={t('pacs.segmentation.thresholdMin')}
              value={localMin}
              onChange={handleMinChange}
              min={-1024}
              max={localMax}
              step={10}
            />
            <NumberInput
              size="xs"
              label={t('pacs.segmentation.thresholdMax')}
              value={localMax}
              onChange={handleMaxChange}
              min={localMin}
              max={4096}
              step={10}
            />
          </Group>
        </div>
      )}

      {/* Segment list */}
      <Stack gap={4} className="segmentation-panel-segments">
        {segments.length === 0 && (
          <Text size="xs" c="dimmed" ta="center" py="md">
            {t('pacs.segmentation.noSegments')}
          </Text>
        )}

        {segments.map((seg) => {
          const isActive = seg.id === activeSegmentId;
          const isPendingDelete = seg.id === pendingDeleteId;

          return (
            <div
              key={seg.id}
              className={`segmentation-segment-row ${isActive ? 'segmentation-segment-row--active' : ''}`}
              onClick={() => onSetActiveSegment(seg.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  onSetActiveSegment(seg.id);
                }
              }}
              aria-label={`${t('pacs.segmentation.selectSegment')}: ${seg.name}`}
              aria-pressed={isActive}
            >
              <Group gap="xs" wrap="nowrap" style={{ width: '100%' }}>
                <ColorSwatch
                  color={seg.color}
                  size={16}
                  style={{ flexShrink: 0 }}
                />
                <Text
                  size="xs"
                  style={{ flex: 1, minWidth: 0 }}
                  lineClamp={1}
                >
                  {seg.name}
                </Text>
                {seg.volumeMm3 !== null && (
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {formatVolume(seg.volumeMm3)}
                  </Text>
                )}

                {/* Delete confirmation inline */}
                {isPendingDelete ? (
                  <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                    <ActionIcon
                      variant="filled"
                      size="sm"
                      color="red"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleConfirmDelete();
                      }}
                      aria-label={t('pacs.segmentation.confirmDelete')}
                      className="segmentation-action-btn"
                    >
                      <IconCheck size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      color="gray"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancelDelete();
                      }}
                      aria-label={t('pacs.segmentation.cancelDelete')}
                      className="segmentation-action-btn"
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </Group>
                ) : (
                  <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      color="gray"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleVisibility(seg.id);
                      }}
                      aria-label={
                        seg.visible
                          ? t('pacs.segmentation.hideSegment')
                          : t('pacs.segmentation.showSegment')
                      }
                      className="segmentation-action-btn"
                    >
                      {seg.visible ? (
                        <IconEye size={14} />
                      ) : (
                        <IconEyeOff size={14} />
                      )}
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      size="sm"
                      color="red"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClick(seg.id);
                      }}
                      aria-label={t('pacs.segmentation.deleteSegment')}
                      className="segmentation-action-btn"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
            </div>
          );
        })}
      </Stack>

      {/* Add Segment — inline form or button */}
      {showAddForm ? (
        <div className="segmentation-panel-add-form">
          <TextInput
            size="xs"
            placeholder={t('pacs.segmentation.segmentName')}
            value={newSegmentName}
            onChange={(e) => setNewSegmentName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleConfirmAdd();
              }
              if (e.key === 'Escape') {
                handleCancelAdd();
              }
            }}
            autoFocus
          />
          <ColorInput
            size="xs"
            value={newSegmentColor}
            onChange={setNewSegmentColor}
            swatches={DEFAULT_SEGMENT_COLORS}
            swatchesPerRow={4}
            label={t('pacs.segmentation.segmentColor')}
          />
          <Group gap="xs" mt={4}>
            <Button
              size="compact-sm"
              variant="filled"
              onClick={handleConfirmAdd}
              disabled={!newSegmentName.trim()}
              style={{
                flex: 1,
                /* Brand gradient — uses theme token, follows T464 brand ramp. */
                background: 'var(--emr-gradient-primary)',
              }}
              styles={{ label: { overflow: 'visible', height: 'auto' } }}
            >
              {t('pacs.segmentation.create')}
            </Button>
            <Button
              size="compact-sm"
              variant="subtle"
              color="gray"
              onClick={handleCancelAdd}
              styles={{ label: { overflow: 'visible', height: 'auto' } }}
            >
              {t('pacs.segmentation.cancel')}
            </Button>
          </Group>
        </div>
      ) : (
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={handleOpenAddForm}
          fullWidth
          className="segmentation-panel-add-btn"
          styles={{ label: { overflow: 'visible', height: 'auto' } }}
        >
          {t('pacs.segmentation.addSegment')}
        </Button>
      )}
    </div>
  );
}
