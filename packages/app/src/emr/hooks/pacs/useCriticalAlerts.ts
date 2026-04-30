// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCriticalAlerts — Hook for managing critical radiology finding alerts
// ============================================================================
// Provides React-friendly state management for critical alerts.
// Polls for active alerts every 60 seconds, manages escalation timers
// (30-minute countdown per alert), and exposes create/acknowledge actions.
//
// Think of this like a nurse's station alarm board — alerts pop up when
// radiologists flag urgent findings, and if nobody acknowledges within
// 30 minutes, the alert escalates (flashes red, re-notifies).
//
// Phase-4 status (LiverRa):
//   Reads/writes go through `useLiverraFhir()` → `LiverRaFhirClient` (stub).
//   MediMind's event-engine subscription (`useEventSubscription` +
//   `usePollingFallback`) is collapsed to a plain interval poll for now;
//   Phase 4 may re-introduce push-based updates when the Supabase
//   realtime channel is wired.
//
// Ported from MediMind (hooks/pacs/useCriticalAlerts.ts) with:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - Event engine + polling-fallback pair collapsed to `setInterval` poll.
// ============================================================================

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import {
  createCriticalAlert,
  acknowledgeCriticalAlert,
  getActiveAlerts,
  isEscalationDue,
  type CreateCriticalAlertParams,
  type CriticalAlert,
} from '../../services/pacs/criticalAlertService';

// ============================================================================
// Constants
// ============================================================================

/** Poll for active alerts every 60 seconds */
const POLL_INTERVAL_MS = 60_000;

/** Escalation threshold: 30 minutes without acknowledgment */
const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000;

/** Check escalation timers every 60 seconds */
const ESCALATION_CHECK_INTERVAL_MS = 60_000;

// ============================================================================
// Types
// ============================================================================

export interface UseCriticalAlertsReturn {
  /** Create a new critical finding alert */
  createAlert: (params: CreateCriticalAlertParams) => Promise<CriticalAlert | null>;
  /** Acknowledge an alert (marks it as handled) */
  acknowledgeAlert: (communicationId: string) => Promise<boolean>;
  /** All currently active (unacknowledged) alerts */
  activeAlerts: CriticalAlert[];
  /** Alerts that have exceeded the 30-minute escalation threshold */
  escalatedAlerts: CriticalAlert[];
  /** Whether data is loading */
  isLoading: boolean;
  /** Error from most recent operation */
  error: string | null;
}

// ============================================================================
// Hook
// ============================================================================

export function useCriticalAlerts(): UseCriticalAlertsReturn {
  const fhir = useLiverraFhir();

  const [activeAlerts, setActiveAlerts] = useState<CriticalAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track escalation timer IDs so we can clean them up
  const escalationTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Track which alerts have been escalated (for re-render trigger)
  const [escalatedIds, setEscalatedIds] = useState<Set<string>>(new Set());

  // ── Fetch active alerts ──

  const fetchAlerts = useCallback(async () => {
    try {
      const alerts = await getActiveAlerts(fhir);
      setActiveAlerts(alerts);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch alerts';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [fhir]);

  // Initial fetch + poll every 60s
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await fetchAlerts();
    };

    void tick();
    const intervalId = setInterval(() => void tick(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [fetchAlerts]);

  // ── Escalation timer management ──

  // Start escalation timer for an alert. When 30 min elapse, mark it escalated.
  const startEscalationTimer = useCallback((alertId: string, sentAt: string) => {
    // Don't start a timer if one already exists for this alert
    if (escalationTimersRef.current.has(alertId)) return;

    const sentTime = new Date(sentAt).getTime();
    const elapsed = Date.now() - sentTime;
    const remaining = ESCALATION_THRESHOLD_MS - elapsed;

    if (remaining <= 0) {
      // Already past threshold — mark as escalated immediately
      setEscalatedIds((prev) => {
        const next = new Set(prev);
        next.add(alertId);
        return next;
      });
      return;
    }

    // Set timer for when escalation becomes due
    const timerId = setTimeout(() => {
      setEscalatedIds((prev) => {
        const next = new Set(prev);
        next.add(alertId);
        return next;
      });
      escalationTimersRef.current.delete(alertId);
    }, remaining);

    escalationTimersRef.current.set(alertId, timerId);
  }, []);

  // Clear escalation timer for a specific alert
  const clearEscalationTimer = useCallback((alertId: string) => {
    const timerId = escalationTimersRef.current.get(alertId);
    if (timerId) {
      clearTimeout(timerId);
      escalationTimersRef.current.delete(alertId);
    }
    setEscalatedIds((prev) => {
      const next = new Set(prev);
      next.delete(alertId);
      return next;
    });
  }, []);

  // Start timers for all active alerts, clean up timers for resolved ones
  useEffect(() => {
    const activeIds = new Set(activeAlerts.map((a) => a.id));

    // Start timers for new alerts
    for (const alert of activeAlerts) {
      startEscalationTimer(alert.id, alert.sentAt);
    }

    // Clear timers for alerts that are no longer active
    for (const [id] of escalationTimersRef.current) {
      if (!activeIds.has(id)) {
        clearEscalationTimer(id);
      }
    }
  }, [activeAlerts, startEscalationTimer, clearEscalationTimer]);

  // Periodic escalation check — also catches alerts that arrived already past threshold
  useEffect(() => {
    const interval = setInterval(() => {
      setEscalatedIds((prev) => {
        const next = new Set(prev);
        for (const alert of activeAlerts) {
          if (isEscalationDue(alert, ESCALATION_THRESHOLD_MS)) {
            next.add(alert.id);
          }
        }
        return next;
      });
    }, ESCALATION_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [activeAlerts]);

  // Clean up ALL timers on unmount (memory leak prevention)
  useEffect(() => {
    const timers = escalationTimersRef.current;
    return () => {
      for (const [, timerId] of timers) {
        clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);

  // ── Actions ──

  const createAlertAction = useCallback(
    async (params: CreateCriticalAlertParams): Promise<CriticalAlert | null> => {
      try {
        setError(null);
        const alert = await createCriticalAlert(fhir, params);
        // Start escalation timer for the new alert
        startEscalationTimer(alert.id, alert.sentAt);
        // Optimistically add to active list
        setActiveAlerts((prev) => [alert, ...prev]);
        return alert;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to create alert';
        setError(msg);
        return null;
      }
    },
    [fhir, startEscalationTimer]
  );

  const acknowledgeAlertAction = useCallback(
    async (communicationId: string): Promise<boolean> => {
      try {
        setError(null);
        await acknowledgeCriticalAlert(fhir, communicationId);
        // Clear escalation timer
        clearEscalationTimer(communicationId);
        // Optimistically remove from active list
        setActiveAlerts((prev) => prev.filter((a) => a.id !== communicationId));
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to acknowledge alert';
        setError(msg);
        return false;
      }
    },
    [fhir, clearEscalationTimer]
  );

  // ── Derived state ──

  const escalatedAlerts = useMemo(
    () => activeAlerts.filter((a) => escalatedIds.has(a.id)),
    [activeAlerts, escalatedIds]
  );

  return {
    createAlert: createAlertAction,
    acknowledgeAlert: acknowledgeAlertAction,
    activeAlerts,
    escalatedAlerts,
    isLoading,
    error,
  };
}
