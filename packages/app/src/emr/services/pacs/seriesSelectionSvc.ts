// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * seriesSelectionSvc — Feature 079 (TAVI Planning Suite).
 *
 * Plain-English explanation:
 *   A TAVI cardiac-CT study is NOT one stack of pictures — it is a folder of
 *   many "series": a scout/localizer, a calcium-score series, MIP recons, and
 *   (often) a 4D gated CTA with one series per cardiac phase. You can only
 *   reconstruct a usable axial/sagittal/coronal MPR from ONE coherent
 *   volumetric series. If you stack every series into a single Cornerstone3D
 *   volume, each 2D axial slice still looks fine but the sagittal/coronal
 *   reformats turn into dense horizontal banding because the through-plane
 *   axis is now a jumble of unrelated acquisitions.
 *
 *   This pure helper takes the flat, all-series imageId list that
 *   `fetchImageIds` returns and narrows it to a single series:
 *     1. The clinically-recommended cardiac-phase series, when Step-2 phase
 *        detection resolved one (mid-systole ~35 % R-R for annulus sizing).
 *     2. Otherwise the largest CT series (the thin-slice volumetric CTA
 *        reconstruction TAVI sizing is performed on — it always has the most
 *        slices; scout/calcium/MIP series are far smaller).
 *     3. Otherwise the largest series of any modality.
 *     4. Otherwise (single series, or imageIds with no parseable series UID —
 *        e.g. unit-test fixtures) the input is returned unchanged, so this is
 *        never worse than the previous all-series behavior.
 *
 *   Pure + never throws — safe to call inside the volume-load path.
 *
 *   Lives under services/pacs/ (relocated out of pacs-planning/tavi/ so the
 *   PACS viewer no longer imports the TAVI tree) — it is generic DICOM series
 *   geometry with no TAVI logic, used by both the PACS viewer and TAVI volume
 *   load paths.
 *
 * @module services/pacs/seriesSelectionSvc
 */

import type { ExtractedSeriesItem } from '../../hooks/pacs/usePACSViewer.dicom';

/**
 * wadors imageId template (see DicomWebClient.getInstanceUrl):
 *   wadors:{baseUrl}/studies/{study}/series/{series}/instances/{sop}/frames/{f}
 * The series UID is the path segment immediately after `/series/`.
 */
const SERIES_UID_RE = /\/series\/([^/]+)/;
const NON_VOLUMETRIC_MODALITIES = new Set(['SEG', 'PR', 'KO', 'SR', 'DOC', 'REG', 'RTSTRUCT', 'RTDOSE', 'RTPLAN', 'RWV']);

function isNonVolumetricModality(modality: string | undefined): boolean {
  return NON_VOLUMETRIC_MODALITIES.has((modality ?? '').toUpperCase());
}

/** Parse the DICOM Series Instance UID out of a wadors imageId, if present. */
export function seriesUidOfImageId(imageId: string): string | undefined {
  return imageId.match(SERIES_UID_RE)?.[1];
}

/** Minimal imagePlaneModule shape we need to order slices spatially. */
export interface ImagePlane {
  imagePositionPatient?: number[];
  imageOrientationPatient?: number[];
}

/**
 * Sort imageIds along the acquisition through-plane axis (the slice normal),
 * using each slice's DICOM ImagePositionPatient / ImageOrientationPatient.
 *
 * Why this is mandatory for MPR: `fetchImageIds` builds the imageId list from
 * a 5-way PARALLEL series fetch and concatenates results in worker-completion
 * order; within a series the order is whatever the DICOMweb metadata endpoint
 * returns. Cornerstone3D streams/uploads volume texture planes in imageId
 * ARRAY order, so an unsorted list makes the sagittal/coronal reformats band
 * (rows pull from spatially non-adjacent slices). Sorting by the normal-axis
 * projection of ImagePositionPatient is the canonical fix.
 *
 * Pure + total: any slice whose plane metadata is missing keeps its original
 * relative position (stable sort) so this is never worse than the input.
 *
 * @param imageIds  The series imageIds to order.
 * @param getPlane  Resolver for a slice's imagePlaneModule (e.g. Cornerstone's
 *                  `metaData.get('imagePlaneModule', id)`).
 */
export function sortImageIdsBySpatialPosition(
  imageIds: string[],
  getPlane: (imageId: string) => ImagePlane | undefined,
): string[] {
  if (imageIds.length < 2) return imageIds;

  // Derive the slice-normal from the first slice that has a valid
  // ImageOrientationPatient (row ⨯ col). Fall back to the Z axis.
  let normal: [number, number, number] = [0, 0, 1];
  for (const id of imageIds) {
    const iop = getPlane(id)?.imageOrientationPatient;
    if (iop && iop.length === 6) {
      const [rx, ry, rz, cx, cy, cz] = iop;
      normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
      break;
    }
  }

  // Project each slice's position onto the normal; missing position → NaN.
  const dist = new Map<string, number>();
  let anyValid = false;
  for (const id of imageIds) {
    const ipp = getPlane(id)?.imagePositionPatient;
    if (ipp && ipp.length === 3) {
      dist.set(id, ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2]);
      anyValid = true;
    } else {
      dist.set(id, Number.NaN);
    }
  }
  // No usable geometry at all → return untouched (never worse).
  if (!anyValid) return imageIds;

  // Stable sort by normal-axis distance ascending. Slices with no usable
  // position (NaN) sort to the END (treated as +Infinity) and keep their
  // incoming relative order — in practice every CT slice has a position,
  // so this is just a safe, predictable guard. Decorate-sort-undecorate
  // with the original index guarantees a valid total order + stability.
  const POS_INF = Number.POSITIVE_INFINITY;
  return imageIds
    .map((id, i) => {
      const raw = dist.get(id);
      return { id, i, d: raw === undefined || Number.isNaN(raw) ? POS_INF : raw };
    })
    .sort((a, b) => (a.d === b.d ? a.i - b.i : a.d - b.d))
    .map((e) => e.id);
}

export type SeriesSelectionReason =
  | 'preferred-phase'
  | 'largest-ct'
  | 'largest'
  | 'all-fallback';

export interface PrimarySeriesSelection {
  /** The imageIds for the single chosen series (the volume should bind these). */
  imageIds: string[];
  /** The chosen series UID (undefined when the fallback path was taken). */
  seriesUid?: string;
  /** Why this series was chosen — surfaced in diagnostics. */
  reason: SeriesSelectionReason;
  /** Distinct series the study contained (1 ⇒ nothing to narrow). */
  seriesCount: number;
}

/**
 * Narrow a flat, all-series imageId list down to one coherent series.
 *
 * @param allImageIds       Flat imageId list from `fetchImageIds`.
 * @param seriesItems       Per-series descriptors (modality + counts) from
 *                          the same `fetchImageIds` call. Used only to prefer
 *                          CT — safe to pass `[]`.
 * @param preferredSeriesUid Optional clinically-recommended series UID
 *                          (e.g. `detectCardiacPhases().recommendedPhase.seriesUid`).
 */
export function selectPrimarySeriesImageIds(
  allImageIds: string[],
  seriesItems: ExtractedSeriesItem[],
  preferredSeriesUid?: string,
): PrimarySeriesSelection {
  if (allImageIds.length === 0) {
    return { imageIds: allImageIds, reason: 'all-fallback', seriesCount: 0 };
  }

  // Group imageIds by the series UID parsed from each wadors URL. This is
  // the authoritative grouping (imageId URLs always carry the real series
  // UID); seriesItems is only consulted for modality.
  const bySeries = new Map<string, string[]>();
  for (const id of allImageIds) {
    const uid = seriesUidOfImageId(id);
    if (!uid) continue;
    const arr = bySeries.get(uid);
    if (arr) arr.push(id);
    else bySeries.set(uid, [id]);
  }

  // Non-volumetric / derived modalities that must NEVER back a displayable
  // image volume: a DICOM SEG (segmentation) is a multi-frame bitmap overlay,
  // not a CT/MR image stack — binding it as a Cornerstone volume yields a
  // scalar buffer whose size doesn't match the expected texture dimensions
  // ("texImage2D: ArrayBufferView not big enough") → BLACK panes. The same is
  // true of presentation-state / key-object / structured-report / RT objects.
  // Build the set of series UIDs to exclude from selection. (Root cause of the
  // PACS black-slices-on-layout-re-switch bug: the viewer's activeSeriesUid had
  // been auto-set to a SEG series, and once its frames entered the imageId pool
  // a layout re-switch honored it as the "preferred" series and built the MPR
  // volume from the segmentation.)
  const nonVolumetricUids = new Set(
    seriesItems
      .filter((s) => isNonVolumetricModality(s.modality))
      .map((s) => s.seriesUid),
  );

  // 0 parseable (test fixtures / odd URLs) or exactly 1 series → nothing to
  // narrow, unless the only parseable series is a derived/non-volume object.
  if (bySeries.size <= 1) {
    const onlyUid = bySeries.size === 1 ? bySeries.keys().next().value : undefined;
    return {
      imageIds: onlyUid && nonVolumetricUids.has(onlyUid) ? [] : allImageIds,
      seriesUid: onlyUid && !nonVolumetricUids.has(onlyUid) ? onlyUid : undefined,
      reason: 'all-fallback',
      seriesCount: bySeries.size,
    };
  }

  // 1. Honor the clinically-recommended / operator-selected series when its
  //    imageIds are actually present — UNLESS it is a non-volumetric series
  //    (e.g. a SEG), which cannot form a displayable volume.
  if (preferredSeriesUid && !nonVolumetricUids.has(preferredSeriesUid)) {
    const preferred = bySeries.get(preferredSeriesUid);
    if (preferred && preferred.length > 0) {
      return {
        imageIds: preferred,
        seriesUid: preferredSeriesUid,
        reason: 'preferred-phase',
        seriesCount: bySeries.size,
      };
    }
  }

  // 2. Largest CT series (the volumetric CTA reconstruction). Prefer
  //    modality === 'CT'; if seriesItems lacks modality, this set is empty
  //    and we fall through to "largest of any modality".
  const ctUids = new Set(
    seriesItems
      .filter((s) => (s.modality ?? '').toUpperCase() === 'CT')
      .map((s) => s.seriesUid),
  );

  let bestUid: string | undefined;
  let bestLen = -1;
  let bestReason: SeriesSelectionReason = 'largest';

  if (ctUids.size > 0) {
    for (const [uid, ids] of bySeries) {
      if (!ctUids.has(uid)) continue;
      if (ids.length > bestLen) {
        bestLen = ids.length;
        bestUid = uid;
        bestReason = 'largest-ct';
      }
    }
  }

  // 3. Fallback: largest series of any modality — but still skip non-volumetric
  //    (SEG/PR/KO/…) series so a segmentation never becomes the volume.
  if (!bestUid) {
    for (const [uid, ids] of bySeries) {
      if (nonVolumetricUids.has(uid)) continue;
      if (ids.length > bestLen) {
        bestLen = ids.length;
        bestUid = uid;
        bestReason = 'largest';
      }
    }
  }

  if (bestUid) {
    return {
      imageIds: bySeries.get(bestUid) ?? allImageIds,
      seriesUid: bestUid,
      reason: bestReason,
      seriesCount: bySeries.size,
    };
  }

  return { imageIds: [], reason: 'all-fallback', seriesCount: bySeries.size };
}

/** Cheap QIDO series-level descriptor (no per-instance metadata fetch). */
export interface SeriesLevelMeta {
  seriesUid: string;
  modality: string;
  /** QIDO NumberOfSeriesRelatedInstances — series-level, cheap. */
  instanceCount: number;
}

/**
 * Series-level pre-selection (I6, 2026-05-19).
 *
 * Plain-English: today the TAVI volume path fetches per-instance metadata
 * for EVERY series (~2,000 instance headers across ~14 series) just to feed
 * `selectPrimarySeriesImageIds`, which then keeps one ~600-slice series. This
 * picks that series UID up-front from the CHEAP QIDO `/series` list so the
 * caller can fetch instance metadata for ONLY it.
 *
 * Parity guard: returns `undefined` unless the choice is *provably identical*
 * to what `selectPrimarySeriesImageIds` would pick from a full fetch — the
 * caller then takes the unchanged full path. Never worse, never wrong.
 *
 * Precedence mirrors `selectPrimarySeriesImageIds`:
 *   1. `preferredSeriesUid` present in the list → that (step-1 there).
 *   2. The CT-modality series with the STRICT UNIQUE MAX instance count →
 *      that. `selectPrimarySeriesImageIds` step 2 (largest-CT) always wins
 *      over step 3 when ≥1 CT exists. For CT, instances are single-frame, so
 *      QIDO `NumberOfSeriesRelatedInstances` equals the flat per-series
 *      imageId (frame) count `selectPrimarySeriesImageIds` ranks by — the
 *      orderings are identical and the winner is the same. We require a
 *      STRICT unique max so that the ONLY case where instance-vs-frame
 *      counting could flip the result (a tie, e.g. multi-phase CTA) is
 *      declined rather than risked.
 *   3. 0 CT, a CT-count tie, ≤1 series, or preferred-not-in-list →
 *      `undefined` (caller does the unchanged full fetch).
 */
export function selectPrimarySeriesUidFromSeriesMeta(
  series: SeriesLevelMeta[],
  preferredSeriesUid?: string,
): string | undefined {
  if (series.length <= 1) return undefined;
  if (
    preferredSeriesUid &&
    series.some((s) => s.seriesUid === preferredSeriesUid && !isNonVolumetricModality(s.modality))
  ) {
    return preferredSeriesUid;
  }
  const ct = series.filter((s) => (s.modality ?? '').toUpperCase() === 'CT');
  if (ct.length === 0) return undefined;
  let best = ct[0];
  let tie = false;
  for (let i = 1; i < ct.length; i++) {
    if (ct[i].instanceCount > best.instanceCount) {
      best = ct[i];
      tie = false;
    } else if (ct[i].instanceCount === best.instanceCount) {
      tie = true;
    }
  }
  // A tie at the max → instance-vs-frame counting could pick a different
  // winner than the full fetch; decline and let the full path decide.
  return tie ? undefined : best.seriesUid;
}
