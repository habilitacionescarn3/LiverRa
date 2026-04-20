/**
 * liverra/no-forbidden-hex
 *
 * Plain-language: Constitution IX bans specific "generic AI-looking" blue
 * hex codes — Tailwind blues and the classic Facebook blue. If someone
 * pastes one of them into a component, this rule flags it and points them
 * at `theme.css` for the LiverRa palette.
 *
 * See plan.md §Guardrail lint rules and CLAUDE.md §Unified Color System.
 */
'use strict';

const FORBIDDEN_PATTERN = /#(3b82f6|60a5fa|2563eb|4267B2)\b/i;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Hard-ban Tailwind/Facebook blue hexes anywhere in the codebase (Constitution IX).',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      forbiddenHex:
        'Forbidden hex `{{hex}}` (Constitution IX). Use LiverRa palette from packages/app/src/emr/styles/theme.css.',
    },
  },
  create(context) {
    function check(node, value) {
      if (typeof value !== 'string') return;
      const match = value.match(FORBIDDEN_PATTERN);
      if (match) {
        context.report({
          node,
          messageId: 'forbiddenHex',
          data: { hex: match[0] },
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
