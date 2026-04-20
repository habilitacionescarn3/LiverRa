/**
 * liverra/no-hardcoded-color
 *
 * Plain-language: colors must come from `theme.css` via CSS variables
 * (e.g. `var(--emr-primary)`). If someone writes `color: '#1a365d'` or
 * `background: 'rgb(...)'` anywhere outside the theme source files,
 * this rule flags it and points them at `theme.css`.
 *
 * Exemptions (handled via `overrides` in the root .eslintrc.cjs):
 *  - `packages/app/src/emr/styles/theme.css`
 *  - `packages/app/src/emr/constants/theme-colors.ts`
 *  - `*.gen.ts`
 *
 * See plan.md §Guardrail lint rules and CLAUDE.md §Unified Color System.
 */
'use strict';

// Match 3/4/6/8-digit hex at word boundary; also rgb()/hsl() openings.
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}\b/;
const RGB_HSL_PATTERN = /\b(rgb|rgba|hsl|hsla)\s*\(/i;
// Extra safety: never allow this rule to fire inside the theme file itself.
const THEME_FILE_PATTERN = /[\\/](theme\.css|theme-colors\.ts)$/;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid hardcoded hex/rgb/hsl colors outside theme.css and theme-colors.ts.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      hardcodedColor:
        'Hardcoded color `{{color}}` detected. Use CSS variables from emr/styles/theme.css.',
    },
  },
  create(context) {
    if (THEME_FILE_PATTERN.test(context.getFilename())) {
      return {};
    }
    function check(node, value) {
      if (typeof value !== 'string') return;
      const hexMatch = value.match(HEX_PATTERN);
      if (hexMatch) {
        context.report({ node, messageId: 'hardcodedColor', data: { color: hexMatch[0] } });
        return;
      }
      const rgbMatch = value.match(RGB_HSL_PATTERN);
      if (rgbMatch) {
        context.report({ node, messageId: 'hardcodedColor', data: { color: rgbMatch[0] } });
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
