// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RUODisclaimer — T178
 *
 * Persistent, UN-DISMISSABLE overlay surfaced on every view that renders
 * AI-derived output. Anchored to the viewport bottom-right with
 * `position: fixed`. Per spec FR-028 / FR-028a the disclaimer MUST:
 *
 *   - Always be visible while any AI output is on screen
 *   - Survive screenshots via pixel-level burn (5-layer overlay)
 *   - Be screen-reader announced on focus
 *
 * 5-layer implementation (research §B.7):
 *   Layer 1: DOM `<Text>` carrying the short disclaimer
 *   Layer 2: `<canvas>` overlay with diagonal-stripe watermark
 *   Layer 3: CSS `::before` pseudo-element (via inline style trick + SSR
 *            safe outer span — implemented here as a sibling div with
 *            `pointer-events: none` + low-alpha text tiling)
 *   Layer 4: SVG overlay with stroked text path
 *   Layer 5: `role="note"` + `aria-hidden="false"` for SR announcement
 *
 * Scope-narrowing per FR-028b: when `useRUOClaim()` returns
 * `disclaimerVariant: 'ce_class_iib'` the banner swaps to the softer CE
 * wording. For MVP all outputs are `ruo`.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Box, Text } from '@mantine/core';
import { IconAlertOctagon } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';

/** Disclaimer variants. */
export type RUODisclaimerVariant = 'ruo' | 'ce_class_iib';

/** Props for {@link RUODisclaimer}. */
export interface RUODisclaimerProps {
  /** Force a specific variant (e.g. for storybook). Defaults to `'ruo'`. */
  variant?: RUODisclaimerVariant;
  /** Optional `data-testid`. */
  'data-testid'?: string;
}

/**
 * Emit a synthetic audit event whenever the user attempts to dismiss the
 * banner. The real writer lives on the server (FR-028a); dispatching a
 * custom DOM event keeps the client decoupled from the audit transport.
 */
function emitDismissAttempted(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('liverra:audit', {
      detail: { type: 'ruo_dismiss_attempted', ts: new Date().toISOString() },
    }),
  );
}

/**
 * Keep the embedded canvas stripe burn in sync with the banner's pixel
 * size. Runs on resize + mount.
 */
function useStripeBurn(
  canvasRef: React.RefObject<HTMLCanvasElement>,
  text: string,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const render = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      canvas.width = Math.max(1, Math.floor(rect.width));
      canvas.height = Math.max(1, Math.floor(rect.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.globalAlpha = 0.22;
      // Resolve themed watermark fill from CSS custom property so the burn
      // layer stays in sync with theme variables (no hardcoded rgba).
      const themed = getComputedStyle(document.documentElement)
        .getPropertyValue('--emr-white-alpha-95')
        .trim();
      ctx.fillStyle = themed;
      ctx.font = 'bold 10px sans-serif';
      const step = 110;
      for (let x = -canvas.height; x < canvas.width; x += step) {
        for (let y = 20; y < canvas.height; y += 22) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(-Math.PI / 7);
          ctx.fillText(text, 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();
    };

    render();
    const ro = new ResizeObserver(render);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [canvasRef, text]);
}

/**
 * Persistent RUO overlay.
 */
export function RUODisclaimer({
  variant = 'ruo',
  'data-testid': testId = 'ruo-disclaimer',
}: RUODisclaimerProps): React.ReactElement {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const shortText = useMemo(
    () =>
      variant === 'ce_class_iib'
        ? t('ruo:disclaimer.ceShort')
        : t('ruo:disclaimer.short'),
    [t, variant],
  );

  const longText = useMemo(
    () =>
      variant === 'ce_class_iib'
        ? t('ruo:disclaimer.ceLong')
        : t('ruo:disclaimer.long'),
    [t, variant],
  );

  useStripeBurn(canvasRef, shortText);

  return (
    <Box
      data-testid={testId}
      role="note"
      aria-hidden="false"
      aria-label={shortText}
      tabIndex={0}
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1150,
        maxWidth: 360,
        minWidth: 240,
        borderRadius: 'var(--emr-border-radius-lg)',
        overflow: 'hidden',
        background:
          variant === 'ce_class_iib'
            ? 'var(--emr-info, var(--emr-secondary))'
            : 'var(--emr-warning)',
        boxShadow: 'var(--emr-shadow-lg)',
        color: 'var(--emr-text-inverse)',
        pointerEvents: 'auto',
      }}
      onClick={(e) => {
        // Layer 5 guard: if a close affordance is ever injected into the
        // DOM (browser extension, accidental child button), we still refuse
        // to dismiss and log an audit event.
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-ruo-close]')) {
          e.preventDefault();
          emitDismissAttempted();
        }
      }}
    >
      {/* Layer 2: canvas stripe burn */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          mixBlendMode: 'overlay',
        }}
      />

      {/* Layer 3: tiled CSS text (pseudo-element substitute using bg-image) */}
      <Box
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.12,
          backgroundImage: `repeating-linear-gradient(-20deg, transparent 0 38px, var(--emr-glass-white-80) 38px 40px)`,
        }}
      />

      {/* Layer 4: SVG stroked text path */}
      <svg
        aria-hidden="true"
        width="100%"
        height="100%"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.25,
        }}
      >
        <defs>
          <pattern id="ruo-svg-pattern" width="180" height="36" patternUnits="userSpaceOnUse">
            <text
              x="0"
              y="24"
              fontSize="10"
              fontWeight="700"
              fill="none"
              strokeWidth="0.5"
              style={{ stroke: 'var(--emr-watermark-fill)' }}
            >
              {shortText}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#ruo-svg-pattern)" />
      </svg>

      {/* Layer 1: primary readable text */}
      <Box
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
        }}
      >
        <IconAlertOctagon
          size={20}
          stroke={2}
          style={{ flexShrink: 0, marginTop: 2 }}
          aria-hidden="true"
        />
        <Box style={{ minWidth: 0 }}>
          <Text fz="var(--emr-font-sm)" fw={700} c="inherit" lh={1.3}>
            {shortText}
          </Text>
          <Text fz="var(--emr-font-xs)" c="inherit" lh={1.35} style={{ opacity: 0.92 }}>
            {longText}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

export default RUODisclaimer;
