/**
 * liverra/mantine-button-padding-check
 *
 * Plain-language: per CLAUDE.md, setting `padding` on a Mantine `Button`'s
 * `root` element breaks the internal label height — the label ends up
 * vertically off-center. Safer patterns: use EMRButton, or Mantine's
 * `size` prop, or add `label: { overflow: 'visible', height: 'auto' }`.
 *
 * This rule flags any JSX `<Button styles={{ root: { padding: ... } }}>`.
 *
 * See plan.md §Guardrail lint rules and CLAUDE.md §Mantine Button Styling.
 */
'use strict';

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Warn when a Mantine Button has a `padding` override on its root — breaks label height.',
      category: 'LiverRa Guardrails',
      recommended: false,
    },
    schema: [],
    messages: {
      paddingOverride:
        'Do not override `padding` on Mantine Button root — it breaks internal label height. Use EMRButton or Mantine size prop.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier') return;
        if (node.name.name !== 'Button') return;
        for (const attr of node.attributes) {
          if (attr.type !== 'JSXAttribute' || !attr.name) continue;
          if (attr.name.name !== 'styles') continue;
          if (!attr.value || attr.value.type !== 'JSXExpressionContainer') continue;
          const expr = attr.value.expression;
          if (!expr || expr.type !== 'ObjectExpression') continue;
          // Look for `root: { ... padding: ... }`.
          for (const prop of expr.properties) {
            if (prop.type !== 'Property') continue;
            const keyName =
              (prop.key.type === 'Identifier' && prop.key.name) ||
              (prop.key.type === 'Literal' && prop.key.value);
            if (keyName !== 'root') continue;
            if (!prop.value || prop.value.type !== 'ObjectExpression') continue;
            for (const rootProp of prop.value.properties) {
              if (rootProp.type !== 'Property') continue;
              const innerKey =
                (rootProp.key.type === 'Identifier' && rootProp.key.name) ||
                (rootProp.key.type === 'Literal' && rootProp.key.value);
              if (innerKey === 'padding' || innerKey === 'paddingInline' ||
                  innerKey === 'paddingBlock') {
                context.report({ node: rootProp, messageId: 'paddingOverride' });
              }
            }
          }
        }
      },
    };
  },
};
