// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// MacroEditor — CRUD modal for managing report text macros
// ============================================================================
// Think of macros like text-expander shortcuts: a radiologist types ".normal"
// and it expands into a full "no acute findings" paragraph. This modal lets
// them create, edit, and delete those shortcuts.
//
// Uses EMRModal as the container. The table lists existing macros; an inline
// form below the table handles add/edit operations.
//
// Ported from MediMind (components/pacs/MacroEditor.tsx) unchanged except
// for the translation namespace (kept at `pacs.macro.*` — already LiverRa-
// compatible) and removal of the `'cardiac'` category (cardiology cut-out).
// ============================================================================

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActionIcon,
  Group,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Badge,
  Select,
  Tooltip,
} from '@mantine/core';
import {
  IconEdit,
  IconTrash,
  IconPlus,
  IconNotes,
} from '@tabler/icons-react';
import { EMRModal } from '../common/EMRModal';
import { useTranslation } from '../../contexts/TranslationContext';

// ============================================================================
// Types
// ============================================================================

/** A single text-expansion macro (like ".normal" → "No acute findings..."). */
export interface MacroItem {
  id: string;
  trigger: string;
  expansion: string;
  category?: string;
}

/** Available macro categories. 'cardiac' removed — cardiology cut-out. */
const MACRO_CATEGORIES = ['general', 'ct', 'mri', 'xray', 'us'] as const;
export type MacroCategory = (typeof MACRO_CATEGORIES)[number];

export interface MacroEditorProps {
  isOpen: boolean;
  onClose: () => void;
  macros: MacroItem[];
  onCreateMacro: (trigger: string, expansion: string, category?: string) => Promise<void>;
  onUpdateMacro: (
    macroId: string,
    updates: Partial<Pick<MacroItem, 'trigger' | 'expansion' | 'category'>>,
  ) => Promise<void>;
  onDeleteMacro: (macroId: string) => Promise<void>;
}

// ============================================================================
// Form validation
// ============================================================================

interface FormErrors {
  trigger?: string;
  expansion?: string;
}

function validateForm(
  trigger: string,
  expansion: string,
  existingTriggers: string[],
  editingId: string | null,
  macros: MacroItem[],
  t: (key: string) => string,
): FormErrors {
  const errors: FormErrors = {};

  if (!trigger.trim()) {
    errors.trigger = t('pacs.macro.triggerRequired');
  } else if (!trigger.startsWith('.')) {
    errors.trigger = t('pacs.macro.triggerDot');
  } else {
    // Check uniqueness — exclude the macro being edited
    const otherTriggers = editingId
      ? macros.filter((m) => m.id !== editingId).map((m) => m.trigger)
      : existingTriggers;
    if (otherTriggers.includes(trigger.trim())) {
      errors.trigger = t('pacs.macro.triggerUnique');
    }
  }

  if (!expansion.trim()) {
    errors.expansion = t('pacs.macro.expansionRequired');
  }

  return errors;
}

// ============================================================================
// Component
// ============================================================================

export function MacroEditor({
  isOpen,
  onClose,
  macros,
  onCreateMacro,
  onUpdateMacro,
  onDeleteMacro,
}: MacroEditorProps): React.ReactElement {
  const { t } = useTranslation();

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [trigger, setTrigger] = useState('');
  const [expansion, setExpansion] = useState('');
  const [category, setCategory] = useState<string | null>('general');
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // All existing triggers for uniqueness check
  const existingTriggers = useMemo(() => macros.map((m) => m.trigger), [macros]);

  // Category options for the select dropdown
  const categoryOptions = useMemo(
    () =>
      MACRO_CATEGORIES.map((cat) => ({
        value: cat,
        label: t(`pacs.macro.categories.${cat}`),
      })),
    [t],
  );

  // Reset form to initial state
  const resetForm = useCallback(() => {
    setEditingId(null);
    setShowForm(false);
    setTrigger('');
    setExpansion('');
    setCategory('general');
    setErrors({});
  }, []);

  // Open form for adding a new macro
  const handleAdd = useCallback(() => {
    resetForm();
    setShowForm(true);
  }, [resetForm]);

  // Open form for editing an existing macro
  const handleEdit = useCallback((macro: MacroItem) => {
    setEditingId(macro.id);
    setTrigger(macro.trigger);
    setExpansion(macro.expansion);
    setCategory(macro.category ?? 'general');
    setErrors({});
    setShowForm(true);
  }, []);

  // Save (create or update)
  const handleSave = useCallback(async () => {
    const formErrors = validateForm(trigger, expansion, existingTriggers, editingId, macros, t);
    if (Object.keys(formErrors).length > 0) {
      setErrors(formErrors);
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await onUpdateMacro(editingId, {
          trigger: trigger.trim(),
          expansion: expansion.trim(),
          category: category ?? undefined,
        });
      } else {
        await onCreateMacro(trigger.trim(), expansion.trim(), category ?? undefined);
      }
      resetForm();
    } finally {
      setSaving(false);
    }
  }, [
    trigger,
    expansion,
    category,
    editingId,
    existingTriggers,
    macros,
    t,
    onCreateMacro,
    onUpdateMacro,
    resetForm,
  ]);

  // Delete with confirmation
  const handleDelete = useCallback(
    async (macroId: string) => {
      if (deletingId === macroId) {
        // Second click = confirm
        try {
          await onDeleteMacro(macroId);
        } finally {
          setDeletingId(null);
        }
      } else {
        // First click = arm confirmation
        setDeletingId(macroId);
      }
    },
    [deletingId, onDeleteMacro],
  );

  // Close modal resets form state
  const handleClose = useCallback(() => {
    resetForm();
    setDeletingId(null);
    onClose();
  }, [resetForm, onClose]);

  // Truncate long expansion text for the table preview
  const truncate = (text: string, maxLen: number): string =>
    text.length > maxLen ? text.slice(0, maxLen) + '…' : text;

  return (
    <EMRModal
      opened={isOpen}
      onClose={handleClose}
      size="md"
      icon={IconNotes}
      title={t('pacs.macro.title')}
      testId="macro-editor-modal"
    >
      <Stack gap="md" style={{ padding: 'var(--emr-spacing-md)' }}>
        {/* ── Macro List Table ── */}
        {macros.length === 0 ? (
          <Text
            ta="center"
            c="dimmed"
            py="xl"
            data-testid="macro-empty-state"
          >
            {t('pacs.macro.noMacros')}
          </Text>
        ) : (
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders={false}
            data-testid="macro-table"
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 120 }}>{t('pacs.macro.trigger')}</Table.Th>
                <Table.Th>{t('pacs.macro.expansion')}</Table.Th>
                <Table.Th style={{ width: 110 }}>{t('pacs.macro.category')}</Table.Th>
                <Table.Th style={{ width: 90 }}>{t('pacs.macro.actions')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {macros.map((macro) => (
                <Table.Tr key={macro.id} data-testid={`macro-row-${macro.id}`}>
                  <Table.Td>
                    <Text fw={600} ff="monospace" size="sm">
                      {macro.trigger}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
                      {truncate(macro.expansion, 80)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {macro.category && (
                      <Badge
                        size="sm"
                        variant="light"
                        color="blue"
                        style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                      >
                        {t(`pacs.macro.categories.${macro.category}`)}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label={t('pacs.macro.editMacro')}>
                        <ActionIcon
                          variant="subtle"
                          color="blue"
                          size="sm"
                          onClick={() => handleEdit(macro)}
                          aria-label={t('pacs.macro.editMacro')}
                          data-testid={`macro-edit-${macro.id}`}
                        >
                          <IconEdit size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip
                        label={
                          deletingId === macro.id
                            ? t('pacs.macro.deleteConfirm')
                            : t('pacs.macro.deleteMacro')
                        }
                      >
                        <ActionIcon
                          variant="subtle"
                          color={deletingId === macro.id ? 'red' : 'gray'}
                          size="sm"
                          onClick={() => handleDelete(macro.id)}
                          aria-label={t('pacs.macro.deleteMacro')}
                          data-testid={`macro-delete-${macro.id}`}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        {/* ── Add / Edit Form ── */}
        {showForm ? (
          <Stack
            gap="sm"
            style={{
              padding: 'var(--emr-spacing-md)',
              background: 'var(--emr-bg-hover)',
              borderRadius: 'var(--emr-radius-md)',
              border: '1px solid var(--emr-border-color)',
            }}
            data-testid="macro-form"
          >
            <Text fw={600} size="sm">
              {editingId ? t('pacs.macro.editMacro') : t('pacs.macro.addMacro')}
            </Text>

            <Group grow align="flex-start">
              <TextInput
                label={t('pacs.macro.trigger')}
                placeholder={t('pacs.macro.triggerPlaceholder')}
                value={trigger}
                onChange={(e) => {
                  setTrigger(e.currentTarget.value);
                  if (errors.trigger) {
                    setErrors((prev) => ({ ...prev, trigger: undefined }));
                  }
                }}
                error={errors.trigger}
                data-testid="macro-trigger-input"
                styles={{ input: { fontFamily: 'monospace' } }}
              />
              <Select
                label={t('pacs.macro.category')}
                data={categoryOptions}
                value={category}
                onChange={setCategory}
                data-testid="macro-category-select"
              />
            </Group>

            <Textarea
              label={t('pacs.macro.expansion')}
              placeholder={t('pacs.macro.expansionPlaceholder')}
              value={expansion}
              onChange={(e) => {
                setExpansion(e.currentTarget.value);
                if (errors.expansion) {
                  setErrors((prev) => ({ ...prev, expansion: undefined }));
                }
              }}
              error={errors.expansion}
              minRows={3}
              maxRows={6}
              autosize
              data-testid="macro-expansion-input"
            />

            <Group justify="flex-end" gap="sm">
              <button
                type="button"
                onClick={resetForm}
                style={{
                  background: 'none',
                  border: '1px solid var(--emr-border-color)',
                  borderRadius: 'var(--emr-radius-sm)',
                  padding: '6px 16px',
                  cursor: 'pointer',
                  color: 'var(--emr-text-primary)',
                  fontSize: 'var(--emr-font-sm)',
                }}
                data-testid="macro-cancel-btn"
              >
                {t('pacs.macro.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: 'var(--emr-gradient-primary)',
                  border: 'none',
                  borderRadius: 'var(--emr-radius-sm)',
                  padding: '6px 16px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  color: 'var(--emr-text-inverse)',
                  fontSize: 'var(--emr-font-sm)',
                  fontWeight: 600,
                  opacity: saving ? 0.7 : 1,
                }}
                data-testid="macro-save-btn"
              >
                {t('pacs.macro.save')}
              </button>
            </Group>
          </Stack>
        ) : (
          <Group justify="center">
            <button
              type="button"
              onClick={handleAdd}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--emr-gradient-primary)',
                border: 'none',
                borderRadius: 'var(--emr-radius-sm)',
                padding: '8px 20px',
                cursor: 'pointer',
                color: 'var(--emr-text-inverse)',
                fontSize: 'var(--emr-font-sm)',
                fontWeight: 600,
              }}
              data-testid="macro-add-btn"
            >
              <IconPlus size={16} />
              {t('pacs.macro.addMacro')}
            </button>
          </Group>
        )}
      </Stack>
    </EMRModal>
  );
}

export default MacroEditor;
