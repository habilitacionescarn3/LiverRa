/**
 * LiverRa root ESLint configuration.
 *
 * Enforces the import graph from plan.md §Monorepo & Guardrails:
 *   app        → { core, imaging, fhirtypes }
 *   imaging    → { core, fhirtypes }
 *   fhirtypes  → {}
 *   core       → {}
 *
 * Also wires the 11 custom LiverRa guard rules (see
 * packages/core/eslint-plugin-liverra/).
 */
/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    node: true,
    es2023: true,
  },
  plugins: ['@typescript-eslint', 'boundaries', 'liverra'],
  settings: {
    'boundaries/elements': [
      { type: 'app', pattern: 'packages/app/**' },
      { type: 'imaging', pattern: 'packages/imaging/**' },
      { type: 'core', pattern: 'packages/core/**' },
      { type: 'fhirtypes', pattern: 'packages/fhirtypes/**' },
    ],
    'boundaries/ignore': [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__tests__/**',
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
  rules: {
    // Import graph enforcement (plan.md §Import graph rules)
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'app', allow: ['core', 'imaging', 'fhirtypes'] },
          { from: 'imaging', allow: ['core', 'fhirtypes'] },
          { from: 'fhirtypes', allow: [] },
          { from: 'core', allow: [] },
        ],
      },
    ],
    // Belt-and-braces: explicitly block reverse edges
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@liverra/app', '@liverra/app/*'],
            message: 'core/imaging/fhirtypes must not import from app.',
          },
        ],
      },
    ],
    // LiverRa custom guardrails (plan.md §Guardrail lint rules).
    // Severities per T125:
    //   error: safety-critical (FHIR URLs, forbidden hex, Russian locale,
    //          hardcoded colors, unjustified any, Mantine Button padding).
    //   warn:  stylistic / heuristic (font size, EMR button, raw Mantine
    //          inputs, state triplet heuristic).
    'liverra/no-hardcoded-fhir-url': 'error',
    'liverra/no-forbidden-hex': 'error',
    'liverra/no-russian-locale': 'error',
    'liverra/no-hardcoded-color': 'error',
    'liverra/no-any-without-justification': 'error',
    'liverra/mantine-button-padding-check': 'error',
    'liverra/no-hardcoded-font-size': 'warn',
    'liverra/require-emr-button': 'warn',
    'liverra/no-raw-mantine-inputs': 'warn',
    'liverra/require-state-triplet': 'warn',
  },
  overrides: [
    {
      // Allow hardcoded FHIR URLs inside the canonical constants file only.
      files: ['packages/app/src/emr/constants/fhir-*.ts'],
      rules: { 'liverra/no-hardcoded-fhir-url': 'off' },
    },
    {
      // Allow hex colors only in the design-system source.
      files: [
        'packages/app/src/emr/styles/theme.css',
        'packages/app/src/emr/constants/theme-colors.ts',
      ],
      rules: { 'liverra/no-hardcoded-color': 'off' },
    },
    {
      // EMRButton itself wraps Mantine's Button — it needs the primitive.
      files: [
        'packages/app/src/emr/components/common/**',
        'packages/app/src/emr/components/shared/**',
      ],
      rules: {
        'liverra/require-emr-button': 'off',
        'liverra/no-raw-mantine-inputs': 'off',
      },
    },
    {
      // The rule plugin itself must not trip its own rules while implementing them.
      files: ['packages/core/eslint-plugin-liverra/**'],
      rules: {
        'liverra/no-hardcoded-fhir-url': 'off',
        'liverra/no-hardcoded-color': 'off',
        'liverra/no-forbidden-hex': 'off',
        'liverra/no-russian-locale': 'off',
        'liverra/require-emr-button': 'off',
        'liverra/no-raw-mantine-inputs': 'off',
        'liverra/no-any-without-justification': 'off',
        'liverra/no-hardcoded-font-size': 'off',
        'liverra/mantine-button-padding-check': 'off',
        'liverra/require-state-triplet': 'off',
      },
    },
    {
      // Generated files are not hand-maintained — never lint their content.
      files: ['**/*.gen.ts', '**/*.gen.tsx'],
      rules: {
        'liverra/no-hardcoded-fhir-url': 'off',
        'liverra/no-hardcoded-color': 'off',
        'liverra/no-forbidden-hex': 'off',
        'liverra/no-any-without-justification': 'off',
      },
    },
  ],
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.turbo/',
    'packages/ml-inference/',
    'coverage/',
    '**/*.gen.ts',
    '**/*.gen.tsx',
  ],
};
