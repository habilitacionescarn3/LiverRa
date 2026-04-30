// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// CloudOfflineBanner Component
// ============================================================================
// A small, non-intrusive banner that appears at the top of the PACS viewer
// when the backend (FHIR + Orthanc) is unreachable. Think of it like the
// "No Internet" notification on your phone — it warns you but doesn't block
// you from using what still works (viewing images from the local PACS server).
//
// It tells the user:
// 1. Backend is offline
// 2. Which features are disabled (annotations, reports)
// 3. That it will auto-reconnect
// ============================================================================

import { IconCloudOff, IconRefresh } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import './CloudOfflineBanner.css';

// ============================================================================
// Types
// ============================================================================

// TODO(phase-4): Import CloudStatus from a real LiverRa useCloudConnectivity
// hook once we wire Supabase + Orthanc health probes. For now the type is
// defined inline so this leaf component can ship without pulling in the
// still-to-be-ported hook (which depends on @medplum/react-hooks upstream).
export type CloudStatus = 'online' | 'offline' | 'checking';

export interface CloudOfflineBannerProps {
  /** Current cloud connectivity status */
  status: CloudStatus;
  /** Trigger a manual reconnect attempt */
  onRetry?: () => void;
}

// ============================================================================
// Stub connectivity probe (replaced in Phase 4)
// ============================================================================

/**
 * TODO(phase-4): Wire this to a real probe that checks Supabase FHIR shim +
 * Orthanc health endpoints. Until then the stub always reports reachable,
 * which means the banner will stay hidden unless a caller explicitly passes
 * `status="offline"` (e.g., for Storybook or tests). This matches the Phase
 * 1 plan in `/Users/toko/.claude/plans/i-have-fully-nifty-corbato.md` that
 * defers real health checks (`useCloudConnectivity`) to Phase 4.
 */
export async function isBackendReachable(): Promise<boolean> {
  // TODO(phase-4): Replace with real Supabase + Orthanc reachability check.
  return true;
}

// ============================================================================
// Component
// ============================================================================

export function CloudOfflineBanner({ status, onRetry }: CloudOfflineBannerProps): JSX.Element | null {
  const { t } = useTranslation();

  // Only show when offline
  if (status !== 'offline') {
    return null;
  }

  return (
    <div
      className="pacs-cloud-offline-banner"
      role="alert"
      aria-live="polite"
    >
      <div className="pacs-cloud-offline-content">
        <IconCloudOff size={16} />
        <span className="pacs-cloud-offline-text">
          {t('pacs.cloudOffline')}
          {' — '}
          {t('pacs.cloudOfflineDetail')}
        </span>
      </div>

      {onRetry && (
        <button
          className="pacs-cloud-offline-retry"
          onClick={onRetry}
          aria-label={t('pacs.retryConnection')}
        >
          <IconRefresh size={14} />
          {t('pacs.retry')}
        </button>
      )}
    </div>
  );
}
