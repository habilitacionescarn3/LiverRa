// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useRUOClaim (T184).
 *
 * Plain-English: a 1-line hook a component uses to ask "what should I
 * show next to this AI output — a full RUO watermark + disclaimer, a
 * narrowed one, or nothing?". It looks up the entry for a given claim
 * key (e.g. `flr_volumetry`) in the `RUOClaimRegistry` context and
 * returns the pre-baked UI semantics.
 *
 * Fail-safe behaviour (FR-028a):
 *   - If the registry is still loading → return RUO defaults (watermark
 *     on, full disclaimer). Never flash an un-watermarked output.
 *   - If the registry is missing an entry for the requested key →
 *     return RUO defaults. A forgotten row is never equivalent to
 *     "cleared".
 *   - If the provider isn't mounted → throw. This is a dev-time wiring
 *     bug; silently defaulting here would hide regressions.
 *
 * Spec refs: plan.md §Claim Registry as feature-flag source, FR-028a/b.
 */

import { useMemo } from 'react';

import {
  DEFAULT_RUO_ENTRY,
  useRUOClaimRegistryContext,
  type ClaimKey,
  type ClaimRegistryEntry,
} from '../contexts/RUOClaimRegistryContext';

/**
 * Look up the regulatory entry for a single claim key.
 *
 * @example
 *   const { disclaimerVariant, watermarkRequired, uiGate } = useRUOClaim('flr_volumetry');
 *   return (
 *     <>
 *       <FLRReadout value={flr} />
 *       {watermarkRequired && <WatermarkOverlay text="Research Use Only" />}
 *       <RUODisclaimer variant={disclaimerVariant} />
 *     </>
 *   );
 */
export function useRUOClaim(claimKey: ClaimKey): ClaimRegistryEntry {
  const { registry, isLoading } = useRUOClaimRegistryContext();

  return useMemo<ClaimRegistryEntry>(() => {
    if (isLoading) return DEFAULT_RUO_ENTRY(claimKey);
    return registry[claimKey] ?? DEFAULT_RUO_ENTRY(claimKey);
  }, [registry, isLoading, claimKey]);
}

export type { ClaimKey, ClaimRegistryEntry } from '../contexts/RUOClaimRegistryContext';
