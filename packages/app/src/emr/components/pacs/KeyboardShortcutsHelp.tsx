// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// KeyboardShortcutsHelp Component
// ============================================================================
// A translucent overlay that shows all available keyboard shortcuts, grouped
// by category (Tools, Modes, Actions). Think of it like the "?" help screen
// in a video game — press '?' to see all the controls, press it again to hide.
// ============================================================================

import { useEffect, useRef, useCallback } from 'react';
import { FocusTrap } from '@mantine/core';
import { IconX, IconKeyboard } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import './KeyboardShortcutsHelp.css';

// ============================================================================
// Types
// ============================================================================

// TODO(phase-4): Import ShortcutMapping from `../../hooks/pacs/useKeyboardShortcuts`
// once that hook is ported (Phase 1 in the master plan). The type is inlined
// here so this presentational component can ship ahead of the hook.
export interface ShortcutMapping {
  /** The key that triggers this action (case-insensitive for letters) */
  key: string;
  /** Which visual group the shortcut belongs to */
  group: 'tools' | 'actions' | 'modes';
  /** Human-readable label (translation key) for the shortcut */
  label: string;
}

export interface KeyboardShortcutsHelpProps {
  /** Whether the overlay is visible */
  opened: boolean;
  /** Called when the user closes the overlay */
  onClose: () => void;
  /** Current shortcut mappings to display */
  shortcuts: ShortcutMapping[];
}

// ============================================================================
// Component
// ============================================================================

const GROUP_I18N_KEYS: Record<string, string> = {
  tools: 'imaging.shortcuts.groupTools',
  modes: 'imaging.shortcuts.groupModes',
  actions: 'imaging.shortcuts.groupActions',
};

const GROUP_ORDER: string[] = ['tools', 'modes', 'actions'];

export function KeyboardShortcutsHelp({
  opened,
  onClose,
  shortcuts,
}: KeyboardShortcutsHelpProps): JSX.Element | null {
  const { t } = useTranslation();
  const triggerRef = useRef<Element | null>(null);

  // Capture the element that had focus before the modal opened
  // so we can return focus to it when the modal closes
  useEffect(() => {
    if (opened) {
      triggerRef.current = document.activeElement;
    } else if (triggerRef.current && triggerRef.current instanceof HTMLElement) {
      triggerRef.current.focus();
      triggerRef.current = null;
    }
  }, [opened]);

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  if (!opened) {
    return null;
  }

  // Group shortcuts by their group field
  const grouped = new Map<string, ShortcutMapping[]>();
  for (const s of shortcuts) {
    const existing = grouped.get(s.group) ?? [];
    existing.push(s);
    grouped.set(s.group, existing);
  }

  return (
    <FocusTrap active={opened}>
      <div
        className="pacs-shortcuts-overlay"
        onClick={onClose}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={t('pacs.shortcuts.title')}
      >
        <div
          className="pacs-shortcuts-panel"
          onClick={(e) => e.stopPropagation()}
        >
        {/* Header */}
        <div className="pacs-shortcuts-header">
          <div className="pacs-shortcuts-title">
            <IconKeyboard size={20} />
            <span>{t('pacs.shortcuts.title')}</span>
          </div>
          <button
            className="pacs-shortcuts-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Shortcut groups */}
        <div className="pacs-shortcuts-body">
          {GROUP_ORDER.map((groupKey) => {
            const items = grouped.get(groupKey);
            if (!items || items.length === 0) {
              return null;
            }

            return (
              <div key={groupKey} className="pacs-shortcuts-group">
                <h3 className="pacs-shortcuts-group-title">
                  {t(GROUP_I18N_KEYS[groupKey] ?? `pacs.shortcuts.group.${groupKey}`)}
                </h3>
                <div className="pacs-shortcuts-grid">
                  {items.map((shortcut) => (
                    <div key={shortcut.label} className="pacs-shortcut-item">
                      <kbd className="pacs-shortcut-key">
                        {shortcut.key.toUpperCase()}
                      </kbd>
                      <span className="pacs-shortcut-label">{t(shortcut.label)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="pacs-shortcuts-footer">
          {t('pacs.shortcuts.hint')}
        </div>
      </div>
    </div>
    </FocusTrap>
  );
}
