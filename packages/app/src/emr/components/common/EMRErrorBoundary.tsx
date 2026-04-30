// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { Alert, Anchor, Button, Stack, Text, Code, Box, Group } from '@mantine/core';
import { IconAlertCircle, IconRefresh, IconExternalLink } from '@tabler/icons-react';
import DOMPurify from 'dompurify';

/**
 * Props for EMRErrorBoundary
 */
export interface EMRErrorBoundaryProps {
  /** Child components to render */
  children: ReactNode;
  /** Optional custom fallback UI to show on error */
  fallback?: ReactNode;
  /** Optional callback when error occurs */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Optional callback when reset button is clicked */
  onReset?: () => void;
  /** Optional component/view name for error logging context */
  componentName?: string;
  /** Custom error title - defaults to 'Something went wrong'. Pass t('common.somethingWentWrong') for i18n */
  errorTitle?: string;
  /** Custom error message - defaults to generic error text. Pass translated string for i18n */
  errorMessage?: string;
  /** Custom retry button label - defaults to 'Try Again'. Pass t('common.tryAgain') for i18n */
  retryLabel?: string;
  /** Custom "reload page" label when retries are exhausted */
  reloadPageLabel?: string;
  /** Optional URL for reporting issues */
  reportIssueUrl?: string;
  /** Optional label for report issue link */
  reportIssueLabel?: string;
  /**
   * Keys that, when changed, automatically reset the error state.
   * Prevents infinite retry loops by only resetting when something
   * actually changes (e.g., route, selected patient, form data).
   * Example: resetKeys={[patientId, encounterId]}
   */
  resetKeys?: Array<string | number | boolean | null | undefined>;
  /** Maximum number of consecutive retries before disabling the retry button (default: 3) */
  maxRetries?: number;
}

/**
 * State for EMRErrorBoundary
 */
interface EMRErrorBoundaryState {
  /** Whether an error has been caught */
  hasError: boolean;
  /** The caught error object */
  error: Error | null;
  /** React error info with component stack */
  errorInfo: ErrorInfo | null;
  /** Number of consecutive retries (resets when resetKeys change) */
  retryCount: number;
}

/**
 * EMRErrorBoundary Component
 *
 * A generic error boundary for EMR views and complex components.
 * Catches JavaScript errors in the child component tree, logs them,
 * and displays a user-friendly fallback UI with retry functionality.
 *
 * Features:
 * - Graceful error handling for component rendering errors
 * - Retry functionality to attempt re-rendering
 * - Error reporting callback for logging
 * - Accessible error messages with ARIA attributes
 * - Mobile-responsive design
 * - Shows error details in development mode only
 *
 * @example
 * ```tsx
 * <EMRErrorBoundary componentName="NomenclatureView">
 *   <NomenclatureMedical1View />
 * </EMRErrorBoundary>
 * ```
 *
 * @example
 * ```tsx
 * // With custom error handling
 * <EMRErrorBoundary
 *   componentName="FormBuilder"
 *   onError={(error) => logToService(error)}
 *   errorTitle="Form Builder Error"
 *   errorMessage="Unable to load the form builder. Please try again."
 * >
 *   <FormBuilderView />
 * </EMRErrorBoundary>
 * ```
 */
export class EMRErrorBoundary extends Component<EMRErrorBoundaryProps, EMRErrorBoundaryState> {
  constructor(props: EMRErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: 0,
    };
  }

  /**
   * Update state when error is caught
   * Called during the "render" phase, so side-effects are not allowed.
   */
  static getDerivedStateFromError(error: Error): Partial<EMRErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  /**
   * Log error information
   * Called during the "commit" phase, so side-effects are allowed.
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { onError, componentName } = this.props;

    // Update state with error info
    this.setState({ errorInfo });

    // Call optional error callback
    if (onError) {
      onError(error, errorInfo);
    }

    // Log to console with context. Sanitize error messages + component stacks
    // before they hit the console — error strings can originate from API
    // responses that echo back untrusted HTML/JS. If a developer later pastes
    // console output into a rich-rendering context (wiki, doc tool), raw
    // script tags could fire. DOMPurify neutralises that.
    const safeMessage = DOMPurify.sanitize(String(error?.message ?? ''));
    const safeStack = DOMPurify.sanitize(String(errorInfo?.componentStack ?? ''));
    console.error(
      `[EMRErrorBoundary${componentName ? ` - ${componentName}` : ''}]:`,
      safeMessage,
      safeStack
    );
  }

  /**
   * Auto-reset error state when resetKeys change.
   * This prevents infinite retry loops: the error only clears when
   * the parent passes new data (e.g., different patientId, new route).
   */
  componentDidUpdate(prevProps: EMRErrorBoundaryProps): void {
    if (this.state.hasError && this.props.resetKeys) {
      const prevKeys = prevProps.resetKeys || [];
      const currKeys = this.props.resetKeys;
      const keysChanged =
        prevKeys.length !== currKeys.length ||
        currKeys.some((key, i) => key !== prevKeys[i]);

      if (keysChanged) {
        this.setState({
          hasError: false,
          error: null,
          errorInfo: null,
          retryCount: 0,
        });
      }
    }
  }

  /**
   * Reset error state to retry rendering.
   * Tracks retry count to prevent infinite loops — disables after maxRetries.
   */
  handleRetry = (): void => {
    const { onReset } = this.props;

    this.setState((prev) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      retryCount: prev.retryCount + 1,
    }));

    // Call optional reset callback
    if (onReset) {
      onReset();
    }
  };

  render(): ReactNode {
    const { children, fallback, componentName, errorTitle, errorMessage, maxRetries = 3, reloadPageLabel } = this.props;
    const { hasError, error, errorInfo, retryCount } = this.state;
    const retriesExhausted = retryCount >= maxRetries;

    if (hasError) {
      // Custom fallback provided
      if (fallback) {
        return fallback;
      }

      // Default error UI
      return (
        <Box
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          p="xl"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}
        >
          <Stack align="center" gap="md" style={{ maxWidth: '500px' }}>
            <Alert
              icon={<IconAlertCircle size={24} />}
              title={errorTitle || 'Something went wrong'}
              color="red"
              variant="light"
              style={{ width: '100%' }}
            >
              <Stack gap="md">
                <Text size="sm">
                  {errorMessage ||
                    (componentName
                      ? `An error occurred in the ${componentName} component. Please try again or contact support if the problem persists.`
                      : 'An unexpected error occurred. Please try again or contact support if the problem persists.')}
                </Text>

                {/* Show error details in development mode */}
                {process.env.NODE_ENV === 'development' && error && (
                  <Box>
                    <Text size="xs" c="dimmed" mb="xs">
                      Error Details:
                    </Text>
                    <Code block style={{ fontSize: 'var(--emr-font-xs)', maxHeight: '120px', overflow: 'auto' }}>
                      {error.message}
                    </Code>
                  </Box>
                )}

                {/* Show component stack in development mode */}
                {process.env.NODE_ENV === 'development' && errorInfo?.componentStack && (
                  <Box>
                    <Text size="xs" c="dimmed" mb="xs">
                      Component Stack:
                    </Text>
                    <Code block style={{ fontSize: 'calc(var(--emr-font-xs) - 1px)', maxHeight: '100px', overflow: 'auto' }}>
                      {errorInfo.componentStack}
                    </Code>
                  </Box>
                )}
              </Stack>
            </Alert>

            <Group gap="md" wrap="wrap" justify="center">
              <Button
                leftSection={<IconRefresh size={16} />}
                onClick={this.handleRetry}
                variant="light"
                color="blue"
                disabled={retriesExhausted}
                data-testid="emr-error-boundary-retry"
              >
                {retriesExhausted
                  ? (reloadPageLabel || 'Please reload the page')
                  : (this.props.retryLabel || 'Try Again')}
              </Button>

              {this.props.reportIssueUrl && (
                <Anchor
                  href={this.props.reportIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="emr-error-boundary-report"
                >
                  <Button
                    leftSection={<IconExternalLink size={16} />}
                    variant="subtle"
                    color="gray"
                    component="span"
                  >
                    {this.props.reportIssueLabel || 'Report Issue'}
                  </Button>
                </Anchor>
              )}
            </Group>
          </Stack>
        </Box>
      );
    }

    return children;
  }
}

export default EMRErrorBoundary;
