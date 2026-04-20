/**
 * FHIR R4 resource + datatype interfaces (generated stub).
 *
 * The full type corpus is emitted by `scripts/generate-fhir-types.ts` into
 * `src/r4/generated/` from the HL7 FHIR R4 JSON Schema
 * (`fhir-r4-schema.json`). Until the generator is wired up in CI (T034 +
 * `turbo run generate:fhir-types`), downstream consumers import the
 * hand-rolled minimum surface from here.
 *
 * When the generator runs, it will emit:
 *   - `./generated/resources/Patient.ts`, `ImagingStudy.ts`, …
 *   - `./generated/datatypes/Identifier.ts`, `Reference.ts`, …
 *   - `./generated/index.ts` re-exporting all of the above
 *
 * This file then becomes `export * from './generated/index.js'`.
 */
export {};
