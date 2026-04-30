// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * HelpIndexView tests (T105).
 *
 * These tests deliberately query by `data-testid` rather than translated text
 * because the TranslationProvider loads bundles asynchronously via dynamic
 * imports — text assertions would need per-test `waitFor` gymnastics and
 * still race with happy-dom's module loader. Test ids are stable,
 * deterministic, and reflect user-visible intent (tile key / modal section).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../../test-utils';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `useAuth` is mocked per test via `setMockUser(...)`.
const mockUser: { current: { id: string; email: string | null; name: string | null; role?: string } | null } = {
  current: null,
};

vi.mock('../../../services/auth', () => ({
  useAuth: () => ({
    user: mockUser.current,
    tenant: null,
    permissions: [],
    isLoading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    challengeStepUp: vi.fn(),
  }),
}));

// Navigate spy — replace react-router's `useNavigate` hook.
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

// Import AFTER mocks are registered so module resolution picks them up.
const importView = async () => (await import('../HelpIndexView')).default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setMockUser(role: string | undefined): void {
  mockUser.current = role
    ? { id: 'user-1', email: 'test@liverra.ai', name: 'Test User', role }
    : null;
}

beforeEach(() => {
  mockUser.current = null;
  navigateSpy.mockReset();
});

afterEach(() => {
  // Restore env overrides.
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HelpIndexView', () => {
  it('renders all six hub tiles', async () => {
    const HelpIndexView = await importView();
    renderWithProviders(<HelpIndexView />);

    for (const key of [
      'sampleCase',
      'glossary',
      'keyboard',
      'ruoPolicy',
      'tutorials',
      'support',
    ]) {
      expect(screen.getByTestId(`help-tile-${key}`)).toBeTruthy();
    }
  });

  it('shows role strip with expected tiles for hpb_surgeon', async () => {
    setMockUser('hpb_surgeon');
    const HelpIndexView = await importView();
    renderWithProviders(<HelpIndexView />);

    const strip = screen.getByTestId('help-role-strip');
    expect(strip).toBeTruthy();
    // Role strip for hpb_surgeon → sampleCase, glossary, keyboard.
    // Each tile inside the strip renders with the same testid prefix as the
    // main grid, so we assert presence of at least one of each expected key
    // via `queryAllByTestId` (main grid also renders them).
    expect(screen.queryAllByTestId('help-tile-sampleCase').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByTestId('help-tile-glossary').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByTestId('help-tile-keyboard').length).toBeGreaterThanOrEqual(2);
    // Not in the hpb_surgeon strip → should only appear once (main grid).
    expect(screen.queryAllByTestId('help-tile-ruoPolicy').length).toBe(1);
  });

  it('opens the keyboard-shortcuts modal with all three sections', async () => {
    const HelpIndexView = await importView();
    renderWithProviders(<HelpIndexView />);

    // Main-grid keyboard tile is the second occurrence is only in grid (no role strip when user is null).
    const tile = screen.getByTestId('help-tile-keyboard');
    fireEvent.click(tile);

    await waitFor(() => {
      expect(screen.getByTestId('kb-section-global')).toBeTruthy();
    });
    expect(screen.getByTestId('kb-section-viewer')).toBeTruthy();
    expect(screen.getByTestId('kb-section-refine')).toBeTruthy();
  });

  it('opens the RUO policy modal when the RUO tile is clicked', async () => {
    const HelpIndexView = await importView();
    const { container } = renderWithProviders(<HelpIndexView />);

    const tile = screen.getByTestId('help-tile-ruoPolicy');
    fireEvent.click(tile);

    // EMRModal renders a dialog role when opened. Assert a visible dialog
    // appears in the DOM after click.
    await waitFor(() => {
      const dialogs = container.ownerDocument.querySelectorAll('[role="dialog"]');
      expect(dialogs.length).toBeGreaterThan(0);
    });
  });

  it('navigates to /demo-case when the sample-case tile is clicked', async () => {
    const HelpIndexView = await importView();
    renderWithProviders(<HelpIndexView />);

    const tile = screen.getByTestId('help-tile-sampleCase');
    fireEvent.click(tile);

    expect(navigateSpy).toHaveBeenCalledWith('/demo-case');
  });

  it('disables the tutorials tile when VITE_LIVERRA_TUTORIALS_URL is missing', async () => {
    vi.stubEnv('VITE_LIVERRA_TUTORIALS_URL', '');
    const HelpIndexView = await importView();
    renderWithProviders(<HelpIndexView />);

    const tile = screen.getByTestId('help-tile-tutorials');
    expect(tile.getAttribute('aria-disabled')).toBe('true');
    expect(tile.getAttribute('tabindex')).toBe('-1');
  });
});
