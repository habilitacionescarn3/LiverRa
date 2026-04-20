// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { Modal, Box, Group, Text, LoadingOverlay } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconX, IconDeviceFloppy } from '@tabler/icons-react';
import type { ReactNode, ComponentType, CSSProperties } from 'react';
import { useId, useMemo } from 'react';
import { EMRButton } from './EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';

/** T-shirt size options for modal width */
export type EMRModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

const sizePixelMap: Record<EMRModalSize, number | string> = {
  sm: 580,
  md: 780,
  lg: 980,
  xl: 1200,
  xxl: '95vw',  // Full-width for complex forms
};

const iconSizeMap: Record<EMRModalSize, number> = {
  sm: 20,
  md: 22,
  lg: 24,
  xl: 26,
  xxl: 28,
};

const iconContainerSizeMap: Record<EMRModalSize, number> = {
  sm: 42,
  md: 46,
  lg: 50,
  xl: 54,
  xxl: 58,
};

const minBodyHeightMap: Record<EMRModalSize, number | string> = {
  sm: 200,
  md: 280,
  lg: 360,
  xl: 440,
  xxl: 'calc(92vh - 140px)',  // Takes most of the viewport height - increased for patient detail
};

export interface EMRModalProps {
  opened: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: EMRModalSize;
  icon?: ComponentType<{ size?: number | string; color?: string }>;
  subtitle?: string | ReactNode;
  footer?: ReactNode;
  showFooter?: boolean;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit?: () => void;
  submitLoading?: boolean;
  submitDisabled?: boolean;
  submitIcon?: ComponentType<{ size?: number | string }>;
  closeOnClickOutside?: boolean;
  closeOnEscape?: boolean;
  withCloseButton?: boolean;
  zIndex?: number;
  testId?: string;
  /** Force fullscreen mode (default: only fullscreen on mobile) */
  fullScreen?: boolean;
  /** Submit button color override */
  submitColor?: string;
  /** Disable focus trap (needed for modals with contenteditable/rich text editors) */
  trapFocus?: boolean;
  /** When set alongside submitLoading, shows a blurred overlay with this message over the body */
  processingMessage?: string;
  /** Optional id for the modal title element; used to link aria-labelledby on the dialog */
  titleId?: string;
}

/**
 * EMRModal - Premium Medical Interface Modal
 *
 * Refined, professional aesthetic for healthcare applications.
 * Features elegant gradients, subtle depth, and polished interactions.
 * @param root0
 * @param root0.opened
 * @param root0.onClose
 * @param root0.title
 * @param root0.children
 * @param root0.size
 * @param root0.icon
 * @param root0.subtitle
 * @param root0.footer
 * @param root0.showFooter
 * @param root0.submitLabel
 * @param root0.cancelLabel
 * @param root0.onSubmit
 * @param root0.submitLoading
 * @param root0.submitDisabled
 * @param root0.submitIcon
 * @param root0.closeOnClickOutside
 * @param root0.closeOnEscape
 * @param root0.withCloseButton
 * @param root0.zIndex
 * @param root0.testId
 */
export function EMRModal({
  opened,
  onClose,
  title,
  children,
  size = 'md',
  icon: Icon,
  subtitle,
  footer,
  showFooter,
  submitLabel,
  cancelLabel,
  onSubmit,
  submitLoading = false,
  submitDisabled = false,
  submitIcon: SubmitIcon = IconDeviceFloppy,
  closeOnClickOutside = true,
  closeOnEscape = true,
  withCloseButton = true,
  zIndex = 1100,
  testId,
  fullScreen: forceFullScreen,
  trapFocus = true,
  processingMessage,
  titleId,
}: EMRModalProps): React.ReactElement {
  const { t } = useTranslation();
  // Stable fallback id so aria-labelledby always resolves to the visible title
  const generatedTitleId = useId();
  const resolvedTitleId = titleId ?? `emr-modal-title-${generatedTitleId}`;
  // Mobile detection for full-screen mode
  const isMobile = useMediaQuery('(max-width: 768px)');
  // Combine mobile and forced fullscreen for style calculations
  const isFullScreen = forceFullScreen || isMobile;

  const sizePixels = isFullScreen ? '100%' : sizePixelMap[size];
  const iconSize = iconSizeMap[size];
  const iconContainerSize = isMobile ? 40 : iconContainerSizeMap[size];
  const minBodyHeight = minBodyHeightMap[size];
  const shouldShowFooter = showFooter ?? (footer !== undefined || onSubmit !== undefined);
  const isProcessing = submitLoading && !!processingMessage;

  // Memoized style objects to prevent recreation on every render
  const mobileContentStyles = useMemo<CSSProperties>(() =>
    isFullScreen
      ? {
          overflow: 'hidden',
          boxShadow: 'none',
          maxHeight: '100vh',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
        }
      : {
          overflow: 'hidden',
          boxShadow: 'var(--emr-modal-shadow)',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
        },
    [isFullScreen]
  );

  const modalBodyStyles = useMemo<CSSProperties>(() => ({
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  }), []);

  const headerStyles = useMemo<CSSProperties>(() => ({
    padding: isFullScreen ? '16px 16px' : '20px 24px',
    background: 'var(--emr-gradient-primary)',
    position: isFullScreen ? 'sticky' : 'relative',
    top: 0,
    borderLeft: isFullScreen ? 'none' : '4px solid var(--emr-section-personal)',
    boxShadow: 'inset 0 -1px 0 var(--emr-white-alpha-10), 0 2px 8px var(--emr-black-alpha-15)',
    flexShrink: 0,
    zIndex: 10,
    paddingTop: isMobile ? 'max(16px, env(safe-area-inset-top))' : '20px',
  }), [isFullScreen, isMobile]);

  const noiseTextureStyles = useMemo<CSSProperties>(() => ({
    position: 'absolute',
    inset: 0,
    opacity: 0.03,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
    pointerEvents: 'none',
  }), []);

  const highlightLineStyles = useMemo<CSSProperties>(() => ({
    position: 'absolute',
    top: 0,
    left: 24,
    right: 24,
    height: 1,
    background: 'var(--emr-gradient-highlight)',
    pointerEvents: 'none',
  }), []);

  const iconContainerStyles = useMemo<CSSProperties>(() => ({
    width: iconContainerSize,
    height: iconContainerSize,
    minWidth: iconContainerSize,
    borderRadius: 10,
    background: 'var(--emr-glass-bg)',
    backdropFilter: 'blur(8px)',
    border: '1px solid var(--emr-glass-border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'var(--emr-shadow-glass)',
  }), [iconContainerSize]);

  const titleStyles = useMemo<CSSProperties>(() => ({
    letterSpacing: '-0.01em',
    lineHeight: 'var(--emr-line-height-snug)',
  }), []);

  const closeButtonStyles = useMemo<CSSProperties>(() => ({
    width: isMobile ? 44 : 36,
    height: isMobile ? 44 : 36,
    minWidth: isMobile ? 44 : 36,
    minHeight: isMobile ? 44 : 36,
    borderRadius: isMobile ? 12 : 8,
    border: 'none',
    background: 'var(--emr-button-close-bg)',
    color: 'var(--emr-button-close-color)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  }), [isMobile]);

  const bodyStyles = useMemo<CSSProperties>(() => ({
    padding: isFullScreen ? '16px' : '24px',
    background: 'var(--emr-bg-card)',
    minHeight: isFullScreen ? 0 : (typeof minBodyHeight === 'number' ? minBodyHeight : 200),
    flex: 1,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : '24px',
    position: 'relative',
  }), [isFullScreen, isMobile, minBodyHeight]);

  const footerStyles = useMemo<CSSProperties>(() => ({
    padding: isFullScreen ? '16px' : '16px 24px',
    paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : '16px',
    background: 'var(--emr-bg-page)',
    borderTop: '1px solid var(--emr-border-default)',
    flexShrink: 0,
    position: isFullScreen ? 'sticky' : 'relative',
    bottom: 0,
    zIndex: 10,
  }), [isFullScreen, isMobile]);

  const mobileButtonStyles = useMemo<CSSProperties | undefined>(
    () => isFullScreen ? { minHeight: 48 } : undefined,
    [isFullScreen]
  );

  // Static style objects (no dependencies, never change)
  const headerGroupStyles = useMemo<CSSProperties>(() => ({
    position: 'relative',
  }), []);

  const headerInnerGroupStyles = useMemo<CSSProperties>(() => ({
    flex: 1,
    minWidth: 0,
  }), []);

  const titleContainerStyles = useMemo<CSSProperties>(() => ({
    minWidth: 0,
    flex: 1,
  }), []);

  const subtitleStyles = useMemo<CSSProperties>(() => ({
    letterSpacing: '0.01em',
  }), []);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size={sizePixels}
      centered={!isMobile && !forceFullScreen}
      fullScreen={forceFullScreen || isMobile}
      closeOnClickOutside={isProcessing ? false : closeOnClickOutside}
      closeOnEscape={isProcessing ? false : closeOnEscape}
      trapFocus={trapFocus}
      withCloseButton={false}
      padding={0}
      zIndex={zIndex}
      radius={isFullScreen ? 0 : 12}
      overlayProps={{
        backgroundOpacity: isFullScreen ? 0 : 0.35,
        blur: isFullScreen ? 0 : 12,
      }}
      transitionProps={{
        transition: isFullScreen ? 'slide-up' : 'fade',
        duration: 180,
      }}
      styles={{
        content: mobileContentStyles,
        body: modalBodyStyles,
      }}
      aria-labelledby={resolvedTitleId}
      data-testid={testId}
    >
      {/* ═══════════════════════════════════════════════════════════════
          HEADER - Refined gradient with subtle depth (sticky on mobile)
          ═══════════════════════════════════════════════════════════════ */}
      <Box style={headerStyles}>
        {/* Subtle noise texture overlay */}
        <Box style={noiseTextureStyles} />

        {/* Soft highlight line at top */}
        <Box style={highlightLineStyles} />

        <Group justify="space-between" align="center" wrap="nowrap" style={headerGroupStyles}>
          <Group gap="md" wrap="nowrap" style={headerInnerGroupStyles}>
            {/* Icon - frosted glass effect */}
            {Icon && (
              <Box style={iconContainerStyles}>
                <Icon size={iconSize} color="var(--emr-modal-icon-color)" />
              </Box>
            )}

            {/* Title & Subtitle */}
            <Box style={titleContainerStyles}>
              <Text
                id={resolvedTitleId}
                fw={500}
                size="md"
                c="var(--emr-modal-title-color)"
                style={titleStyles}
                truncate
                role="heading"
                aria-level={2}
              >
                {title}
              </Text>
              {subtitle && (
                typeof subtitle === 'string' ? (
                  <Text
                    size="xs"
                    c="var(--emr-text-inverse-secondary)"
                    mt={2}
                    truncate
                    style={subtitleStyles}
                  >
                    {subtitle}
                  </Text>
                ) : (
                  <Box mt={2}>{subtitle}</Box>
                )
              )}
            </Box>
          </Group>

          {/* Close button - touch-friendly (44px on mobile) */}
          {withCloseButton && (
            <Box
              component="button"
              type="button"
              onClick={onClose}
              style={closeButtonStyles}
              aria-label={t('common.close', 'Close')}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--emr-button-close-hover-bg)';
                e.currentTarget.style.color = 'var(--emr-button-close-hover-color)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--emr-button-close-bg)';
                e.currentTarget.style.color = 'var(--emr-button-close-color)';
              }}
            >
              <IconX size={16} strokeWidth={1.5} aria-hidden="true" />
            </Box>
          )}
        </Group>
      </Box>

      {/* ═══════════════════════════════════════════════════════════════
          BODY - Clean with subtle warmth (scrollable on mobile)
          ═══════════════════════════════════════════════════════════════ */}
      <Box style={bodyStyles}>
        {isProcessing && (
          <>
            <LoadingOverlay
              visible
              zIndex={100}
              overlayProps={{ radius: 'sm', blur: 2 }}
              loaderProps={{ type: 'bars', size: 'md' }}
            />
            <Box
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, calc(-50% + 40px))',
                zIndex: 101,
                textAlign: 'center',
              }}
            >
              <Text size="sm" c="var(--emr-text-secondary)">{processingMessage}</Text>
            </Box>
          </>
        )}
        {children}
      </Box>

      {/* ═══════════════════════════════════════════════════════════════
          FOOTER - Sticky on mobile with safe area padding
          ═══════════════════════════════════════════════════════════════ */}
      {shouldShowFooter && (
        <Box style={footerStyles}>
          {footer ?? (
            <Group justify={isFullScreen ? 'stretch' : 'flex-end'} gap="sm" grow={isFullScreen}>
              <EMRButton
                variant="secondary"
                size={isFullScreen ? 'md' : 'sm'}
                onClick={onClose}
                disabled={submitLoading}
                style={mobileButtonStyles}
              >
                {cancelLabel || t('common.cancel')}
              </EMRButton>
              {onSubmit && (
                <EMRButton
                  variant="primary"
                  size={isFullScreen ? 'md' : 'sm'}
                  onClick={onSubmit}
                  loading={submitLoading}
                  disabled={submitDisabled}
                  icon={submitLoading ? undefined : SubmitIcon}
                  style={mobileButtonStyles}
                >
                  {submitLabel || t('common.save')}
                </EMRButton>
              )}
            </Group>
          )}
        </Box>
      )}
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMRModalSection - Elegant form grouping with subtle visual hierarchy
   ═══════════════════════════════════════════════════════════════════════════ */

export interface EMRModalSectionProps {
  title: ReactNode;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'accent' | 'muted';
  icon?: ComponentType<{ size: number; color?: string }>;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export function EMRModalSection({
  title,
  children,
  variant = 'primary',
  icon: SectionIcon,
}: EMRModalSectionProps): React.ReactElement {
  const variantMap: Record<string, { accent: string; bg: string; border: string }> = {
    primary: {
      accent: 'var(--emr-primary)',
      bg: 'var(--emr-gradient-subtle-primary)',
      border: 'var(--emr-border-default)',
    },
    secondary: {
      accent: 'var(--emr-secondary)',
      bg: 'var(--emr-gradient-subtle-secondary)',
      border: 'var(--emr-border-default)',
    },
    accent: {
      accent: 'var(--emr-accent)',
      bg: 'var(--emr-gradient-subtle-accent)',
      border: 'var(--emr-border-default)',
    },
    muted: {
      accent: 'var(--emr-text-secondary)',
      bg: 'var(--emr-bg-page)',
      border: 'var(--emr-border-default)',
    },
  };
  const styles = variantMap[variant] || variantMap.primary;

  return (
    <Box
      style={{
        background: styles.bg,
        borderRadius: 10,
        padding: '18px 20px',
        border: `1px solid ${styles.border}`,
        marginBottom: 16,
      }}
    >
      {/* Section header */}
      <Group gap={10} mb={16}>
        {/* Accent line */}
        <Box
          style={{
            width: 3,
            height: 16,
            borderRadius: 2,
            background: styles.accent,
          }}
        />

        {/* Optional icon */}
        {SectionIcon && (
          <Box
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: styles.accent,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SectionIcon size={12} color="var(--emr-bg-card)" />
          </Box>
        )}

        <Text
          size="xs"
          fw={600}
          c="var(--emr-text-primary)"
          style={{
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {title}
        </Text>
      </Group>

      {children}
    </Box>
  );
}
