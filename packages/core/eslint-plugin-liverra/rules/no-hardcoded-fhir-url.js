/**
 * liverra/no-hardcoded-fhir-url
 *
 * Plain-language: FHIR URLs (like `http://liverra.ai/fhir/...`) must live in
 * one single constants file so that renaming them later is a one-line change.
 * This rule flags any string literal that looks like a FHIR base URL
 * appearing outside the canonical constants file.
 *
 * Canonical location: `packages/app/src/emr/constants/fhir-*.ts`.
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

const FHIR_URL_PATTERN = /https?:\/\/(liverra|[a-z]+)\.ai\/fhir\//i;
// Allow-list the canonical constants files (platform-agnostic separator).
const ALLOWED_FILE_PATTERN = /[\\/]emr[\\/]constants[\\/]fhir-[^\\/]+\.ts$/;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid hardcoded FHIR URLs outside packages/app/src/emr/constants/fhir-*.ts.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      hardcodedFhirUrl:
        'Hardcoded FHIR URL `{{url}}` detected. Use constants from emr/constants/fhir-systems.ts.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (ALLOWED_FILE_PATTERN.test(filename)) {
      return {};
    }
    function check(node, value) {
      if (typeof value !== 'string') return;
      const match = value.match(FHIR_URL_PATTERN);
      if (match) {
        context.report({
          node,
          messageId: 'hardcodedFhirUrl',
          data: { url: match[0] },
        });
      }
    }
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value && node.value.cooked);
      },
    };
  },
};
