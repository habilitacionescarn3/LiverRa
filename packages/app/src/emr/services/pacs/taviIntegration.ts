// SPDX-License-Identifier: Apache-2.0
/**
 * taviIntegration — LiverRa deployment STUB of MediMind's TAVI planning seam.
 *
 * MediMind's PACSViewer routes all TAVI touchpoints (the "Plan TAVI" button,
 * source-DICOM provenance feed, marker-tool registration, cardiac-CT
 * eligibility) through this single module so the viewer never imports from
 * the TAVI tree directly. LiverRa has no TAVI planning workspace, so this is
 * the permanent "PACS-only build" variant MediMind documents in its own
 * header: the button renders nothing, the feed/tool wrappers are no-ops, and
 * eligibility always returns false — TAVI is physically absent from the
 * bundle while PACSViewer.tsx stays byte-identical to upstream.
 *
 * If LiverRa ever grows a procedure-planning workspace, replace these stubs
 * with the real wiring (see medplum_medimind services/pacs/taviIntegration.ts).
 *
 * @module services/pacs/taviIntegration
 */

import type { DicomJsonObject } from './dicomwebClient';

/** Props accepted by the (stubbed) "Plan TAVI" CTA — kept for type parity. */
export interface PlanTaviActionButtonProps {
  /** ImagingStudy resource id (used to build the planning URL). */
  studyId: string;
  /** Study description from DICOM metadata — used by the description regex fallback. */
  studyDescription?: string;
  /** Resolved subspecialty hint (from the `imaging-subspecialty` extension). */
  subspecialty?: string;
  /** Study modalities, when known. TAVI planning requires CT. */
  modalities?: string[];
  /** When set, used as a `data-testid` — defaults to `pacs-plan-tavi-button`. */
  testId?: string;
  /** Optional custom className applied to the wrapper button element. */
  className?: string;
  /** Optional onClick interceptor — receives the resolved target path. */
  onBeforeNavigate?: (path: string) => void;
}

/** Study-eligibility input shape — kept for type parity with upstream. */
export interface TaviStudyEligibilityInput {
  description?: string;
  subspecialty?: string;
  modalities?: string[];
}

/** The "Plan TAVI" CTA. Render-nothing stub — LiverRa has no TAVI workspace. */
export function TaviActionButton(_props: PlanTaviActionButtonProps): null {
  return null;
}

/** RBAC permission code required for any TAVI planning capability. */
export const PLAN_PROCEDURE_PERMISSION = 'plan-procedure';

/**
 * Record source DICOM metadata for later TAVI provenance.
 * No-op: the PACS viewer never reads it; only a TAVI workspace would.
 */
export function recordSourceDicomMetadata(_imageId: string, _metadata: DicomJsonObject): void {
  // intentional no-op (no TAVI tree in LiverRa)
}

/**
 * Register the TAVI Cornerstone3D marker-placement tool during viewer init.
 * No-op: nothing to register without the TAVI tree.
 */
export async function registerTaviTools(): Promise<void> {
  // intentional no-op (no TAVI tree in LiverRa)
}

/** Whether a study is a TAVI cardiac-CT candidate. Always false in LiverRa. */
export function isTaviEligible(_study: TaviStudyEligibilityInput): boolean {
  return false;
}
