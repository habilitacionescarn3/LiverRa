// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import {
  MODALITY_TAG,
  NUMBER_OF_FRAMES_TAG,
  NUMBER_OF_SERIES_RELATED_INSTANCES_TAG,
  SERIES_DESCRIPTION_TAG,
  SERIES_INSTANCE_UID_TAG,
  SOP_CLASS_UID_TAG,
  SOP_INSTANCE_UID_TAG,
  IMAGE_LATERALITY_TAG,
  VIEW_POSITION_TAG,
  PRESENTATION_INTENT_TYPE_TAG,
  PATIENT_ORIENTATION_TAG,
  FIELD_OF_VIEW_HORIZONTAL_FLIP_TAG,
} from '../../constants/dicom-tags';
import type { DicomJsonObject } from '../../services/pacs';
import type { DicomWebClientHandle } from '../../services/pacs/dicomwebClient';
import type { SeriesLevelMeta } from '../../services/pacs/seriesSelectionSvc';
import type { MammoImageDescriptor } from '../../types/pacs';
import { recordSourceDicomMetadata } from '../../services/pacs/taviIntegration';

interface CS3DMetaDataManager {
  add: (imageId: string, metadata: DicomJsonObject) => void;
}

function addInstanceMetadata(imageId: string, metadata: DicomJsonObject): void {
  const manager = cornerstoneDICOMImageLoader.wadors.metaDataManager as Partial<CS3DMetaDataManager>;
  if (typeof manager.add === 'function') {
    manager.add(imageId, metadata);
  }
}

/** Extract a string value from a DICOM JSON tag object */
function getDicomTagValue(obj: DicomJsonObject, tag: string): string {
  const entry = obj[tag];
  if (entry?.Value && entry.Value.length > 0) {
    return String(entry.Value[0]);
  }
  return '';
}

/**
 * Build a mammography descriptor from one instance's DICOM JSON — reads and
 * normalizes ImageLaterality / ViewPosition / PresentationIntentType. Used
 * only for MG images; drives the 4-up hanging protocol (see mammoLayout.ts).
 */
function buildMammoDescriptor(imageId: string, instanceMeta: DicomJsonObject): MammoImageDescriptor {
  const lat = getDicomTagValue(instanceMeta, IMAGE_LATERALITY_TAG).trim().toUpperCase();
  const view = getDicomTagValue(instanceMeta, VIEW_POSITION_TAG).trim().toUpperCase();
  const intent = getDicomTagValue(instanceMeta, PRESENTATION_INTENT_TYPE_TAG).trim().toUpperCase();
  const patientOrientation = getDicomTagValue(instanceMeta, PATIENT_ORIENTATION_TAG).trim().toUpperCase();
  const fovFlip = getDicomTagValue(instanceMeta, FIELD_OF_VIEW_HORIZONTAL_FLIP_TAG).trim().toUpperCase();
  return {
    imageId,
    laterality: lat === 'L' || lat === 'R' ? lat : undefined,
    view: view || undefined,
    presentationIntent:
      intent === 'FOR PRESENTATION'
        ? 'PRESENTATION'
        : intent === 'FOR PROCESSING'
          ? 'PROCESSING'
          : undefined,
    patientOrientation: patientOrientation || undefined,
    fieldOfViewHorizontalFlip: fovFlip || undefined,
  };
}

/**
 * Fetch all image IDs for a study from DICOMweb and populate Cornerstone's
 * metadata manager so it can decode pixel data.
 *
 * The flow is like ordering from a catalog:
 * 1. Search for series in the study (find which "sections" exist)
 * 2. Fetch full metadata for each series (get the "product details" sheet
 *    with pixel format, dimensions, etc.)
 * 3. Store metadata in Cornerstone's internal registry so when it fetches
 *    actual pixel data later, it knows how to decode it
 * 4. Build wadors: URLs for each frame — these are the "download links"
 */
/** Series metadata extracted during image loading */
export interface ExtractedSeriesItem {
  seriesUid: string;
  modality: string;
  description?: string;
  instanceCount: number;
}

interface FetchResult {
  imageIds: string[];
  seriesItems: ExtractedSeriesItem[];
  /** MG-only per-image descriptors for the mammo hanging protocol; [] otherwise. */
  mammoImages: MammoImageDescriptor[];
}

/** Result of processing a single series — collected after parallel fetching */
interface SeriesProcessResult {
  imageIds: string[];
  seriesItems: ExtractedSeriesItem[];
  mammoImages: MammoImageDescriptor[];
  hasMultiFrameMammo: boolean;
}

/**
 * Run async tasks with a concurrency limit — like a pool of 5 workers
 * each grabbing the next task from a shared queue. Prevents overwhelming
 * the PACS server with too many simultaneous requests.
 */
async function promiseAllWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  signal?: AbortSignal
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = nextIndex++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  );
  return results;
}

/** Max concurrent series metadata fetches — prevents overwhelming the PACS server */
const SERIES_FETCH_CONCURRENCY = 5;
const MAX_DICOM_INSTANCE_FRAMES = 10_000;

function parseNumberOfFrames(value: string, sopUid: string): number {
  const raw = value.trim() || '1';
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`Invalid DICOM NumberOfFrames for instance ${sopUid}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_DICOM_INSTANCE_FRAMES) {
    throw new Error(`DICOM NumberOfFrames for instance ${sopUid} exceeds ${MAX_DICOM_INSTANCE_FRAMES}`);
  }
  return parsed;
}

function getValidatedInstanceUrl(
  client: DicomWebClientHandle,
  studyUid: string,
  seriesUid: string,
  sopUid: string,
  frame: number
): string {
  if (!Number.isSafeInteger(frame) || frame < 1 || frame > MAX_DICOM_INSTANCE_FRAMES) {
    throw new Error(`Invalid DICOM frame number for instance ${sopUid}`);
  }
  return client.getInstanceUrl(studyUid, seriesUid, sopUid, frame);
}

/**
 * I6 (2026-05-19): cheap series-level metadata for the TAVI volume
 * pre-filter. One QIDO `/studies/{s}/series` call (~N rows, no per-instance
 * retrieve) → seriesUid + modality + NumberOfSeriesRelatedInstances. Feeds
 * `selectPrimarySeriesUidFromSeriesMeta` so the volume path can fetch
 * per-instance headers for ONLY the chosen series instead of all of them.
 */
export async function fetchSeriesLevelMeta(
  client: DicomWebClientHandle,
  studyUid: string,
  signal?: AbortSignal,
): Promise<SeriesLevelMeta[]> {
  const seriesList = await client.searchSeries(studyUid, undefined, signal);
  const out: SeriesLevelMeta[] = [];
  for (const s of seriesList) {
    const seriesUid = getDicomTagValue(s, SERIES_INSTANCE_UID_TAG);
    if (!seriesUid) continue;
    const modality = getDicomTagValue(s, MODALITY_TAG) || 'OT';
    const parsed = parseInt(
      getDicomTagValue(s, NUMBER_OF_SERIES_RELATED_INSTANCES_TAG),
      10,
    );
    out.push({
      seriesUid,
      modality,
      instanceCount: Number.isFinite(parsed) ? parsed : 0,
    });
  }
  return out;
}

export async function fetchImageIds(
  client: DicomWebClientHandle,
  studyUid: string,
  signal?: AbortSignal,
  // B11 (opt-in, TAVI volume path only): when set, fetch the EXPENSIVE
  // per-instance metadata for ONLY this series and skip it for every other
  // series. Default (omitted) = unchanged full multi-series behavior, so
  // the regular PACS viewer + prior-study prefetch callers are untouched.
  opts?: { onlySeriesUid?: string }
): Promise<FetchResult> {
  // Step 1: Get all series in the study
  const seriesList = await client.searchSeries(studyUid, undefined, signal);
  const onlySeriesUid = opts?.onlySeriesUid;

  // Step 2: Process each series in parallel (max 5 concurrent) instead of sequentially.
  // A study with 10 series now loads ~5x faster since we fetch metadata in parallel.
  const tasks = seriesList.map((seriesObj) => async (): Promise<SeriesProcessResult | null> => {
    const seriesUid = getDicomTagValue(seriesObj, SERIES_INSTANCE_UID_TAG);
    if (!seriesUid) return null;

    // Extract series-level metadata for the SeriesBrowser filmstrip
    const modality = getDicomTagValue(seriesObj, MODALITY_TAG) || 'OT';
    const description = getDicomTagValue(seriesObj, SERIES_DESCRIPTION_TAG) || undefined;

    // B11: a single target series was requested → skip the per-instance
    // metadata round-trip for every OTHER series. Still emit a lightweight
    // QIDO-derived filmstrip stub so seriesItems consumers don't regress;
    // the volume path discards non-target imageIds anyway, and
    // selectPrimarySeriesImageIds groups by imageId so the one series that
    // carries imageIds is selected correctly.
    if (onlySeriesUid && seriesUid !== onlySeriesUid) {
      // Deferred series: skip the expensive per-instance metadata round-trip,
      // but surface its REAL instance count from the cheap QIDO series row
      // (NumberOfSeriesRelatedInstances) so the SeriesBrowser lists it
      // accurately instead of "0 images". Its imageIds are fetched on demand
      // the first time the user clicks it (PACSViewer.handleSeriesSelect).
      const relatedInstances = parseInt(
        getDicomTagValue(seriesObj, NUMBER_OF_SERIES_RELATED_INSTANCES_TAG),
        10,
      );
      return {
        imageIds: [],
        seriesItems: [{
          seriesUid,
          modality,
          description,
          instanceCount: Number.isFinite(relatedInstances) ? relatedInstances : 0,
        }],
        mammoImages: [],
        hasMultiFrameMammo: false,
      };
    }

    // Fetch series-level metadata — contains full DICOM tags (Rows, Columns,
    // BitsAllocated, SamplesPerPixel, etc.) that Cornerstone3D needs to decode images.
    // Without this, images fail with "samplesPerPixel is undefined".
    const metadata = await client.retrieveSeriesMetadata(studyUid, seriesUid, signal);

    const localImageIds: string[] = [];
    const localSeriesItems: ExtractedSeriesItem[] = [];
    const localMammoImages: MammoImageDescriptor[] = [];
    let hasMultiFrameMammo = false;

    // Separate multi-frame instances (cine clips) from single-frame ones (slices)
    const multiFrameInstances: { sopUid: string; numFrames: number }[] = [];
    const singleFrameInstances: { sopUid: string }[] = [];

    for (const instanceMeta of metadata) {
      const sopUid = getDicomTagValue(instanceMeta, SOP_INSTANCE_UID_TAG);
      if (!sopUid) continue;

      const numFrames = parseNumberOfFrames(getDicomTagValue(instanceMeta, NUMBER_OF_FRAMES_TAG) || '1', sopUid);

      // Store metadata for frame 1 — Cornerstone's metadata manager automatically
      // derives other frames from it for multi-frame images
      const frame1Id = getValidatedInstanceUrl(client, studyUid, seriesUid, sopUid, 1);
      addInstanceMetadata(frame1Id, instanceMeta);
      if (getDicomTagValue(instanceMeta, SOP_CLASS_UID_TAG)) {
        recordSourceDicomMetadata(frame1Id, instanceMeta);
      }

      // MG only: capture single-frame FFDM descriptors for the 4-up hanging
      // protocol. Multi-frame MG/tomosynthesis uses the regular stack path so
      // all frames remain scrollable instead of binding only frame 1 to a pane.
      if (modality === 'MG') {
        if (numFrames > 1) {
          hasMultiFrameMammo = true;
        } else {
          localMammoImages.push(buildMammoDescriptor(frame1Id, instanceMeta));
        }
      }

      // Build imageId for each frame
      for (let frame = 1; frame <= numFrames; frame++) {
        const imageId = getValidatedInstanceUrl(client, studyUid, seriesUid, sopUid, frame);
        localImageIds.push(imageId);
        if (frame !== 1 && getDicomTagValue(instanceMeta, SOP_CLASS_UID_TAG)) {
          recordSourceDicomMetadata(imageId, instanceMeta);
        }
      }

      if (numFrames > 1) {
        multiFrameInstances.push({ sopUid, numFrames });
      } else {
        singleFrameInstances.push({ sopUid });
      }
    }

    // If multiple multi-frame instances share one series (e.g. coronarography runs),
    // create one filmstrip entry per instance so each clip can be viewed separately.
    if (multiFrameInstances.length > 1) {
      multiFrameInstances.forEach((inst, idx) => {
        localSeriesItems.push({
          seriesUid: inst.sopUid,
          modality,
          description: `${description || modality} #${idx + 1}`,
          instanceCount: inst.numFrames,
        });
      });
      if (singleFrameInstances.length > 0) {
        localSeriesItems.push({
          seriesUid: seriesUid,
          modality,
          description: description || undefined,
          instanceCount: singleFrameInstances.length,
        });
      }
    } else {
      // Normal case: one entry per series (CT slices, single cine clip, etc.)
      localSeriesItems.push({
        seriesUid,
        modality,
        description,
        instanceCount: metadata.length,
      });
    }

    return { imageIds: localImageIds, seriesItems: localSeriesItems, mammoImages: localMammoImages, hasMultiFrameMammo };
  });

  const results = await promiseAllWithLimit(tasks, SERIES_FETCH_CONCURRENCY, signal);

  // Collect results from all series
  const imageIds: string[] = [];
  const seriesItems: ExtractedSeriesItem[] = [];
  const mammoImages: MammoImageDescriptor[] = [];
  let hasMultiFrameMammo = false;
  for (const result of results) {
    if (!result) continue;
    imageIds.push(...result.imageIds);
    seriesItems.push(...result.seriesItems);
    mammoImages.push(...result.mammoImages);
    hasMultiFrameMammo = hasMultiFrameMammo || result.hasMultiFrameMammo;
  }

  return { imageIds, seriesItems, mammoImages: hasMultiFrameMammo ? [] : mammoImages };
}
