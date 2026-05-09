// SPDX-License-Identifier: Apache-2.0
/**
 * Barrel file for LiverRa EMR common components (T090).
 *
 * Ported from MediMind — maintains drop-in API compatibility so existing
 * MediMind code paths can be migrated without import-path changes. New
 * LiverRa code should import from `'../components/common'` rather than
 * reaching into individual files.
 */

// ── Batch 1 (T082) ────────────────────────────────────────────────────────
export { EMRModal, EMRModalSection } from './EMRModal';
export type { EMRModalProps, EMRModalSectionProps, EMRModalSize } from './EMRModal';

export { EMRButton } from './EMRButton';
export type { } from './EMRButton';

export { EMRCard } from './EMRCard';
export { EMRCard as EMRContentCard } from './EMRCard';  // alias for upstream compat
export type { EMRCardAction, EMRCardProps } from './EMRCard';

// ── Batch 2 (T083) ────────────────────────────────────────────────────────
export { EMRConfirmationModal } from './EMRConfirmationModal';
export { EMRPageHeader } from './EMRPageHeader';
export { EMRErrorBoundary } from './EMRErrorBoundary';
export type { EMRErrorBoundaryProps } from './EMRErrorBoundary';

// ── Batch 3 (T084) ────────────────────────────────────────────────────────
export { EMREmptyState } from './EMREmptyState';
export type {
  EMREmptyStateProps,
  EMREmptyStateAction,
  EMREmptyStateLink,
  EMREmptyStateSize,
  EMREmptyStateVariant,
} from './EMREmptyState';

export {
  EMRSkeleton,
  EMRCardSkeleton,
  EMRTableRowSkeleton,
  EMRFormSkeleton,
  EMRListSkeleton,
  EMRStatCardSkeleton,
  EMRGridSkeleton,
} from './EMRSkeleton';
export type {
  EMRSkeletonBaseProps,
  EMRSkeletonProps,
  EMRCardSkeletonProps,
  EMRTableRowSkeletonProps,
  EMRFormSkeletonProps,
  EMRListSkeletonProps,
  EMRStatCardSkeletonProps,
  EMRGridSkeletonProps,
} from './EMRSkeleton';

export { EMRAlert } from './EMRAlert';
export type { EMRAlertProps, EMRAlertVariant } from './EMRAlert';

// ── Batch 4 (T085) ────────────────────────────────────────────────────────
// EMRTableSkeleton re-exports from EMRSkeleton (stub — see file comment).
export { EMRTableSkeleton } from './EMRTableSkeleton';
export type { EMRTableSkeletonProps } from './EMRTableSkeleton';

export { EMRTableEmptyState } from './EMRTableEmptyState';
export type { EMRTableEmptyStateProps } from './EMRTableEmptyState';

export { EMRToast } from './EMRToast';

// ── Batch 5 (T086) ────────────────────────────────────────────────────────
export { EMRProgressStepper } from './EMRProgressStepper';
export type { EMRProgressStepperProps } from './EMRProgressStepper';

export { EMRWizardStepper } from './EMRWizardStepper';

export { EMRDropzone } from './EMRDropzone';

// ── Batch 6 (T087) ────────────────────────────────────────────────────────
export { EMRBreadcrumbs } from './EMRBreadcrumbs';
export type { BreadcrumbItem, EMRBreadcrumbsProps } from './EMRBreadcrumbs';

export { EMRFAB } from './EMRFAB';
export type { EMRFABProps, EMRFABAction, EMRFABSize, EMRFABColor } from './EMRFAB';

export { EMRNotificationCenter } from './EMRNotificationCenter';
export type {
  EMRNotification,
  EMRNotificationCenterProps,
  NotificationType,
  NotificationPriority,
} from './EMRNotificationCenter';

// ── Batch 7 (T088) ────────────────────────────────────────────────────────
export { SessionTimeoutModal } from './SessionTimeoutModal';
export type { SessionTimeoutModalProps } from './SessionTimeoutModal';

// FailClosedErrorStates: LiverRa will replace MediMind-specific exports
// (Cashier/Pharmacy/Warehouse/etc.) with liver-imaging fail-closed states
// in a later task; ported verbatim for now so type-check passes.
export {
  CashierFailClosedError,
  RoleAssignmentFailClosedError,
  PharmacyDDIFailClosedError,
  ShiftOverlapFailClosedError,
  WarehouseFailClosedError,
  EmergencyAccessFailClosedError,
} from './FailClosedErrorStates';

export { FormLoadingSkeleton, FormBuilderLoadingSkeleton } from './FormLoadingSkeleton';
export type { FormLoadingSkeletonProps } from './FormLoadingSkeleton';

// ── Batch 8 (T089) ────────────────────────────────────────────────────────
export { FormErrorBoundary, TranslatedFormErrorBoundary } from './FormErrorBoundary';
export type { FormErrorBoundaryProps } from './FormErrorBoundary';

export { EMRBottomSheet } from './EMRBottomSheet';
export type {
  EMRBottomSheetProps,
  EMRBottomSheetAction,
  EMRBottomSheetSnapPoint,
} from './EMRBottomSheet';

export { MobileFormWrapper } from './MobileFormWrapper';
export type { MobileFormWrapperProps, MobileFormWrapperGap } from './MobileFormWrapper';

// ── Batch 9 — case-analysis upgrade primitives ────────────────────────────
export { EMRBadge } from './EMRBadge';
export type { EMRBadgeProps, EMRBadgeVariant, EMRBadgeSize } from './EMRBadge';

export { EMRTabs, emrTabPanelProps } from './EMRTabs';
export type { EMRTabsProps, EMRTabItem } from './EMRTabs';

export { EMRIconButton } from './EMRIconButton';
export type { EMRIconButtonProps } from './EMRIconButton';
