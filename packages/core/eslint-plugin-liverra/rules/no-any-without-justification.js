/**
 * liverra/no-any-without-justification
 *
 * Plain-language: `any` is the TypeScript escape hatch — sometimes legit,
 * sometimes lazy. This rule says: you may use `any`, but the line above
 * must carry a `// any-ok: <reason>` comment (or the legacy
 * `// eslint-disable-next-line ...  TODO|HACK`). Without that, it's an error.
 *
 * Catches: `x: any`, `fn(x: any)`, `as any`, `<any>x`.
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

const JUSTIFICATION_PATTERN = /\b(any-ok|TODO|HACK)\b/;

function hasJustifyingComment(context, node) {
  const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
  if (!sourceCode) return false;
  const comments = sourceCode.getCommentsBefore
    ? sourceCode.getCommentsBefore(node)
    : [];
  return comments.some((c) => JUSTIFICATION_PATTERN.test(c.value));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `// any-ok: <reason>` (or TODO/HACK) comment adjacent to any use of `any`.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      unjustifiedAny:
        'Use of `any` requires a preceding `// any-ok: <reason>` (or TODO/HACK) comment.',
    },
  },
  create(context) {
    function report(node) {
      if (!hasJustifyingComment(context, node)) {
        context.report({ node, messageId: 'unjustifiedAny' });
      }
    }
    return {
      TSAnyKeyword(node) {
        report(node);
      },
    };
  },
};
