// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Panel3DControls Component
// ============================================================================
// Right-docked, collapsible "3D Controls" panel for the Cornerstone3D VR
// viewer. It RELOCATES the 3D cluster that used to live inline in the PACS
// toolbar into a proper, labelled, scrollable side panel — replacing cryptic
// 2-letter badges and a row of bare reset icons with readable controls.
//
// Sections (top → bottom):
//   1. Interaction   — Rotate | Crop | Isolate (segmented), + "Show all"
//   2. Rendering preset — Bone / Soft Tissue / Lung / Vascular / CTA Vessel
//   3. Orientation   — A P L R S I anatomical pose buttons
//   4. Projection    — Default | MIP | MinIP (+ Average), + slab slider
//   5. Reset         — Reset 3D view + Reset rotation / Reset crop
//   6. Capture       — Capture key image
//
// Every control no-ops gracefully when its handler prop is undefined. All
// colours come from theme variables; every string goes through t().
// ============================================================================

import { memo } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  IconRotate360,
  IconCrop,
  IconFocus2,
  IconEraser,
  IconScissors,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconRestore,
  IconCube,
  IconCamera,
  IconX,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton } from '../common/EMRButton';
import { EMRSlider } from '../shared/EMRFormFields/EMRSlider';
import type {
  TransferFunctionPreset,
  RenderingMode,
  VrInteractionMode,
} from '../../types/pacs';
import './Panel3DControls.css';

// ============================================================================
// Types
// ============================================================================

/** Anatomical orientation axes (LPS) used by the orientation row. */
export type OrientationAxis = 'A' | 'P' | 'L' | 'R' | 'S' | 'I';

export interface Panel3DControlsProps {
  /** Whether the panel is expanded (false = collapsed header only) */
  expanded: boolean;
  /** Toggle the panel expand/collapse */
  onToggleExpanded: () => void;
  /** Fully close (hide) the panel — reopened via the topbar button */
  onClose?: () => void;
  /** Globally disable all controls (e.g. during a load) */
  disabled?: boolean;

  // ── Interaction (relocated from PACSToolbar, same names/types) ────────────
  /** Current VR-pane mouse-interaction mode: 'rotate' or 'crop' */
  vrInteractionMode?: VrInteractionMode;
  /** Toggle VR pane between rotate and crop mode */
  onVrInteractionModeChange?: (mode: VrInteractionMode) => void;

  // ── Structure isolation ───────────────────────────────────────────────────
  /** Toggle the Isolate tool (arms click-to-isolate or exits isolation) */
  onIsolateToggle?: () => void;
  /** Whether the Isolate tool is armed (awaiting a click on the VR pane) */
  isIsolateArmed?: boolean;
  /** Whether a structure is currently isolated */
  isIsolateActive?: boolean;
  /** Reset / "Show all" — clears isolation */
  onIsolateReset?: () => void;
  /** Whether an isolate operation is in progress */
  isIsolateLoading?: boolean;
  /** Whether the current user may isolate structures */
  canIsolate?: boolean;

  // ── Cut tools (Remove = click a structure to delete it; Scalpel = drag-box cut) ──
  /** Which cut tool is armed: 'none' | 'remove' | 'scalpel'. */
  cutMode?: 'none' | 'remove' | 'scalpel';
  /** Arm/disarm a cut tool (pass 'none' to disarm). */
  onCutModeChange?: (mode: 'none' | 'remove' | 'scalpel') => void;
  /** Number of cuts currently applied (for the "Cuts: N" indicator + Reset enablement). */
  cutCount?: number;
  /** Clear ALL cuts and restore the full volume. */
  onResetCuts?: () => void;
  /** Whether a cut operation (scalpel sweep) is in progress. */
  isCutLoading?: boolean;
  /** Whether the current user may edit the VR (reuse of the isolate permission). */
  canRemove?: boolean;

  // ── Rendering preset ──────────────────────────────────────────────────────
  /** Called when user selects a transfer function preset */
  onPresetChange?: (preset: TransferFunctionPreset) => void;
  /** Currently active transfer function preset */
  activePreset?: TransferFunctionPreset;

  // ── Orientation (new) ─────────────────────────────────────────────────────
  /** Snap the VR camera to an anatomical pose. Best-effort; never throws. */
  onOrientationPreset?: (axis: OrientationAxis) => void;

  // ── Projection (MIP/MinIP slab) ───────────────────────────────────────────
  /** Current rendering mode */
  renderingMode?: RenderingMode;
  /** Called when user changes the rendering mode */
  onRenderingModeChange?: (mode: RenderingMode) => void;
  /** Current slab thickness in mm (1-50) */
  slabThickness?: number;
  /** Called when user changes the slab thickness */
  onSlabThicknessChange?: (thickness: number) => void;

  // ── Reset ─────────────────────────────────────────────────────────────────
  /** Reset rotation only */
  onReset3DRotation?: () => void;
  /** Reset the crop box to full volume extents */
  onResetCrop?: () => void;
  /** Full revert of the 3D view (rotation + crop + blend + slab + preset) */
  onReset3DView?: () => void;

  // ── Capture (new) ─────────────────────────────────────────────────────────
  /** Capture the current VR pane as a key image. Best-effort; never throws. */
  onCaptureScreenshot?: () => void;
}

// ============================================================================
// Static configuration
// ============================================================================

/** Rendering presets in display order, with their i18n label keys. */
const PRESETS: readonly { value: TransferFunctionPreset; labelKey: string }[] = [
  { value: 'Bone', labelKey: 'pacs.tools.preset.Bone' },
  { value: 'SoftTissue', labelKey: 'pacs.tools.preset.SoftTissue' },
  { value: 'Lung', labelKey: 'pacs.tools.preset.Lung' },
  { value: 'Vascular', labelKey: 'pacs.tools.preset.Vascular' },
  { value: 'CtVessel', labelKey: 'pacs.tools.preset.CtVessel' },
];

/** Orientation buttons: axis + i18n label key + short glyph. */
const ORIENTATIONS: readonly { axis: OrientationAxis; labelKey: string; glyph: string }[] = [
  { axis: 'A', labelKey: 'pacs.tools.orientAnterior', glyph: 'A' },
  { axis: 'P', labelKey: 'pacs.tools.orientPosterior', glyph: 'P' },
  { axis: 'L', labelKey: 'pacs.tools.orientLeft', glyph: 'L' },
  { axis: 'R', labelKey: 'pacs.tools.orientRight', glyph: 'R' },
  { axis: 'S', labelKey: 'pacs.tools.orientSuperior', glyph: 'S' },
  { axis: 'I', labelKey: 'pacs.tools.orientInferior', glyph: 'I' },
];

/** Projection modes: rendering mode + i18n label key. */
const PROJECTIONS: readonly { value: RenderingMode; labelKey: string }[] = [
  { value: 'default', labelKey: 'pacs.mip.default' },
  { value: 'mip', labelKey: 'pacs.mip.title' },
  { value: 'minip', labelKey: 'pacs.minip.title' },
  // 'average' is best-effort: extended in types/pacs.ts; the engine handler may
  // ignore it (degrades to no slab projection change) — that is acceptable.
  { value: 'average', labelKey: 'pacs.mip.average' },
];

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Small uppercase section heading.
 *
 * @param root0 - Props.
 * @param root0.children - Heading content.
 * @returns The heading element.
 */
function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return <Text className="pacs-panel3d-heading">{children}</Text>;
}

/**
 * A themed segmented control built from EMR-styled buttons (no raw Mantine
 * SegmentedControl, which has no wrapper). Each option is a 44px-tall pill;
 * the selected one gets the accent treatment. Options may be disabled.
 *
 * @param root0 - Props.
 * @param root0.options - Selectable options (value + label + optional icon/disabled/pressed).
 * @param root0.value - Currently selected option value.
 * @param root0.onSelect - Called with the chosen option value.
 * @param root0.ariaLabel - Accessible group label.
 * @returns The segmented control element.
 */
function SegmentedRow({
  options,
  value,
  onSelect,
  ariaLabel,
}: {
  options: readonly { value: string; label: string; icon?: React.ReactNode; disabled?: boolean; pressed?: boolean }[];
  value: string;
  onSelect: (value: string) => void;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="pacs-panel3d-segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isActive = opt.pressed ?? value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            className={`pacs-panel3d-seg-btn ${isActive ? 'active' : ''}`}
            onClick={() => onSelect(opt.value)}
            disabled={opt.disabled}
            aria-pressed={isActive}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

function Panel3DControlsInner({
  expanded,
  onToggleExpanded,
  onClose,
  disabled = false,
  vrInteractionMode = 'rotate',
  onVrInteractionModeChange,
  onIsolateToggle,
  isIsolateArmed = false,
  isIsolateActive = false,
  onIsolateReset,
  isIsolateLoading = false,
  canIsolate = false,
  cutMode = 'none',
  onCutModeChange,
  cutCount = 0,
  onResetCuts,
  isCutLoading = false,
  canRemove = false,
  onPresetChange,
  activePreset,
  onOrientationPreset,
  renderingMode = 'default',
  onRenderingModeChange,
  slabThickness = 10,
  onSlabThicknessChange,
  onReset3DRotation,
  onResetCrop,
  onReset3DView,
  onCaptureScreenshot,
}: Panel3DControlsProps): JSX.Element {
  const { t } = useTranslation();

  const isolateActiveOrArmed = isIsolateArmed || isIsolateActive;
  const isolateDisabled = disabled || !canIsolate || isIsolateLoading;

  // Interaction segmented: rotate / crop drive the VR mode; isolate is a toggle;
  // remove / scalpel are cut tools layered over the same row (like isolate).
  // The "current" value reflects isolate when armed/active, else the active cut
  // tool when armed, else the VR mode.
  const interactionValue = isolateActiveOrArmed
    ? 'isolate'
    : cutMode !== 'none'
      ? cutMode
      : vrInteractionMode;
  const handleInteractionSelect = (next: string): void => {
    if (next === 'isolate') {
      // Arming isolate should exit any armed cut tool first.
      if (cutMode !== 'none') {
        onCutModeChange?.('none');
      }
      onIsolateToggle?.();
      return;
    }
    if (next === 'remove' || next === 'scalpel') {
      // Picking a cut tool while isolating should exit isolation first.
      if (isolateActiveOrArmed) {
        onIsolateReset?.();
      }
      onCutModeChange?.(next);
      return;
    }
    // Selecting rotate/crop while isolating or cutting should also drop those
    // modes so the VR mode actually changes — disarm first, then set the mode.
    if (isolateActiveOrArmed) {
      onIsolateReset?.();
    }
    if (cutMode !== 'none') {
      onCutModeChange?.('none');
    }
    onVrInteractionModeChange?.(next as VrInteractionMode);
  };

  const interactionOptions = [
    { value: 'rotate', label: t('pacs.panel3d.rotate'), icon: <IconRotate360 size={16} /> },
    {
      value: 'crop',
      label: t('pacs.tools.cropBox'),
      icon: <IconCrop size={16} />,
      disabled: disabled || !onVrInteractionModeChange,
    },
    {
      value: 'isolate',
      label: t('pacs.tools.isolate'),
      icon: <IconFocus2 size={16} />,
      disabled: !onIsolateToggle || isolateDisabled,
      pressed: isolateActiveOrArmed,
    },
    {
      value: 'remove',
      label: t('pacs.tools.remove'),
      icon: <IconEraser size={16} />,
      disabled: !onCutModeChange || disabled || !canRemove,
      pressed: cutMode === 'remove',
    },
    {
      value: 'scalpel',
      label: t('pacs.tools.scalpel'),
      icon: <IconScissors size={16} />,
      disabled: !onCutModeChange || disabled || !canRemove,
      pressed: cutMode === 'scalpel',
    },
  ];

  return (
    <aside
      className={`pacs-panel3d ${expanded ? 'expanded' : 'collapsed'}`}
      aria-label={t('pacs.tools.3dGroup')}
      data-testid="pacs-panel3d"
    >
      {/* Header — title + collapse chevron + optional close */}
      <div className="pacs-panel3d-header">
        <button
          type="button"
          className="pacs-panel3d-collapse"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={t('pacs.tools.3dGroup')}
        >
          {expanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
          <IconCube size={18} />
          <span className="pacs-panel3d-title">{t('pacs.panel3d.title')}</span>
        </button>
        {onClose && (
          <button
            type="button"
            className="pacs-panel3d-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconX size={16} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="pacs-panel3d-body">
          {/* 1. Interaction */}
          <section className="pacs-panel3d-section">
            <SectionHeading>{t('pacs.panel3d.interaction')}</SectionHeading>
            <SegmentedRow
              options={interactionOptions}
              value={interactionValue}
              onSelect={handleInteractionSelect}
              ariaLabel={t('pacs.panel3d.interaction')}
            />
            <Text className="pacs-panel3d-hint">
              {t('pacs.panel3d.interactionHint')}
            </Text>
            {isolateActiveOrArmed && onIsolateReset && (
              <Box mt={8}>
                <EMRButton
                  variant="secondary"
                  size="sm"
                  fullWidth
                  icon={IconRestore}
                  onClick={onIsolateReset}
                  disabled={disabled || isIsolateLoading}
                >
                  {t('pacs.tools.isolateReset')}
                </EMRButton>
              </Box>
            )}
            {isIsolateLoading && (
              <Text className="pacs-panel3d-loading" mt={6}>
                {t('pacs.tools.isolateLoading')}
              </Text>
            )}

            {/* Cut tools state: hint + count + reset + working line */}
            {(cutMode !== 'none' || cutCount > 0) && (
              <Box mt={8}>
                {cutMode === 'remove' && (
                  <Text className="pacs-panel3d-hint">
                    {t('pacs.tools.removeHint')}
                  </Text>
                )}
                {cutMode === 'scalpel' && (
                  <Text className="pacs-panel3d-hint">
                    {t('pacs.tools.scalpelHint')}
                  </Text>
                )}
                {cutCount > 0 && (
                  <Text className="pacs-panel3d-cut-count" mt={6}>
                    {t('pacs.tools.cutsApplied', { count: cutCount })}
                  </Text>
                )}
                <Box mt={8}>
                  <EMRButton
                    variant="secondary"
                    size="sm"
                    fullWidth
                    icon={IconRestore}
                    onClick={onResetCuts}
                    disabled={disabled || isCutLoading || cutCount === 0}
                  >
                    {t('pacs.tools.resetCuts')}
                  </EMRButton>
                </Box>
                {isCutLoading && (
                  <Text className="pacs-panel3d-loading" mt={6}>
                    {t('pacs.tools.removedStructure')}
                  </Text>
                )}
              </Box>
            )}
          </section>

          {/* 2. Rendering preset */}
          {onPresetChange && (
            <section className="pacs-panel3d-section">
              <SectionHeading>{t('pacs.panel3d.preset')}</SectionHeading>
              <div className="pacs-panel3d-preset-grid">
                {PRESETS.map((p) => {
                  const isActive = activePreset === p.value;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      className={`pacs-panel3d-preset-btn ${isActive ? 'active' : ''}`}
                      onClick={() => onPresetChange?.(p.value)}
                      disabled={disabled}
                      aria-pressed={isActive}
                    >
                      {t(p.labelKey)}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 3. Orientation */}
          {onOrientationPreset && (
            <section className="pacs-panel3d-section">
              <SectionHeading>{t('pacs.panel3d.orientation')}</SectionHeading>
              <div className="pacs-panel3d-orient-grid" role="group" aria-label={t('pacs.panel3d.orientation')}>
                {ORIENTATIONS.map((o) => (
                  <button
                    key={o.axis}
                    type="button"
                    className="pacs-panel3d-orient-btn"
                    onClick={() => onOrientationPreset?.(o.axis)}
                    disabled={disabled}
                    aria-label={t(o.labelKey)}
                    title={t(o.labelKey)}
                  >
                    {o.glyph}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* 4. Projection */}
          {onRenderingModeChange && (
            <section className="pacs-panel3d-section">
              <SectionHeading>{t('pacs.panel3d.projection')}</SectionHeading>
              <SegmentedRow
                options={PROJECTIONS.map((p) => ({
                  value: p.value,
                  label: t(p.labelKey),
                  disabled,
                }))}
                value={renderingMode}
                onSelect={(v) => onRenderingModeChange?.(v as RenderingMode)}
                ariaLabel={t('pacs.panel3d.projection')}
              />
              {renderingMode !== 'default' && onSlabThicknessChange && (
                <Box mt={10}>
                  <EMRSlider
                    label={t('pacs.mip.slabThickness')}
                    value={slabThickness}
                    onChange={onSlabThicknessChange}
                    min={1}
                    max={50}
                    step={1}
                    unit="mm"
                    size="sm"
                    disabled={disabled}
                  />
                </Box>
              )}
            </section>
          )}

          {/* 5. Reset */}
          {(onReset3DView || onReset3DRotation || onResetCrop) && (
            <section className="pacs-panel3d-section">
              <SectionHeading>{t('pacs.panel3d.reset')}</SectionHeading>
              <Stack gap={8}>
                {onReset3DView && (
                  <EMRButton
                    variant="secondary"
                    size="sm"
                    fullWidth
                    icon={IconCube}
                    onClick={onReset3DView}
                    disabled={disabled}
                  >
                    {t('pacs.tools.reset3DView')}
                  </EMRButton>
                )}
                <Group gap={8} grow wrap="nowrap">
                  {onReset3DRotation && (
                    <EMRButton
                      variant="ghost"
                      size="sm"
                      icon={IconRefresh}
                      onClick={onReset3DRotation}
                      disabled={disabled}
                    >
                      {t('pacs.tools.reset3DRotation')}
                    </EMRButton>
                  )}
                  {onResetCrop && (
                    <EMRButton
                      variant="ghost"
                      size="sm"
                      icon={IconRestore}
                      onClick={onResetCrop}
                      disabled={disabled}
                    >
                      {t('pacs.tools.resetCrop')}
                    </EMRButton>
                  )}
                </Group>
              </Stack>
            </section>
          )}

          {/* 6. Capture */}
          <section className="pacs-panel3d-section">
            <SectionHeading>{t('pacs.panel3d.capture')}</SectionHeading>
            <EMRButton
              variant="primary"
              size="sm"
              fullWidth
              icon={IconCamera}
              onClick={() => onCaptureScreenshot?.()}
              disabled={disabled || !onCaptureScreenshot}
            >
              {t('pacs.tools.screenshot')}
            </EMRButton>
          </section>
        </div>
      )}
    </aside>
  );
}

/**
 * Memoized Panel3DControls — skips re-renders when props are unchanged, so VR
 * camera-drag churn in the parent doesn't repaint the whole panel.
 */
export const Panel3DControls = memo(Panel3DControlsInner);

export default Panel3DControls;
