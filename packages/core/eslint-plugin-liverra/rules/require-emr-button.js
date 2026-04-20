/**
 * liverra/require-emr-button
 *
 * Plain-language: primary actions should use the shared `EMRButton`, not the
 * raw Mantine `Button`. Reason: EMRButton bakes in the LiverRa gradient and
 * avoids the "padding on root breaks label height" trap (CLAUDE.md).
 *
 * Heuristic:
 *   1. Flag any `import { Button } from '@mantine/core'` in feature dirs
 *      (common/ and shared/ are exempt — they're where EMRButton wraps the
 *      primitive).
 *   2. Also flag `<Button type="submit">` / `<Button color="primary">` JSX
 *      (primary-action intent) regardless of where `Button` came from.
 *
 * Scope + allow-list is enforced via `overrides` in the root .eslintrc.cjs.
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require EMRButton for primary actions instead of @mantine/core Button.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      importMantineButton:
        'Import EMRButton from emr/components/common/ instead of @mantine/core Button.',
      primaryActionButton:
        '<Button> used as primary action (type="submit" or color="primary"). Use <EMRButton> instead.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== '@mantine/core') return;
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            spec.imported &&
            spec.imported.name === 'Button'
          ) {
            context.report({ node: spec, messageId: 'importMantineButton' });
          }
        }
      },
      JSXOpeningElement(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier') return;
        if (node.name.name !== 'Button') return;
        // Primary-action heuristic: type="submit" OR color="primary".
        let isPrimary = false;
        for (const attr of node.attributes) {
          if (attr.type !== 'JSXAttribute' || !attr.name) continue;
          const n = attr.name.name;
          const v =
            attr.value && attr.value.type === 'Literal' ? attr.value.value : null;
          if (n === 'type' && v === 'submit') isPrimary = true;
          if (n === 'color' && v === 'primary') isPrimary = true;
        }
        if (isPrimary) {
          context.report({ node, messageId: 'primaryActionButton' });
        }
      },
    };
  },
};
