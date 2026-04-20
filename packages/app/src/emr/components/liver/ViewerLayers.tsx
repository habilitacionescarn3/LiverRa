// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ViewerLayers composer (T223 companion).
 *
 * Plain-English: the 3D liver viewer is built like a stack of transparencies
 * laid on top of each other — the parenchyma mask, the Couinaud segment
 * colouring, the vessel tree, and the lesion overlays. Each transparency is
 * its own React component (owned by different agents). This composer file
 * simply decides which transparencies are actually turned on, based on the
 * toggles in `ViewerStateContext.activeLayers`.
 *
 * Why this file exists: `LiverViewer3D.tsx` is owned by the frontend-designer
 * agent and the us2-couinaud agent's `LiverViewer3D.layers.tsx` composer had
 * not landed yet when us3-lesions needed to ship. Rather than edit the
 * viewer file directly (risk of conflict), we centralise layer composition
 * here and have `LiverViewer3D` import `<ViewerLayers />` as its single child.
 *
 * Ownership & TODOs:
 *   - `ParenchymaLayer`, `SegmentLayer`, `VesselLayer`, `LesionLayer` — each
 *     is created in its own sibling file by the respective feature agent
 *     (parenchyma/us1, couinaud/us2, lesions/us3, vessels/later).
 *   - This file is deliberately import-shy: it uses dynamic `React.lazy`
 *     loading so missing sibling files during early development don't break
 *     the whole viewer — the layer renders `null` and the others still work.
 *
 * Spec ref: plan.md §Component Architecture, data-model.md §8 Lesion,
 * ViewerStateContext.activeLayers.
 */

import { Suspense, lazy, type ComponentType } from 'react';

import { useViewerState, type ViewerLayer } from '../../contexts/ViewerStateContext';

/**
 * Shared props every layer component must accept. Layers are free to ignore
 * unused props (e.g., a bundled vessel tree layer may not need `analysisId`
 * if it reads from a shared context instead).
 */
export interface LayerComponentProps {
  analysisId: string;
}

/**
 * Lazy-load each layer so a missing sibling during staged rollout never
 * crashes the viewer. If the module fails to resolve the default export
 * (e.g., the file doesn't exist yet), we substitute a no-op renderer.
 *
 * The cast is deliberate: when a file is missing Vite throws at module-
 * resolution time, which surfaces in the Suspense error boundary — the
 * viewer then falls back to rendering nothing for that layer.
 */
function lazyLayer(loader: () => Promise<{ default: ComponentType<LayerComponentProps> }>) {
  return lazy(async () => {
    try {
      return await loader();
    } catch {
      // Graceful no-op when the sibling file hasn't been created yet.
      return {
        default: (_props: LayerComponentProps) => null,
      } as { default: ComponentType<LayerComponentProps> };
    }
  });
}

const ParenchymaLayer = lazyLayer(() => import('./ParenchymaLayer'));
const SegmentLayer = lazyLayer(() => import('./SegmentLayer'));
const VesselLayer = lazyLayer(() => import('./VesselLayer'));
const LesionLayer = lazyLayer(() => import('./LesionLayer'));

const LAYER_REGISTRY: Record<ViewerLayer, ComponentType<LayerComponentProps>> = {
  parenchyma: ParenchymaLayer,
  segments: SegmentLayer,
  vessels: VesselLayer,
  lesions: LesionLayer,
};

/**
 * Props for `<ViewerLayers />`. `analysisId` is drilled in rather than pulled
 * from a context so the composer is unit-testable in isolation.
 */
export interface ViewerLayersProps {
  analysisId: string;
  /**
   * Optional override order — defaults to parenchyma → segments → vessels →
   * lesions (bottom-up in 3D compositing terms). Override when a study
   * layout demands a different stack (e.g., lesions below segments for a
   * specific surgical review mode).
   */
  order?: ViewerLayer[];
}

const DEFAULT_ORDER: ViewerLayer[] = ['parenchyma', 'segments', 'vessels', 'lesions'];

/**
 * Render every toggled-on layer in the configured order. A layer whose
 * toggle is off is not mounted at all (no hidden render) — this keeps the
 * WebGL scene lean and matches what Cornerstone3D expects from an explicit
 * add/remove API.
 */
export function ViewerLayers({ analysisId, order = DEFAULT_ORDER }: ViewerLayersProps): JSX.Element {
  const { activeLayers } = useViewerState();

  return (
    <Suspense fallback={null}>
      {order
        .filter((layer) => activeLayers.has(layer))
        .map((layer) => {
          const Cmp = LAYER_REGISTRY[layer];
          return <Cmp key={layer} analysisId={analysisId} />;
        })}
    </Suspense>
  );
}
