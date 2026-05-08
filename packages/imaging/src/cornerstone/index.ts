// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Cornerstone3D bridge — Pass B1
 *
 * Status: intentionally a no-op stub.
 *
 * Plain-English: this file is reserved as the future home of LiverRa's
 * Cornerstone3D init helpers, but for v1 the real init lives in
 * `packages/app/src/emr/services/pacs/cornerstoneInit.ts` (where the
 * `@cornerstonejs/*` deps are installed). `LiverViewer3D.tsx` imports
 * directly from there, so this module is only kept around to preserve
 * the Vite alias `@liverra/imaging/cornerstone` and document the
 * intended package boundary.
 *
 * If a second consumer ever needs Cornerstone3D, lift the relevant
 * helpers from `cornerstoneInit.ts` into this package (and add the
 * `@cornerstonejs/*` deps to `packages/imaging/package.json`).
 */
export {};
