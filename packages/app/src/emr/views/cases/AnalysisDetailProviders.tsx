// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisDetailProviders (T186 — wiring).
 *
 * Plain-English: a small 3-in-1 wrapper that drops the three route-scoped
 * contexts (Analysis, ViewerState, RUOClaimRegistry) around whatever the
 * `/cases/:id` route renders. Instead of editing `AnalysisDetailView.tsx`
 * (owned by the UI agent) we hand them a pre-built provider stack and
 * leave a TODO so the final integration is a single-import swap:
 *
 * ```tsx
 * // AnalysisDetailView.tsx (to be added by the UI agent):
 * import { AnalysisDetailProviders } from './AnalysisDetailProviders';
 * export default function AnalysisDetailView() {
 *   const { id } = useParams();
 *   return (
 *     <AnalysisDetailProviders analysisId={id!}>
 *       <AnalysisDetailLayout />
 *     </AnalysisDetailProviders>
 *   );
 * }
 * ```
 *
 * Why route-scoped (not app-root):
 *   - `AnalysisContext` opens an SSE connection tied to a specific id —
 *     mounting it app-root would leak connections across routes.
 *   - `ViewerStateContext` persists per-analysis keys — global provider
 *     would collide state across tabs.
 *   - `RUOClaimRegistry` could live globally, but keeping it route-scoped
 *     ensures the `/cases/:id` surface can refresh independently of other
 *     compliance dashboards.
 *
 * Spec refs: T186 from tasks.md, plan.md §Contexts graph.
 */

import type { ReactNode } from 'react';

import { AnalysisProvider } from '../../contexts/AnalysisContext';
import { RUOClaimRegistryProvider } from '../../contexts/RUOClaimRegistryContext';
import { ViewerStateProvider } from '../../contexts/ViewerStateContext';

export interface AnalysisDetailProvidersProps {
  analysisId: string;
  children: ReactNode;
}

export function AnalysisDetailProviders({
  analysisId,
  children,
}: AnalysisDetailProvidersProps): JSX.Element {
  return (
    <AnalysisProvider analysisId={analysisId}>
      <ViewerStateProvider analysisId={analysisId}>
        <RUOClaimRegistryProvider>{children}</RUOClaimRegistryProvider>
      </ViewerStateProvider>
    </AnalysisProvider>
  );
}
