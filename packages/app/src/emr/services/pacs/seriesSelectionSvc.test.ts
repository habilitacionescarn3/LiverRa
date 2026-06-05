// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// LiverRa: explicit vitest imports (MediMind ran with jest globals).
import { describe, expect, it } from 'vitest';

import {
  selectPrimarySeriesImageIds,
  selectPrimarySeriesUidFromSeriesMeta,
  seriesUidOfImageId,
  sortImageIdsBySpatialPosition,
  type SeriesLevelMeta,
} from './seriesSelectionSvc';
import type { ExtractedSeriesItem } from '../../hooks/pacs/usePACSViewer.dicom';

/** Local mirror of seriesSelectionSvc.ImagePlane (avoids a 2nd type-import). */
type ImagePlane = {
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
};

const wadors = (series: string, n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) =>
      `wadors:http://pacs/dicom-web/studies/1.2.3/series/${series}/instances/9.9.${i}/frames/1`,
  );

const item = (
  seriesUid: string,
  modality: string,
  instanceCount: number,
): ExtractedSeriesItem => ({ seriesUid, modality, instanceCount });

describe('seriesUidOfImageId', () => {
  it('parses the series UID from a wadors imageId', () => {
    expect(
      seriesUidOfImageId(
        'wadors:http://pacs/dicom-web/studies/1.2/series/4.5.6/instances/7.8/frames/1',
      ),
    ).toBe('4.5.6');
  });

  it('returns undefined when there is no /series/ segment (test fixtures)', () => {
    expect(seriesUidOfImageId('wadors:test/frames/1')).toBeUndefined();
  });
});

describe('selectPrimarySeriesImageIds', () => {
  it('returns input unchanged when imageIds have no parseable series (jest fixtures)', () => {
    const ids = ['wadors:test/frames/1', 'wadors:test/frames/2'];
    const sel = selectPrimarySeriesImageIds(ids, []);
    expect(sel.imageIds).toBe(ids);
    expect(sel.reason).toBe('all-fallback');
    expect(sel.seriesCount).toBe(0);
  });

  it('returns input unchanged when the study has exactly one series', () => {
    const ids = wadors('SERIES_A', 300);
    const sel = selectPrimarySeriesImageIds(ids, [item('SERIES_A', 'CT', 300)]);
    expect(sel.imageIds).toBe(ids);
    expect(sel.seriesUid).toBe('SERIES_A');
    expect(sel.reason).toBe('all-fallback');
    expect(sel.seriesCount).toBe(1);
  });

  it('picks the largest CT series out of a multi-series study (the banding fix)', () => {
    const scout = wadors('SCOUT', 3);
    const calcium = wadors('CALCIUM', 60);
    const cta = wadors('CTA_RECON', 512); // the volumetric reconstruction
    const all = [...scout, ...calcium, ...cta];
    const sel = selectPrimarySeriesImageIds(all, [
      item('SCOUT', 'CT', 3),
      item('CALCIUM', 'CT', 60),
      item('CTA_RECON', 'CT', 512),
    ]);
    expect(sel.seriesUid).toBe('CTA_RECON');
    expect(sel.imageIds).toHaveLength(512);
    expect(sel.reason).toBe('largest-ct');
    expect(sel.seriesCount).toBe(3);
  });

  it('honors the recommended cardiac-phase series even if it is not the largest', () => {
    const phase35 = wadors('PHASE_35', 400); // clinically recommended
    const phase75 = wadors('PHASE_75', 480); // largest, but wrong phase
    const all = [...phase35, ...phase75];
    const sel = selectPrimarySeriesImageIds(
      all,
      [item('PHASE_35', 'CT', 400), item('PHASE_75', 'CT', 480)],
      'PHASE_35',
    );
    expect(sel.seriesUid).toBe('PHASE_35');
    expect(sel.imageIds).toHaveLength(400);
    expect(sel.reason).toBe('preferred-phase');
  });

  it('falls back to largest CT when the preferred series UID is absent from the study', () => {
    const a = wadors('A', 100);
    const b = wadors('B', 200);
    const sel = selectPrimarySeriesImageIds(
      [...a, ...b],
      [item('A', 'CT', 100), item('B', 'CT', 200)],
      'PHASE_NOT_IN_STUDY',
    );
    expect(sel.seriesUid).toBe('B');
    expect(sel.reason).toBe('largest-ct');
  });

  it('falls back to largest series of any modality when no CT modality is known', () => {
    const a = wadors('A', 100);
    const b = wadors('B', 250);
    // seriesItems empty → no CT set → "largest" path
    const sel = selectPrimarySeriesImageIds([...a, ...b], []);
    expect(sel.seriesUid).toBe('B');
    expect(sel.reason).toBe('largest');
    expect(sel.seriesCount).toBe(2);
  });

  it('handles an empty imageId list without throwing', () => {
    const sel = selectPrimarySeriesImageIds([], []);
    expect(sel.imageIds).toEqual([]);
    expect(sel.reason).toBe('all-fallback');
    expect(sel.seriesCount).toBe(0);
  });
});

describe('sortImageIdsBySpatialPosition', () => {
  // Axial acquisition: row=(1,0,0), col=(0,1,0) → normal = +Z.
  const AXIAL_IOP = [1, 0, 0, 0, 1, 0];
  const planeAt = (z: number): ImagePlane => ({
    imagePositionPatient: [0, 0, z],
    imageOrientationPatient: AXIAL_IOP,
  });

  it('orders scrambled imageIds by through-plane (Z) position', () => {
    const planes: Record<string, ImagePlane> = {
      a: planeAt(10),
      b: planeAt(-5),
      c: planeAt(30),
      d: planeAt(0),
    };
    const sorted = sortImageIdsBySpatialPosition(
      ['a', 'b', 'c', 'd'],
      (id) => planes[id],
    );
    expect(sorted).toEqual(['b', 'd', 'a', 'c']);
  });

  it('returns the input unchanged when no plane metadata is available', () => {
    const ids = ['x', 'y', 'z'];
    expect(sortImageIdsBySpatialPosition(ids, () => undefined)).toBe(ids);
  });

  it('sorts positioned slices by Z and pushes unpositioned slices to the end (stable)', () => {
    const planes: Record<string, ImagePlane | undefined> = {
      a: planeAt(20),
      b: undefined, // no position
      c: planeAt(5),
      d: undefined, // no position — keeps order after b
    };
    const sorted = sortImageIdsBySpatialPosition(
      ['a', 'b', 'c', 'd'],
      (id) => planes[id],
    );
    // positioned ascending by Z: c(5) then a(20); unpositioned b,d last
    // in their original relative order.
    expect(sorted).toEqual(['c', 'a', 'b', 'd']);
  });

  it('derives the normal from ImageOrientationPatient (oblique acquisition)', () => {
    // Sagittal-ish: row=(0,1,0), col=(0,0,1) → normal = (1,0,0) = +X.
    const iop = [0, 1, 0, 0, 0, 1];
    const planes: Record<string, ImagePlane> = {
      p: { imagePositionPatient: [9, 0, 0], imageOrientationPatient: iop },
      q: { imagePositionPatient: [-3, 0, 0], imageOrientationPatient: iop },
      r: { imagePositionPatient: [4, 0, 0], imageOrientationPatient: iop },
    };
    expect(
      sortImageIdsBySpatialPosition(['p', 'q', 'r'], (id) => planes[id]),
    ).toEqual(['q', 'r', 'p']);
  });

  it('is a no-op for 0 or 1 imageIds', () => {
    expect(sortImageIdsBySpatialPosition([], () => undefined)).toEqual([]);
    const one = ['only'];
    expect(sortImageIdsBySpatialPosition(one, () => planeAt(1))).toBe(one);
  });
});

describe('selectPrimarySeriesUidFromSeriesMeta — parity guard (I6)', () => {
  const meta = (
    seriesUid: string,
    modality: string,
    instanceCount: number,
  ): SeriesLevelMeta => ({ seriesUid, modality, instanceCount });

  /**
   * THE contract: the cheap series-level chooser must either decline
   * (`undefined` → caller does the unchanged full fetch) OR return the
   * byte-identical seriesUid that the full-fetch `selectPrimarySeriesImageIds`
   * would pick. It must NEVER return a different series. We verify by
   * building the synthetic full fetch from the same fixtures.
   */
  const assertParity = (
    fixtures: SeriesLevelMeta[],
    preferred?: string,
  ): string | undefined => {
    const flat = fixtures.flatMap((s) =>
      wadors(s.seriesUid, s.instanceCount),
    );
    const seriesItems = fixtures.map((s) =>
      item(s.seriesUid, s.modality, s.instanceCount),
    );
    const fullPick = selectPrimarySeriesImageIds(
      flat,
      seriesItems,
      preferred,
    ).seriesUid;
    const cheapPick = selectPrimarySeriesUidFromSeriesMeta(
      fixtures,
      preferred,
    );
    if (cheapPick !== undefined) {
      expect(cheapPick).toBe(fullPick);
    }
    return cheapPick;
  };

  it('commits to the strict-max CT (localizer + CTA) and matches the full fetch', () => {
    const fixtures = [
      meta('scout', 'CT', 3), // CT localizer (real studies always have ≥2 CT)
      meta('cta', 'CT', 594), // the volumetric CTA — strict unique max
      meta('mip', 'OT', 40),
      meta('report', 'SR', 1),
    ];
    expect(assertParity(fixtures)).toBe('cta');
  });

  it('commits to the strict-max CT among several CT series and matches the full fetch', () => {
    const fixtures = [
      meta('phaseA', 'CT', 320), // strict unique max
      meta('phaseB', 'CT', 318),
      meta('scout', 'CT', 3),
    ];
    expect(assertParity(fixtures)).toBe('phaseA');
  });

  it('honours an in-list preferred series and matches the full fetch', () => {
    const fixtures = [
      meta('phase35', 'CT', 300),
      meta('phase75', 'CT', 300),
      meta('calcium', 'CT', 60),
    ];
    expect(assertParity(fixtures, 'phase75')).toBe('phase75');
  });

  it('declines (undefined → full fallback) on a CT-count tie at the max', () => {
    // Equal max instance counts → instance-vs-frame counting could flip the
    // winner vs the full fetch, so the cheap chooser must NOT commit.
    const fixtures = [
      meta('phaseA', 'CT', 320),
      meta('phaseB', 'CT', 320),
      meta('scout', 'CT', 3),
    ];
    expect(selectPrimarySeriesUidFromSeriesMeta(fixtures)).toBeUndefined();
    // Parity holds vacuously (no commitment made).
    assertParity(fixtures);
  });

  it('declines when there is no CT series at all', () => {
    const fixtures = [meta('us1', 'US', 50), meta('xa1', 'XA', 12)];
    expect(selectPrimarySeriesUidFromSeriesMeta(fixtures)).toBeUndefined();
    assertParity(fixtures);
  });

  it('declines when the study has ≤1 series (nothing to narrow)', () => {
    expect(selectPrimarySeriesUidFromSeriesMeta([])).toBeUndefined();
    expect(
      selectPrimarySeriesUidFromSeriesMeta([meta('solo', 'CT', 500)]),
    ).toBeUndefined();
  });

  it('ignores a preferred not in the list and falls to strict-max CT (matches full)', () => {
    const fixtures = [meta('a', 'CT', 10), meta('b', 'CT', 20)];
    // preferred 'missing' is absent → both chooser and full fetch skip it
    // and take largest-CT = 'b'. They must still agree.
    expect(assertParity(fixtures, 'missing')).toBe('b');
  });
});
