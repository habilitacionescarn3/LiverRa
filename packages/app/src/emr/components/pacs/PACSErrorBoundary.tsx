// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACSErrorBoundary — PACS-specific error boundary
// ============================================================================
// Wraps PACS components to catch rendering crashes from Cornerstone3D (WebGL
// errors, shader failures, etc.) and shows a PACS-aware fallback with specific
// error messages and retry functionality.
//
// Think of this like a safety net: if the medical image viewer crashes (e.g.,
// WebGL context lost, GPU memory exhausted), this catches it and shows a
// helpful message instead of a blank screen.
// ============================================================================

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { Alert, Button, Stack, Text, Code, Box, Group } from '@mantine/core';
import {
  IconAlertTriangle,
  IconDeviceDesktopOff,
  IconRefresh,
  IconWifiOff,
} from '@tabler/icons-react';
import { captureException } from '../../services/observability/sentryInit';

// ============================================================================
// Types
// ============================================================================

export interface PACSErrorBoundaryProps {
  children: ReactNode;
  /** Called when the user clicks "Try Again" — use to re-initialize the viewer */
  onRetry?: () => void;
  /**
   * Translation function — pass `t` from `useTranslation()`.
   * NOTE: LiverRa's `t()` signature is `(key, params?)` — the fallback-string
   * overload from MediMind is not used here. When a key is missing, LiverRa's
   * provider returns the key itself, so callers should treat the key text as
   * both the lookup and the worst-case fallback.
   */
  t: (key: string) => string;
}

interface PACSErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  retryCount: number;
}

/** Classify the error to show the right icon and message */
type PACSErrorKind = 'webgl' | 'network' | 'generic';

function classifyError(error: Error): PACSErrorKind {
  const msg = error.message.toLowerCase();
  if (
    msg.includes('webgl') ||
    msg.includes('gpu') ||
    msg.includes('shader') ||
    msg.includes('rendering engine') ||
    msg.includes('context lost') ||
    msg.includes('gl_')
  ) {
    return 'webgl';
  }
  if (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('econnrefused')
  ) {
    return 'network';
  }
  return 'generic';
}

// ============================================================================
// Component
// ============================================================================

export class PACSErrorBoundary extends Component<PACSErrorBoundaryProps, PACSErrorBoundaryState> {
  constructor(props: PACSErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, retryCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<PACSErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    // M-PACS-4: route through Sentry's PHI-scrubbing pipeline rather
    // than dumping the raw Error to the console. Cornerstone3D crashes
    // routinely include the failing imageId — which itself includes the
    // study/series/instance UID — in the stack trace. Sentry's
    // captureException uses our beforeSend hook to strip those before
    // shipping the event. We forward only the error CATEGORY (classify
    // result) to console for dev triage.
    const category = classifyError(error);
    captureException(error, {
      source: 'PACSErrorBoundary',
      kind: category,
      componentStack: typeof errorInfo.componentStack === 'string'
        ? errorInfo.componentStack.slice(0, 500)
        : undefined,
    });
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[PACSErrorBoundary] category=' + category);
    }
  }

  handleRetry = (): void => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prev.retryCount + 1,
    }));
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const { children, t } = this.props;
    const { hasError, error, retryCount } = this.state;
    const maxRetries = 3;
    const retriesExhausted = retryCount >= maxRetries;

    if (!hasError) {
      return children;
    }

    const kind = error ? classifyError(error) : 'generic';

    // Choose icon and messages based on the error kind
    const iconMap = {
      webgl: <IconDeviceDesktopOff size={24} />,
      network: <IconWifiOff size={24} />,
      generic: <IconAlertTriangle size={24} />,
    };

    const titleMap = {
      webgl: t('pacs.error.webglTitle'),
      network: t('pacs.error.unreachable'),
      generic: t('pacs.error.viewerCrashTitle'),
    };

    const messageMap = {
      webgl: t('pacs.error.webglDescription'),
      network: t('pacs.error.unreachableDescription'),
      generic: t('pacs.error.viewerCrashDescription'),
    };

    return (
      <Box
        role="alert"
        aria-live="assertive"
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '300px',
          padding: '24px',
          backgroundColor: 'var(--emr-bg-page)',
        }}
      >
        <Stack align="center" gap="md" style={{ maxWidth: '500px', width: '100%' }}>
          <Alert
            icon={iconMap[kind]}
            title={titleMap[kind]}
            color="red"
            variant="light"
            style={{ width: '100%' }}
          >
            <Stack gap="sm">
              <Text size="sm">{messageMap[kind]}</Text>

              {/* Show technical details in development */}
              {import.meta.env.DEV && error && (
                <Code
                  block
                  style={{
                    fontSize: 'var(--emr-font-xs)',
                    maxHeight: '80px',
                    overflow: 'auto',
                  }}
                >
                  {error.message}
                </Code>
              )}
            </Stack>
          </Alert>

          <Group gap="md">
            <Button
              leftSection={<IconRefresh size={16} />}
              variant="light"
              color="var(--emr-accent)"
              onClick={this.handleRetry}
              disabled={retriesExhausted}
              styles={{ label: { overflow: 'visible', height: 'auto' } }}
              data-testid="pacs-error-boundary-retry"
            >
              {retriesExhausted
                ? t('pacs.error.reloadPage')
                : t('common.tryAgain')}
            </Button>
          </Group>
        </Stack>
      </Box>
    );
  }
}

export default PACSErrorBoundary;
