/**
 * @liverra/fhirtypes — barrel entry point.
 *
 * Re-exports:
 *   - r4/      base FHIR R4 resource + datatype interfaces (generated)
 *   - liverra/ LiverRa-specific StructureDefinition URL constants, profile
 *              narrowings, and TypeScript helpers keyed by those profiles
 */
export * from './r4/index.js';
export * from './liverra/index.js';
