// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACS Performance Instrumentation
// ============================================================================
// Lightweight timing utilities that use the browser's Performance API to
// measure how long key operations take. Think of these as stopwatches for
// important actions like loading the first image, activating MPR, or
// fetching the worklist.
//
// Performance marks are visible in the browser's DevTools Performance tab,
// and the results are logged to the console in development mode.
//
// Target benchmarks:
//   - First image display:  <5 seconds
//   - MPR activation:       <3 seconds
//   - Worklist fetch:       <30 seconds (typically <2s)
//
// Ported from MediMind (services/pacs/pacsPerformance.ts). No Medplum.
// ============================================================================

// ============================================================================
// Constants
// ============================================================================

/** Performance mark prefix to namespace our marks */
const PREFIX = 'pacs';

/** Target benchmarks in milliseconds */
export const BENCHMARKS = {
  firstImage: 5000,   // <5 seconds
  mprActivation: 3000, // <3 seconds
  worklistFetch: 30000, // <30 seconds
} as const;

/** Whether to log timing results (development only) */
const SHOULD_LOG = import.meta.env.DEV;

// ============================================================================
// Core Timing API
// ============================================================================

/**
 * Start a named performance timer.
 * Places a "mark" in the browser's Performance timeline.
 *
 * @param name - Timer name (e.g., 'firstImage', 'mprActivation')
 */
export function startTimer(name: string): void {
  try {
    performance.mark(`${PREFIX}:${name}:start`);
  } catch {
    // Performance API not available — silently skip
  }
}

/**
 * Stop a named performance timer and return the elapsed time in milliseconds.
 * Creates a Performance "measure" between the start and end marks.
 *
 * @param name - Timer name (must match a previous startTimer call)
 * @param benchmarkMs - Optional benchmark to compare against
 * @returns Elapsed time in milliseconds, or -1 if the start mark was not found
 */
export function stopTimer(name: string, benchmarkMs?: number): number {
  const startMark = `${PREFIX}:${name}:start`;
  const endMark = `${PREFIX}:${name}:end`;
  const measureName = `${PREFIX}:${name}`;

  try {
    performance.mark(endMark);
    const entries = performance.getEntriesByName(startMark, 'mark');
    if (entries.length === 0) {
      return -1;
    }

    const measure = performance.measure(measureName, startMark, endMark);
    const durationMs = Math.round(measure.duration);

    // Log in development mode
    if (SHOULD_LOG) {
      const status = benchmarkMs ? (durationMs <= benchmarkMs ? '✅' : '⚠️') : '📊';
      const benchmarkStr = benchmarkMs ? ` (target: <${benchmarkMs}ms)` : '';
      console.debug(`[PACS Perf] ${status} ${name}: ${durationMs}ms${benchmarkStr}`);
    }

    // Clean up marks to avoid memory buildup
    performance.clearMarks(startMark);
    performance.clearMarks(endMark);
    performance.clearMeasures(measureName);

    return durationMs;
  } catch {
    return -1;
  }
}

// ============================================================================
// Pre-built Timers for Key Operations
// ============================================================================

/**
 * Track first image display time.
 * Start this when the viewer begins loading, stop when the first image renders.
 */
export const firstImageTimer = {
  start: () => startTimer('firstImage'),
  stop: () => stopTimer('firstImage', BENCHMARKS.firstImage),
};

/**
 * Track MPR (Multi-Planar Reconstruction) activation time.
 * Start when the user clicks MPR, stop when all 3 viewports are ready.
 */
export const mprTimer = {
  start: () => startTimer('mprActivation'),
  stop: () => stopTimer('mprActivation', BENCHMARKS.mprActivation),
};

/**
 * Track worklist fetch time.
 * Start when the fetch begins, stop when data is ready for display.
 */
export const worklistTimer = {
  start: () => startTimer('worklistFetch'),
  stop: () => stopTimer('worklistFetch', BENCHMARKS.worklistFetch),
};

/**
 * Track Cornerstone3D initialization time.
 * Start before init, stop after engine is ready.
 */
export const cornerstoneInitTimer = {
  start: () => startTimer('cornerstoneInit'),
  stop: () => stopTimer('cornerstoneInit'),
};

/**
 * Track study metadata fetch time.
 * Start when DICOMweb request begins, stop when metadata returns.
 */
export const metadataFetchTimer = {
  start: () => startTimer('metadataFetch'),
  stop: () => stopTimer('metadataFetch'),
};
