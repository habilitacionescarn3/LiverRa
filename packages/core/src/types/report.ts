/**
 * SurgeonReview, Report, ReportDelivery domain types.
 *
 * Source of truth: `specs/001-zero-training-mvp/data-model.md` §11-§13.
 */

/**
 * Event entry captured during a review session (mask edit, lesion reprompt,
 * classification override, finalize). Used to reconstruct the review
 * timeline for FR-017 history + the PDF Report "Edit history" appendix.
 */
export interface SurgeonReviewTimelineEvent {
  occurredAt: string;
  kind:
    | 'mask_edit'
    | 'lesion_reprompt'
    | 'classification_override'
    | 'flr_edit'
    | 'finalize_attempt'
    | 'finalize_success'
    | 'seat_extended';
  userId: string;
  detail: Record<string, unknown>;
}

/**
 * The edit-session envelope over an Analysis. Holds the review-seat lock
 * (`seatHeldUntil`, heartbeat-extended) and finalize intent.
 * Finalized reviews are immutable; addenda get their own row via
 * `is_addendum_of_review_id` (see data-model §11).
 */
export interface SurgeonReview {
  id: string;
  analysisId: string;
  userId: string;
  seatHeldUntil: string;
  finalizedAt: string | null;
  timelineEvents: SurgeonReviewTimelineEvent[];
}

/**
 * A bundled export artifact (PDF + DICOM-SEG + DICOM-SR). Created on
 * finalize; one Report per finalize event. Supersession is non-destructive:
 * the new Report's `supersedesReportId` points back at the old row, which
 * retains its `retractedAt` timestamp for audit (FR-027a).
 */
export interface Report {
  id: string;
  analysisId: string;
  reviewId: string;
  version: number;
  supersedesReportId: string | null;
  pdfUri: string;
  segSopUid: string;
  srSopUid: string;
  finalizedAt: string | null;
  retractedAt: string | null;
}

/**
 * Per-destination PACS push state. `manual_fallback` is set by an admin
 * after `retryCount >= 6`; `lastError` is PHI-scrubbed per research B.6.
 */
export interface ReportDelivery {
  id: string;
  reportId: string;
  destinationId: string;
  state: 'pending' | 'sending' | 'acknowledged' | 'failed' | 'manual_fallback';
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: string | null;
}
