// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LayerToggle — checkbox panel for the 4 liver-viewer layers (T202).
 *
 * Plain-English analogy:
 *   Photoshop has a layers panel on the right where you tick which
 *   drawing-tablet "sheets" to show. This is the same idea: four
 *   sheets (parenchyma outline, Couinaud segments, vein trunks,
 *   lesions) sit stacked on the 3D liver, and the surgeon picks
 *   whichever combination makes the case clearest.
 *
 * Keyboard shortcut: pressing `L` cycles through a curated set of
 * sensible combos so power users don't have to click four boxes one
 * by one. The cycle is:
 *   1. Parenchyma only
 *   2. Parenchyma + Segments
 *   3. Parenchyma + Vessels
 *   4. Parenchyma + Segments + Vessels + Lesions (all on)
 *
 * Spec refs:
 *   - §FR-019   toggle each layer independently
 *   - §NFR-002  keyboard + ARIA (role="group", aria-labelledby)
 */

import { memo, useCallback, useEffect, useId, useMemo } from 'react';
import { Box, Text, Stack } from '@mantine/core';

import { EMRCheckbox } from '../shared/EMRFormFields/EMRCheckbox';
import { useTranslation } from '../../contexts/TranslationContext';

export interface LayerToggleState {
  parenchyma: boolean;
  segments: boolean;
  vessels: boolean;
  lesions: boolean;
}

export interface LayerToggleProps {
  state: LayerToggleState;
  onChange: (next: LayerToggleState) => void;
  /** Enable/disable the `L`-cycles-combos shortcut. Defaults to true. */
  keyboardShortcut?: boolean;
  /** Lesions layer is wired in US3; set false to hide the row until then. */
  showLesions?: boolean;
  'data-testid'?: string;
}

const CYCLE: LayerToggleState[] = [
  { parenchyma: true, segments: false, vessels: false, lesions: false },
  { parenchyma: true, segments: true, vessels: false, lesions: false },
  { parenchyma: true, segments: false, vessels: true, lesions: false },
  { parenchyma: true, segments: true, vessels: true, lesions: true },
];

function sameState(a: LayerToggleState, b: LayerToggleState): boolean {
  return (
    a.parenchyma === b.parenchyma &&
    a.segments === b.segments &&
    a.vessels === b.vessels &&
    a.lesions === b.lesions
  );
}

export const LayerToggle = memo(function LayerToggle({
  state,
  onChange,
  keyboardShortcut = true,
  showLesions = true,
  'data-testid': dataTestId = 'layer-toggle',
}: LayerToggleProps) {
  const { t } = useTranslation();
  const headingId = useId();

  const nextInCycle = useMemo(() => {
    const idx = CYCLE.findIndex((combo) => sameState(combo, state));
    const nextIdx = idx === -1 ? 0 : (idx + 1) % CYCLE.length;
    return CYCLE[nextIdx];
  }, [state]);

  // L-key cycles through layer combos.
  useEffect(() => {
    if (!keyboardShortcut) {
      return undefined;
    }
    const handler = (event: KeyboardEvent) => {
      // Don't steal `L` when the user is typing in an input.
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return;
      }
      if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        onChange(nextInCycle);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [keyboardShortcut, nextInCycle, onChange]);

  const toggle = useCallback(
    (key: keyof LayerToggleState) => {
      onChange({ ...state, [key]: !state[key] });
    },
    [onChange, state],
  );

  return (
    <Box
      data-testid={dataTestId}
      role="group"
      aria-labelledby={headingId}
      style={{
        background: 'var(--emr-bg-card)',
        borderRadius: 'var(--emr-radius-md, 8px)',
        padding: 'var(--emr-space-md, 12px)',
        minWidth: 180,
      }}
    >
      <Text
        id={headingId}
        size="sm"
        fw={600}
        style={{
          color: 'var(--emr-text-primary)',
          fontSize: 'var(--emr-font-sm)',
          marginBottom: 'var(--emr-space-sm, 8px)',
        }}
      >
        {t('refine:layers.heading')}
      </Text>

      <Stack gap={6}>
        <EMRCheckbox
          name="layer-parenchyma"
          label={t('refine:layers.parenchyma')}
          checked={state.parenchyma}
          onChange={() => toggle('parenchyma')}
          data-testid="layer-toggle-parenchyma"
        />
        <EMRCheckbox
          name="layer-segments"
          label={t('refine:layers.couinaudSegments')}
          checked={state.segments}
          onChange={() => toggle('segments')}
          data-testid="layer-toggle-segments"
        />
        <EMRCheckbox
          name="layer-vessels"
          label={t('refine:layers.veinTrunks')}
          checked={state.vessels}
          onChange={() => toggle('vessels')}
          data-testid="layer-toggle-vessels"
        />
        {showLesions ? (
          <EMRCheckbox
            name="layer-lesions"
            label={t('refine:layers.lesions')}
            checked={state.lesions}
            onChange={() => toggle('lesions')}
            data-testid="layer-toggle-lesions"
          />
        ) : null}
      </Stack>

      {keyboardShortcut ? (
        <Text
          size="xs"
          style={{
            color: 'var(--emr-text-secondary)',
            fontSize: 'var(--emr-font-xs, 11px)',
            marginTop: 'var(--emr-space-sm, 8px)',
          }}
        >
          {t('refine:layers.keyHint', { key: 'L' })}
        </Text>
      ) : null}
    </Box>
  );
});
