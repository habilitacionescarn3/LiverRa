/**
 * liverra/no-russian-locale (DEPRECATED — kept as a no-op for now).
 *
 * Historical context: LiverRa originally shipped en/de/ka only. The 2026
 * spec re-activated the Georgia/CIS market and made `ru` part of the
 * canonical triad (per CLAUDE.md). Russian locale references in
 * `translations/**` are now SUPPORTED, so this rule is intentionally a
 * no-op pending plugin removal.
 *
 * TODO: remove this rule + its `recommended` registration entirely once
 * the eslint-plugin-liverra index drops the export (audit M-I18N-5).
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'DEPRECATED — Russian is now part of the active triad (CLAUDE.md). This rule is a no-op.',
      category: 'LiverRa Guardrails',
      recommended: false,
    },
    schema: [],
    messages: {},
  },
  create() {
    // Intentional no-op: see file docstring.
    return {};
  },
};
