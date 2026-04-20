// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import { EMRErrorCard } from './EMRErrorCard';

/**
 * Fail-closed error states for critical EMR operations.
 *
 * "Fail closed" means the system blocks the operation when something goes wrong,
 * rather than allowing it through unchecked. Think of it like a hospital door that
 * locks when the fire alarm malfunctions — safer to block access than leave it open.
 *
 * Each component wraps EMRErrorCard with domain-specific messaging, suggestions,
 * and actions appropriate for that failure scenario.
 */

// ---------------------------------------------------------------------------
// 1. CashierFailClosedError
// ---------------------------------------------------------------------------

export interface CashierFailClosedErrorProps {
  /** Callback to retry the payment processing connection */
  onRetry: () => void;
}

/**
 * Shown when the payment/billing subsystem is unreachable.
 * Provides a retry button so the cashier can attempt reconnection.
 */
export function CashierFailClosedError({ onRetry }: CashierFailClosedErrorProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <EMRErrorCard
      title={t('failClosed.cashier.title')}
      message={t('failClosed.cashier.message')}
      suggestions={[
        t('failClosed.cashier.suggestion1'),
        t('failClosed.cashier.suggestion2'),
        t('failClosed.cashier.suggestion3'),
      ]}
      onRetry={onRetry}
      retryLabel={t('failClosed.cashier.retryLabel')}
      alternativeMessage={t('failClosed.cashier.alternative')}
      data-testid="cashier-fail-closed-error"
    />
  );
}

// ---------------------------------------------------------------------------
// 2. RoleAssignmentFailClosedError
// ---------------------------------------------------------------------------

/**
 * Shown when the role/permission service is unavailable.
 * No retry — role changes are admin-only and require the service to recover.
 */
export function RoleAssignmentFailClosedError(): React.ReactElement {
  const { t } = useTranslation();

  return (
    <EMRErrorCard
      title={t('failClosed.roleAssignment.title')}
      message={t('failClosed.roleAssignment.message')}
      suggestions={[
        t('failClosed.roleAssignment.suggestion1'),
        t('failClosed.roleAssignment.suggestion2'),
        t('failClosed.roleAssignment.suggestion3'),
      ]}
      alternativeMessage={t('failClosed.roleAssignment.alternative')}
      data-testid="role-assignment-fail-closed-error"
    />
  );
}

// ---------------------------------------------------------------------------
// 3. PharmacyDDIFailClosedError
// ---------------------------------------------------------------------------

export interface PharmacyDDIFailClosedErrorProps {
  /** Callback to retry the drug-drug interaction check */
  onRetry: () => void;
  /** Callback for pharmacist override (requires credentials) */
  onPharmacistOverride: () => void;
}

/**
 * Shown when the drug-drug interaction (DDI) checker is unavailable.
 * Blocks dispensing by default but allows a pharmacist to override
 * after manual verification — similar to a physical sign-off.
 */
export function PharmacyDDIFailClosedError({
  onRetry,
  onPharmacistOverride,
}: PharmacyDDIFailClosedErrorProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <EMRErrorCard
      title={t('failClosed.pharmacyDDI.title')}
      message={t('failClosed.pharmacyDDI.message')}
      suggestions={[
        t('failClosed.pharmacyDDI.suggestion1'),
        t('failClosed.pharmacyDDI.suggestion2'),
        t('failClosed.pharmacyDDI.suggestion3'),
      ]}
      onRetry={onRetry}
      retryLabel={t('failClosed.pharmacyDDI.retryLabel')}
      onSecondary={onPharmacistOverride}
      secondaryLabel={t('failClosed.pharmacyDDI.overrideLabel')}
      alternativeMessage={t('failClosed.pharmacyDDI.alternative')}
      data-testid="pharmacy-ddi-fail-closed-error"
    />
  );
}

// ---------------------------------------------------------------------------
// 4. ShiftOverlapFailClosedError
// ---------------------------------------------------------------------------

export interface ShiftOverlapFailClosedErrorProps {
  /** Callback for manual verification of shift assignments */
  onVerifyManually: () => void;
}

/**
 * Shown when the shift scheduling validator is unavailable.
 * Blocks automatic assignment but offers a manual verification path.
 */
export function ShiftOverlapFailClosedError({
  onVerifyManually,
}: ShiftOverlapFailClosedErrorProps): React.ReactElement {
  const { t } = useTranslation();

  return (
    <EMRErrorCard
      title={t('failClosed.shiftOverlap.title')}
      message={t('failClosed.shiftOverlap.message')}
      suggestions={[
        t('failClosed.shiftOverlap.suggestion1'),
        t('failClosed.shiftOverlap.suggestion2'),
        t('failClosed.shiftOverlap.suggestion3'),
      ]}
      onRetry={onVerifyManually}
      retryLabel={t('failClosed.shiftOverlap.verifyLabel')}
      alternativeMessage={t('failClosed.shiftOverlap.alternative')}
      data-testid="shift-overlap-fail-closed-error"
    />
  );
}

// ---------------------------------------------------------------------------
// 5. WarehouseFailClosedError
// ---------------------------------------------------------------------------

/**
 * Shown when the warehouse/inventory service is unreachable.
 * No self-service retry — directs staff to contact their supervisor.
 */
export function WarehouseFailClosedError(): React.ReactElement {
  const { t } = useTranslation();

  return (
    <EMRErrorCard
      title={t('failClosed.warehouse.title')}
      message={t('failClosed.warehouse.message')}
      suggestions={[
        t('failClosed.warehouse.suggestion1'),
        t('failClosed.warehouse.suggestion2'),
        t('failClosed.warehouse.suggestion3'),
      ]}
      alternativeMessage={t('failClosed.warehouse.alternative')}
      data-testid="warehouse-fail-closed-error"
    />
  );
}

// ---------------------------------------------------------------------------
// 6. EmergencyAccessFailClosedError
// ---------------------------------------------------------------------------

/** Auto-retry interval in milliseconds */
const AUTO_RETRY_INTERVAL_MS = 5000;
/** Maximum number of automatic retries before giving up */
const MAX_AUTO_RETRIES = 6;

export interface EmergencyAccessFailClosedErrorProps {
  /** Callback invoked on each auto-retry attempt and manual retry */
  onRetry: () => void;
  /** Callback for break-glass emergency access */
  onBreakGlass: () => void;
}

/**
 * Shown when emergency access verification is unavailable.
 * Automatically retries on a 5-second interval (up to 6 times) because
 * emergency situations cannot wait for manual intervention. Also provides
 * a "break glass" link for immediate override when time is critical.
 */
export function EmergencyAccessFailClosedError({
  onRetry,
  onBreakGlass,
}: EmergencyAccessFailClosedErrorProps): React.ReactElement {
  const { t } = useTranslation();
  const [retryCount, setRetryCount] = useState(0);
  const [autoRetrying, setAutoRetrying] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleAutoRetry = useCallback(() => {
    setRetryCount((prev) => {
      const next = prev + 1;
      if (next >= MAX_AUTO_RETRIES) {
        setAutoRetrying(false);
      }
      return next;
    });
    onRetry();
  }, [onRetry]);

  // Start auto-retry timer on mount
  useEffect(() => {
    if (!autoRetrying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(handleAutoRetry, AUTO_RETRY_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRetrying, handleAutoRetry]);

  const handleManualRetry = useCallback(() => {
    setRetryCount((prev) => prev + 1);
    setAutoRetrying(true);
    onRetry();
  }, [onRetry]);

  const retryMessage = autoRetrying
    ? t('failClosed.emergencyAccess.autoRetrying', { count: String(retryCount), max: String(MAX_AUTO_RETRIES) })
    : t('failClosed.emergencyAccess.autoRetryExhausted');

  return (
    <EMRErrorCard
      title={t('failClosed.emergencyAccess.title')}
      message={t('failClosed.emergencyAccess.message')}
      suggestions={[
        t('failClosed.emergencyAccess.suggestion1'),
        t('failClosed.emergencyAccess.suggestion2'),
        t('failClosed.emergencyAccess.suggestion3'),
      ]}
      onRetry={handleManualRetry}
      retryLabel={t('failClosed.emergencyAccess.retryLabel')}
      onSecondary={onBreakGlass}
      secondaryLabel={t('failClosed.emergencyAccess.breakGlassLabel')}
      alternativeMessage={retryMessage}
      data-testid="emergency-access-fail-closed-error"
    />
  );
}
