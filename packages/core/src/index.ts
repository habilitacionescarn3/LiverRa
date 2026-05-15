/**
 * @liverra/core — barrel entry point.
 *
 * Re-exports all public API surface of the shared core package:
 *   - types/    domain TypeScript interfaces (Analysis, Study, Tenant, Audit, …)
 *   - fhir/     FHIR helper utilities (resource builders, identifier lookup)
 *   - hash/     chain-of-hashes primitives (RFC 8785 JCS + SHA-256)
 *
 * Note: frontend locale helpers live in
 * `packages/app/src/emr/services/localeService.ts` (canonical). The previous
 * 9-line `core/i18n` stub had zero importers and was removed (L-I18N-1 in
 * the 2026-05-14 audit).
 */
export * from './types/index.js';
export * from './fhir/index.js';
export * from './hash/index.js';
