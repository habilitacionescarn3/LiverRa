// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// DICOM Tag Constants (DICOM PS3.6 Data Dictionary)
// ============================================================================
// Hex tag values used when reading DICOM JSON (QIDO/WADO) responses. The
// JSON encoding strips the standard "(group,element)" delimiter, leaving a
// concatenated 8-character hex string.
//
// Originally defined locally in usePACSViewer.dicom.ts but lost in the
// god-file-split refactor (commit 92d7a0946). Centralized here so every
// PACS component reads from one source of truth.
// ============================================================================

export const SERIES_INSTANCE_UID_TAG = '0020000E';
export const MODALITY_TAG = '00080060';
export const SERIES_DESCRIPTION_TAG = '0008103E';
export const SOP_CLASS_UID_TAG = '00080016';
export const SOP_INSTANCE_UID_TAG = '00080018';
export const NUMBER_OF_FRAMES_TAG = '00280008';
/** QIDO series-level instance count — returned by /studies/{s}/series without per-instance retrieve. */
export const NUMBER_OF_SERIES_RELATED_INSTANCES_TAG = '00201209';

// Mammography (FFDM) hanging-protocol tags — drive RCC/LCC/RMLO/LMLO
// auto-placement and right-breast mirroring. See services/pacs/mammoLayout.ts.
/** Image Laterality (0020,0062) — per-image breast side: 'L' | 'R'. */
export const IMAGE_LATERALITY_TAG = '00200062';
/** View Position (0018,5101) — e.g. 'CC' | 'MLO' | 'ML' | 'XCCL'. */
export const VIEW_POSITION_TAG = '00185101';
/** Presentation Intent Type (0008,0068) — 'FOR PRESENTATION' | 'FOR PROCESSING'. */
export const PRESENTATION_INTENT_TYPE_TAG = '00080068';
/** Patient Orientation (0020,0020) — row/column direction, e.g. 'A\\F'; for MG the
 *  first value's polarity (L vs R / P vs A) tells whether the image is already
 *  mirrored, so we don't double-flip the right breast. */
export const PATIENT_ORIENTATION_TAG = '00200020';
/** Field of View Horizontal Flip (0018,7034) — 'YES' | 'NO'; when 'YES' the
 *  detector already flipped the image horizontally. */
export const FIELD_OF_VIEW_HORIZONTAL_FLIP_TAG = '00187034';
