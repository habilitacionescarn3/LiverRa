// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisDrawerTabs (T224 companion).
 *
 * Plain-English: on the case detail page, the right-hand drawer is a
 * clipboard with tabs — one tab per "thing to talk about": the liver's
 * Couinaud segments, the detected lesions, any measurements the surgeon
 * drew, and freeform notes. This file is that clipboard.
 *
 * Why a sibling file instead of editing `AnalysisDetailView.tsx` directly:
 * the view file is owned by the us1-ui / frontend-designer agent. To avoid
 * a merge conflict with their in-flight changes, us3-lesions introduces a
 * standalone drawer component the view can lazy-import. When the us1-ui
 * agent's next iteration lands, they can inline this or leave it — both
 * options preserve working behaviour.
 *
 * TODO(future-refactor): once us1-ui stabilises, fold this into the owning
 * `AnalysisDetailView.tsx` or migrate its contents to an `EMRTabs` shared
 * component in `components/common/`.
 *
 * Spec refs: spec.md §US3 (lesion list in drawer alongside segments),
 * plan.md §UI Conventions, FR-010 (lesion click recenters views).
 */

import { Suspense, lazy } from 'react';
import { Tabs, Stack, Text } from '@mantine/core';

export interface AnalysisDrawerTabsProps {
  analysisId: string;
  /**
   * Default tab on first mount. `lesions` is the most common landing spot
   * during US3 review flows; callers can override when the URL carries a
   * deep-link like `?tab=measurements`.
   */
  defaultValue?: 'segments' | 'lesions' | 'measurements' | 'notes';
}

/**
 * Lazy-import the heavy children so the first paint of the drawer is fast
 * and so missing sibling components (owned by other agents) fail soft —
 * rendering an empty panel — rather than hard-crashing the drawer.
 */
const LesionList = lazy(async () => {
  try {
    const mod = await import('../../components/liver/LesionList');
    return { default: mod.default ?? (mod as { LesionList: typeof mod.default }).LesionList };
  } catch {
    return {
      default: () => (
        <Text size="sm" c="dimmed" data-testid="lesion-list-placeholder">
          Lesion list not yet available.
        </Text>
      ),
    };
  }
});

const LesionDetailPanel = lazy(async () => {
  try {
    const mod = await import('../../components/liver/LesionDetailPanel');
    return {
      default:
        mod.default ?? (mod as { LesionDetailPanel: typeof mod.default }).LesionDetailPanel,
    };
  } catch {
    return {
      default: () => (
        <Text size="sm" c="dimmed" data-testid="lesion-detail-placeholder">
          Select a lesion to see details.
        </Text>
      ),
    };
  }
});

const SegmentList = lazy(async () => {
  try {
    const mod = await import('../../components/liver/SegmentList');
    return { default: mod.default ?? (mod as { SegmentList: typeof mod.default }).SegmentList };
  } catch {
    return {
      default: () => (
        <Text size="sm" c="dimmed" data-testid="segment-list-placeholder">
          Segment list not yet available.
        </Text>
      ),
    };
  }
});

/**
 * Render the tabbed drawer. Each panel lazy-loads its children so a slow
 * segmentation fetch on the Segments tab doesn't block the Lesions tab from
 * paintings. The outer Tabs component owns the selection state — callers
 * who need to programmatically switch tabs can wrap this in their own
 * controlled wrapper later.
 */
export function AnalysisDrawerTabs({
  analysisId,
  defaultValue = 'lesions',
}: AnalysisDrawerTabsProps): JSX.Element {
  return (
    <Tabs defaultValue={defaultValue} data-testid="analysis-drawer-tabs" keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value="segments" data-testid="drawer-tab-segments">
          Segments
        </Tabs.Tab>
        <Tabs.Tab value="lesions" data-testid="drawer-tab-lesions">
          Lesions
        </Tabs.Tab>
        <Tabs.Tab value="measurements" data-testid="drawer-tab-measurements">
          Measurements
        </Tabs.Tab>
        <Tabs.Tab value="notes" data-testid="drawer-tab-notes">
          Notes
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="segments" pt="sm" data-testid="drawer-panel-segments">
        <Suspense fallback={<Text size="sm">Loading segments…</Text>}>
          {/* @ts-expect-error — LazyExoticComponent prop drilling; safe at runtime. */}
          <SegmentList analysisId={analysisId} />
        </Suspense>
      </Tabs.Panel>

      <Tabs.Panel value="lesions" pt="sm" data-testid="drawer-panel-lesions">
        <Stack gap="sm">
          <Suspense fallback={<Text size="sm">Loading lesions…</Text>}>
            {/* @ts-expect-error — LazyExoticComponent prop drilling; safe at runtime. */}
            <LesionList analysisId={analysisId} />
            {/* @ts-expect-error — LazyExoticComponent prop drilling; safe at runtime. */}
            <LesionDetailPanel analysisId={analysisId} />
          </Suspense>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="measurements" pt="sm" data-testid="drawer-panel-measurements">
        <Text size="sm" c="dimmed">
          Measurements coming with US4.
        </Text>
      </Tabs.Panel>

      <Tabs.Panel value="notes" pt="sm" data-testid="drawer-panel-notes">
        <Text size="sm" c="dimmed">
          Notes coming with US4.
        </Text>
      </Tabs.Panel>
    </Tabs>
  );
}

export default AnalysisDrawerTabs;
