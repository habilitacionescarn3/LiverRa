// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useNotificationPreferences.
 *
 * Plain-English: the hook that drives the Notification Preferences
 * settings page. Think of it as the "email opt-out switchboard" for
 * each authenticated user — one row per event type the platform can
 * email them about (analysis finished, PACS push failed, PHI incident,
 * etc.). The hook fetches the current preferences, lets the UI flip a
 * single switch with an optimistic update, and reverts on server error
 * so the UI never stays out of sync with the backend.
 *
 * Endpoints:
 *   - GET  /api/v1/auth/me/notification-preferences
 *   - PUT  /api/v1/auth/me/notification-preferences
 *           body: { preferences: [{ event_type, opted_out }] }
 *
 * Compliance note: some preferences are `locked` (e.g. PHI-incident).
 * The hook refuses to toggle those — it throws before hitting the
 * network so the backend can't be tricked into recording an opt-out
 * that would then be silently ignored.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface NotificationPreference {
  user_id: string;
  event_type: string;
  opted_out: boolean;
  locked: boolean;
}

export interface UseNotificationPreferencesResult {
  preferences: NotificationPreference[];
  isLoading: boolean;
  error: Error | null;
  toggle: (eventType: string, optedOut: boolean) => Promise<void>;
  refetch: () => void;
}

export const notificationPreferencesQueryKey = [
  'auth',
  'me',
  'notification-preferences',
] as const;

function readApiBaseUrl(): string {
  const meta =
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

interface PreferencesResponseShape {
  preferences?: NotificationPreference[];
}

function normalizePayload(
  payload: unknown,
): NotificationPreference[] {
  if (Array.isArray(payload)) {
    return payload as NotificationPreference[];
  }
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as PreferencesResponseShape).preferences)
  ) {
    return (payload as PreferencesResponseShape).preferences ?? [];
  }
  return [];
}

async function fetchPreferences(): Promise<NotificationPreference[]> {
  const res = await fetch(
    `${readApiBaseUrl()}/auth/me/notification-preferences`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to load notification preferences: HTTP ${res.status}`,
    );
  }
  return normalizePayload(await res.json());
}

async function putPreference(
  eventType: string,
  optedOut: boolean,
): Promise<NotificationPreference[]> {
  const res = await fetch(
    `${readApiBaseUrl()}/auth/me/notification-preferences`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preferences: [{ event_type: eventType, opted_out: optedOut }],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Failed to save notification preference: HTTP ${res.status}`,
    );
  }
  return normalizePayload(await res.json());
}

export function useNotificationPreferences(): UseNotificationPreferencesResult {
  const queryClient = useQueryClient();

  const query = useQuery<NotificationPreference[], Error>({
    queryKey: notificationPreferencesQueryKey,
    queryFn: fetchPreferences,
    staleTime: 30_000,
  });

  const mutation = useMutation<
    NotificationPreference[],
    Error,
    { eventType: string; optedOut: boolean },
    { previous: NotificationPreference[] | undefined }
  >({
    mutationFn: ({ eventType, optedOut }) => putPreference(eventType, optedOut),
    onMutate: async ({ eventType, optedOut }) => {
      await queryClient.cancelQueries({
        queryKey: notificationPreferencesQueryKey,
      });
      const previous = queryClient.getQueryData<NotificationPreference[]>(
        notificationPreferencesQueryKey,
      );
      if (previous) {
        queryClient.setQueryData<NotificationPreference[]>(
          notificationPreferencesQueryKey,
          previous.map((pref) =>
            pref.event_type === eventType
              ? { ...pref, opted_out: optedOut }
              : pref,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      // Revert optimistic update on failure.
      if (ctx?.previous) {
        queryClient.setQueryData(
          notificationPreferencesQueryKey,
          ctx.previous,
        );
      }
    },
    onSuccess: (serverPrefs) => {
      // Server response is authoritative — merge back so any fields we
      // don't locally mutate (e.g. `locked`, `user_id`) stay canonical.
      queryClient.setQueryData<NotificationPreference[]>(
        notificationPreferencesQueryKey,
        (prev) => {
          if (!prev) return serverPrefs;
          const byEvent = new Map(
            serverPrefs.map((p) => [p.event_type, p] as const),
          );
          return prev.map((p) => byEvent.get(p.event_type) ?? p);
        },
      );
    },
  });

  const toggle = useCallback(
    async (eventType: string, optedOut: boolean): Promise<void> => {
      const current = queryClient.getQueryData<NotificationPreference[]>(
        notificationPreferencesQueryKey,
      );
      const target = current?.find((p) => p.event_type === eventType);
      if (target?.locked) {
        throw new Error(
          `Preference "${eventType}" is locked by policy and cannot be toggled.`,
        );
      }
      await mutation.mutateAsync({ eventType, optedOut });
    },
    [mutation, queryClient],
  );

  const refetch = useCallback((): void => {
    void query.refetch();
  }, [query]);

  return {
    preferences: query.data ?? [],
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    toggle,
    refetch,
  };
}

export default useNotificationPreferences;
