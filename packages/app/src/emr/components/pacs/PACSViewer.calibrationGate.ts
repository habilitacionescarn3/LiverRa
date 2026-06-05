// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// SFAR/XA #8-L3130 — XA annotation-autosave calibration gate.
//
// Plain-English explanation:
//   On X-ray angiography (XA), a "length" or "area" measurement only has a real
//   millimetre value once the operator has drawn the calibration line across a
//   known-size catheter (mm-per-pixel). Until that calibration is confirmed and
//   persisted, autosaving a length/area/stenosis measurement would store a number
//   derived from an unconfirmed scale. This module isolates the pure decision —
//   which annotations may be saved now vs. must be deferred — so the heavy
//   PACSViewer component stays thin and the rule is unit-testable.

// Tools whose persisted value is derived from the mm-per-pixel scale (length,
// area, distance, point density). Angle/CobbAngle (dimensionless) and
// Polyline/ArrowAnnotate (markup, no scaled value) are NOT gated.
export const CALIBRATION_DEPENDENT_TOOLS = new Set<string>([
  'Length',
  'Bidirectional',
  'Probe',
  'DragProbe',
  'EllipticalROI',
  'FreehandROI',
  'RectangleROI',
  'CircleROI',
  'SplineROI',
]);

export function isCalibrationDependentAnnotation(ann: unknown): boolean {
  if (!ann || typeof ann !== 'object') return false;
  const metadata = (ann as { metadata?: { toolName?: unknown; purpose?: unknown } }).metadata;
  if (metadata?.purpose === 'stenosis') return true;
  const toolName = metadata?.toolName;
  return typeof toolName === 'string' && CALIBRATION_DEPENDENT_TOOLS.has(toolName);
}

/**
 * Split an annotation-state JSON array into the annotations safe to persist now
 * (`retained`) and a flag for whether any calibration-dependent annotation was
 * withheld (`deferred`). Returns `retained: null` on parse failure so the caller
 * can fail closed (skip the save) rather than persist on an unconfirmed scale.
 */
export function splitCalibrationDependentAnnotations(annotationJson: string): {
  retained: string | null;
  deferred: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(annotationJson);
  } catch {
    return { retained: null, deferred: true };
  }
  if (!Array.isArray(parsed)) {
    return { retained: annotationJson, deferred: false };
  }
  const safe = parsed.filter((ann) => !isCalibrationDependentAnnotation(ann));
  return { retained: JSON.stringify(safe), deferred: safe.length !== parsed.length };
}
