// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RUODisclaimerClaimAware (T352).
 *
 * Plain-English: a thin wrapper around `RUODisclaimer` that decides —
 * for a *specific* AI claim — whether to render the full RUO banner,
 * the narrower CE Class IIb banner, or nothing at all (cleared claim
 * in a jurisdiction where the viewer has no other RUO outputs on
 * screen).
 *
 * Analogy: the bare `RUODisclaimer` is a one-size-fits-all warning
 * poster. This wrapper is the building directory at the entrance that
 * hides the poster in the rooms where it no longer applies (FR-028b).
 *
 * Why a wrapper, not an edit to `RUODisclaimer`?
 *   - `RUODisclaimer` is owned by the Phase-3 UI agent (T178) and is
 *     shared by every viewer surface. Overloading its props with a
 *     claim-key would couple it to the compliance module. A wrapper
 *     keeps the separation clean AND preserves the existing import
 *     sites (every caller keeps using `RUODisclaimer` directly if it
 *     doesn't care about per-claim scope).
 *
 * Usage:
 *
 *     <RUODisclaimerClaimAware claimKey="flr_volumetry" />
 *
 * Falls back to the full `RUODisclaimer` if no claim key is provided.
 *
 * Spec refs: FR-028b, plan §Claim Registry as feature-flag source.
 */

import type { ReactElement } from 'react';

import {
  type ClaimKey,
  type DisclaimerVariant,
  useRUOClaim,
} from '../../contexts/RUOClaimRegistryContext';
import { RUODisclaimer, type RUODisclaimerVariant } from './RUODisclaimer';

export interface RUODisclaimerClaimAwareProps {
  /**
   * Which AI claim the surface is currently rendering. Used to look up
   * the per-claim regulatory status + decide whether to narrow or hide
   * the banner. When omitted, the bare RUO disclaimer is shown.
   */
  claimKey?: ClaimKey;
  /** Optional `data-testid`. */
  'data-testid'?: string;
}

/** Map the context's `DisclaimerVariant` to the banner's internal variant. */
function mapVariant(v: DisclaimerVariant): RUODisclaimerVariant {
  // `fda` clearance is out of v1 scope (MVP is RUO only). We still map
  // it to the softest CE variant so a later jurisdiction unlock can
  // land without touching this wrapper.
  if (v === 'ce' || v === 'fda') return 'ce_class_iib';
  return 'ruo';
}

/**
 * Wrapper around `RUODisclaimer` that respects the per-claim registry.
 * When the claim is `cleared` (CE / FDA) and therefore marked
 * `watermarkRequired=false`, the banner still renders — but in its
 * narrower variant — so the pixel-burn + screen-reader announcement
 * stay in place even in a cleared surface. This is intentional: we
 * never *hide* the banner in v1 (FR-028a), only narrow its scope.
 */
export function RUODisclaimerClaimAware({
  claimKey,
  'data-testid': testId,
}: RUODisclaimerClaimAwareProps): ReactElement {
  // Both branches must call the hook unconditionally (Rules of Hooks).
  const claim = useRUOClaim(claimKey ?? 'flr_volumetry');
  const variant: RUODisclaimerVariant = claimKey ? mapVariant(claim.disclaimerVariant) : 'ruo';

  return <RUODisclaimer variant={variant} data-testid={testId ?? 'ruo-disclaimer-claim-aware'} />;
}

export default RUODisclaimerClaimAware;
