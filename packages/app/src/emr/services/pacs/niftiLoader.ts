// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * niftiLoader — Pass B3
 *
 * Plain-English: when the cascade pipeline finishes a segmentation stage it
 * dumps the mask as a NIfTI file (a medical-imaging format that's basically
 * a 3D byte array + header). This module fetches that file through the
 * authenticated FastAPI proxy (NOT raw S3 — the browser has no S3 creds),
 * decompresses gzip if needed, and unpacks the voxel buffer + dims/spacing.
 *
 * Output is consumed by `cornerstoneInit.createLabelmapFromNifti()` to
 * build a Cornerstone3D segmentation labelmap that overlays on the CT.
 */

import * as nifti from 'nifti-reader-js';

/** Minimal NIfTI header shape we care about. The library returns either an
 *  `NIFTI1` or `NIFTI2` instance — both expose these props. */
interface NiftiHeader {
  dims: number[];
  pixDims: number[];
  datatypeCode?: number;
  numBitsPerVoxel?: number;
}

export interface NiftiMask {
  /** 1D voxel buffer; voxel order is [x, y, z] flattened. */
  voxels: Uint8Array;
  /** [columns, rows, slices] — i.e. NIfTI dim[1..3]. */
  dims: [number, number, number];
  /** Voxel spacing in mm — pixDim[1..3]. */
  spacing: [number, number, number];
  /** Raw NIfTI header (callers can poke at the affine if alignment drifts). */
  header: NiftiHeader;
}

/**
 * Fetch + decompress + parse a NIfTI volume. Throws if the response isn't
 * a valid NIfTI (probably an HTML error page or a 404 reaching us).
 *
 * @param httpUrl  Path under our origin — e.g. `/api/v1/analyses/{id}/mask/liver`.
 *                 Always relative; never s3:// (browser can't fetch S3).
 */
export async function loadNiftiAsLabelmap(httpUrl: string): Promise<NiftiMask> {
  const r = await fetch(httpUrl, { credentials: 'include' });
  if (!r.ok) {
    throw new Error(`NIfTI fetch failed: ${r.status} ${r.statusText} — ${httpUrl}`);
  }
  let buffer = await r.arrayBuffer();

  // `.nii.gz` is the common on-disk form. nifti-reader-js bundles its own
  // gzip path via `decompress` so we don't need a separate pako dep at the
  // call site.
  if (nifti.isCompressed(buffer)) {
    buffer = nifti.decompress(buffer) as ArrayBuffer;
  }

  const bytes = new Uint8Array(buffer);

  if (!nifti.isNIFTI(buffer)) {
    // Defensive: if the server returned a JSON error or HTML page, surface
    // a hint of the body so devs can see what came back.
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64));
    throw new Error(`Response is not a NIfTI volume — first 64 bytes: ${head}`);
  }

  const header = nifti.readHeader(buffer) as unknown as NiftiHeader | null;
  if (!header) {
    throw new Error('NIfTI header could not be parsed.');
  }

  const rawImage = nifti.readImage(header as never, buffer);
  const view = new Uint8Array(rawImage);

  // Most segmentation masks are uint8 with values {0, 1, 2, …}. If the
  // backend ever ships a different datatype we just reinterpret the raw
  // buffer as bytes — Cornerstone's labelmap expects integer voxels and
  // doesn't care about the original NIfTI datatype here. Non-zero pixels
  // become the segment.
  const voxels = view;

  const dims: [number, number, number] = [
    header.dims[1] ?? 0,
    header.dims[2] ?? 0,
    header.dims[3] ?? 0,
  ];
  const spacing: [number, number, number] = [
    header.pixDims[1] ?? 1,
    header.pixDims[2] ?? 1,
    header.pixDims[3] ?? 1,
  ];

  return { voxels, dims, spacing, header };
}

/**
 * Build the proxied URL for a mask. Centralised so the path can move later
 * without touching every call site.
 */
export function maskUrl(analysisId: string, anatomyCategory: string): string {
  return `/api/v1/analyses/${encodeURIComponent(analysisId)}/mask/${encodeURIComponent(anatomyCategory)}`;
}
