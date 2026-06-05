// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// DSAControls — settings bar for Digital Subtraction Angiography
// Shows when DSA is active. Lets the user pick the mask frame, adjust pixel
// shift (motion correction), and toggle between subtracted/original view.

import { Group, Slider, Text, Tooltip, NumberInput } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';

export interface DSAControlsProps {
  /** Index of the mask (pre-contrast) frame */
  maskFrameIndex: number;
  /** Total number of frames in the current series */
  totalFrames: number;
  /** Horizontal pixel shift for motion correction */
  shiftX: number;
  /** Vertical pixel shift for motion correction */
  shiftY: number;
  /** Whether showing the original (un-subtracted) frame */
  showOriginal: boolean;
  /** Called when user changes the mask frame index */
  onMaskFrameChange: (index: number) => void;
  /** Called when user changes the pixel shift */
  onShiftChange: (x: number, y: number) => void;
  /** Called when user toggles showOriginal */
  onToggleShowOriginal: () => void;
}

export function DSAControls({
  maskFrameIndex,
  totalFrames,
  shiftX,
  shiftY,
  showOriginal,
  onMaskFrameChange,
  onShiftChange,
  onToggleShowOriginal,
}: DSAControlsProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className="pacs-dsa-controls"
      role="toolbar"
      aria-label={t('pacs.dsa.controls')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '4px 12px',
        backgroundColor: 'var(--emr-bg-card)',
        borderBottom: '1px solid var(--emr-border-color)',
        flexWrap: 'wrap',
        minHeight: 44,
      }}
    >
      {/* Mask frame selector */}
      <Group gap={6} style={{ flexShrink: 0 }}>
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', color: 'var(--emr-text-secondary)' }}>
          {t('pacs.dsa.maskFrame')}:
        </Text>
        <NumberInput
          value={maskFrameIndex}
          onChange={(val) => onMaskFrameChange(typeof val === 'number' ? val : 0)}
          min={0}
          max={Math.max(0, totalFrames - 1)}
          size="xs"
          styles={{ input: { width: 60, textAlign: 'center' } }}
          aria-label={t('pacs.dsa.maskFrame')}
        />
        <Text size="xs" c="dimmed">/ {totalFrames - 1}</Text>
      </Group>

      {/* Pixel shift X */}
      <Group gap={6} style={{ flexShrink: 0 }}>
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', color: 'var(--emr-text-secondary)' }}>
          {t('pacs.dsa.shiftX')}:
        </Text>
        <Slider
          value={shiftX}
          onChange={(val) => onShiftChange(val, shiftY)}
          min={-20}
          max={20}
          step={1}
          size="xs"
          style={{ width: 100 }}
          aria-label={t('pacs.dsa.shiftX')}
          marks={[{ value: 0 }]}
        />
        <Text size="xs" c="dimmed" style={{ width: 24, textAlign: 'right' }}>{shiftX}</Text>
      </Group>

      {/* Pixel shift Y */}
      <Group gap={6} style={{ flexShrink: 0 }}>
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap', color: 'var(--emr-text-secondary)' }}>
          {t('pacs.dsa.shiftY')}:
        </Text>
        <Slider
          value={shiftY}
          onChange={(val) => onShiftChange(shiftX, val)}
          min={-20}
          max={20}
          step={1}
          size="xs"
          style={{ width: 100 }}
          aria-label={t('pacs.dsa.shiftY')}
          marks={[{ value: 0 }]}
        />
        <Text size="xs" c="dimmed" style={{ width: 24, textAlign: 'right' }}>{shiftY}</Text>
      </Group>

      {/* Show original toggle */}
      <Tooltip
        label={showOriginal ? t('pacs.dsa.showSubtracted') : t('pacs.dsa.showOriginal')}
        position="bottom"
        withArrow
      >
        <button
          className={`pacs-toolbar-btn ${showOriginal ? '' : 'active'}`}
          onClick={onToggleShowOriginal}
          aria-label={showOriginal ? t('pacs.dsa.showSubtracted') : t('pacs.dsa.showOriginal')}
          aria-pressed={!showOriginal}
          style={{ minWidth: 44, minHeight: 44 }}
        >
          {showOriginal ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </Tooltip>
    </div>
  );
}
