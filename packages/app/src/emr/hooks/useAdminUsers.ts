// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
/**
 * useAdminUsers (T291, T436).
 *
 * Plain-English: fetches + mutates the tenant user list for the admin
 * console. Think of it as the remote control for /admin/users: list,
 * invite, suspend — each action invalidates the list so the table stays
 * in sync.
 */
import { useCallback, useEffect, useState } from 'react';

export interface AdminUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  locale_preference: string;
  suspended: boolean;
  ruo_accepted_at: string | null;
  mfa_enrolled_at: string | null;
  last_active_at: string | null;
}

export interface InviteUserPayload {
  email: string;
  role: string;
  display_name: string;
  locale_preference: string;
}

export interface UseAdminUsersResult {
  users: AdminUserRow[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  invite: (p: InviteUserPayload) => Promise<{ invite_id: string; expires_at: string }>;
  suspend: (userId: string) => Promise<void>;
}

const API_BASE = '/api/v1/admin';

export function useAdminUsers(): UseAdminUsersResult {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/users`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`GET /admin/users failed: ${r.status}`);
        return r.json() as Promise<AdminUserRow[]>;
      })
      .then((data) => {
        if (!cancelled) setUsers(data);
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

  const invite = useCallback(
    async (payload: InviteUserPayload) => {
      const r = await fetch(`${API_BASE}/users/invite`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`invite failed: ${r.status}`);
      refetch();
      return (await r.json()) as { invite_id: string; expires_at: string };
    },
    [refetch],
  );

  const suspend = useCallback(
    async (userId: string) => {
      const r = await fetch(`${API_BASE}/users/${userId}/suspend`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok && r.status !== 204) throw new Error(`suspend failed: ${r.status}`);
      refetch();
    },
    [refetch],
  );

  return { users, loading, error, refetch, invite, suspend };
}
