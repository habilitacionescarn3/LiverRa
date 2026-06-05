// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// SFAR/XA #8-L3130 — XA annotation autosave must respect the calibration gate.
// These tests pin down the pure split decision that PACSViewer.queueAnnotationSave
// applies when the active modality is XA and calibration is not yet persistable.

import { describe, expect, it } from 'vitest';

import {
  isCalibrationDependentAnnotation,
  splitCalibrationDependentAnnotations,
} from './PACSViewer.calibrationGate';

const ann = (toolName: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  metadata: { toolName, ...extra },
  data: {},
});

describe('isCalibrationDependentAnnotation', () => {
  it.each(['Length', 'Bidirectional', 'Probe', 'DragProbe', 'EllipticalROI', 'RectangleROI', 'CircleROI', 'SplineROI', 'FreehandROI'])(
    'flags %s as calibration-dependent',
    (tool) => {
      expect(isCalibrationDependentAnnotation(ann(tool))).toBe(true);
    },
  );

  it.each(['Angle', 'CobbAngle', 'Polyline', 'ArrowAnnotate'])(
    'does NOT flag %s (dimensionless / markup)',
    (tool) => {
      expect(isCalibrationDependentAnnotation(ann(tool))).toBe(false);
    },
  );

  it('flags a stenosis annotation by metadata.purpose regardless of toolName', () => {
    expect(isCalibrationDependentAnnotation(ann('Length', { purpose: 'stenosis' }))).toBe(true);
    expect(isCalibrationDependentAnnotation(ann('Angle', { purpose: 'stenosis' }))).toBe(true);
  });

  it('returns false for non-object input', () => {
    expect(isCalibrationDependentAnnotation(null)).toBe(false);
    expect(isCalibrationDependentAnnotation('Length')).toBe(false);
  });
});

describe('splitCalibrationDependentAnnotations', () => {
  it('withholds a calibration-dependent Length annotation (deferred) when calibration not persisted', () => {
    const json = JSON.stringify([ann('Length')]);
    const { retained, deferred } = splitCalibrationDependentAnnotations(json);
    expect(deferred).toBe(true);
    expect(JSON.parse(retained as string)).toEqual([]);
  });

  it('retains non-calibration annotations and withholds only the calibration-dependent ones', () => {
    const json = JSON.stringify([ann('Angle'), ann('Length'), ann('ArrowAnnotate')]);
    const { retained, deferred } = splitCalibrationDependentAnnotations(json);
    expect(deferred).toBe(true);
    const kept = JSON.parse(retained as string) as Array<{ metadata: { toolName: string } }>;
    expect(kept.map((a) => a.metadata.toolName)).toEqual(['Angle', 'ArrowAnnotate']);
  });

  it('keeps all annotations (deferred=false) when none are calibration-dependent', () => {
    const json = JSON.stringify([ann('Angle'), ann('CobbAngle')]);
    const { retained, deferred } = splitCalibrationDependentAnnotations(json);
    expect(deferred).toBe(false);
    expect(JSON.parse(retained as string)).toHaveLength(2);
  });

  it('fails closed on malformed JSON (retained=null, deferred=true)', () => {
    const { retained, deferred } = splitCalibrationDependentAnnotations('{not json');
    expect(retained).toBeNull();
    expect(deferred).toBe(true);
  });
});
