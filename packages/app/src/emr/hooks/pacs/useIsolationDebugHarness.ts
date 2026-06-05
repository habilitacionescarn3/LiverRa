// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useIsolationDebugHarness — [DEV-ONLY] structure-isolation primitive harness
// ============================================================================
// Behavior-preserving extraction from PACSViewer.tsx (audit finding
// EMR-PACS-IMAGING-AUDIT-009, D11 code-scale). This effect is guarded by
// `import.meta.env.DEV`, so it is STRIPPED FROM PRODUCTION BUILDS entirely — it
// never runs for clinicians. It exposes the isolation primitives on
// `window.__isolation` so they can be proven on real GPU hardware. Moving it
// into its own hook removes ~90 lines of dev-only scaffolding from the clinical
// viewer's review surface with zero runtime/clinical impact. The effect body
// and dependency array are unchanged. PACSViewer.tsx calls this hook in place.
// ============================================================================

import { useEffect, type MutableRefObject } from 'react';
import { cache } from '@cornerstonejs/core';
import { getOrCreateRenderingEngine } from '../../services/pacs';
import { getViewportActors, getCachedVolume } from '../../services/pacs/cornerstoneCompat';
import {
  buildMaskedIntensityVolume,
  applyIsolation,
  clearIsolation,
  huThresholdKeep,
  growMaskFromSeed,
  findSeedNearCenter,
  maskKeep,
  pickSeedVoxel,
} from '../../services/pacs/structureIsolation';

export interface UseIsolationDebugHarnessParams {
  /** Currently-active viewport id (viewerState?.activeViewportId). */
  activeViewportId: string | undefined;
  /** Live MPR volume id ref (from useViewerCacheCleanup). */
  activeVolumeIdRef: MutableRefObject<string | null>;
}

export function useIsolationDebugHarness({ activeViewportId, activeVolumeIdRef }: UseIsolationDebugHarnessParams): void {
  useEffect(() => {
    // LiverRa: typed via local narrow — this tsconfig doesn't load vite/client.
    if (!(import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV) return;
    const engineId = (() => {
      try { return getOrCreateRenderingEngine().id; } catch (err) { console.warn('[PACSViewer] isolation harness engine lookup failed:', err); return ''; }
    })();
    const vpId = (): string => activeViewportId ?? 'viewport-0';
    const ct = (): string | null => activeVolumeIdRef.current;
    (window as unknown as { __isolation?: unknown }).__isolation = {
      info: () => ({ ct: ct(), vp: vpId(), engine: engineId }),
      actors: () => {
        try {
          const vp = getOrCreateRenderingEngine().getViewport(vpId());
          return getViewportActors(vp).map((a) => ({ uid: a.uid, referenceId: a.referenceId, hasActor: !!a.actor }));
        } catch (e) { console.warn('[PACSViewer] isolation harness actor snapshot failed:', e); return String(e); }
      },
      maskStats: () => {
        try {
          const c = ct();
          if (!c) return 'no-ct';
          const vol = getCachedVolume<{ dimensions?: number[]; voxelManager?: { getCompleteScalarDataArray?: () => ArrayLike<number>; getScalarData?: () => ArrayLike<number> }; imageData?: { getPointData?: () => { getScalars?: () => { getData?: () => ArrayLike<number> } } } }>(cache, `${c}_isolation_masked`);
          if (!vol) return 'no-masked-volume';
          const src =
            (() => { try { return vol.imageData?.getPointData?.()?.getScalars?.()?.getData?.(); } catch (err) { console.warn('[PACSViewer] isolation mask imageData scalar read failed:', err); return undefined; } })() ??
            (() => { try { return vol.voxelManager?.getScalarData?.(); } catch (err) { console.warn('[PACSViewer] isolation mask voxel scalar read failed:', err); return undefined; } })() ??
            (() => { try { return vol.voxelManager?.getCompleteScalarDataArray?.(); } catch (err) { console.warn('[PACSViewer] isolation mask complete scalar read failed:', err); return undefined; } })();
          if (!src) return { dims: vol.dimensions, scalars: 'unreadable' };
          let min = Infinity, max = -Infinity, nonAir = 0;
          const stride = Math.max(1, Math.floor(src.length / 5000));
          for (let i = 0; i < src.length; i += stride) {
            const v = src[i];
            if (v < min) min = v; if (v > max) max = v;
            if (v > -1000) nonAir++;
          }
          return { dims: vol.dimensions, len: src.length, sampled: Math.ceil(src.length / stride), min, max, nonAir };
        } catch (e) { console.warn('[PACSViewer] isolation harness mask stats failed:', e); return String(e); }
      },
      build: (threshold = 150) => {
        const c = ct();
        return c ? buildMaskedIntensityVolume(c, huThresholdKeep(threshold)) : null;
      },
      apply: async (maskedId: string, ghost = 0.08) => {
        const c = ct();
        if (c) await applyIsolation(engineId, vpId(), c, maskedId, ghost);
      },
      isolate: async (threshold = 150, ghost = 0.08) => {
        const c = ct();
        if (!c) return 'no-ct';
        const m = buildMaskedIntensityVolume(c, huThresholdKeep(threshold));
        if (!m) return 'no-mask';
        await applyIsolation(engineId, vpId(), c, m, ghost);
        return 'ok';
      },
      // Region-grow isolation: seed near volume centre at ~targetHu (contrast
      // aorta), grow the connected lumen, isolate ONLY that structure.
      growIsolate: async (targetHu = 320, tol = 70) => {
        const c = ct();
        if (!c) return 'no-ct';
        const seed = findSeedNearCenter(c, targetHu);
        if (seed == null || seed < 0) return 'no-seed';
        const grow = growMaskFromSeed(c, seed, { tolerance: tol, minHu: 120, maxVoxels: 4_000_000 });
        if (!grow) return 'no-ct';
        const m = buildMaskedIntensityVolume(c, maskKeep(grow.mask));
        if (!m) return 'no-mask';
        await applyIsolation(engineId, vpId(), c, m, 0);
        return JSON.stringify({ result: 'ok', count: grow.count, capped: grow.capped });
      },
      // Click-to-isolate: ray-pick the structure under canvas (x,y) → grow it →
      // isolate. This is the real "click the aorta on the 3D" interaction; the
      // production UI will pass the click's viewport-relative coords here.
      clickIsolate: async (canvasX: number, canvasY: number, tol = 80, surfaceThr = 150) => {
        const c = ct();
        if (!c) return 'no-ct';
        const seed = pickSeedVoxel(engineId, vpId(), c, canvasX, canvasY, surfaceThr);
        if (seed == null) return 'no-hit';
        const grow = growMaskFromSeed(c, seed, { tolerance: tol, minHu: 120, maxVoxels: 4_000_000 });
        if (!grow) return 'no-ct';
        const m = buildMaskedIntensityVolume(c, maskKeep(grow.mask));
        if (!m) return 'no-mask';
        await applyIsolation(engineId, vpId(), c, m, 0);
        return JSON.stringify({ result: 'ok', seed, count: grow.count, capped: grow.capped });
      },
      clear: async () => {
        const c = ct();
        if (c) await clearIsolation(engineId, vpId(), c);
      },
    };
    return () => { delete (window as unknown as { __isolation?: unknown }).__isolation; };
  }, [activeViewportId, activeVolumeIdRef]);
}
