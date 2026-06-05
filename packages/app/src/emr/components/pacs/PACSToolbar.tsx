// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACSToolbar Component
// ============================================================================
// Toolbar for the Cornerstone3D PACS viewer. Organised into grouped dropdown
// menus to save horizontal space:
//
// 1. **Viewing** dropdown — WindowLevel, Zoom, Pan, StackScroll, Magnify, PlanarRotate
// 2. **Measurement** dropdown — Length, Angle, CobbAngle, Bidirectional, Probe, DragProbe, Polyline
// 3. **ROI** dropdown — EllipticalROI, FreehandROI, RectangleROI, CircleROI, SplineROI
// 4. **Annotation** dropdown — ArrowAnnotate
// 5. **Viewport Controls** dropdown — RotateCW, RotateCCW, FlipH, FlipV, Reset (instant actions)
//
// Plus standalone sections: MPR, 3D, Protocol, Report, Export, DICOM Tags, Shortcuts.
//
// All trigger buttons are 44x44px minimum for mobile tap targets.
// Uses theme CSS variables for colors and t() for translations.
// ============================================================================

import React, { useState } from 'react';
import { Tooltip, Menu, Text } from '@mantine/core';
import {
  IconAdjustments,
  IconZoomIn,
  IconHandMove,
  IconArrowsVertical,
  IconRotateClockwise,
  IconRotate,
  IconArrowsHorizontal,
  IconFlipVertical,
  IconRefresh,
  IconBox,
  IconChevronDown,
  IconCube,
  IconKeyboard,
  IconRuler,
  IconAngle,
  IconOvalVertical,
  IconPoint,
  IconPointer,
  IconDimensions,
  IconArrowBearRight,
  IconCircle,
  IconSquare,
  IconScribble,
  IconVectorSpline,
  IconLine,
  IconSearch,
  IconRotate2,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconLink,
  IconLinkOff,
  IconBrightnessHalf,
  IconHeartbeat,
  IconRuler2,
  IconAlertCircle,
  IconLayersSubtract,
  IconStack2,
  IconBrush,
  IconEraser,
  IconPaint,
  IconTrash,
  IconLineDashed,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import type { PACSViewerTool } from '../../types/pacs';
import type { ActiveFilter, FilterType, FilterStrength } from '../../hooks/pacs/useImageFilters';
import { ImageFilterControls } from './ImageFilterControls';
import { ViewingPresetsMenu } from './ViewingPresetsMenu';
import { getOrCreateToolGroup } from '../../services/pacs/cornerstoneInit';
import './PACSToolbar.css';

interface ReferenceLinesToolGroup {
  setToolDisabled: (name: string) => void;
  setToolEnabled: (name: string) => void;
}

function hasReferenceLinesToolMethods(value: unknown): value is ReferenceLinesToolGroup {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { setToolDisabled?: unknown; setToolEnabled?: unknown };
  return (
    typeof candidate.setToolDisabled === 'function' &&
    typeof candidate.setToolEnabled === 'function'
  );
}

// ============================================================================
// Types
// ============================================================================

export interface PACSToolbarProps {
  /** Currently active tool */
  activeTool: PACSViewerTool;
  /** Called when user selects a different tool */
  onToolChange: (tool: PACSViewerTool) => void;
  /** Rotate the active viewport clockwise by 90 degrees */
  onRotateCW: () => void;
  /** Rotate the active viewport counter-clockwise by 90 degrees */
  onRotateCCW: () => void;
  /** Flip the active viewport horizontally */
  onFlipH: () => void;
  /** Flip the active viewport vertically */
  onFlipV: () => void;
  /** Reset the active viewport to default state */
  onReset: () => void;
  /** Disable all buttons (e.g., during loading) */
  disabled?: boolean;
  /** Whether MPR mode is currently active */
  isMPRActive?: boolean;
  /** Called when user toggles MPR mode on/off */
  onMPRToggle?: () => void;
  /** Whether the study supports volumetric MPR (false for XR, US) */
  isMPREnabled?: boolean;
  // NOTE (audit Wave 4, 2026-05-15 — fix-w4-pacs-toolbar-prop-audit):
  // Removed orphan props that no caller passed and that had no JSX wiring:
  //   activeProtocolName, onSaveProtocol, onResetProtocol, onSelectProtocol,
  //   availableProtocols, isSaving, studyStatus, hasFindings, onToggleReport.
  // The protocol menu lives directly in PACSViewer's sidebar; the Report Panel
  // is opened by ReportPanel itself. If a future caller needs to drive them
  // from the toolbar, re-add the props AND wire the JSX at the same time.
  /** Whether 3D mode is currently active */
  is3DActive?: boolean;
  /** Called when user toggles 3D mode on/off */
  on3DToggle?: () => void;
  /** Whether the study supports 3D volume rendering (same as MPR — needs CT/MR data) */
  is3DEnabled?: boolean;
  // NOTE (Wave 8G.13 — 3D-controls relocation, 2026-06-03):
  // The 3D-cluster props that used to live here drive the dedicated
  // <Panel3DControls> side panel now, not the toolbar. Removed from this
  // interface (and the matching JSX) because the toolbar no longer renders the
  // cluster — only the IconCube 3D toggle (on3DToggle) and reference-lines
  // button remain. PACSViewer passes those props straight to Panel3DControls.
  // Removed: onPresetChange, activePreset, onReset3DRotation, vrInteractionMode,
  // onVrInteractionModeChange, onResetCrop, onReset3DView, onIsolateToggle,
  // isIsolateArmed, isIsolateActive, onIsolateReset, ghostOpacity (dead slider —
  // deleted entirely), onGhostOpacityChange (dead slider), isIsolateLoading,
  // canIsolate, renderingMode, onRenderingModeChange, slabThickness,
  // onSlabThicknessChange, isVolumeViewportActive.
  /** Called when user clicks the keyboard shortcuts help button */
  onShowShortcuts?: () => void;
  // NOTE (audit Wave 4, 2026-05-15 — fix-w4-pacs-toolbar-prop-audit):
  // Removed orphan props that no caller passed and that had no JSX wiring:
  //   onExportImage, onAnonymizeExport, isAnonymizing, onShowDicomTags.
  // Export and the DICOM Tag browser are launched from PACSViewer's sidebar
  // actions menu, not the toolbar. If you re-add toolbar entry points, wire
  // the JSX in the same change.
  /** Called when user clicks the Undo button (Ctrl+Z) */
  onUndo?: () => void;
  /** Called when user clicks the Redo button (Ctrl+Shift+Z) */
  onRedo?: () => void;
  /** Whether undo is available (undo stack has entries) */
  canUndo?: boolean;
  /** Whether redo is available (redo stack has entries) */
  canRedo?: boolean;
  /** Whether scroll synchronization is currently enabled */
  scrollSyncEnabled?: boolean;
  /** Whether window/level synchronization is currently enabled */
  wlSyncEnabled?: boolean;
  /** Called when user toggles scroll synchronization */
  onToggleScrollSync?: () => void;
  /** Called when user toggles window/level synchronization */
  onToggleWLSync?: () => void;
  /** Current study modality — used to show/hide cardiology group (only for 'XA') */
  modality?: string;
  /** Whether calibration mode is active */
  isCalibrating?: boolean;
  /** Whether stenosis measurement mode is active */
  isStenosisActive?: boolean;
  /** Called when user clicks the Calibrate button */
  onCalibrate?: () => void;
  /** Called when user clicks the Stenosis button */
  onStenosis?: () => void;
  /** Whether the study has been calibrated (for warning dot on Stenosis button) */
  isCalibrated?: boolean;
  /** Whether DSA mode is currently active */
  isDSAActive?: boolean;
  /** Called when user clicks the DSA toggle button */
  onDSAToggle?: () => void;
  // NOTE (audit Wave 4, 2026-05-15 — fix-w4-pacs-toolbar-prop-audit):
  // Removed orphan props that no caller passed and that had no JSX wiring:
  //   onSaveToPacs, onLoadFromPacs, isSRSaving, isSRLoading, lastSRSavedAt,
  //   srAnnotationCount, onCriticalFinding, criticalAlertCount.
  // DICOM SR save/load lives in PACSViewer sidebar actions; critical findings
  // are launched from CriticalAlertModal. If a toolbar entry point is added
  // later, re-add the props AND wire the JSX in the same change.
  /** Whether the segmentation panel is currently visible */
  segmentationPanelVisible?: boolean;
  /** Called when user toggles the segmentation panel */
  onToggleSegmentationPanel?: () => void;
  /** Currently active image filter (sharpen/smooth), or null if none */
  activeImageFilter?: ActiveFilter | null;
  /** Called when user selects an image filter from the dropdown */
  onApplyImageFilter?: (type: FilterType, strength: FilterStrength) => void;
  /** Called when user clears the active image filter */
  onClearImageFilter?: () => void;
  /** Called when user clicks the "Clear All Annotations" button */
  onClearAnnotations?: () => void;
  /** ID of the currently active viewport (used by viewing-preset menu) */
  activeViewportId?: string;
  /** Body part of the current study — used to filter viewing presets */
  bodyPart?: string;
  /**
   * External toggle for the Reference-Lines tool. When provided, the toolbar
   * shows a press-to-toggle button (visible in MPR / 3D mode). When omitted,
   * the toolbar manages its own local state via Cornerstone3D's ToolGroup.
   */
  isReferenceLinesActive?: boolean;
  /** Called when user toggles reference lines */
  onReferenceLinesToggle?: () => void;
}

// ============================================================================
// Configuration
// ============================================================================

interface ToolConfig {
  tool: PACSViewerTool;
  icon: React.ReactNode;
  labelKey: string;
  shortcut: string;
}

/** Tool group — a labelled collection of related tools shown in a dropdown */
interface ToolGroup {
  id: string;
  labelKey: string;
  icon: React.ReactNode;
  tools: ToolConfig[];
}

/** Grouped tool dropdowns — each group appears as a single button with a chevron */
const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'viewing',
    labelKey: 'pacs.toolbar.viewingGroup',
    icon: <IconAdjustments size={20} />,
    tools: [
      { tool: 'WindowLevel', icon: <IconAdjustments size={16} />, labelKey: 'pacs.tools.windowLevel', shortcut: 'W' },
      { tool: 'Zoom', icon: <IconZoomIn size={16} />, labelKey: 'pacs.tools.zoom', shortcut: 'Z' },
      { tool: 'Pan', icon: <IconHandMove size={16} />, labelKey: 'pacs.tools.pan', shortcut: 'P' },
      { tool: 'StackScroll', icon: <IconArrowsVertical size={16} />, labelKey: 'pacs.tools.scroll', shortcut: 'S' },
      { tool: 'MagnifyTool', icon: <IconSearch size={16} />, labelKey: 'pacs.toolbar.magnify', shortcut: 'N' },
      { tool: 'PlanarRotate', icon: <IconRotate2 size={16} />, labelKey: 'pacs.tools.planarRotate', shortcut: '' },
    ],
  },
  {
    id: 'measurement',
    labelKey: 'pacs.toolbar.measurementGroup',
    icon: <IconRuler size={20} />,
    tools: [
      { tool: 'Length', icon: <IconRuler size={16} />, labelKey: 'pacs.tools.length', shortcut: 'L' },
      { tool: 'Angle', icon: <IconAngle size={16} />, labelKey: 'pacs.tools.angle', shortcut: 'A' },
      { tool: 'CobbAngle', icon: <IconAngle size={16} />, labelKey: 'pacs.tools.cobbAngle', shortcut: 'O' },
      { tool: 'Bidirectional', icon: <IconDimensions size={16} />, labelKey: 'pacs.tools.bidirectional', shortcut: 'B' },
      { tool: 'Probe', icon: <IconPoint size={16} />, labelKey: 'pacs.tools.probe', shortcut: 'I' },
      { tool: 'DragProbe', icon: <IconPointer size={16} />, labelKey: 'pacs.tools.dragProbe', shortcut: 'D' },
      { tool: 'Polyline', icon: <IconLine size={16} />, labelKey: 'pacs.tools.polyline', shortcut: 'Y' },
    ],
  },
  {
    id: 'roi',
    labelKey: 'pacs.toolbar.roiGroup',
    icon: <IconOvalVertical size={20} />,
    tools: [
      { tool: 'EllipticalROI', icon: <IconOvalVertical size={16} />, labelKey: 'pacs.tools.ellipticalROI', shortcut: 'E' },
      { tool: 'FreehandROI', icon: <IconScribble size={16} />, labelKey: 'pacs.tools.freehandROI', shortcut: 'G' },
      { tool: 'RectangleROI', icon: <IconSquare size={16} />, labelKey: 'pacs.tools.rectangleROI', shortcut: 'U' },
      { tool: 'CircleROI', icon: <IconCircle size={16} />, labelKey: 'pacs.tools.circleROI', shortcut: 'C' },
      { tool: 'SplineROI', icon: <IconVectorSpline size={16} />, labelKey: 'pacs.tools.splineROI', shortcut: 'X' },
    ],
  },
  {
    id: 'annotation',
    labelKey: 'pacs.toolbar.annotationGroup',
    icon: <IconArrowBearRight size={20} />,
    tools: [
      { tool: 'ArrowAnnotate', icon: <IconArrowBearRight size={16} />, labelKey: 'pacs.tools.arrowAnnotate', shortcut: 'T' },
    ],
  },
  {
    id: 'segmentation',
    labelKey: 'pacs.toolbar.segmentationGroup',
    icon: <IconBrush size={20} />,
    tools: [
      { tool: 'Brush', icon: <IconBrush size={16} />, labelKey: 'imaging.segmentation.brush', shortcut: '' },
      { tool: 'Threshold', icon: <IconPaint size={16} />, labelKey: 'imaging.segmentation.threshold', shortcut: '' },
      { tool: 'Eraser', icon: <IconEraser size={16} />, labelKey: 'imaging.segmentation.eraser', shortcut: '' },
    ],
  },
];

interface ActionConfig {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  shortcut: string;
  handler: keyof Pick<PACSToolbarProps, 'onRotateCW' | 'onRotateCCW' | 'onFlipH' | 'onFlipV' | 'onReset'>;
}

/** Action buttons — instant one-shot operations */
const ACTIONS: ActionConfig[] = [
  {
    id: 'rotate-cw',
    icon: <IconRotateClockwise size={20} />,
    labelKey: 'pacs.tools.rotateCW',
    shortcut: ']',
    handler: 'onRotateCW',
  },
  {
    id: 'rotate-ccw',
    icon: <IconRotate size={20} />,
    labelKey: 'pacs.tools.rotateCCW',
    shortcut: '[',
    handler: 'onRotateCCW',
  },
  {
    id: 'flip-h',
    icon: <IconArrowsHorizontal size={20} />,
    labelKey: 'pacs.tools.flipH',
    shortcut: 'H',
    handler: 'onFlipH',
  },
  {
    id: 'flip-v',
    icon: <IconFlipVertical size={20} />,
    labelKey: 'pacs.tools.flipV',
    shortcut: 'V',
    handler: 'onFlipV',
  },
  {
    id: 'reset',
    icon: <IconRefresh size={20} />,
    labelKey: 'pacs.tools.reset',
    shortcut: 'R',
    handler: 'onReset',
  },
];

// ============================================================================
// Sub-components
// ============================================================================

// Shared dark "reading-room" dropdown styling. Mantine renders Menu.Dropdown
// panels in a portal at <body>, so we tag them with these classNames and style
// the panels via GLOBAL rules in PACSToolbar.css (`.pacs-menu-dropdown`). This
// is purely visual — no dropdown / tool-activation logic changes.
const PACS_MENU_CLASSNAMES = {
  dropdown: 'pacs-menu-dropdown',
  item: 'pacs-menu-item',
  label: 'pacs-menu-label',
  divider: 'pacs-menu-divider',
} as const;

/**
 * Dropdown for a group of mutually-exclusive tools (e.g., Viewing, Measurement).
 *
 * @param root0 - Props.
 * @param root0.group - The tool group to render (label + icon + tools).
 * @param root0.activeTool - Currently active tool, for highlighting.
 * @param root0.onToolChange - Called with the chosen tool.
 * @param root0.disabled - Whether the trigger is disabled.
 * @param root0.t - Translation function.
 * @returns The dropdown element.
 */
function ToolGroupDropdown({
  group,
  activeTool,
  onToolChange,
  disabled,
  t,
}: {
  group: ToolGroup;
  activeTool: PACSViewerTool;
  onToolChange: (tool: PACSViewerTool) => void;
  disabled: boolean;
  // LiverRa's t() takes (key, params?) — only the key is used here.
  t: (key: string) => string;
}): JSX.Element {
  const hasActiveTool = group.tools.some((tc) => tc.tool === activeTool);

  return (
    <Menu shadow="md" width={220} position="bottom" withArrow classNames={PACS_MENU_CLASSNAMES}>
      <Menu.Target>
        <Tooltip label={t(group.labelKey)} position="bottom" withArrow>
          <button
            className={`pacs-toolbar-btn pacs-group-trigger ${hasActiveTool ? 'active' : ''}`}
            disabled={disabled}
            aria-label={t(group.labelKey)}
          >
            {group.icon}
            <IconChevronDown size={12} className="pacs-group-chevron" />
          </button>
        </Tooltip>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>{t(group.labelKey)}</Menu.Label>
        {group.tools.map(({ tool, icon, labelKey, shortcut }) => (
          <Menu.Item
            key={tool}
            leftSection={icon}
            onClick={() => onToolChange(tool)}
            style={
              activeTool === tool
                ? { backgroundColor: 'var(--emr-accent-alpha-15)' }
                : undefined
            }
            rightSection={
              shortcut ? (
                <Text size="xs" c="dimmed">{shortcut}</Text>
              ) : undefined
            }
          >
            {t(labelKey)}
            {activeTool === tool && (
              <span style={{ marginLeft: 6, fontSize: 'var(--emr-font-xs)', color: 'var(--emr-accent)' }}>&#10003;</span>
            )}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Dropdown for viewport action buttons (rotate, flip, reset) — instant-fire,
 * not tool selection.
 *
 * @param root0 - Props.
 * @param root0.actions - The action buttons to render.
 * @param root0.handlerMap - Maps each action's handler name to its callback.
 * @param root0.disabled - Whether the trigger is disabled.
 * @param root0.t - Translation function.
 * @returns The dropdown element.
 */
function ActionGroupDropdown({
  actions,
  handlerMap,
  disabled,
  t,
}: {
  actions: ActionConfig[];
  handlerMap: Record<string, (() => void) | undefined>;
  disabled: boolean;
  // LiverRa's t() takes (key, params?) — only the key is used here.
  t: (key: string) => string;
}): JSX.Element {
  return (
    <Menu shadow="md" width={220} position="bottom" withArrow classNames={PACS_MENU_CLASSNAMES}>
      <Menu.Target>
        <Tooltip label={t('pacs.toolbar.viewportGroup')} position="bottom" withArrow>
          <button
            className="pacs-toolbar-btn pacs-group-trigger"
            disabled={disabled}
            aria-label={t('pacs.toolbar.viewportGroup')}
          >
            <IconRotateClockwise size={20} />
            <IconChevronDown size={12} className="pacs-group-chevron" />
          </button>
        </Tooltip>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>{t('pacs.toolbar.viewportGroup')}</Menu.Label>
        {actions.map(({ id, icon, labelKey, shortcut, handler }) => (
          <Menu.Item
            key={id}
            leftSection={icon}
            onClick={() => handlerMap[handler]?.()}
            rightSection={
              shortcut ? (
                <Text size="xs" c="dimmed">{shortcut}</Text>
              ) : undefined
            }
          >
            {t(labelKey)}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

// ============================================================================
// Component
// ============================================================================

/** Modalities that do NOT support MPR (flat 2D images only) */
const NON_VOLUMETRIC_MODALITIES = new Set(['XR', 'CR', 'US', 'DX', 'MG', 'IO']);

/**
 * Check if a modality supports MPR (volumetric 3D reconstruction).
 * X-ray, ultrasound, mammography etc. are flat 2D — can't slice them in 3D.
 *
 * @param modality - The DICOM modality code (e.g. 'CT', 'MR', 'XR').
 * @returns True if the modality is volumetric (supports MPR / 3D).
 */
export function isModalityVolumetric(modality: string): boolean {
  return !NON_VOLUMETRIC_MODALITIES.has(modality.toUpperCase());
}

function PACSToolbarInner({
  activeTool,
  onToolChange,
  onRotateCW,
  onRotateCCW,
  onFlipH,
  onFlipV,
  onReset,
  disabled = false,
  isMPRActive = false,
  onMPRToggle,
  isMPREnabled = true,
  is3DActive = false,
  on3DToggle,
  is3DEnabled = true,
  // 3D-cluster props (presets, isolate, crop, reset trio, MIP/slab) moved to
  // <Panel3DControls>. They are intentionally NOT destructured here anymore.
  onShowShortcuts,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  scrollSyncEnabled = false,
  wlSyncEnabled = false,
  onToggleScrollSync,
  onToggleWLSync,
  modality,
  isCalibrating = false,
  isStenosisActive = false,
  onCalibrate,
  onStenosis,
  isCalibrated = false,
  isDSAActive = false,
  onDSAToggle,
  segmentationPanelVisible = false,
  onToggleSegmentationPanel,
  activeImageFilter = null,
  onApplyImageFilter,
  onClearImageFilter,
  onClearAnnotations,
  activeViewportId,
  bodyPart,
  isReferenceLinesActive,
  onReferenceLinesToggle,
}: PACSToolbarProps): JSX.Element {
  const { t } = useTranslation();

  // Reference-lines toggle — local state when parent doesn't manage it.
  // Reference lines only make sense across multiple viewports, so the button
  // is only visible in MPR or 3D mode.
  const [localRefLinesActive, setLocalRefLinesActive] = useState(false);
  const refLinesActive = isReferenceLinesActive ?? localRefLinesActive;
  const handleReferenceLinesToggle = (): void => {
    if (onReferenceLinesToggle) {
      onReferenceLinesToggle();
      return;
    }
    // Local-managed toggle: drive Cornerstone3D's ToolGroup directly.
    // Only flip the pressed state if the underlying CS3D call succeeded;
    // otherwise the button would lie about its real tool-state.
    try {
      const group = getOrCreateToolGroup();
      if (!hasReferenceLinesToolMethods(group)) {
        return;
      }
      if (localRefLinesActive) {
        // setToolDisabled fully removes the tool from the render loop
        group.setToolDisabled('ReferenceLines');
      } else {
        // Enabled mode = visible passive overlay (no mouse interaction needed)
        group.setToolEnabled('ReferenceLines');
      }
      setLocalRefLinesActive((prev) => !prev);
    } catch (err) {
      console.warn('[PACSToolbar] reference-lines toggle failed:', err);
    }
  };

  // Map handler names to actual functions
  const handlerMap: Record<string, () => void> = {
    onRotateCW,
    onRotateCCW,
    onFlipH,
    onFlipV,
    onReset,
  };

  return (
    <div className="pacs-toolbar" role="toolbar" aria-label={t('pacs.toolbar')}>
      {/* Tool group dropdowns — Viewing, Measurement, ROI, Annotation */}
      <div className="pacs-toolbar-group" aria-label={t('pacs.a11y.toolGroup')}>
        {TOOL_GROUPS.map((group) => (
          <ToolGroupDropdown
            key={group.id}
            group={group}
            activeTool={activeTool}
            onToolChange={onToolChange}
            disabled={disabled}
            t={t}
          />
        ))}
      </div>

      {/* Segmentation panel toggle — show/hide the SegmentationPanel */}
      {onToggleSegmentationPanel && (
        <>
          <Tooltip
            label={t('imaging.segmentation.panel')}
            position="bottom"
            withArrow
          >
            <button
              className={`pacs-toolbar-btn ${segmentationPanelVisible ? 'active' : ''}`}
              onClick={onToggleSegmentationPanel}
              disabled={disabled}
              aria-label={t('imaging.segmentation.panel')}
              aria-pressed={segmentationPanelVisible}
            >
              <IconStack2 size={20} />
            </button>
          </Tooltip>
        </>
      )}


      {/* Viewport controls dropdown — rotate, flip, reset (instant actions) */}
      <ActionGroupDropdown
        actions={ACTIONS}
        handlerMap={handlerMap}
        disabled={disabled}
        t={t}
      />

      {/* Image Filter controls — sharpen/smooth dropdown */}
      {onApplyImageFilter && onClearImageFilter && (
        <ImageFilterControls
          activeFilter={activeImageFilter}
          onApplyFilter={onApplyImageFilter}
          onClearFilter={onClearImageFilter}
          disabled={disabled}
        />
      )}

      {/* Named viewing presets — save / recall per-user view snapshots */}
      <ViewingPresetsMenu
        activeViewportId={activeViewportId}
        modality={modality}
        bodyPart={bodyPart}
        disabled={disabled}
      />

      {/* Undo / Redo / Clear All buttons — only shown when handlers are provided */}
      {(onUndo || onRedo || onClearAnnotations) && (
        <>
          <div className="pacs-toolbar-group" aria-label={t('pacs.toolbar.undoRedoGroup')}>
            {onUndo && (
              <Tooltip label={`${t('pacs.toolbar.undo')} (Ctrl+Z)`} position="bottom" withArrow>
                <button
                  className="pacs-toolbar-btn"
                  onClick={onUndo}
                  disabled={disabled || !canUndo}
                  aria-label={t('pacs.toolbar.undo')}
                >
                  <IconArrowBackUp size={20} />
                </button>
              </Tooltip>
            )}
            {onRedo && (
              <Tooltip label={`${t('pacs.toolbar.redo')} (Ctrl+Shift+Z)`} position="bottom" withArrow>
                <button
                  className="pacs-toolbar-btn"
                  onClick={onRedo}
                  disabled={disabled || !canRedo}
                  aria-label={t('pacs.toolbar.redo')}
                >
                  <IconArrowForwardUp size={20} />
                </button>
              </Tooltip>
            )}
            {onClearAnnotations && (
              <Tooltip label={t('pacs.toolbar.clearAll')} position="bottom" withArrow>
                <button
                  className="pacs-toolbar-btn"
                  onClick={onClearAnnotations}
                  disabled={disabled}
                  aria-label={t('pacs.toolbar.clearAll')}
                >
                  <IconTrash size={20} />
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}

      {/* Viewport Sync toggles — sync scroll and W/L across viewports */}
      {(onToggleScrollSync || onToggleWLSync) && (
        <>
          <div className="pacs-toolbar-group" aria-label={t('pacs.toolbar.syncGroup')}>
            {onToggleScrollSync && (
              <Tooltip
                label={t('pacs.toolbar.syncScroll')}
                position="bottom"
                withArrow
              >
                <button
                  className={`pacs-toolbar-btn ${scrollSyncEnabled ? 'active' : ''}`}
                  onClick={onToggleScrollSync}
                  disabled={disabled}
                  aria-label={t('pacs.toolbar.syncScroll')}
                  aria-pressed={scrollSyncEnabled}
                >
                  {scrollSyncEnabled ? <IconLink size={20} /> : <IconLinkOff size={20} />}
                </button>
              </Tooltip>
            )}
            {onToggleWLSync && (
              <Tooltip
                label={t('pacs.toolbar.syncWL')}
                position="bottom"
                withArrow
              >
                <button
                  className={`pacs-toolbar-btn ${wlSyncEnabled ? 'active' : ''}`}
                  onClick={onToggleWLSync}
                  disabled={disabled}
                  aria-label={t('pacs.toolbar.syncWL')}
                  aria-pressed={wlSyncEnabled}
                >
                  <IconBrightnessHalf size={20} />
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}

      {/* Cardiology group — only visible for XA (angiography) modality */}
      {modality?.toUpperCase() === 'XA' && (onCalibrate || onStenosis || onDSAToggle) && (
        <>
          <div className="pacs-toolbar-group" aria-label={t('pacs.cardiology.toolbar')}>
            {/* Group label */}
            <span className="pacs-cardiology-label">
              {t('pacs.cardiology.toolbar')}
            </span>

            {/* Calibrate button */}
            {onCalibrate && (
              <Tooltip label={t('pacs.calibration.button')} position="bottom" withArrow>
                <button
                  className={`pacs-toolbar-btn ${isCalibrating ? 'active' : ''}`}
                  onClick={onCalibrate}
                  disabled={disabled}
                  aria-label={t('pacs.calibration.button')}
                  aria-pressed={isCalibrating}
                >
                  <IconRuler2 size={20} />
                </button>
              </Tooltip>
            )}

            {/* Stenosis button — with warning dot when not calibrated */}
            {onStenosis && (
              <Tooltip label={t('pacs.stenosis.button')} position="bottom" withArrow>
                <button
                  className={`pacs-toolbar-btn ${isStenosisActive ? 'active' : ''}`}
                  onClick={onStenosis}
                  disabled={disabled}
                  aria-label={t('pacs.a11y.narrowingTool')}
                  aria-pressed={isStenosisActive}
                  style={{ position: 'relative' }}
                >
                  <IconHeartbeat size={20} />
                  {/* Warning dot — not calibrated */}
                  {!isCalibrated && (
                    <span className="pacs-cardiology-warning-dot" title={t('pacs.calibration.warningUncalibrated')}>
                      <IconAlertCircle size={10} />
                    </span>
                  )}
                </button>
              </Tooltip>
            )}

            {/* DSA toggle button */}
            {onDSAToggle && (
              <Tooltip label={t('pacs.dsa.toggle')} position="bottom" withArrow>
                <button
                  className={`pacs-toolbar-btn ${isDSAActive ? 'active' : ''}`}
                  onClick={onDSAToggle}
                  disabled={disabled}
                  aria-label={t('pacs.dsa.toggle')}
                  aria-pressed={isDSAActive}
                >
                  <IconLayersSubtract size={20} />
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}

      {/* MPR toggle button — separate section */}
      {onMPRToggle && (
        <>

          <div className="pacs-toolbar-group" aria-label={t('pacs.tools.mprGroup')}>
            <Tooltip
              label={
                !isMPREnabled
                  ? t('pacs.tools.mprDisabled')
                  : `${t('pacs.tools.mpr')} (M)`
              }
              position="bottom"
              withArrow
            >
              <button
                className={`pacs-toolbar-btn ${isMPRActive ? 'active' : ''}`}
                onClick={onMPRToggle}
                disabled={disabled || !isMPREnabled}
                aria-label={t('pacs.tools.mpr')}
                aria-pressed={isMPRActive}
                data-shortcut="M"
              >
                <IconBox size={20} />
              </button>
            </Tooltip>

            {/* Reference-lines toggle — only visible when MPR or 3D is active */}
            {(isMPRActive || is3DActive) && (
              <Tooltip
                label={`${t('pacs.toolbar.referenceLines')} (K)`}
                position="bottom"
                withArrow
              >
                <button
                  className={`pacs-toolbar-btn ${refLinesActive ? 'active' : ''}`}
                  onClick={handleReferenceLinesToggle}
                  disabled={disabled}
                  aria-label={t('pacs.toolbar.referenceLines')}
                  aria-pressed={refLinesActive}
                  data-shortcut="K"
                >
                  <IconLineDashed size={20} />
                </button>
              </Tooltip>
            )}
          </div>
        </>
      )}

      {/* 3D Volume Rendering toggle button */}
      {on3DToggle && (
        <>

          <div className="pacs-toolbar-group" aria-label={t('pacs.tools.3dGroup')}>
            <Tooltip
              label={
                !is3DEnabled
                  ? t('pacs.tools.3dDisabled')
                  : `${t('pacs.tools.3d')} (3)`
              }
              position="bottom"
              withArrow
            >
              <button
                className={`pacs-toolbar-btn ${is3DActive ? 'active' : ''}`}
                onClick={on3DToggle}
                disabled={disabled || !is3DEnabled}
                aria-label={t('pacs.tools.3d')}
                aria-pressed={is3DActive}
                data-shortcut="3"
              >
                <IconCube size={20} />
              </button>
            </Tooltip>

            {/* NOTE (Wave 8G.13 — 3D-controls relocation, 2026-06-03):
                The full 3D cluster (rendering presets, reset trio, crop toggle,
                structure-isolation + its ghost-opacity slider, and the MIP/MinIP
                slab controls) used to live HERE, inline in the toolbar. It has
                moved into the dedicated, labelled <Panel3DControls> side panel
                (rendered by PACSViewer when 3D is active) for readability and
                space. Only the IconCube 3D toggle and the reference-lines button
                remain in the toolbar. Do NOT re-add the cluster here. */}
          </div>
        </>
      )}

      {/* Keyboard shortcuts help — optional standalone button for toolbar-only renders */}
      {onShowShortcuts && (
        <Tooltip label={t('pacs.shortcuts.title')} position="bottom" withArrow>
          <button
            className="pacs-toolbar-btn"
            onClick={onShowShortcuts}
            disabled={disabled}
            aria-label={t('pacs.shortcuts.title')}
          >
            <IconKeyboard size={20} />
          </button>
        </Tooltip>
      )}

    </div>
  );
}

/**
 * Memoized PACSToolbar — skips re-renders when props haven't changed.
 * This prevents 30-60 re-renders/sec during camera drag events.
 */
export const PACSToolbar = React.memo(PACSToolbarInner);
