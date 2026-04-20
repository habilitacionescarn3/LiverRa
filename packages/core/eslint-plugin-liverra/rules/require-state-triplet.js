/**
 * liverra/require-state-triplet
 *
 * Plain-language: every view that renders data should handle all three
 * states — loading (skeleton/loader), empty (empty-state), and error
 * (error boundary / error banner). Otherwise the UI feels broken the
 * moment the network hiccups or the dataset is empty.
 *
 * Heuristic: if a file renders `<Table>` or `<List>`, it must also render
 * at least one of each of:
 *   - Loader / Skeleton (loading)
 *   - EmptyState / Empty (empty)
 *   - ErrorBoundary / ErrorBanner / Alert (error)
 *
 * This is a lint heuristic, not a proof — use it to catch obvious misses.
 *
 * See plan.md §Guardrail lint rules and §View state matrix.
 */
'use strict';

const DATA_COMPONENTS = new Set(['Table', 'List', 'DataTable', 'EMRTable']);
const LOADING_COMPONENTS = new Set(['Skeleton', 'Loader', 'LoadingOverlay']);
const EMPTY_COMPONENTS = new Set(['EmptyState', 'Empty', 'EMREmpty']);
const ERROR_COMPONENTS = new Set([
  'ErrorBoundary',
  'ErrorBanner',
  'Alert',
  'PACSErrorBoundary',
]);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Views rendering <Table>/<List> must co-locate loading, empty, and error states.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      missingStateTriplet:
        'View renders data ({{dataComponent}}) but is missing {{missing}} state(s). Co-locate Skeleton/Loader, EmptyState, and ErrorBoundary/Alert.',
    },
  },
  create(context) {
    const seen = {
      data: null, // JSX node of the first data component found
      loading: false,
      empty: false,
      error: false,
    };
    return {
      JSXOpeningElement(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier') return;
        const n = node.name.name;
        if (DATA_COMPONENTS.has(n) && !seen.data) seen.data = node;
        if (LOADING_COMPONENTS.has(n)) seen.loading = true;
        if (EMPTY_COMPONENTS.has(n)) seen.empty = true;
        if (ERROR_COMPONENTS.has(n)) seen.error = true;
      },
      'Program:exit'() {
        if (!seen.data) return;
        const missing = [];
        if (!seen.loading) missing.push('loading (Skeleton/Loader)');
        if (!seen.empty) missing.push('empty (EmptyState)');
        if (!seen.error) missing.push('error (ErrorBoundary/Alert)');
        if (missing.length > 0) {
          context.report({
            node: seen.data,
            messageId: 'missingStateTriplet',
            data: {
              dataComponent:
                seen.data.name && seen.data.name.name ? seen.data.name.name : 'data',
              missing: missing.join(', '),
            },
          });
        }
      },
    };
  },
};
