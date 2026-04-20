/**
 * Segmentation, Lesion, Classification, FLRCalculation domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md` §7-§10.
 */

/**
 * A labelled 3D mask. Reviewer-edited successors point back to the
 * AI-original via `parentSegmentationId` (non-destructive edit lineage).
 */
export interface Segmentation {
  id: string;
  analysisId: string;
  generationSource: 'ai' | 'reviewer_edited';
  parentSegmentationId: string | null;
  maskUri: string;
  sopInstanceUid: string;
  createdAt: string;
}

/**
 * Axis-aligned bounding box in patient-voxel coordinates.
 * `min`/`max` are `[x, y, z]` triples in mm.
 */
export interface Bbox3D {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * A detected focal lesion. Distinct from its mask Segmentation.
 * `discoverySource` = `reviewer_prompted` means MedSAM-2 one-prompt (FR-016).
 */
export interface Lesion {
  id: string;
  analysisId: string;
  bbox3d: Bbox3D;
  couinaudSegment: string;
  diameterMm: number;
  maskUri: string;
  discoverySource: 'ai' | 'reviewer_prompted';
}

/**
 * Six-class lesion classification probability vector.
 * HCC · ICC · MET · FNH · HEM · CYST — sums to 1.0 ± 0.01 after
 * temperature scaling (research C.7).
 */
export type ClassificationProbs = Record<
  'HCC' | 'ICC' | 'MET' | 'FNH' | 'HEM' | 'CYST',
  number
>;

/**
 * Per-lesion classification assignment + calibrated confidence vector +
 * abstention state (FR-011). `suggestedClass` is `null` when abstained.
 */
export interface Classification {
  lesionId: string;
  probsVec: ClassificationProbs;
  suggestedClass: keyof ClassificationProbs | null;
  temperature: number;
  abstained: boolean;
}

/**
 * Resection-plane pose: a unit normal + signed offset from the parenchyma
 * centroid. Sufficient to reproduce the FLR computation deterministically.
 */
export interface ResectionPlanePose {
  normal: [number, number, number];
  offsetMm: number;
}

/**
 * Future Liver Remnant calculation (FR-012).
 * Invariant: `totalMl` equals parenchyma volume; `flrMl = totalMl - resectedMl`
 * within ±0.5 % (enforced at write in the service layer).
 */
export interface FLRCalculation {
  id: string;
  analysisId: string;
  planePose: ResectionPlanePose;
  totalMl: number;
  flrMl: number;
  flrPct: number;
  computedAt: string;
}
