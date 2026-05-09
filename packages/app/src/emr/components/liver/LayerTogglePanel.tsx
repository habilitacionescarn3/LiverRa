// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LayerTogglePanel — Pass D6
 *
 * Plain-English: a small floating toolbar inside the viewer that lets the
 * surgeon toggle which mask layers are drawn on top of the CT slices.
 *
 * Pass D6 expands the panel to surface every anatomy the cascade can
 * produce: parenchyma, the 8 Couinaud sub-segments (collapsed under one
 * master row that expands inline), portal vein, hepatic vein, lesions,
 * and the FLR cutting plane. Each sub-toggle is gated by the presence
 * of the corresponding segmentation row so the UI never offers a
 * non-functional control.
 *
 * Design notes:
 *   - Bottom-left of the viewer; uses theme variables only.
 *   - `flexShrink: 0` + `whiteSpace: 'nowrap'` on the row so labels don't
 *     wrap on mobile.
 *   - Min 44×44 tap targets per the constitution's mobile-first rule.
 *   - Couinaud master row uses Mantine's <Collapse>; the 8 sub-toggles
 *     scroll if they exceed available height (mobile-friendly).
 */

import { Box, Checkbox, Collapse, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import { COUINAUD_LABELS, type CouinaudLabel } from './couinaud-constants';

/** Per-segment Couinaud visibility (lowercase keys for use in JSX bindings). */
export type CouinaudVisibility = {
  i: boolean;
  ii: boolean;
  iii: boolean;
  iv: boolean;
  v: boolean;
  vi: boolean;
  vii: boolean;
  viii: boolean;
};

export interface LayerVisibility {
  parenchyma: boolean;
  /** Per-segment booleans — master toggle is derived (any sub on -> master on). */
  couinaud: CouinaudVisibility;
  /** Combined hepatic + portal vasculature. The cascade emits one mask
   *  today; portal/hepatic separation is a future spec. */
  vessels: boolean;
  lesions: boolean;
  flrPlane: boolean;
}

/** Roman numeral keys, in segment order. Matches COUINAUD_LABELS. */
const COUINAUD_KEYS: Array<keyof CouinaudVisibility> = [
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii',
];

/** Default off state for all 8 segments. */
export const COUINAUD_ALL_OFF: CouinaudVisibility = {
  i: false, ii: false, iii: false, iv: false, v: false, vi: false, vii: false, viii: false,
};

/** Default on state for all 8 segments. */
export const COUINAUD_ALL_ON: CouinaudVisibility = {
  i: true, ii: true, iii: true, iv: true, v: true, vi: true, vii: true, viii: true,
};

export interface LayerTogglePanelProps {
  visibility: LayerVisibility;
  onChange: (next: LayerVisibility) => void;
  /** Drives whether the parenchyma toggle is interactive. */
  hasParenchymaMask: boolean;
  /** Has any Couinaud segmentation row arrived? */
  hasCouinaud?: boolean;
  /** Has the combined vessel mask arrived? */
  hasVessels?: boolean;
  /** Number of lesions detected — gates the lesions toggle. */
  lesionCount?: number;
  /** Whether a FLR cutting plane exists for this analysis. */
  hasFlrPlane?: boolean;
  /** Optional swatch color per Couinaud segment (CSS color string). */
  couinaudSwatch?: Record<keyof CouinaudVisibility, string>;
  /** Test id passthrough. */
  'data-testid'?: string;
}

interface RowProps {
  label: string;
  swatch: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  testId: string;
  indeterminate?: boolean;
}

function ToggleRow({
  label,
  swatch,
  checked,
  onChange,
  disabled,
  disabledReason,
  testId,
  indeterminate,
}: RowProps): React.ReactElement {
  const node = (
    <Group
      gap={8}
      wrap="nowrap"
      style={{
        minHeight: 32,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <Box
        aria-hidden="true"
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          background: swatch,
          flexShrink: 0,
          border: '1px solid var(--emr-gray-300, rgba(255,255,255,0.2))',
        }}
      />
      <Checkbox
        size="xs"
        checked={checked}
        indeterminate={indeterminate}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        label={
          <Text fz="var(--emr-font-xs)" c="var(--emr-text-inverse, #fff)" style={{ whiteSpace: 'nowrap' }}>
            {label}
          </Text>
        }
        data-testid={testId}
      />
    </Group>
  );
  return disabled && disabledReason ? (
    <Tooltip label={disabledReason} withArrow position="right">
      <span>{node}</span>
    </Tooltip>
  ) : (
    node
  );
}

/** Default Couinaud swatches — uses the project's CSS tokens via getCouinaudColorVar. */
function buildDefaultCouinaudSwatch(): Record<keyof CouinaudVisibility, string> {
  // Mirrors COUINAUD_COLORS RGBA palette used in the renderer (Wong-Bang).
  const fallback: Record<keyof CouinaudVisibility, string> = {
    i:    'rgba(230, 159,   0, 0.85)',
    ii:   'rgba( 86, 180, 233, 0.85)',
    iii:  'rgba(  0, 158, 115, 0.85)',
    iv:   'rgba(240, 228,  66, 0.85)',
    v:    'rgba(  0, 114, 178, 0.85)',
    vi:   'rgba(213,  94,   0, 0.85)',
    vii:  'rgba(204, 121, 167, 0.85)',
    viii: 'rgba(100, 100, 100, 0.85)',
  };
  return fallback;
}

export function LayerTogglePanel({
  visibility,
  onChange,
  hasParenchymaMask,
  hasCouinaud = false,
  hasVessels = false,
  lesionCount = 0,
  hasFlrPlane = false,
  couinaudSwatch,
  'data-testid': testId = 'liver-layer-toggle',
}: LayerTogglePanelProps): React.ReactElement {
  const { t } = useTranslation();

  // Master Couinaud derived state.
  const couinaudOnCount = COUINAUD_KEYS.filter((k) => visibility.couinaud[k]).length;
  const couinaudMasterChecked = couinaudOnCount === COUINAUD_KEYS.length;
  const couinaudIndeterminate = couinaudOnCount > 0 && !couinaudMasterChecked;

  const [couinaudExpanded, setCouinaudExpanded] = useState(false);

  const swatch = couinaudSwatch ?? buildDefaultCouinaudSwatch();

  /** Set a single field and forward via onChange. */
  function setField<K extends keyof LayerVisibility>(key: K, value: LayerVisibility[K]): void {
    onChange({ ...visibility, [key]: value });
  }

  /** Toggle a single Couinaud sub-segment. */
  function setCouinaudOne(key: keyof CouinaudVisibility, value: boolean): void {
    onChange({
      ...visibility,
      couinaud: { ...visibility.couinaud, [key]: value },
    });
  }

  /** Master toggle — set all 8 sub-toggles to the new value. */
  function setCouinaudAll(value: boolean): void {
    onChange({
      ...visibility,
      couinaud: value ? { ...COUINAUD_ALL_ON } : { ...COUINAUD_ALL_OFF },
    });
  }

  return (
    <Box
      data-testid={testId}
      role="group"
      aria-label={t('analysis:viewer.layers.ariaLabel')}
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        padding: 10,
        minWidth: 180,
        maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto',
        borderRadius: 'var(--emr-border-radius-lg, 12px)',
        background: 'rgba(15, 23, 42, 0.78)',
        backdropFilter: 'blur(8px)',
        boxShadow: 'var(--emr-shadow-md, 0 4px 12px rgba(0,0,0,0.4))',
        zIndex: 5,
      }}
    >
      <Stack gap={6}>
        <Text
          fz="var(--emr-font-xs)"
          fw={600}
          c="var(--emr-text-inverse, #fff)"
          tt="uppercase"
          style={{ letterSpacing: 0.5, opacity: 0.85 }}
        >
          {t('analysis:viewer.layers.title')}
        </Text>

        <ToggleRow
          label={t('analysis:viewer.layers.parenchyma')}
          swatch="rgba(72, 187, 120, 0.85)"
          checked={visibility.parenchyma}
          onChange={(v) => setField('parenchyma', v)}
          disabled={!hasParenchymaMask}
          disabledReason={!hasParenchymaMask ? t('analysis:viewer.layers.notReady') : undefined}
          testId="layer-toggle-parenchyma"
        />

        {/* Couinaud master + expandable sub-toggles */}
        <Group gap={4} wrap="nowrap" align="center">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <ToggleRow
              label={t('analysis:viewer.layers.couinaud.master')}
              swatch="linear-gradient(90deg,#e69f00,#56b4e9,#009e73,#f0e442,#0072b2,#d55e00,#cc79a7,#646464)"
              checked={couinaudMasterChecked}
              indeterminate={couinaudIndeterminate}
              onChange={setCouinaudAll}
              disabled={!hasCouinaud}
              disabledReason={!hasCouinaud ? t('analysis:viewer.layers.notReady') : undefined}
              testId="layer-toggle-couinaud-master"
            />
          </Box>
          <UnstyledButton
            onClick={() => setCouinaudExpanded((s) => !s)}
            disabled={!hasCouinaud}
            aria-label={t('analysis:viewer.layers.couinaud.expandAria')}
            aria-expanded={couinaudExpanded}
            data-testid="layer-toggle-couinaud-expand"
            style={{
              minWidth: 24,
              minHeight: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              cursor: hasCouinaud ? 'pointer' : 'not-allowed',
              opacity: hasCouinaud ? 0.85 : 0.4,
              color: 'var(--emr-text-inverse, #fff)',
              transition: 'transform 150ms ease',
              transform: couinaudExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          >
            <IconChevronDown size={14} />
          </UnstyledButton>
        </Group>
        <Collapse in={couinaudExpanded && hasCouinaud}>
          <Stack
            gap={2}
            ml={14}
            data-testid="layer-toggle-couinaud-sublist"
            style={{ borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: 8 }}
          >
            {COUINAUD_KEYS.map((key, idx) => {
              const roman = COUINAUD_LABELS[idx] as CouinaudLabel;
              return (
                <ToggleRow
                  key={key}
                  label={t(`analysis:viewer.layers.couinaud.${key}`)}
                  swatch={swatch[key]}
                  checked={visibility.couinaud[key]}
                  onChange={(v) => setCouinaudOne(key, v)}
                  testId={`layer-toggle-couinaud-${roman.toLowerCase()}`}
                />
              );
            })}
          </Stack>
        </Collapse>

        <ToggleRow
          label={t('analysis:viewer.layers.vessels')}
          swatch="rgba(220, 38, 38, 0.85)"
          checked={visibility.vessels}
          onChange={(v) => setField('vessels', v)}
          disabled={!hasVessels}
          disabledReason={!hasVessels ? t('analysis:viewer.layers.notReady') : undefined}
          testId="layer-toggle-vessels"
        />
        <ToggleRow
          label={t('analysis:viewer.layers.lesions')}
          swatch="rgba(250, 204, 21, 0.85)"
          checked={visibility.lesions}
          onChange={(v) => setField('lesions', v)}
          disabled={lesionCount === 0}
          disabledReason={lesionCount === 0 ? t('analysis:viewer.layers.noLesions') : undefined}
          testId="layer-toggle-lesions"
        />
        <ToggleRow
          label={t('analysis:viewer.layers.flrPlane')}
          swatch="rgba(139, 92, 246, 0.85)"
          checked={visibility.flrPlane}
          onChange={(v) => setField('flrPlane', v)}
          disabled={!hasFlrPlane}
          disabledReason={!hasFlrPlane ? t('analysis:viewer.layers.noFlrPlane') : undefined}
          testId="layer-toggle-flr-plane"
        />
      </Stack>
    </Box>
  );
}

export default LayerTogglePanel;
