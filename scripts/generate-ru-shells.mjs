#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * One-shot generator for Russian translation namespace shells.
 *
 * For every `translations/en/*.json` not present in `translations/ru/`,
 * recursively walk the structure and emit `__TODO_TRANSLATE__:<en value>`
 * markers — except for a small whitelist of UI-chrome strings that have
 * clear non-medical Russian equivalents (Copy → Копировать, etc.). The
 * shells are CODEOWNERS-safe; medical terminology stays in marker form.
 *
 * Re-runnable: skips files that already exist.
 *
 * Audit references: H-I18N-1, H-I18NQ-1, H-I18NQ-5, C-ACR-1 (shell phase),
 * CC-4 in `audit-findings/full-emr-audit-2026-05-14-PART1-BLOCKER-CRITICAL-HIGH.md`.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const EN_DIR = join(REPO, 'packages/app/src/emr/translations/en');
const RU_DIR = join(REPO, 'packages/app/src/emr/translations/ru');
const KA_DIR = join(REPO, 'packages/app/src/emr/translations/ka');

// ---------------------------------------------------------------------------
// UI-chrome translations (no medical terminology — safe to translate directly)
// ---------------------------------------------------------------------------
// Key: lowercase normalized English string → Russian.
// Lookup is exact-match on the trimmed English value. Anything not in this
// table becomes a __TODO_TRANSLATE__ marker for CODEOWNERS review.
const RU_CHROME = {
  // Actions
  'save': 'Сохранить',
  'cancel': 'Отмена',
  'submit': 'Отправить',
  'close': 'Закрыть',
  'retry': 'Повторить',
  'back': 'Назад',
  'next': 'Далее',
  'continue': 'Продолжить',
  'confirm': 'Подтвердить',
  'delete': 'Удалить',
  'ok': 'ОК',
  'or': 'или',
  'and': 'и',
  'yes': 'Да',
  'no': 'Нет',
  'skip': 'Пропустить',
  'refresh': 'Обновить',
  'try again': 'Повторить',
  'open': 'Открыть',
  'copy': 'Копировать',
  'paste': 'Вставить',
  'cut': 'Вырезать',
  'edit': 'Редактировать',
  'view': 'Просмотр',
  'add': 'Добавить',
  'remove': 'Удалить',
  'search': 'Поиск',
  'filter': 'Фильтр',
  'sort': 'Сортировка',
  'select': 'Выбрать',
  'select all': 'Выбрать все',
  'clear': 'Очистить',
  'clear input': 'Очистить поле',
  'reset': 'Сбросить',
  'apply': 'Применить',
  'export': 'Экспорт',
  'import': 'Импорт',
  'download': 'Скачать',
  'upload': 'Загрузить',
  'print': 'Печать',
  'share': 'Поделиться',
  'sign in': 'Войти',
  'sign out': 'Выйти',
  'log in': 'Войти',
  'log out': 'Выйти',
  'logout': 'Выйти',
  'login': 'Войти',
  'register': 'Регистрация',
  'help': 'Помощь',
  'settings': 'Настройки',
  'profile': 'Профиль',
  'preferences': 'Настройки',
  'language': 'Язык',
  'theme': 'Тема',
  'notifications': 'Уведомления',
  'menu': 'Меню',
  'more': 'Ещё',
  'less': 'Меньше',
  'details': 'Подробнее',
  'show details': 'Показать подробности',
  'hide details': 'Скрыть подробности',
  'show more': 'Показать больше',
  'show less': 'Показать меньше',
  'insert': 'Вставить',
  'finish': 'Завершить',
  'done': 'Готово',
  'pause': 'Пауза',
  'resume': 'Продолжить',
  'stop': 'Остановить',
  'start': 'Начать',
  'restart': 'Перезапустить',
  'discard': 'Отменить',
  'discard changes': 'Отменить изменения',

  // States
  'loading': 'Загрузка',
  'loading…': 'Загрузка…',
  'loading...': 'Загрузка...',
  'saving': 'Сохранение',
  'saving…': 'Сохранение…',
  'saved': 'Сохранено',
  'submitting': 'Отправка',
  'submitting…': 'Отправка…',
  'processing': 'Обработка',
  'processing…': 'Обработка…',
  'no results': 'Ничего не найдено',
  'no data': 'Нет данных',
  'no options found': 'Варианты не найдены',
  'empty': 'Пусто',
  'pending': 'В ожидании',
  'queued': 'В очереди',
  'running': 'Выполняется',
  'complete': 'Завершено',
  'completed': 'Завершено',
  'failed': 'Ошибка',
  'success': 'Успешно',
  'error': 'Ошибка',
  'warning': 'Предупреждение',
  'info': 'Информация',

  // Common labels
  'name': 'Имя',
  'email': 'Email',
  'password': 'Пароль',
  'username': 'Имя пользователя',
  'date': 'Дата',
  'time': 'Время',
  'status': 'Статус',
  'type': 'Тип',
  'description': 'Описание',
  'notes': 'Заметки',
  'comment': 'Комментарий',
  'comments': 'Комментарии',
  'title': 'Заголовок',
  'subtitle': 'Подзаголовок',
  'welcome': 'Добро пожаловать',

  // Errors
  'something went wrong': 'Что-то пошло не так',
  'something went wrong.': 'Что-то пошло не так.',
  'something went wrong. please try again.': 'Что-то пошло не так. Попробуйте ещё раз.',
  'an unexpected error occurred': 'Произошла непредвиденная ошибка',
  'permission denied': 'Доступ запрещён',
  'access denied': 'Доступ запрещён',
  "you don't have permission to do this.": 'У вас нет прав для выполнения этого действия.',
  'not found': 'Не найдено',
  'page not found': 'Страница не найдена',
  'unauthorized': 'Не авторизован',
  'forbidden': 'Запрещено',
  'invalid': 'Недопустимо',
  'required': 'Обязательно',
  'optional': 'Необязательно',

  // RUO / regulatory
  'research use only — not for clinical use':
    'Только для исследовательских целей — не для клинического применения',
  'research use only':
    'Только для исследовательских целей',

  // Navigation
  'cases': 'Случаи',
  'my cases': 'Мои случаи',
  'all cases': 'Все случаи',
  'demo': 'Демо',
  'administration': 'Администрирование',
  'users': 'Пользователи',
  'audit': 'Аудит',
  'compliance': 'Комплаенс',
  'help center': 'Центр помощи',
  'glossary': 'Глоссарий',
  'erasure': 'Удаление данных',
  'session': 'Сессия',
  'try a sample case': 'Попробовать тестовый случай',

  // File / upload
  'file input': 'Поле загрузки файла',
  'choose file': 'Выбрать файл',
  'choose files': 'Выбрать файлы',
  'drop files here': 'Перетащите файлы сюда',
  'drag and drop': 'Перетащите',

  // Form chrome
  'form error': 'Ошибка формы',
  'please fix the errors and try again.': 'Пожалуйста, исправьте ошибки и попробуйте ещё раз.',
  'invalid time': 'Неверное время',
  'placeholder': 'Placeholder',
  'todo: translation pending': 'TODO: перевод ожидается',
};

// ---------------------------------------------------------------------------
// Recursive shell builder
// ---------------------------------------------------------------------------

const TODO_PREFIX = '__TODO_TRANSLATE__:';

function shellValue(enValue) {
  if (typeof enValue !== 'string') return enValue;
  // Preserve interpolation placeholders {{x}}; just check if the un-interpolated
  // base matches a chrome key.
  const trimmed = enValue.trim();
  const lower = trimmed.toLowerCase();
  if (RU_CHROME[lower]) return RU_CHROME[lower];
  return `${TODO_PREFIX}${enValue}`;
}

function shellBundle(en) {
  if (en === null || en === undefined) return en;
  if (typeof en === 'string') return shellValue(en);
  if (Array.isArray(en)) return en.map(shellBundle);
  if (typeof en === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(en)) {
      out[k] = shellBundle(v);
    }
    return out;
  }
  return en;
}

// ---------------------------------------------------------------------------
// Walk + emit
// ---------------------------------------------------------------------------

function generateFor(locale, dir, mode) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const enFiles = readdirSync(EN_DIR).filter((f) => f.endsWith('.json'));
  const created = [];
  const updated = [];

  for (const f of enFiles) {
    const target = join(dir, f);
    const enRaw = JSON.parse(readFileSync(join(EN_DIR, f), 'utf8'));
    const shell = shellBundle(enRaw);

    // Add _meta header for new files; preserve existing files unless --force
    const meta = {
      _meta: {
        locale,
        status: 'shell',
        notes: `All keys marked __TODO_TRANSLATE__ pending CODEOWNERS medical-terminology review. UI chrome (actions, navigation, errors) translated directly.`,
      },
      ...shell,
    };

    if (!existsSync(target)) {
      writeFileSync(target, JSON.stringify(meta, null, 2) + '\n', 'utf8');
      created.push(f);
    } else if (mode === 'fill-missing') {
      // For KA / RU files that already exist, recursively fill missing keys
      // from the en shell without touching existing translated values.
      const existing = JSON.parse(readFileSync(target, 'utf8'));
      const merged = mergeMissing(existing, shell);
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf8');
        updated.push(f);
      }
    }
  }

  return { created, updated };
}

/** Recursively copy missing keys from shell into existing, preserving existing values. */
function mergeMissing(existing, shell) {
  if (existing === null || existing === undefined) return shell;
  if (typeof shell !== 'object' || shell === null) return existing;
  if (Array.isArray(shell)) return existing; // don't merge arrays — caller's choice
  if (typeof existing !== 'object' || Array.isArray(existing) || existing === null) {
    return existing;
  }
  const out = { ...existing };
  for (const [k, v] of Object.entries(shell)) {
    if (!(k in out)) {
      out[k] = v;
    } else if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof out[k] === 'object' &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = mergeMissing(out[k], v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const DE_DIR = join(REPO, 'packages/app/src/emr/translations/de');

const ruResult = generateFor('ru', RU_DIR, 'fill-missing');
console.log(`[ru] created ${ruResult.created.length} files, updated ${ruResult.updated.length}`);
ruResult.created.forEach((f) => console.log(`  + ru/${f}`));
ruResult.updated.forEach((f) => console.log(`  ~ ru/${f}`));

const kaResult = generateFor('ka', KA_DIR, 'fill-missing');
console.log(`[ka] created ${kaResult.created.length} files, updated ${kaResult.updated.length}`);
kaResult.created.forEach((f) => console.log(`  + ka/${f}`));
kaResult.updated.forEach((f) => console.log(`  ~ ka/${f}`));

const deResult = generateFor('de', DE_DIR, 'fill-missing');
console.log(`[de] created ${deResult.created.length} files, updated ${deResult.updated.length}`);
deResult.created.forEach((f) => console.log(`  + de/${f}`));
deResult.updated.forEach((f) => console.log(`  ~ de/${f}`));
