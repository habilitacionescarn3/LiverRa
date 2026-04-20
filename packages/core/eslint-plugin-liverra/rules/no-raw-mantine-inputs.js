/**
 * liverra/no-raw-mantine-inputs
 *
 * Plain-language: form inputs (TextInput, Select, DatePicker, Checkbox, …)
 * must use the `EMR*` wrappers under `emr/components/shared/EMRFormFields/`.
 * Those wrappers bake in label conventions, i18n keys, error alignment,
 * and a11y hooks that the raw Mantine primitives do not.
 *
 * This rule flags `import { TextInput } from '@mantine/core'` (and the
 * other primitives in `RAW_INPUTS`). Scope/exemptions are enforced via
 * `overrides` in root .eslintrc.cjs.
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

const RAW_INPUTS = new Set([
  'TextInput',
  'Select',
  'MultiSelect',
  'Checkbox',
  'Radio',
  'Textarea',
  'NumberInput',
  'DatePicker',
  'DateInput',
  'PasswordInput',
]);

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid direct @mantine/core form primitives — use EMR* wrappers from EMRFormFields/.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      useEmrFormField:
        'Use EMR{{name}} from emr/components/shared/EMRFormFields/ instead of @mantine/core {{name}}.',
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
            RAW_INPUTS.has(spec.imported.name)
          ) {
            context.report({
              node: spec,
              messageId: 'useEmrFormField',
              data: { name: spec.imported.name },
            });
          }
        }
      },
    };
  },
};
