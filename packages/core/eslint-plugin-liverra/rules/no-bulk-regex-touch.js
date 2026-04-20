/**
 * liverra/no-bulk-regex-touch
 *
 * Rejects commits with >3 files containing identical line-level diffs —
 * the MediMind mass-regex incident (377 files corrupted). Enforced
 * primarily by the pre-commit hook at scripts/hooks/no-bulk-regex-touch.sh;
 * this ESLint rule mirrors that for IDE feedback.
 *
 * STUB — git-aware enforcement lives in the pre-commit hook.
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Mirror of the bulk-regex-touch pre-commit hook for editor feedback.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      bulkTouch:
        'Bulk regex edits across many files are forbidden (Constitution §No Bulk File Edits).',
    },
  },
  create() {
    // Pre-commit hook does the real work; this rule is a marker so
    // editors show the constraint in hover.
    return {};
  },
};
