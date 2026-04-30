// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * NotificationPreferencesView unit tests.
 *
 * Plain-English: exercises the settings page end-to-end against a stubbed
 * fetch layer. Covers:
 *   1. Every event renders in the right group card.
 *   2. PHI-incident is locked ON and badged "Required".
 *   3. Toggling a regular switch PUTs the expected payload.
 *   4. A server 500 on PUT reverts the optimistic update.
 *   5. Groups render in the expected order: clinical → operational → security.
 *   6. `locked===true` forces the switch ON regardless of `opted_out`.
 *
 * Note: we use plain Chai assertions (no jest-dom) to match the project's
 * existing test setup which doesn't load `@testing-library/jest-dom`.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';

import NotificationPreferencesView from '../NotificationPreferencesView';
import { renderWithProviders, jsonResponse } from '../../../../test-utils';
import type { NotificationPreference } from '../../../hooks/useNotificationPreferences';

/** Handy default: every event opted-in, phi_incident locked. */
function buildPrefs(
  overrides: Partial<Record<string, Partial<NotificationPreference>>> = {},
): NotificationPreference[] {
  const defaults: NotificationPreference[] = [
    { user_id: 'u-1', event_type: 'analysis_complete', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'analysis_failed', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'queued_long', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'pacs_failed', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'maintenance_window', opted_out: true, locked: false },
    { user_id: 'u-1', event_type: 'mfa_reset', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'invite_accepted', opted_out: true, locked: false },
    { user_id: 'u-1', event_type: 'erasure_confirmed', opted_out: false, locked: false },
    { user_id: 'u-1', event_type: 'phi_incident', opted_out: false, locked: true },
  ];
  return defaults.map((p) => ({ ...p, ...(overrides[p.event_type] ?? {}) }));
}

const EVENT_TYPES = [
  'analysis_complete',
  'analysis_failed',
  'queued_long',
  'pacs_failed',
  'maintenance_window',
  'mfa_reset',
  'invite_accepted',
  'erasure_confirmed',
  'phi_incident',
] as const;

/**
 * Install a fetch mock that answers both GET and PUT with the supplied
 * preferences. Callers can override the PUT handler to simulate errors.
 */
function installFetchMock(options: {
  getPrefs?: NotificationPreference[];
  onPut?: (
    body: { preferences: Array<{ event_type: string; opted_out: boolean }> },
  ) => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  const fetchSpy = vi
    .spyOn(global, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/auth/me/notification-preferences')) {
        if (method === 'GET') {
          return jsonResponse(options.getPrefs ?? buildPrefs());
        }
        if (method === 'PUT') {
          const body = JSON.parse(
            (init?.body as string | undefined) ?? '{"preferences":[]}',
          ) as {
            preferences: Array<{ event_type: string; opted_out: boolean }>;
          };
          if (options.onPut) {
            return options.onPut(body);
          }
          // Echo back a full prefs array updated with the PUT body values.
          const base = options.getPrefs ?? buildPrefs();
          const updated = base.map((p) => {
            const change = body.preferences.find(
              (c) => c.event_type === p.event_type,
            );
            return change ? { ...p, opted_out: change.opted_out } : p;
          });
          return jsonResponse(updated);
        }
      }
      return new Response('not found', { status: 404 });
    });
  return fetchSpy as unknown as ReturnType<typeof vi.fn>;
}

describe('NotificationPreferencesView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every event in its correct group', async () => {
    installFetchMock({});
    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-switch-analysis_complete')).not.toBeNull();
    });

    // All nine rows are present.
    for (const evt of EVENT_TYPES) {
      expect(screen.queryByTestId(`pref-row-${evt}`)).not.toBeNull();
    }

    // Clinical group contains both clinical events.
    const clinicalGroup = screen.getByTestId('pref-group-clinical');
    expect(clinicalGroup.contains(screen.getByTestId('pref-row-analysis_complete'))).toBe(true);
    expect(clinicalGroup.contains(screen.getByTestId('pref-row-analysis_failed'))).toBe(true);

    // Operational group.
    const opGroup = screen.getByTestId('pref-group-operational');
    expect(opGroup.contains(screen.getByTestId('pref-row-queued_long'))).toBe(true);
    expect(opGroup.contains(screen.getByTestId('pref-row-pacs_failed'))).toBe(true);
    expect(opGroup.contains(screen.getByTestId('pref-row-maintenance_window'))).toBe(true);

    // Security group.
    const secGroup = screen.getByTestId('pref-group-security');
    expect(secGroup.contains(screen.getByTestId('pref-row-mfa_reset'))).toBe(true);
    expect(secGroup.contains(screen.getByTestId('pref-row-phi_incident'))).toBe(true);
  });

  it('locks the PHI-incident switch and shows the Required badge', async () => {
    installFetchMock({});
    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-switch-phi_incident')).not.toBeNull();
    });

    const switchEl = screen.getByTestId(
      'pref-switch-phi_incident',
    ) as HTMLInputElement;
    expect(switchEl.disabled).toBe(true);
    expect(switchEl.checked).toBe(true);

    expect(
      screen.queryByTestId('pref-locked-badge-phi_incident'),
    ).not.toBeNull();
  });

  it('toggling analysis_complete OFF sends the expected PUT payload', async () => {
    const fetchSpy = installFetchMock({});
    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-switch-analysis_complete')).not.toBeNull();
    });

    const switchEl = screen.getByTestId(
      'pref-switch-analysis_complete',
    ) as HTMLInputElement;
    expect(switchEl.checked).toBe(true);

    await act(async () => {
      fireEvent.click(switchEl);
    });

    await waitFor(() => {
      const putCall = fetchSpy.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).not.toBeUndefined();
      const body = JSON.parse(
        (putCall![1] as RequestInit).body as string,
      ) as { preferences: Array<{ event_type: string; opted_out: boolean }> };
      expect(body).toEqual({
        preferences: [{ event_type: 'analysis_complete', opted_out: true }],
      });
    });
  });

  it('reverts the switch when the server returns an error', async () => {
    installFetchMock({
      onPut: () => new Response('boom', { status: 500 }),
    });

    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-switch-analysis_complete')).not.toBeNull();
    });

    const switchEl = screen.getByTestId(
      'pref-switch-analysis_complete',
    ) as HTMLInputElement;
    expect(switchEl.checked).toBe(true);

    await act(async () => {
      fireEvent.click(switchEl);
    });

    // Wait for the mutation to fail and the revert to land.
    await waitFor(() => {
      expect(
        (screen.getByTestId('pref-switch-analysis_complete') as HTMLInputElement)
          .checked,
      ).toBe(true);
    });

    // Error banner surfaces.
    expect(screen.queryByTestId('pref-save-error')).not.toBeNull();
  });

  it('renders groups in order: clinical → operational → security', async () => {
    installFetchMock({});
    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-group-clinical')).not.toBeNull();
    });

    const clinical = screen.getByTestId('pref-group-clinical');
    const operational = screen.getByTestId('pref-group-operational');
    const security = screen.getByTestId('pref-group-security');

    // `compareDocumentPosition` returns bitmask 4 === "follows".
    expect(
      clinical.compareDocumentPosition(operational) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      operational.compareDocumentPosition(security) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('honours locked=true even when opted_out is true on the server', async () => {
    // Intentionally adversarial payload: PHI-incident reported as opted-out,
    // but still locked. The UI must display it as ON.
    const prefs = buildPrefs({
      phi_incident: { opted_out: true, locked: true },
    });
    installFetchMock({ getPrefs: prefs });

    renderWithProviders(<NotificationPreferencesView />);

    await waitFor(() => {
      expect(screen.queryByTestId('pref-switch-phi_incident')).not.toBeNull();
    });

    const switchEl = screen.getByTestId(
      'pref-switch-phi_incident',
    ) as HTMLInputElement;
    expect(switchEl.checked).toBe(true);
    expect(switchEl.disabled).toBe(true);
  });
});
