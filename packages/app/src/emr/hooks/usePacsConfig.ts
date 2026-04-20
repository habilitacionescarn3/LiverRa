// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * usePacsConfig (T291, T436).
 *
 * Plain-English: reads the tenant PACS destination (AE title / host / port),
 * lets the admin update it (which triggers a C-ECHO pre-flight on the
 * server), and exposes a standalone ``testEcho()`` action for the
 * "Test with C-ECHO" button.
 */
import { useCallback, useEffect, useState } from 'react';

export interface PacsDestination {
  ae_title: string;
  host: string;
  port: number;
  use_tls: boolean;
  cert_fingerprint: string | null;
}

export interface TenantInfo {
  id: string;
  name: string;
  locale_default: string;
  pacs_destination: PacsDestination | null;
  allow_partial_coverage_override: boolean;
}

export interface CEchoResult {
  reachable: boolean;
  round_trip_ms?: number;
  scanner_ae_responded?: string;
  error?: string;
}

export interface UsePacsConfigResult {
  tenant: TenantInfo | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  save: (dest: PacsDestination) => Promise<{ cecho_round_trip_ms: number }>;
  testEcho: (dest?: PacsDestination) => Promise<CEchoResult>;
}

const API = '/api/v1/admin';

export function usePacsConfig(): UsePacsConfigResult {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API}/tenants/me`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`GET /admin/tenants/me failed: ${r.status}`);
        return r.json() as Promise<TenantInfo>;
      })
      .then((data) => {
        if (!cancelled) setTenant(data);
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
  }, [reloadKey]);

  const save = useCallback(
    async (dest: PacsDestination) => {
      const r = await fetch(`${API}/pacs-destination`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dest),
      });
      if (!r.ok) throw new Error(`PUT /admin/pacs-destination failed: ${r.status}`);
      const json = (await r.json()) as { cecho_round_trip_ms: number };
      refetch();
      return json;
    },
    [refetch],
  );

  const testEcho = useCallback(async (dest?: PacsDestination) => {
    const r = await fetch(`${API}/pacs-destination/echo`, {
      method: 'POST',
      credentials: 'include',
      headers: dest ? { 'content-type': 'application/json' } : {},
      body: dest ? JSON.stringify(dest) : undefined,
    });
    if (!r.ok) throw new Error(`POST /admin/pacs-destination/echo failed: ${r.status}`);
    return (await r.json()) as CEchoResult;
  }, []);

  return { tenant, loading, error, refetch, save, testEcho };
}
