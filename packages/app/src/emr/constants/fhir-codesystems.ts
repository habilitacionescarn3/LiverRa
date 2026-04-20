// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa — SNOMED CT Code Catalog
 *
 * Every SNOMED CT code that LiverRa writes into a FHIR `CodeableConcept`
 * (DiagnosticReport.code, Observation.valueCodeableConcept, SEG segment
 * category/type, SR qualitative evaluations, …). Mirrors the table in
 * `contracts/dicom-artifacts.md` — keep the two in sync.
 *
 * Plain-English analogy:
 *   SNOMED codes are the "barcode" for a medical concept. `10200004` is the
 *   barcode for "liver"; `109841003` is for "HCC"; etc. This file keeps every
 *   barcode we scan centralized so nobody hand-types them.
 *
 * Every entry references `EXTERNAL_SYSTEMS.SNOMED` for the canonical URL so
 * changes there propagate automatically.
 */

import { EXTERNAL_SYSTEMS } from './fhir-systems';

/** Shape of a LiverRa-referenced SNOMED concept. */
export interface SnomedConcept {
  code: string;
  display: string;
  system: typeof EXTERNAL_SYSTEMS.SNOMED;
}

/** Helper to build a SNOMED concept entry (all entries share one system). */
const snomed = (code: string, display: string): SnomedConcept => ({
  code,
  display,
  system: EXTERNAL_SYSTEMS.SNOMED,
});

// ============================================================================
// SNOMED-CT — Liver anatomy, segments, vasculature, tumor classes
// ============================================================================

/**
 * Every SNOMED code used by LiverRa's DICOM-SEG + DICOM-SR writers, the
 * LiLNet classifier head, the Couinaud parser, and the FLR adequacy
 * qualitative evaluation.
 */
export const SNOMED_LIVER_CODES = {
  // -- Anatomy --

  /** Whole-liver parenchyma. */
  LIVER: snomed('10200004', 'Liver structure'),

  // -- Couinaud segments I–VIII (sequential; match contracts/dicom-artifacts.md) --
  COUINAUD_I: snomed('245302009', 'Couinaud hepatic segment I'),
  COUINAUD_II: snomed('245303004', 'Couinaud hepatic segment II'),
  COUINAUD_III: snomed('245304005', 'Couinaud hepatic segment III'),
  COUINAUD_IV: snomed('245305006', 'Couinaud hepatic segment IV'),
  COUINAUD_V: snomed('245306007', 'Couinaud hepatic segment V'),
  COUINAUD_VI: snomed('245307003', 'Couinaud hepatic segment VI'),
  COUINAUD_VII: snomed('245308008', 'Couinaud hepatic segment VII'),
  COUINAUD_VIII: snomed('245309003', 'Couinaud hepatic segment VIII'),

  // -- Vasculature --
  PORTAL_VEIN: snomed('32764006', 'Portal vein structure'),
  HEPATIC_VEIN: snomed('8887007', 'Hepatic vein structure'),

  // -- Tumor / lesion classes (LiLNet 6-class head) --
  HCC: snomed('109841003', 'Hepatocellular carcinoma'),
  ICC: snomed('312104005', 'Intrahepatic cholangiocarcinoma'),
  FNH: snomed('62129009', 'Focal nodular hyperplasia of liver'),
  HEMANGIOMA: snomed('235857004', 'Hemangioma of liver'),
  CYST: snomed('235866006', 'Cyst of liver'),
  METASTASIS: snomed('94381002', 'Secondary malignant neoplasm of liver'),
} as const;

export type SnomedLiverCodeKey = keyof typeof SNOMED_LIVER_CODES;

/**
 * Convenience list of the 8 Couinaud segment concepts in anatomical order
 * (I → VIII). Matches SEG segment numbers 2..9 in contracts/dicom-artifacts.md.
 */
export const COUINAUD_SEGMENTS_ORDERED: readonly SnomedConcept[] = [
  SNOMED_LIVER_CODES.COUINAUD_I,
  SNOMED_LIVER_CODES.COUINAUD_II,
  SNOMED_LIVER_CODES.COUINAUD_III,
  SNOMED_LIVER_CODES.COUINAUD_IV,
  SNOMED_LIVER_CODES.COUINAUD_V,
  SNOMED_LIVER_CODES.COUINAUD_VI,
  SNOMED_LIVER_CODES.COUINAUD_VII,
  SNOMED_LIVER_CODES.COUINAUD_VIII,
] as const;

/**
 * Convenience list of the 6 LiLNet tumor classes. Used when rendering the
 * lesion-classification confusion matrix and for abstention fallback lookup.
 */
export const LESION_CLASSES_ORDERED: readonly SnomedConcept[] = [
  SNOMED_LIVER_CODES.HCC,
  SNOMED_LIVER_CODES.ICC,
  SNOMED_LIVER_CODES.FNH,
  SNOMED_LIVER_CODES.HEMANGIOMA,
  SNOMED_LIVER_CODES.CYST,
  SNOMED_LIVER_CODES.METASTASIS,
] as const;
