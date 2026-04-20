/**
 * eslint-plugin-liverra
 *
 * 11 guardrail rules enforcing LiverRa's engineering conventions
 * (plan.md §Guardrail lint rules). Each rule is currently a stub;
 * real AST logic lands in a later phase.
 */
'use strict';

module.exports = {
  rules: {
    'no-hardcoded-fhir-url': require('./rules/no-hardcoded-fhir-url'),
    'no-hardcoded-color': require('./rules/no-hardcoded-color'),
    'no-forbidden-hex': require('./rules/no-forbidden-hex'),
    'no-russian-locale': require('./rules/no-russian-locale'),
    'require-emr-button': require('./rules/require-emr-button'),
    'no-raw-mantine-inputs': require('./rules/no-raw-mantine-inputs'),
    'no-any-without-justification': require('./rules/no-any-without-justification'),
    'no-bulk-regex-touch': require('./rules/no-bulk-regex-touch'),
    'no-hardcoded-font-size': require('./rules/no-hardcoded-font-size'),
    'mantine-button-padding-check': require('./rules/mantine-button-padding-check'),
    'require-state-triplet': require('./rules/require-state-triplet'),
  },
};
