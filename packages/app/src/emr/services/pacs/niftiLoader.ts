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
  // Affine fields. NIfTI specifies two parallel encodings of the
  // voxel→world transform — sform (preferred) and qform. We extract whichever
  // is valid and synthesise a 4×4 matrix.
  qform_code?: number;
  sform_code?: number;
  quatern_b?: number;
  quatern_c?: number;
  quatern_d?: number;
  qoffset_x?: number;
  qoffset_y?: number;
  qoffset_z?: number;
  srow_x?: number[];
  srow_y?: number[];
  srow_z?: number[];
}

export interface NiftiMask {
  /** 1D voxel buffer; voxel order is [x, y, z] flattened. */
  voxels: Uint8Array;
  /** [columns, rows, slices] — i.e. NIfTI dim[1..3]. */
  dims: [number, number, number];
  /** Voxel spacing in mm — pixDim[1..3]. */
  spacing: [number, number, number];
  /** Voxel→world 4×4 affine in row-major form. World units are mm.
   *  Plain-English: each mask voxel (i,j,k) maps to world point
   *  `affine · [i, j, k, 1]` so we can align it to the CT regardless of how
   *  the cascade reoriented the volume. */
  affine: number[][];
  /** Raw NIfTI header (callers can poke at the affine if alignment drifts). */
  header: NiftiHeader;
}

/** Build a 4×4 voxel→world affine from a parsed NIfTI header.
 *
 *  Order of preference (per NIfTI spec):
 *    1. sform (`sform_code > 0`) — `srow_x/y/z` are the first 3 rows.
 *    2. qform (`qform_code > 0`) — quaternion + offset + qfac.
 *    3. Diagonal pixDim with zero offset (degenerate fallback).
 */
function deriveAffine(header: NiftiHeader): number[][] {
  // Path 1 — sform
  if (
    typeof header.sform_code === 'number' &&
    header.sform_code > 0 &&
    Array.isArray(header.srow_x) &&
    Array.isArray(header.srow_y) &&
    Array.isArray(header.srow_z)
  ) {
    return [
      [header.srow_x[0] ?? 1, header.srow_x[1] ?? 0, header.srow_x[2] ?? 0, header.srow_x[3] ?? 0],
      [header.srow_y[0] ?? 0, header.srow_y[1] ?? 1, header.srow_y[2] ?? 0, header.srow_y[3] ?? 0],
      [header.srow_z[0] ?? 0, header.srow_z[1] ?? 0, header.srow_z[2] ?? 1, header.srow_z[3] ?? 0],
      [0, 0, 0, 1],
    ];
  }

  // Path 2 — qform (quaternion → rotation matrix, plus qoffset, plus qfac).
  if (typeof header.qform_code === 'number' && header.qform_code > 0) {
    const b = header.quatern_b ?? 0;
    const c = header.quatern_c ?? 0;
    const d = header.quatern_d ?? 0;
    // a = sqrt(1 - b² - c² - d²), clamped to ≥0.
    const aSq = 1 - b * b - c * c - d * d;
    const a = aSq > 0 ? Math.sqrt(aSq) : 0;
    // qfac is stored in pixDims[0] per NIfTI spec — sign-flips Z column when -1.
    const qfac = header.pixDims[0] === -1 ? -1 : 1;
    const sx = header.pixDims[1] ?? 1;
    const sy = header.pixDims[2] ?? 1;
    const sz = (header.pixDims[3] ?? 1) * qfac;
    // Rotation matrix from unit quaternion (row-major).
    const r00 = a * a + b * b - c * c - d * d;
    const r01 = 2 * (b * c - a * d);
    const r02 = 2 * (b * d + a * c);
    const r10 = 2 * (b * c + a * d);
    const r11 = a * a + c * c - b * b - d * d;
    const r12 = 2 * (c * d - a * b);
    const r20 = 2 * (b * d - a * c);
    const r21 = 2 * (c * d + a * b);
    const r22 = a * a + d * d - b * b - c * c;
    return [
      [r00 * sx, r01 * sy, r02 * sz, header.qoffset_x ?? 0],
      [r10 * sx, r11 * sy, r12 * sz, header.qoffset_y ?? 0],
      [r20 * sx, r21 * sy, r22 * sz, header.qoffset_z ?? 0],
      [0, 0, 0, 1],
    ];
  }

  // Path 3 — degenerate. Identity orientation, pixDim spacing, zero offset.
  // Matches the previous (proportional-grid-fraction) behaviour for masks
  // that happen to share the CT's frame already.
  return [
    [header.pixDims[1] ?? 1, 0, 0, 0],
    [0, header.pixDims[2] ?? 1, 0, 0],
    [0, 0, header.pixDims[3] ?? 1, 0],
    [0, 0, 0, 1],
  ];
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
  const affine = deriveAffine(header);

  return { voxels, dims, spacing, affine, header };
}

/**
 * Build the proxied URL for a mask. Centralised so the path can move later
 * without touching every call site.
 */
export function maskUrl(analysisId: string, anatomyCategory: string): string {
  return `/api/v1/analyses/${encodeURIComponent(analysisId)}/mask/${encodeURIComponent(anatomyCategory)}`;
}
