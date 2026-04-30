// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ArrowAnnotateTextInput Component
// ============================================================================
// A small floating text input that appears when the user places an arrow
// annotation. Instead of the default browser prompt(), this provides a
// polished in-app experience for entering annotation labels.
//
// Think of it like a sticky note — after you stick the arrow on the image,
// this little text box pops up so you can type what the arrow is pointing to.
// ============================================================================

import { useState, useRef, useEffect } from 'react';
import { TextInput, Button, Group, Paper } from '@mantine/core';
import { useTranslation } from '../../contexts/TranslationContext';
import './ArrowAnnotateTextInput.css';

export interface ArrowAnnotateTextInputProps {
  /** Whether the text input is visible */
  opened: boolean;
  /** Called when the user submits the label text */
  onSubmit: (text: string) => void;
  /** Called when the user cancels (closes without submitting) */
  onCancel: () => void;
}

export function ArrowAnnotateTextInput({
  opened,
  onSubmit,
  onCancel,
}: ArrowAnnotateTextInputProps): JSX.Element | null {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when it opens
  useEffect(() => {
    if (opened) {
      setText('');
      // Small delay to ensure the component is mounted before focusing
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [opened]);

  const handleSubmit = (): void => {
    onSubmit(text.trim() || '');
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  if (!opened) {
    return null;
  }

  return (
    <div className="arrow-annotate-overlay">
      <Paper className="arrow-annotate-input-container" shadow="md" radius="sm" p="sm">
        <TextInput
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('pacs.tools.arrowAnnotatePrompt')}
          aria-label={t('pacs.tools.arrowAnnotateLabel')}
          size="sm"
        />
        <Group gap="xs" mt="xs" justify="flex-end">
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={onCancel}
            styles={{ label: { overflow: 'visible', height: 'auto' } }}
          >
            {t('pacs.tools.arrowAnnotateCancel')}
          </Button>
          <Button
            size="compact-sm"
            onClick={handleSubmit}
            style={{ background: 'var(--emr-gradient-primary)' }}
            styles={{ label: { overflow: 'visible', height: 'auto' } }}
          >
            {t('pacs.tools.arrowAnnotateSubmit')}
          </Button>
        </Group>
      </Paper>
    </div>
  );
}
