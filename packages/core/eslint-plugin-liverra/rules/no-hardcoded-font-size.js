/**
 * liverra/no-hardcoded-font-size
 *
 * Plain-language: font sizes must come from CSS variables
 * (`var(--emr-font-xs)` … `var(--emr-font-3xl)`). Writing
 * `style={{ fontSize: '14px' }}` or a raw `font-size: 14px;` in CSS
 * drifts away from the type scale and breaks dark-mode / a11y overrides.
 *
 * Detects:
 *  - Inline `{ fontSize: '14px' }` object property in JSX style props.
 *  - CSS string literals containing `font-size: Npx/Nrem/Nem`.
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

const NUMERIC_FONT_SIZE = /^\s*\d+(\.\d+)?(px|rem|em|pt)\s*$/;
const CSS_FONT_SIZE_DECL = /font-size\s*:\s*\d+(\.\d+)?(px|rem|em|pt)/i;
const THEME_FILE_PATTERN = /[\\/]theme\.css$/;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid numeric font-size values — use var(--emr-font-xs..3xl) from theme.css.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      hardcodedFontSize:
        'Numeric font-size `{{size}}` is forbidden. Use var(--emr-font-xs..3xl) from theme.css.',
    },
  },
  create(context) {
    if (THEME_FILE_PATTERN.test(context.getFilename())) {
      return {};
    }
    return {
      // JSX/inline style: { fontSize: '14px' } or { fontSize: 14 }
      Property(node) {
        if (
          node.key &&
          ((node.key.type === 'Identifier' && node.key.name === 'fontSize') ||
            (node.key.type === 'Literal' && node.key.value === 'fontSize'))
        ) {
          const v = node.value;
          if (v.type === 'Literal') {
            if (typeof v.value === 'number') {
              context.report({
                node: v,
                messageId: 'hardcodedFontSize',
                data: { size: String(v.value) },
              });
              return;
            }
            if (typeof v.value === 'string' && NUMERIC_FONT_SIZE.test(v.value)) {
              context.report({
                node: v,
                messageId: 'hardcodedFontSize',
                data: { size: v.value.trim() },
              });
            }
          }
        }
      },
      // CSS-in-JS strings containing `font-size: 14px`.
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const match = node.value.match(CSS_FONT_SIZE_DECL);
        if (match) {
          context.report({
            node,
            messageId: 'hardcodedFontSize',
            data: { size: match[0] },
          });
        }
      },
    };
  },
};
