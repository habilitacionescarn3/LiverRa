// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Peer Review Service — RADPEER 2016 Scoring
// ============================================================================
// FHIR data layer for radiologist peer reviews using the RADPEER 2016 scale.
//
// Think of this like a quality-assurance check at a restaurant:
// One chef reviews another chef's dish and scores it on a standard scale.
// Here, one radiologist reviews another radiologist's report and scores it
// using the RADPEER 2016 scoring system (1, 2a, 2b, 3a, 3b).
//
// We store peer reviews as Observation resources linked to the DiagnosticReport.
//
// Phase-4 status (LiverRa):
//   The persistence layer routes through `LiverRaFhirClient`, which is the
//   stubbed `fhirClient.ts`. Creates echo back with no id, searches return
//   empty. Phase 4 wires Supabase-backed FHIR.
//
// Ported from MediMind (services/pacs/peerReviewService.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient` (kept method surface identical).
//   - `@medplum/fhirtypes` Observation inlined as a local minimal shape.
//   - Extension + CodeSystem URLs inlined locally under `http://liverra.ai/fhir`.
//   - `requirePermission(..., 'manage-imaging')` removed (LiverRa permission
//     model is RBAC via Cognito + Guarded, wired in Phase 4).
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';

// ============================================================================
// Minimal FHIR shape (inlined — Phase 4 may swap for richer FHIR type)
// ============================================================================

/** Minimal FHIR Observation shape used by this service. */
interface Observation extends FhirResourceLike {
  resourceType: 'Observation';
  id?: string;
  status?: string;
  code?: {
    coding?: Array<{ system?: string; code?: string; display?: string }>;
  };
  focus?: Array<{ reference?: string }>;
  performer?: Array<{ reference?: string; display?: string }>;
  effectiveDateTime?: string;
  valueString?: string;
  extension?: Array<{ url?: string; valueString?: string }>;
  note?: Array<{ text?: string }>;
}

// ============================================================================
// Inline constants (Phase 4 may centralize into fhir-systems.ts)
// ============================================================================

/** Extension URL carrying the peer-review score (RADPEER 2016 value). */
const PEER_REVIEW_SCORE_EXT = `${FHIR_BASE_URL}/StructureDefinition/peer-review-score` as const;
/** LiverRa-owned CodeSystem covering imaging-related Observation codes. */
const PEER_REVIEW_CATEGORY_SYSTEM = `${FHIR_BASE_URL}/CodeSystem/imaging-codes` as const;
const PEER_REVIEW_CATEGORY_CODE = 'peer-review';

// ============================================================================
// Types
// ============================================================================

/** Valid RADPEER 2016 score values */
export type RadpeerScore = '1' | '2a' | '2b' | '3a' | '3b';

export interface SubmitPeerReviewParams {
  /** DiagnosticReport ID being reviewed */
  reportId: string;
  /** RADPEER score */
  score: RadpeerScore;
  /** Required when score is not '1' */
  discrepancyNote?: string;
  /** Practitioner reference (e.g., 'Practitioner/abc') */
  reviewerReference: string;
  /** Reviewer display name */
  reviewerDisplay?: string;
}

export interface PeerReviewResult {
  id: string;
  score: RadpeerScore;
  discrepancyNote?: string;
  reviewerReference: string;
  reviewerDisplay?: string;
  date: string;
}

// ============================================================================
// Submit a peer review
// ============================================================================

/** All valid RADPEER 2016 scores */
export const RADPEER_SCORES: Record<RadpeerScore, string> = {
  '1': 'Agree with interpretation',
  '2a': 'Discrepancy — understandable miss (not clinically significant)',
  '2b': 'Discrepancy — should not have been missed (not clinically significant)',
  '3a': 'Discrepancy — diagnosis not made (clinically significant)',
  '3b': 'Discrepancy — diagnosis incorrect (clinically significant)',
};

const VALID_SCORES = new Set<string>(Object.keys(RADPEER_SCORES));

/**
 * Submit a peer review score for a DiagnosticReport.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this to Supabase FHIR + QA
 * dashboard. Today the stub echoes back without assigning an id, so we
 * fabricate a pending id so the UI has something to key on.
 */
export async function submitPeerReview(
  fhir: LiverRaFhirClient,
  params: SubmitPeerReviewParams
): Promise<string> {
  const { reportId, score, discrepancyNote, reviewerReference, reviewerDisplay } = params;

  // Service-level validation: score must be valid
  if (!VALID_SCORES.has(score)) {
    throw new Error(`Invalid RADPEER score: ${score}. Must be one of: ${[...VALID_SCORES].join(', ')}`);
  }

  // Service-level validation: discrepancy note required for non-1 scores
  if (score !== '1' && (!discrepancyNote || !discrepancyNote.trim())) {
    throw new Error('Discrepancy note is required for RADPEER scores other than 1');
  }

  const observation: Observation = {
    resourceType: 'Observation',
    status: 'final',
    code: {
      coding: [
        {
          system: PEER_REVIEW_CATEGORY_SYSTEM,
          code: PEER_REVIEW_CATEGORY_CODE,
          display: 'Peer Review',
        },
      ],
    },
    focus: [{ reference: `DiagnosticReport/${reportId}` }],
    performer: [
      {
        reference: reviewerReference,
        display: reviewerDisplay,
      },
    ],
    effectiveDateTime: new Date().toISOString(),
    valueString: score,
    extension: [
      {
        url: PEER_REVIEW_SCORE_EXT,
        valueString: score,
      },
    ],
  };

  // Add discrepancy note if provided
  if (discrepancyNote) {
    observation.note = [{ text: discrepancyNote }];
  }

  const saved = await fhir.createResource(observation);
  if (!saved.id) {
    // Stub path — fabricate a pending id so the UI has something to key on.
    return `pending-${Date.now()}`;
  }
  return saved.id;
}

// ============================================================================
// Get reviews for a report
// ============================================================================

/**
 * Get all peer reviews for a DiagnosticReport.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires real search; stub returns [].
 */
export async function getReviewsForReport(
  fhir: LiverRaFhirClient,
  reportId: string
): Promise<PeerReviewResult[]> {
  const bundle = await fhir.search('Observation', {
    focus: `DiagnosticReport/${reportId}`,
    code: `${PEER_REVIEW_CATEGORY_SYSTEM}|${PEER_REVIEW_CATEGORY_CODE}`,
    _count: '100',
    _sort: '-date',
  });

  return (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((r): r is FhirResourceLike => Boolean(r))
    .map((r) => r as Observation)
    .filter((obs) => obs.id)
    .map((obs) => ({
      id: obs.id as string,
      score: (obs.valueString || '1') as RadpeerScore,
      discrepancyNote: obs.note?.[0]?.text,
      reviewerReference: obs.performer?.[0]?.reference || '',
      reviewerDisplay: obs.performer?.[0]?.display,
      date: obs.effectiveDateTime || '',
    }));
}
