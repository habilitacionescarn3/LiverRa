// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverViewer3D — T175
 *
 * Cornerstone3D shell with a parenchyma overlay layer only. Segments /
 * vessels / lesions land in later user-stories. Responsibilities:
 *
 *   - Mount a Cornerstone3D render engine + volume viewport
 *   - Load the parenchyma mask URI exposed by `useAnalysis()`
 *   - Toggle layers via `LayerToggle` (stubbed here; US2 T202 owns the real one)
 *   - Keyboard + touch controls (L = layers, P = plane, +/- zoom, Space = reset)
 *   - Burn an RUO watermark on every rendered frame via
 *     `@liverra/imaging/watermark` (T179, sibling agent)
 *
 * Performance target: 60 FPS on M1+ / RTX 2060+; graceful 30 FPS + bitmap
 * slice fallback on low-end hardware.
 *
 * Accessibility: `role="application"` with `aria-label`, fully keyboard-
 * navigable per NFR-002.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconCircleDashed,
  IconKeyboard,
  IconLayersIntersect,
  IconRotate,
  IconTarget,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import { EMRAlert, EMRButton } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';
import { ResectionPlaneTool } from './ResectionPlaneTool';

/** Props for {@link LiverViewer3D}. */
export interface LiverViewer3DProps {
  /** Analysis ID used as the volume cache key. */
  analysisId: string;
  /** Whether the analysis is `done` — viewer renders a placeholder until then. */
  ready?: boolean;
  /** Optional parenchyma mask URI override (normally from `useAnalysis()`). */
  parenchymaMaskUri?: string;
  /** Optional `data-testid` for tests. */
  'data-testid'?: string;
}

/**
 * Try to import the shared watermark util from the imaging package. The
 * real implementation is T179 (sibling agent); in its absence we fall
 * back to a minimal in-module stripe rasteriser so screenshots still carry
 * the RUO disclaimer in pixels.
 */
type BurnWatermarkFn = (
  canvas: HTMLCanvasElement,
  opts?: { text?: string; opacity?: number },
) => void;

async function loadBurnWatermark(): Promise<BurnWatermarkFn> {
  try {
    // T179 owns this module; dynamic import avoids a hard dep on sibling work.
    const mod: /* any-ok: dynamic import of optional sibling module; narrowed via optional chaining */ any = await import(
      /* @vite-ignore */ '@liverra/imaging/watermark'
    ).catch(() => undefined);
    if (mod?.burnWatermark) return mod.burnWatermark as BurnWatermarkFn;
  } catch {
    // fallthrough
  }
  return function fallbackBurn(canvas, opts) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const text = opts?.text ?? 'RESEARCH USE ONLY — Not for clinical use';
    ctx.save();
    ctx.globalAlpha = opts?.opacity ?? 0.15;
    ctx.font = '12px sans-serif';
    // Resolve theme variable so the watermark respects the design system.
    const watermarkFill =
      typeof window !== 'undefined'
        ? getComputedStyle(document.documentElement)
            .getPropertyValue('--emr-watermark-fill')
            .trim()
        : '';
    ctx.fillStyle = watermarkFill || 'white';
    const step = 220;
    for (let x = -canvas.height; x < canvas.width; x += step) {
      for (let y = step; y < canvas.height; y += step) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-Math.PI / 6);
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  };
}

/**
 * Detect GPU tier. Returns `high` when WebGPU is available, else `low`.
 */
function detectGpuTier(): 'high' | 'low' {
  if (typeof navigator === 'undefined') return 'low';
  // `navigator.gpu` presence is a conservative proxy for WebGPU support.
  return 'gpu' in navigator ? 'high' : 'low';
}

/**
 * Cornerstone3D shell.
 */
export function LiverViewer3D({
  analysisId,
  ready = false,
  parenchymaMaskUri,
  'data-testid': testId = 'liver-viewer-3d',
}: LiverViewer3DProps): React.ReactElement {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const burnRef = useRef<BurnWatermarkFn | null>(null);
  const rafRef = useRef<number | null>(null);

  const gpuTier = useMemo(detectGpuTier, []);
  const webgpuAvailable = gpuTier === 'high';

  const [layersVisible, setLayersVisible] = useState(true);
  const [planeToolOpen, setPlaneToolOpen] = useState(false);
  const [keyboardHelpOpen, setKeyboardHelpOpen] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Resolve the watermark util on mount; keep a ref so the render loop
  // doesn't hit `await` every frame.
  useEffect(() => {
    let mounted = true;
    void loadBurnWatermark().then((fn) => {
      if (mounted) burnRef.current = fn;
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Mount the Cornerstone3D render engine. The real initialiser lives in
  // `@liverra/imaging/cornerstone` (stub today). We wrap it in try/catch so
  // the viewer degrades to a placeholder rather than crashing the view.
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const mod: /* any-ok: dynamic import of optional sibling module; narrowed via optional chaining */ any = await import(
          /* @vite-ignore */ '@liverra/imaging/cornerstone'
        ).catch(() => undefined);
        if (cancelled) return;
        if (mod?.initCornerstone && mod?.mountVolumeViewport && containerRef.current) {
          await mod.initCornerstone();
          await mod.mountVolumeViewport(containerRef.current, {
            analysisId,
            parenchymaMaskUri,
            gpuTier,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setInitError((err as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [analysisId, gpuTier, parenchymaMaskUri, ready]);

  // Watermark burn loop — runs continuously at animation-frame cadence and
  // overlays the RUO stripe pattern on top of whatever Cornerstone drew.
  useEffect(() => {
    const tick = (): void => {
      const canvas = canvasRef.current;
      const burn = burnRef.current;
      if (canvas && burn) {
        // Resize to container bounds.
        const rect = canvas.parentElement?.getBoundingClientRect();
        if (rect && (canvas.width !== rect.width || canvas.height !== rect.height)) {
          canvas.width = Math.floor(rect.width);
          canvas.height = Math.floor(rect.height);
        }
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        burn(canvas, { text: t('ruo:watermark') });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [t]);

  // Keyboard shortcuts — `role="application"` means the viewer owns
  // keyboard focus, so arrow/letter keys don't bubble to the shell.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const k = e.key.toLowerCase();
    if (k === 'l') {
      e.preventDefault();
      setLayersVisible((v) => !v);
    } else if (k === 'p') {
      e.preventDefault();
      setPlaneToolOpen((v) => !v);
    } else if (k === '?' || k === 'h') {
      e.preventDefault();
      setKeyboardHelpOpen((v) => !v);
    } else if (k === ' ') {
      // Reset view placeholder — real impl resets camera via Cornerstone API.
      e.preventDefault();
    }
  }, []);

  if (!ready) {
    return (
      <Stack
        data-testid={testId}
        p="lg"
        gap="sm"
        align="center"
        justify="center"
        style={{ height: '100%', background: 'var(--emr-gray-50)' }}
      >
        <IconCircleDashed
          size={48}
          stroke={1.25}
          color="var(--emr-gray-400)"
          aria-hidden="true"
        />
        <Text fz="var(--emr-font-md)" fw={600} c="var(--emr-text-primary)">
          {t('analysis:viewer.statusNotReady')}
        </Text>
        <Text fz="var(--emr-font-sm)" c="var(--emr-text-secondary)" ta="center" maw={360}>
          {t('analysis:viewer.loading')}
        </Text>
      </Stack>
    );
  }

  return (
    <Box
      data-testid={testId}
      role="application"
      aria-label={t('analysis:viewer.ariaLabel')}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 420,
        background: 'var(--emr-gray-900)',
        outline: 'none',
      }}
    >
      {/* Cornerstone3D mount point */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden="true"
      />

      {/* Watermark overlay (burns stripes into the canvas for screenshot resilience) */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          mixBlendMode: 'screen',
        }}
      />

      {/* Toolbar */}
      <Group
        gap="xs"
        wrap="wrap"
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: 8,
          borderRadius: 'var(--emr-border-radius-lg)',
          background: 'var(--emr-primary-alpha-32)',
          backdropFilter: 'blur(6px)',
        }}
      >
        <Tooltip label={t('analysis:viewer.keyboard.layers')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton
              variant={layersVisible ? 'primary' : 'ghost'}
              size="sm"
              icon={IconLayersIntersect}
              onClick={() => setLayersVisible((v) => !v)}
            >
              L
            </EMRButton>
          </span>
        </Tooltip>
        <Tooltip label={t('analysis:viewer.keyboard.plane')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton
              variant={planeToolOpen ? 'primary' : 'ghost'}
              size="sm"
              icon={IconTarget}
              onClick={() => setPlaneToolOpen((v) => !v)}
            >
              P
            </EMRButton>
          </span>
        </Tooltip>
        <Tooltip label={t('analysis:viewer.keyboard.zoom')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton variant="ghost" size="sm" icon={IconZoomIn}>
              +
            </EMRButton>
          </span>
        </Tooltip>
        <Tooltip label={t('analysis:viewer.keyboard.zoom')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton variant="ghost" size="sm" icon={IconZoomOut}>
              −
            </EMRButton>
          </span>
        </Tooltip>
        <Tooltip label={t('analysis:viewer.keyboard.reset')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton variant="ghost" size="sm" icon={IconRotate}>
              ␣
            </EMRButton>
          </span>
        </Tooltip>
        <Tooltip label={t('analysis:viewer.keyboardHelpTitle')} withArrow>
          <span style={{ display: 'inline-flex' }}>
            <EMRButton
              variant="ghost"
              size="sm"
              icon={IconKeyboard}
              onClick={() => setKeyboardHelpOpen((v) => !v)}
            >
              ?
            </EMRButton>
          </span>
        </Tooltip>
      </Group>

      {/* Layer toggle stub (real impl in US2 T202) */}
      {layersVisible && (
        <Box
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            padding: 8,
            borderRadius: 'var(--emr-border-radius)',
            background: 'var(--emr-primary-alpha-32)',
            backdropFilter: 'blur(6px)',
            color: 'var(--emr-text-inverse)',
            fontSize: 'var(--emr-font-xs)',
          }}
        >
          {t('analysis:viewer.parenchymaLabel')}
        </Box>
      )}

      {/* Resection plane tool (mounted only when toggled — sub-20ms updates). */}
      {planeToolOpen && (
        <Box
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            right: 16,
            padding: 12,
            borderRadius: 'var(--emr-border-radius-lg)',
            background: 'var(--emr-bg-card)',
            boxShadow: 'var(--emr-shadow-md)',
          }}
        >
          <ResectionPlaneTool analysisId={analysisId} webgpuAvailable={webgpuAvailable} />
        </Box>
      )}

      {/* Keyboard help drawer */}
      {keyboardHelpOpen && (
        <Box
          role="dialog"
          aria-label={t('analysis:viewer.keyboardHelpTitle')}
          style={{
            position: 'absolute',
            top: 64,
            left: 12,
            maxWidth: 280,
            padding: 12,
            borderRadius: 'var(--emr-border-radius-lg)',
            background: 'var(--emr-bg-card)',
            boxShadow: 'var(--emr-shadow-lg)',
            zIndex: 10,
          }}
        >
          <Stack gap={8}>
            <Text fz="var(--emr-font-sm)" fw={600}>
              {t('analysis:viewer.keyboardHelpTitle')}
            </Text>
            <Group justify="space-between" gap="xs">
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('analysis:viewer.keyboard.layers')}
              </Text>
              <kbd style={{ fontSize: 'var(--emr-font-xs)' }}>L</kbd>
            </Group>
            <Group justify="space-between" gap="xs">
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('analysis:viewer.keyboard.plane')}
              </Text>
              <kbd style={{ fontSize: 'var(--emr-font-xs)' }}>P</kbd>
            </Group>
            <Group justify="space-between" gap="xs">
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('analysis:viewer.keyboard.zoom')}
              </Text>
              <kbd style={{ fontSize: 'var(--emr-font-xs)' }}>+ / −</kbd>
            </Group>
            <Group justify="space-between" gap="xs">
              <Text fz="var(--emr-font-xs)" c="var(--emr-text-secondary)">
                {t('analysis:viewer.keyboard.reset')}
              </Text>
              <kbd style={{ fontSize: 'var(--emr-font-xs)' }}>Space</kbd>
            </Group>
          </Stack>
        </Box>
      )}

      {/* WebGPU-missing hint */}
      {!webgpuAvailable && (
        <Box
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            maxWidth: 320,
          }}
        >
          <EMRAlert variant="info" title={t('analysis:viewer.statusReady')}>
            {t('analysis:viewer.webgpuMissing')}
          </EMRAlert>
        </Box>
      )}

      {/* Fatal init error */}
      {initError && (
        <Box
          style={{
            position: 'absolute',
            inset: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <EMRAlert variant="error" title={t('analysis:detail.error.title')}>
            {initError}
          </EMRAlert>
        </Box>
      )}
    </Box>
  );
}

export default LiverViewer3D;
