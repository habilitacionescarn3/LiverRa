// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * acrTelemetry — unit tests for feature 002-acr-structured-readout T051.
 *
 * Verifies:
 *   - Each helper invokes capture() with the expected event name.
 *   - lesionCount is bucketed (string), never raw number.
 *   - Forbidden PHI-adjacent properties are NEVER in the payload:
 *     userId, patientRef, actorId, text, clipboardText.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the capture export from postHogClient so we can assert it received
// the right event name + scrubbed properties. The spy is created inside a
// vi.hoisted() block because vi.mock factories run BEFORE module-level
// statements — otherwise the captureSpy reference would be undefined when
// the factory executes.
const { captureSpy } = vi.hoisted(() => ({ captureSpy: vi.fn() }));
vi.mock('../../telemetry/postHogClient', () => ({
  capture: captureSpy,
}));

import {
  bucketLesionCount,
  trackCopyFailed,
  trackCopySucceeded,
  trackCopyTooltipDismissed,
  trackCopyTooltipSeen,
  trackPdfSectionRendered,
  trackReadoutViewed,
} from '../acrTelemetry';

const FORBIDDEN = ['userId', 'patientRef', 'actorId', 'text', 'clipboardText'];

beforeEach(() => {
  captureSpy.mockClear();
  // safeCapture short-circuits when globalThis.posthog === undefined.
  // Stub a no-op object so capture() actually runs.
  (globalThis as { posthog?: unknown }).posthog = {};
});

afterEach(() => {
  delete (globalThis as { posthog?: unknown }).posthog;
});

function assertNoForbidden(props: Record<string, unknown>): void {
  for (const key of FORBIDDEN) {
    expect(props, `forbidden key "${key}" must not appear in telemetry payload`).not.toHaveProperty(key);
  }
}

describe('bucketLesionCount', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2-5'],
    [5, '2-5'],
    [6, '6-10'],
    [10, '6-10'],
    [11, '11-20'],
    [20, '11-20'],
    [21, '21-50'],
    [50, '21-50'],
    [51, '50+'],
    [999, '50+'],
  ])('buckets %i → %s', (n, bucket) => {
    expect(bucketLesionCount(n)).toBe(bucket);
  });
});

describe('trackReadoutViewed', () => {
  it('captures acr_readout_viewed with bucketed lesionCount + no forbidden keys', () => {
    trackReadoutViewed({
      analysisId: 'a-001',
      locale: 'en',
      status: 'completed',
      lesionCount: 7,
    });
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_readout_viewed');
    expect(props).toMatchObject({
      analysisId: 'a-001',
      locale: 'en',
      status: 'completed',
      lesionCount: '6-10', // bucketed
    });
    expect(typeof (props as Record<string, unknown>).lesionCount).toBe('string');
    assertNoForbidden(props as Record<string, unknown>);
  });
});

describe('trackCopySucceeded', () => {
  it('captures acr_clipboard_copy_succeeded with bucketed lesionCount + duration rounded', () => {
    trackCopySucceeded({
      analysisId: 'a-002',
      locale: 'de',
      lesionCount: 3,
      durationMs: 187.6,
      pendingQueueDepth: 2,
    });
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_clipboard_copy_succeeded');
    expect(props).toMatchObject({
      analysisId: 'a-002',
      locale: 'de',
      lesionCount: '2-5',
      durationMs: 188,
      pendingQueueDepth: 2,
    });
    assertNoForbidden(props as Record<string, unknown>);
  });
});

describe('trackCopyFailed', () => {
  it('captures acr_clipboard_copy_failed with failureCategory + no forbidden keys', () => {
    trackCopyFailed({
      analysisId: 'a-003',
      locale: 'ka',
      failureCategory: 'clipboard_blocked',
      durationMs: 12.3,
    });
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_clipboard_copy_failed');
    expect(props).toMatchObject({
      analysisId: 'a-003',
      locale: 'ka',
      failureCategory: 'clipboard_blocked',
      durationMs: 12,
    });
    assertNoForbidden(props as Record<string, unknown>);
  });
});

describe('trackPdfSectionRendered', () => {
  it('captures acr_pdf_section_rendered with bucketed lesionCount', () => {
    trackPdfSectionRendered({
      analysisId: 'a-004',
      locale: 'ru',
      lesionCount: 25,
      durationMs: 1200.7,
    });
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_pdf_section_rendered');
    expect(props).toMatchObject({
      analysisId: 'a-004',
      locale: 'ru',
      lesionCount: '21-50',
      durationMs: 1201,
    });
    assertNoForbidden(props as Record<string, unknown>);
  });
});

describe('tooltip telemetry', () => {
  it('captures acr_copy_tooltip_seen with analysisId only', () => {
    trackCopyTooltipSeen('a-005');
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_copy_tooltip_seen');
    expect(props).toEqual({ analysisId: 'a-005' });
    assertNoForbidden(props as Record<string, unknown>);
  });

  it('captures acr_copy_tooltip_dismissed with analysisId only', () => {
    trackCopyTooltipDismissed('a-006');
    expect(captureSpy).toHaveBeenCalledOnce();
    const [event, props] = captureSpy.mock.calls[0]!;
    expect(event).toBe('acr_copy_tooltip_dismissed');
    expect(props).toEqual({ analysisId: 'a-006' });
    assertNoForbidden(props as Record<string, unknown>);
  });
});

describe('safeCapture short-circuit', () => {
  it('does not call capture when globalThis.posthog is undefined', () => {
    delete (globalThis as { posthog?: unknown }).posthog;
    trackReadoutViewed({
      analysisId: 'a-007',
      locale: 'en',
      status: 'completed',
      lesionCount: 0,
    });
    expect(captureSpy).not.toHaveBeenCalled();
  });
});
