// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { ActionIcon, Loader, Text } from '@mantine/core';
import { IconAlertTriangle, IconDeviceDesktopOff, IconRefresh, IconX } from '@tabler/icons-react';
import { EMRButton } from '../common';
import { BUTTON_MARGIN_TOP_STYLE } from './PACSViewer.helpers';

// LiverRa adaptation: the target useTranslation().t takes (key, params?) — no
// string-fallback second arg — so the prop type mirrors that exact signature.
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface PACSViewerStateProps {
  t: Translate;
  onClose?: () => void;
}

function PACSViewerCloseButton({ t, onClose }: PACSViewerStateProps): JSX.Element | null {
  if (!onClose) {
    return null;
  }

  return (
    <ActionIcon
      className="pacs-viewer-close"
      variant="subtle"
      color="gray"
      size="lg"
      onClick={onClose}
      aria-label={t('common.close')}
    >
      <IconX size={20} />
    </ActionIcon>
  );
}

function decodeErrorParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    console.warn('[PACSViewer.states] best-effort PACS operation failed:', err);
    return value;
  }
}

function translateMaybeErrorKey(error: string | null | undefined, t: Translate): string {
  if (!error) {
    return t('pacs.viewer.loadError');
  }
  const [key, ...paramParts] = error.split('|');
  if (!key.startsWith('pacs.')) {
    return error;
  }
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    params[part.slice(0, separatorIndex)] = decodeErrorParam(part.slice(separatorIndex + 1));
  }
  return t(key, params);
}

export function PACSNoWebGLState({ t, onClose }: PACSViewerStateProps): JSX.Element {
  return (
    <div className="pacs-viewer">
      <div className="pacs-viewer-no-webgl">
        <IconDeviceDesktopOff size={48} />
        <Text className="pacs-viewer-no-webgl-text">
          {t('pacs.viewer.noWebGL')}
        </Text>
      </div>
      <PACSViewerCloseButton t={t} onClose={onClose} />
    </div>
  );
}

interface PACSErrorStateProps extends PACSViewerStateProps {
  error?: string | null;
  onRetry: () => void;
}

export function PACSErrorState({ t, error, onRetry, onClose }: PACSErrorStateProps): JSX.Element {
  return (
    <div className="pacs-viewer">
      <div className="pacs-viewer-error">
        <IconAlertTriangle size={48} />
        <Text className="pacs-viewer-error-text">
          {translateMaybeErrorKey(error, t)}
        </Text>
        <EMRButton
          leftSection={<IconRefresh size={16} />}
          variant="light"
          color="gray"
          size="sm"
          onClick={onRetry}
          style={BUTTON_MARGIN_TOP_STYLE}
          data-testid="pacs-viewer-retry"
        >
          {t('common.tryAgain')}
        </EMRButton>
      </div>
      <PACSViewerCloseButton t={t} onClose={onClose} />
    </div>
  );
}

interface PACSLoadingStateProps extends PACSViewerStateProps {
  status: string;
}

export function PACSLoadingState({ t, status, onClose }: PACSLoadingStateProps): JSX.Element {
  return (
    <div className="pacs-viewer">
      <div className="pacs-viewer-loading">
        <Loader size="xl" color="var(--emr-accent)" />
        <Text size="sm" c="dimmed">
          {status === 'initializing'
            ? t('pacs.viewer.initializingViewer')
            : t('pacs.viewer.loadingStudy')}
        </Text>
      </div>
      <PACSViewerCloseButton t={t} onClose={onClose} />
    </div>
  );
}
