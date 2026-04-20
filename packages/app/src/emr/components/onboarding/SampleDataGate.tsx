// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * SampleDataGate (T441 companion).
 *
 * Plain-English: tiny hook + wrapper used by AnalysisDetailView and
 * PACSPushPanel to know whether the current analysis is a demo case.
 * When `isDemo` is true:
 *   - AnalysisDetailView mounts <SampleDataBadge />
 *   - PACSPushPanel disables its push button with a tooltip
 *   - PDFPreview burns a sample-data marker into the watermark layer
 *
 * The actual analysis detail is fetched via `useAnalysis()`; this file
 * exists so sibling agents that own those views don't have to re-derive
 * the demo-detection logic.
 */
import type { ReactNode } from 'react';
import SampleDataBadge from './SampleDataBadge';

export interface SampleDataDescriptor {
  isDemo: boolean;
  fixtureKey?: string;
  seededAt?: string;
}

export function isSampleAnalysis(a: {
  is_demo?: boolean;
  demo_fixture_key?: string;
  seededAt?: string;
} | null | undefined): SampleDataDescriptor {
  if (!a?.is_demo) return { isDemo: false };
  return {
    isDemo: true,
    fixtureKey: a.demo_fixture_key,
    seededAt: a.seededAt,
  };
}

export interface SampleDataGateProps {
  analysis: { is_demo?: boolean; demo_fixture_key?: string } | null | undefined;
  children: ReactNode;
  /** Render the banner above the children when demo. */
  showBadge?: boolean;
}

export function SampleDataGate({
  analysis,
  children,
  showBadge = true,
}: SampleDataGateProps): React.ReactElement {
  const desc = isSampleAnalysis(analysis);
  return (
    <>
      {desc.isDemo && showBadge && <SampleDataBadge />}
      {children}
    </>
  );
}

export default SampleDataGate;
