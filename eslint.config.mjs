/**
 * LiverRa root ESLint flat config (ESLint 9+).
 *
 * This is the ESLint 9 flat-config equivalent of `.eslintrc.cjs`. It wires:
 *   - @typescript-eslint/parser for .ts / .tsx
 *   - the local eslint-plugin-liverra guardrail rules (10 rules — see plugin index.js)
 *   - the same overrides (constants files, design-system source, EMR component
 *     library, the rule plugin itself, generated files).
 *
 * NOTE: `.eslintrc.cjs` is intentionally left in place for tooling/tests that
 * still reference it. ESLint 9 uses THIS file at runtime.
 *
 * Intentionally NOT ported (would require a new dev-dep that is not installed):
 *   - `eslint-plugin-boundaries` (`boundaries/element-types` rule). The belt-
 *     and-braces `no-restricted-imports` rule below still blocks reverse edges.
 */

import { createRequire } from 'node:module';
import tsParser from '@typescript-eslint/parser';

const require = createRequire(import.meta.url);
const liverra = require('./packages/core/eslint-plugin-liverra/index.js');

const LIVERRA_RULES_ON = {
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
};

const LIVERRA_RULES_OFF = Object.fromEntries(
  Object.keys(LIVERRA_RULES_ON).map((name) => [name, 'off']),
);

export default [
  // 1. Global ignores — flat-config replacement for `ignorePatterns`.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.gen.ts',
      '**/*.gen.tsx',
      '**/*.css',
      '**/*.json',
      '**/*.md',
      'packages/ml-inference/**',
    ],
  },

  // 2. Base config for every TS/TSX file in the monorepo.
  {
    files: [
      'packages/app/src/**/*.{ts,tsx}',
      'packages/core/src/**/*.ts',
      'packages/imaging/src/**/*.ts',
      'packages/fhirtypes/src/**/*.ts',
    ],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Browser + Node + ES2023 — matches old `env: { browser, node, es2023 }`.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        globalThis: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    plugins: {
      liverra,
    },
    rules: {
      // Belt-and-braces: block reverse edges in the monorepo import graph.
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
      // LiverRa custom guardrails.
      ...LIVERRA_RULES_ON,
    },
  },

  // 3. Overrides (flat config = later objects override earlier ones).

  // Allow hardcoded FHIR URLs inside the canonical constants file only.
  {
    files: ['packages/app/src/emr/constants/fhir-*.ts'],
    rules: { 'liverra/no-hardcoded-fhir-url': 'off' },
  },

  // Allow hex colors only in the design-system source.
  {
    files: [
      'packages/app/src/emr/styles/theme.css',
      'packages/app/src/emr/constants/theme-colors.ts',
    ],
    rules: { 'liverra/no-hardcoded-color': 'off' },
  },

  // EMRButton itself wraps Mantine's Button — it needs the primitive.
  {
    files: [
      'packages/app/src/emr/components/common/**',
      'packages/app/src/emr/components/shared/**',
    ],
    rules: {
      'liverra/require-emr-button': 'off',
      'liverra/no-raw-mantine-inputs': 'off',
    },
  },

  // The rule plugin itself must not trip its own rules while implementing them.
  {
    files: ['packages/core/eslint-plugin-liverra/**'],
    rules: LIVERRA_RULES_OFF,
  },

  // Generated files are not hand-maintained.
  {
    files: ['**/*.gen.ts', '**/*.gen.tsx'],
    rules: {
      'liverra/no-hardcoded-fhir-url': 'off',
      'liverra/no-hardcoded-color': 'off',
      'liverra/no-forbidden-hex': 'off',
      'liverra/no-any-without-justification': 'off',
    },
  },
];
