// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ViewingPresetsMenu — Save / Apply Named Viewing Presets
// ============================================================================
// Toolbar dropdown that lets a radiologist:
//   1. Save the current viewport state (zoom / W-L / rotation / flips) as a
//      named preset, scoped to their own user account.
//   2. Recall any saved preset with one click — applies state to the active
//      viewport.
//   3. Delete presets they no longer want.
//
// Think of it like camera presets on a security console: line up the shot,
// hit "save," then jump back to that exact framing any time you need it.
//
// Storage: per-user via `viewingPresetsService.ts` (Basic resources).
// Filter: presets created without a modality/bodyPart filter always show;
// presets with filters only show when the current study matches.
// ============================================================================

import { useEffect, useState, useCallback } from 'react';
import { Menu } from '@mantine/core';
import { EMRTooltip } from '../common/EMRTooltip';
import {
  IconCamera,
  IconChevronDown,
  IconDeviceFloppy,
  IconTrash,
} from '@tabler/icons-react';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import { useAuth } from '../../services/auth';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRModal } from '../common/EMRModal';
import { EMRTextInput } from '../shared/EMRFormFields';
import {
  listPresets,
  savePreset,
  deletePreset,
  type ViewingPreset,
} from '../../services/pacs/viewingPresetsService';
import { getOrCreateRenderingEngine } from '../../services/pacs/cornerstoneInit';

// ============================================================================
// Types
// ============================================================================

export interface ViewingPresetsMenuProps {
  /** ID of the currently active Cornerstone3D viewport */
  activeViewportId?: string;
  /** Current study modality — used to filter relevant presets */
  modality?: string;
  /** Current study body part — used to filter relevant presets */
  bodyPart?: string;
  /** Disable the menu (e.g., during study loading) */
  disabled?: boolean;
}

// ============================================================================
// Viewport state helpers — Cornerstone3D API
// ============================================================================

interface ViewportStateSnapshot {
  windowCenter: number;
  windowWidth: number;
  zoom: number;
  rotationDegrees: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  cameraPosition?: number[];
}

interface ViewingPresetViewport {
  getProperties?: () => {
    voiRange?: { lower: number; upper: number };
    rotation?: number;
    flipHorizontal?: boolean;
    flipVertical?: boolean;
  };
  getZoom?: () => number;
  getCamera?: () => { position?: number[] };
  setProperties?: (props: Record<string, unknown>) => void;
  setZoom?: (z: number) => void;
  setCamera?: (c: { position?: number[] }) => void;
  render?: () => void;
}

/** Read the current state from the active Cornerstone3D viewport. */
function captureViewportState(activeViewportId?: string): ViewportStateSnapshot | null {
  if (!activeViewportId) {
    return null;
  }
  try {
    const re = getOrCreateRenderingEngine();
    const vp = re.getViewport(activeViewportId);
    if (!vp) {
      return null;
    }
    // Cornerstone3D returns a generic viewport — narrow lazily to the
    // properties we care about.
    const viewport = vp as ViewingPresetViewport;

    const props = viewport.getProperties?.() ?? {};
    const voi = props.voiRange;
    const windowCenter = voi ? (voi.upper + voi.lower) / 2 : 40;
    const windowWidth = voi ? voi.upper - voi.lower : 400;
    const zoom = viewport.getZoom?.() ?? 1;
    const rotationDegrees = props.rotation ?? 0;
    const flipHorizontal = props.flipHorizontal ?? false;
    const flipVertical = props.flipVertical ?? false;
    const cameraPosition = viewport.getCamera?.()?.position;

    return {
      windowCenter,
      windowWidth,
      zoom,
      rotationDegrees,
      flipHorizontal,
      flipVertical,
      cameraPosition,
    };
  } catch (err) {
    console.warn('[ViewingPresetsMenu] best-effort PACS operation failed:', err);
    return null;
  }
}

/** Apply a viewport state snapshot to the active Cornerstone3D viewport. */
function applyViewportState(activeViewportId: string | undefined, state: ViewportStateSnapshot): void {
  if (!activeViewportId) {
    return;
  }
  try {
    const re = getOrCreateRenderingEngine();
    const vp = re.getViewport(activeViewportId);
    if (!vp) {
      return;
    }
    const viewport = vp as ViewingPresetViewport;

    const voiRange = {
      lower: state.windowCenter - state.windowWidth / 2,
      upper: state.windowCenter + state.windowWidth / 2,
    };

    viewport.setProperties?.({
      voiRange,
      rotation: state.rotationDegrees,
      flipHorizontal: state.flipHorizontal,
      flipVertical: state.flipVertical,
    });

    viewport.setZoom?.(state.zoom);

    if (state.cameraPosition && state.cameraPosition.length === 3) {
      viewport.setCamera?.({ position: state.cameraPosition });
    }

    viewport.render?.();
  } catch (err) {
    console.warn('[ViewingPresetsMenu] best-effort PACS operation failed:', err);
  }
}

// ============================================================================
// Component
// ============================================================================

export function ViewingPresetsMenu({
  activeViewportId,
  modality,
  bodyPart,
  disabled = false,
}: ViewingPresetsMenuProps): JSX.Element {
  const fhir = useLiverraFhir();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [presets, setPresets] = useState<ViewingPreset[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  // Phase-2 auth may run unauthenticated locally — fall back to the same
  // stable "local-user" identity annotationService uses.
  const ownerId = user?.id ?? 'local-user';

  const refreshPresets = useCallback(async () => {
    if (!ownerId) {
      return;
    }
    setLoading(true);
    try {
      const result = await listPresets(fhir, ownerId, { modality, bodyPart });
      setPresets(result);
    } finally {
      setLoading(false);
    }
  }, [fhir, ownerId, modality, bodyPart]);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  const handleSave = async (): Promise<void> => {
    if (!ownerId || !newName.trim()) {
      return;
    }
    const snapshot = captureViewportState(activeViewportId);
    if (!snapshot) {
      return;
    }
    setSaving(true);
    try {
      const preset: ViewingPreset = {
        name: newName.trim(),
        ownerId,
        modality: modality || undefined,
        bodyPart: bodyPart || undefined,
        windowCenter: snapshot.windowCenter,
        windowWidth: snapshot.windowWidth,
        zoom: snapshot.zoom,
        rotationDegrees: snapshot.rotationDegrees,
        flipHorizontal: snapshot.flipHorizontal,
        flipVertical: snapshot.flipVertical,
        cameraPosition: snapshot.cameraPosition,
        createdAt: new Date().toISOString(),
      };
      await savePreset(fhir, preset);
      setNewName('');
      setSaveModalOpen(false);
      await refreshPresets();
    } finally {
      setSaving(false);
    }
  };

  const handleApply = (preset: ViewingPreset): void => {
    applyViewportState(activeViewportId, {
      windowCenter: preset.windowCenter,
      windowWidth: preset.windowWidth,
      zoom: preset.zoom,
      rotationDegrees: preset.rotationDegrees,
      flipHorizontal: preset.flipHorizontal,
      flipVertical: preset.flipVertical,
      cameraPosition: preset.cameraPosition,
    });
  };

  const handleDelete = async (id: string | undefined): Promise<void> => {
    if (!id) {
      return;
    }
    try {
      await deletePreset(fhir, id);
      await refreshPresets();
    } catch (err) {
      console.warn('[ViewingPresetsMenu] preset delete failed:', err);
    }
  };

  return (
    <>
      <Menu shadow="md" width={260} position="bottom" withArrow closeOnItemClick={false} classNames={{ dropdown: 'pacs-menu-dropdown', item: 'pacs-menu-item', label: 'pacs-menu-label', divider: 'pacs-menu-divider' }}>
        <Menu.Target>
          <EMRTooltip label={t('pacs.viewingPresets.menuLabel')} position="bottom">
            <button
              className="pacs-toolbar-btn pacs-group-trigger"
              disabled={disabled}
              aria-label={t('pacs.viewingPresets.menuLabel')}
            >
              <IconCamera size={20} />
              <IconChevronDown size={12} className="pacs-group-chevron" />
            </button>
          </EMRTooltip>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Label>{t('pacs.viewingPresets.menuLabel')}</Menu.Label>

          <Menu.Item
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={() => setSaveModalOpen(true)}
            disabled={!activeViewportId || !ownerId}
          >
            {t('pacs.viewingPresets.saveCurrent')}
          </Menu.Item>

          <Menu.Divider />

          {loading && (
            <Menu.Item disabled>
              <span style={{ color: 'var(--emr-text-secondary)', fontSize: 'var(--emr-font-xs)' }}>
                {t('common.loading')}
              </span>
            </Menu.Item>
          )}

          {!loading && presets.length === 0 && (
            <Menu.Item disabled>
              <span style={{ color: 'var(--emr-text-secondary)', fontSize: 'var(--emr-font-xs)' }}>
                {t('pacs.viewingPresets.noneYet')}
              </span>
            </Menu.Item>
          )}

          {!loading &&
            presets.map((preset) => (
              <Menu.Item
                key={preset.id}
                onClick={() => handleApply(preset)}
                rightSection={
                  <button
                    type="button"
                    aria-label={t('pacs.viewingPresets.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(preset.id);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--emr-error)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: 2,
                    }}
                  >
                    <IconTrash size={14} />
                  </button>
                }
              >
                {preset.name}
              </Menu.Item>
            ))}
        </Menu.Dropdown>
      </Menu>

      <EMRModal
        opened={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        size="sm"
        icon={IconDeviceFloppy}
        title={t('pacs.viewingPresets.saveCurrent')}
        cancelLabel={t('common.cancel')}
        submitLabel={t('common.save')}
        onSubmit={handleSave}
        submitLoading={saving}
        submitDisabled={!newName.trim()}
      >
        <EMRTextInput
          label={t('pacs.viewingPresets.namePrompt')}
          value={newName}
          onChange={(v) => setNewName(v)}
          required
          autoFocus
        />
      </EMRModal>
    </>
  );
}
