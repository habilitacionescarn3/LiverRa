// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared TypeScript shapes for the liver lesion UI (T217, T218, T219, T220).
 *
 * Plain-English: before every component re-derives what a "lesion" looks
 * like on the wire, we centralise the minimum field set used by the UI in
 * this file. The authoritative database rows live in `data-model.md §8–9`;
 * what the backend sends to the browser is a flattened join of Lesion +
 * its latest Classification row + a few AI-inferred extras.
 *
 * These types are UI-facing only. The full API schema lives in
 * `services/api-schema.gen.ts` once the OpenAPI client is generated.
 */

/** 6 tumour classes produced by LiLNet. Matches `Classification.suggested_class`. */
export type LesionClass = 'HCC' | 'ICC' | 'MET' | 'FNH' | 'HEM' | 'CYST';

/** Malignancy buckets — drives badge colour family. */
export type LesionMalignancy = 'malignant' | 'benign';

/** Couinaud segments (I–VIII) or a multi-segment span. */
export type CouinaudSegment = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII' | 'VIII' | 'multi_segment';

/** Source of the detection — AI auto-detect vs. reviewer one-prompt (FR-016). */
export type DiscoverySource = 'ai_detected' | 'reviewer_prompted';

/** Axis-aligned bounding box in world-space (mm). `[xMin,yMin,zMin,xMax,yMax,zMax]`. */
export type BBox3D = readonly [number, number, number, number, number, number];

/**
 * Per-class probability distribution after temperature scaling.
 * Σ = 1.0 ± 0.01 per research §C.7.
 */
export interface LesionConfidenceVector {
  HCC: number;
  ICC: number;
  MET: number;
  FNH: number;
  HEM: number;
  CYST: number;
}

/**
 * A single focal lesion flattened for UI consumption.
 * Mirrors `Lesion` + latest `Classification` row.
 */
export interface LesionUI {
  id: string;
  analysisId: string;
  displayOrder: number;
  /** UI-visible 1-based index, derived from `displayOrder`. */
  index: number;
  /** Couinaud segment label or multi-span marker. */
  couinaudLocation: CouinaudSegment;
  /** Human-readable location string (e.g. "Segment IV/V"). */
  locationLabel: string;
  longestDiameterMm: number;
  axialDiameterMm?: number;
  coronalDiameterMm?: number;
  sagittalDiameterMm?: number;
  volumeMl: number;
  discoverySource: DiscoverySource;
  /** Thumbnail URL — a cropped axial slice centred on the lesion. */
  thumbnailUrl?: string;
  /** World-space bounding box for recenter-on-click (FR-010 + FR-020). */
  bbox3d: BBox3D;
  /** AI-suggested class after abstention gate (`null` → abstained, FR-011). */
  suggestedClass: LesionClass | null;
  /** Max confidence in [0, 1]. `null` when abstained. */
  confidence: number | null;
  /** Full distribution for the detail-panel bar chart. */
  confidenceVector: LesionConfidenceVector;
  /** Abstention threshold used when computing `suggestedClass`. */
  abstentionThreshold: number;
  /** Calibration temperature applied (research §C.7). */
  temperatureApplied: number;
  /** MBoM key of the classifier run. */
  modelVersion: string;
  /** Optional reviewer override (FR-046). */
  reviewerOverride?: {
    classValue: LesionClass;
    reviewerUserId: string;
    at: string;
    reason?: string;
  };
  /** URL or data-URI for the segmentation mask (used by LesionLayer overlay). */
  maskUrl?: string;
}

/** Maps a LesionClass → malignancy bucket for colour selection. */
export const LESION_MALIGNANCY: Readonly<Record<LesionClass, LesionMalignancy>> = {
  HCC: 'malignant',
  ICC: 'malignant',
  MET: 'malignant',
  FNH: 'benign',
  HEM: 'benign',
  CYST: 'benign',
};

/** Deterministic display order for the detail-panel bar chart. */
export const LESION_CLASS_ORDER: readonly LesionClass[] = [
  'HCC',
  'ICC',
  'MET',
  'FNH',
  'HEM',
  'CYST',
];
