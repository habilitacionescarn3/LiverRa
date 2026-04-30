// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// usePeerReview — Hook for RADPEER 2016 peer review workflow
// ============================================================================
// Wraps peerReviewService to provide a React-friendly peer review interface.
//
// Think of it like a grading app for teachers: the hook handles submitting
// scores, loading previous scores, and validating the form before submit.
//
// RADPEER 2016 Scores:
//   1  — Agree with interpretation
//   2a — Discrepancy, understandable miss
//   2b — Discrepancy, should not have been missed
//   3a — Discrepancy, diagnosis not made (clinically significant)
//   3b — Discrepancy, diagnosis incorrect (clinically significant)
//
// Validation: Scores other than '1' REQUIRE a discrepancy note.
//
// Phase-4 status (LiverRa):
//   Reads/writes go through `useLiverraFhir()` → `LiverRaFhirClient` (stub).
//   Reviewer identity is resolved from the stub's (currently empty) profile;
//   Phase 4 wires the real Cognito session so the reviewer reference is
//   populated automatically.
//
// Ported from MediMind (hooks/pacs/usePeerReview.ts) with:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - `medplum.getProfile()` replaced by a best-effort empty profile
//     fallback — the caller is free to pass reviewer info explicitly
//     (see `submitScore` which still emits a Practitioner reference).
// ============================================================================

import { useState, useCallback } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import {
  submitPeerReview,
  getReviewsForReport,
  type RadpeerScore,
  type PeerReviewResult,
} from '../../services/pacs/peerReviewService';

// ============================================================================
// Types
// ============================================================================

/** Valid RADPEER scores — re-exported for convenience */
export type { RadpeerScore } from '../../services/pacs/peerReviewService';

export const VALID_RADPEER_SCORES: RadpeerScore[] = ['1', '2a', '2b', '3a', '3b'];

export interface ValidationError {
  field: 'score' | 'discrepancyNote';
  message: string;
}

export interface SubmitScoreParams {
  reportId: string;
  score: RadpeerScore;
  discrepancyNote?: string;
}

export interface UsePeerReviewReturn {
  /** Submit a peer review score */
  submitScore: (params: SubmitScoreParams) => Promise<boolean>;
  /** List of previous reviews for the current report */
  reviews: PeerReviewResult[];
  /** Whether reviews are loading */
  isLoading: boolean;
  /** Whether a submission is in progress */
  isSubmitting: boolean;
  /** Current validation error (null if valid) */
  validationError: ValidationError | null;
  /** Reload reviews for a report */
  loadReviews: (reportId: string) => Promise<void>;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a peer review submission before sending to the server.
 * Returns null if valid, or a ValidationError describing the problem.
 */
export function validatePeerReview(
  score: RadpeerScore | undefined,
  discrepancyNote: string | undefined
): ValidationError | null {
  // Score must be one of the valid RADPEER values
  if (!score || !VALID_RADPEER_SCORES.includes(score)) {
    return { field: 'score', message: 'Score must be one of: 1, 2a, 2b, 3a, 3b' };
  }

  // If score is not '1', a discrepancy note is required
  if (score !== '1' && (!discrepancyNote || !discrepancyNote.trim())) {
    return { field: 'discrepancyNote', message: 'Discrepancy note is required for non-1 scores' };
  }

  return null;
}

// ============================================================================
// Hook
// ============================================================================

export function usePeerReview(): UsePeerReviewReturn {
  const fhir = useLiverraFhir();

  const [reviews, setReviews] = useState<PeerReviewResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<ValidationError | null>(null);

  // Load reviews for a given report
  const loadReviews = useCallback(
    async (reportId: string) => {
      if (!reportId) return;
      setIsLoading(true);
      try {
        const results = await getReviewsForReport(fhir, reportId);
        setReviews(results);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[usePeerReview] Failed to load reviews:', err);
      } finally {
        setIsLoading(false);
      }
    },
    [fhir]
  );

  // Submit a peer review score
  const submitScore = useCallback(
    async (params: SubmitScoreParams): Promise<boolean> => {
      const { reportId, score, discrepancyNote } = params;

      // Client-side validation
      const error = validatePeerReview(score, discrepancyNote);
      if (error) {
        setValidationError(error);
        return false;
      }
      setValidationError(null);

      // TODO(phase-4): Resolve reviewer from Cognito session. The stub
      // client has no session yet, so we submit an anonymous review — the
      // backend will reject this when Phase 4 wires real auth, which is
      // the expected fail-safe.
      const reviewerReference = '';
      const reviewerDisplay = '';

      setIsSubmitting(true);
      try {
        await submitPeerReview(fhir, {
          reportId,
          score,
          discrepancyNote,
          reviewerReference,
          reviewerDisplay,
        });

        // Invalidate / reload the reviews after successful submit
        await loadReviews(reportId);
        return true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[usePeerReview] Failed to submit review:', err);
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    [fhir, loadReviews]
  );

  return {
    submitScore,
    reviews,
    isLoading,
    isSubmitting,
    validationError,
    loadReviews,
  };
}
