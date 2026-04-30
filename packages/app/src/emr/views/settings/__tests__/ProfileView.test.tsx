// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ProfileView unit tests (co-located with T105 profile view).
 *
 * Plain-English: drives the profile page end-to-end against a stubbed
 * `useAuth()` + `fetch()` layer. Covers the eight scenarios from the
 * spec:
 *   1. Renders the user's current values.
 *   2. Editing the display name surfaces Save + Cancel.
 *   3. Cancel reverts to the original values.
 *   4. Empty display name shows a validation error + disables Save.
 *   5. Save calls `PUT /auth/me` with the correct payload.
 *   6. Server error on save shows an inline alert + re-enables Save.
 *   7. MFA reset calls the endpoint + renders the admin-contact alert.
 *   8. Re-accept RUO dispatches the `liverra:step-up-required` event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ProfileView from '../ProfileView';
import { renderWithProviders, jsonResponse } from '../../../../test-utils';

// ---------------------------------------------------------------------------
// Mocks — `useAuth()` is the single source of truth the view consumes, so
// we mock the module. The shape is richer than the stub's default because
// the view treats `user` as a `ProfileUser` hydrated from `/auth/me`.
// ---------------------------------------------------------------------------

const USER_001 = {
  id: 'user-001',
  email: 'levan@geohospitals.ge',
  display_name: 'Dr. Levan Gogichaishvili',
  role: 'hpb_surgeon',
  locale_preference: 'en' as const,
  theme_preference: 'system' as const,
  last_active_at: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
  mfa_enrolled_at: '2025-06-01T10:00:00Z',
  ruo_accepted_at: '2025-06-01T10:05:00Z',
};

const refreshMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../services/auth', async () => {
  return {
    useAuth: () => ({
      user: USER_001,
      tenant: { id: 'tenant-ge-01' },
      permissions: ['compliance.view'],
      isLoading: false,
      signIn: vi.fn(),
      signOut: vi.fn(),
      refresh: refreshMock,
      challengeStepUp: vi.fn(),
    }),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  refreshMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Render + wait until the async translation bundle has loaded. */
async function renderProfile(): Promise<void> {
  renderWithProviders(<ProfileView />);
  // Translation provider lazy-loads the `profile` namespace; the initial
  // render shows the raw keys until the bundle resolves. Wait for the
  // display-name label to become human-readable English.
  await waitFor(() => {
    expect(screen.getByText('Display name')).toBeDefined();
  });
}

/**
 * Install a fetch spy that answers the three endpoints the view calls.
 * Callers override individual handlers to simulate errors.
 */
function installFetchMock(handlers: {
  onPutMe?: (body: unknown) => Response | Promise<Response>;
  onMfaReset?: () => Response | Promise<Response>;
  onRuoAccept?: () => Response | Promise<Response>;
}): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/auth/me') && method === 'PUT') {
      const body = JSON.parse((init?.body as string | undefined) ?? '{}') as unknown;
      return handlers.onPutMe?.(body) ?? jsonResponse({ ok: true });
    }
    if (url.endsWith('/auth/me/mfa-reset-request') && method === 'POST') {
      return (
        handlers.onMfaReset?.() ??
        jsonResponse({
          request_id: 'req-123',
          admin_contact: 'security@geohospitals.ge',
          message: 'Reset request received.',
        })
      );
    }
    if (url.endsWith('/auth/me/ruo-accept') && method === 'POST') {
      return (
        handlers.onRuoAccept?.() ??
        jsonResponse({
          accepted_at: new Date().toISOString(),
          signature_hash: 'sha256:deadbeef',
        })
      );
    }
    return new Response('Not Found', { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileView', () => {
  it('renders the user\'s current values', async () => {
    installFetchMock({});
    await renderProfile();

    expect(screen.getByText('levan@geohospitals.ge')).toBeDefined();
    expect(screen.getByText('HPB surgeon')).toBeDefined();

    const nameInput = screen.getByTestId('profile-input-display-name') as HTMLInputElement;
    expect(nameInput.value).toBe('Dr. Levan Gogichaishvili');
  });

  it('surfaces Save + Cancel once the display name is edited', async () => {
    installFetchMock({});
    const user = userEvent.setup();
    await renderProfile();

    // Save button hidden on first render (form not dirty).
    expect(screen.queryByTestId('profile-save-button')).toBeNull();

    const nameInput = screen.getByTestId('profile-input-display-name');
    await user.type(nameInput, ' MD');

    expect(screen.getByTestId('profile-save-button')).toBeDefined();
    expect(screen.getByTestId('profile-cancel-button')).toBeDefined();
  });

  it('reverts to original values when Cancel is clicked', async () => {
    installFetchMock({});
    const user = userEvent.setup();
    await renderProfile();

    const nameInput = screen.getByTestId('profile-input-display-name') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Different Name');
    expect(nameInput.value).toBe('Different Name');

    await user.click(screen.getByTestId('profile-cancel-button'));
    expect(nameInput.value).toBe('Dr. Levan Gogichaishvili');
    // Save hides again because form is no longer dirty.
    expect(screen.queryByTestId('profile-save-button')).toBeNull();
  });

  it('shows a validation error and disables Save when display name is empty', async () => {
    installFetchMock({});
    const user = userEvent.setup();
    await renderProfile();

    const nameInput = screen.getByTestId('profile-input-display-name');
    await user.clear(nameInput);

    expect(screen.getByText('Display name is required.')).toBeDefined();
    const saveBtn = screen.getByTestId('profile-save-button') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('PUTs /auth/me with the edited payload when Save is clicked', async () => {
    let received: unknown = null;
    const fetchSpy = installFetchMock({
      onPutMe: (body) => {
        received = body;
        return jsonResponse({ ok: true });
      },
    });
    const user = userEvent.setup();
    await renderProfile();

    const nameInput = screen.getByTestId('profile-input-display-name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Dr. Levan G.');

    await user.click(screen.getByTestId('profile-save-button'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    expect(received).toEqual({
      display_name: 'Dr. Levan G.',
      locale_preference: 'en',
      theme_preference: 'system',
    });
    await waitFor(() => {
      expect(screen.getByTestId('profile-save-success')).toBeDefined();
    });
  });

  it('shows an error alert and re-enables Save when the server rejects', async () => {
    installFetchMock({
      onPutMe: () =>
        new Response(
          JSON.stringify({
            title: 'Validation failed',
            detail: 'Display name already taken',
            slug: 'display_name_taken',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    const user = userEvent.setup();
    await renderProfile();

    const nameInput = screen.getByTestId('profile-input-display-name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Dr. Levan G.');

    const saveBtn = screen.getByTestId('profile-save-button') as HTMLButtonElement;
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByTestId('profile-save-error')).toBeDefined();
    });
    expect(screen.getByTestId('profile-save-error').textContent).toContain(
      'Display name already taken',
    );
    // Save re-enables after the failure so the user can retry.
    await waitFor(() => {
      expect((screen.getByTestId('profile-save-button') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('requests MFA reset and renders the admin-contact success alert', async () => {
    const mfaSpy = vi.fn(() =>
      jsonResponse({
        request_id: 'req-xyz',
        admin_contact: 'security@geohospitals.ge',
      }),
    );
    installFetchMock({ onMfaReset: mfaSpy });
    const user = userEvent.setup();
    await renderProfile();

    await user.click(screen.getByTestId('profile-mfa-reset-button'));

    await waitFor(() => {
      expect(mfaSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('profile-mfa-sent')).toBeDefined();
    });
    expect(screen.getByTestId('profile-mfa-sent').textContent).toContain(
      'security@geohospitals.ge',
    );
    // Button is replaced by the success alert — no retry button remains.
    expect(screen.queryByTestId('profile-mfa-reset-button')).toBeNull();
  });

  it('dispatches liverra:step-up-required when Re-accept RUO is clicked', async () => {
    installFetchMock({});
    const eventSpy = vi.fn();
    window.addEventListener('liverra:step-up-required', eventSpy);

    try {
      const user = userEvent.setup();
      await renderProfile();

      await user.click(screen.getByTestId('profile-ruo-reaccept-button'));

      await waitFor(() => {
        expect(eventSpy).toHaveBeenCalled();
      });
      const evt = eventSpy.mock.calls[0][0] as CustomEvent<{ action?: string }>;
      expect(evt.detail?.action).toBeDefined();
    } finally {
      window.removeEventListener('liverra:step-up-required', eventSpy);
    }
  });
});
