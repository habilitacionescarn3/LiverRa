/**
 * liverra/no-russian-locale
 *
 * Plain-language: LiverRa ships en / de / ka only (no Russian). If any
 * translations file under `translations/**` references a `ru` locale key
 * or imports a `ru.json`, this rule flags it.
 *
 * We only scan files under `translations/**` to avoid matching ordinary
 * words like "true" or "instructor" that happen to contain "ru".
 *
 * See plan.md §Guardrail lint rules.
 */
'use strict';

const TRANSLATIONS_PATH_PATTERN = /[\\/]translations[\\/]/;
// Match `ru` as a whole token — either quoted in a string ("ru", 'ru'),
// as an object key 'ru:', or as an import path segment ending in `ru.json`.
const RU_TOKEN_PATTERN = /(^|[^a-zA-Z])ru([^a-zA-Z]|$)/;
const RU_JSON_PATTERN = /\bru\.json$/;

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid Russian locale references in translations/** — LiverRa ships en/de/ka only.',
      category: 'LiverRa Guardrails',
      recommended: true,
    },
    schema: [],
    messages: {
      russianLocale:
        'Russian locale reference detected (`{{token}}`). LiverRa supports en, de, ka only.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (!TRANSLATIONS_PATH_PATTERN.test(filename)) {
      return {};
    }

    function checkString(node, value) {
      if (typeof value !== 'string') return;
      // Direct path import like `./ru.json`.
      if (RU_JSON_PATTERN.test(value)) {
        context.report({ node, messageId: 'russianLocale', data: { token: value } });
        return;
      }
      // Exact locale key literals ("ru").
      if (value === 'ru' || value === 'RU') {
        context.report({ node, messageId: 'russianLocale', data: { token: value } });
      }
    }

    return {
      Literal(node) {
        checkString(node, node.value);
      },
      // `{ ru: { ... } }` — unquoted object key.
      Property(node) {
        if (
          node.key &&
          node.key.type === 'Identifier' &&
          (node.key.name === 'ru' || node.key.name === 'RU') &&
          RU_TOKEN_PATTERN.test(node.key.name)
        ) {
          context.report({
            node: node.key,
            messageId: 'russianLocale',
            data: { token: node.key.name },
          });
        }
      },
    };
  },
};
