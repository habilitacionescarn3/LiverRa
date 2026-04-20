// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * useAdminAudit (T291, T436).
 *
 * Plain-English: fetches filterable AuditEvent rows (PHI-free summaries)
 * for the admin audit browser. Supports date range + category filters.
 */
import { useCallback, useEffect, useState } from 'react';

export interface AuditEventRow {
  id: string;
  sequence_no: number;
  category: string;
  recorded: string;
  actor: string | null;
  outcome: string;
  summary: string | null;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  category?: string;
  limit?: number;
}

export interface UseAdminAuditResult {
  events: AuditEventRow[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

const API = '/api/v1/admin';

export function useAdminAudit(filters: AuditFilters = {}): UseAdminAuditResult {
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const key = JSON.stringify(filters);

  const refetch = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    if (filters.category) q.set('category', filters.category);
    if (filters.limit) q.set('limit', String(filters.limit));
    fetch(`${API}/audit?${q.toString()}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`GET /admin/audit failed: ${r.status}`);
        return r.json() as Promise<AuditEventRow[]>;
      })
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]);

  return { events, loading, error, refetch };
}
