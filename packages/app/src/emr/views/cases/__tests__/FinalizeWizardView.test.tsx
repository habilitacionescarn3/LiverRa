// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * FinalizeWizardView tests.
 *
 * We mock `useAnalysis`, `useReviewSeat`, `useFinalize`, `useAuth`, and the
 * PermissionContext so the view renders without a full provider tree. A
 * mutable `mockState` is toggled per-test to drive different scenarios
 * (permission missing, seat lost, analysis not ready, finalize error slug).
 *
 * PACSPushPanel is mocked to a minimal stub so we don't need to wire its
 * hooks for the success-screen assertion.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders } from '../../../../test-utils';

// ---------------------------------------------------------------------------
// Mutable mock state (reset in beforeEach)
// ---------------------------------------------------------------------------

interface MockState {
  permissions: string[];
  hasSeat: boolean;
  seatStatus: 'idle' | 'acquiring' | 'held' | 'degraded' | 'lost';
  reviewId: string | null;
  analysisStatus: 'queued' | 'running' | 'completed' | 'failed' | 'partial';
  finalizeImpl: () => Promise<{ report_id: string; status: string; polling_url: string }>;
}

const mockState: MockState = {
  permissions: ['report.finalize'],
  hasSeat: true,
  seatStatus: 'held',
  reviewId: 'review-abc',
  analysisStatus: 'completed',
  finalizeImpl: async () => ({
    report_id: 'report-new-1',
    status: 'finalizing',
    polling_url: '/api/v1/reports/report-new-1',
  }),
};

const finalizeSpy = vi.fn();

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useAnalysis', () => ({
  useAnalysis: () => ({
    analysis: { id: 'case-42', status: mockState.analysisStatus },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useReviewSeat', () => ({
  useReviewSeat: () => ({
    status: mockState.seatStatus,
    reviewId: mockState.reviewId,
    analysisId: 'case-42',
    seatHeldUntil: null,
    isLoading: false,
    holderDisplayName: null,
    hasSeat: mockState.hasSeat,
    acquire: vi.fn(),
    release: vi.fn(),
    requestTakeover: vi.fn(),
    requestTransfer: vi.fn(),
  }),
  default: () => ({
    status: mockState.seatStatus,
    reviewId: mockState.reviewId,
    analysisId: 'case-42',
    seatHeldUntil: null,
    isLoading: false,
    holderDisplayName: null,
    hasSeat: mockState.hasSeat,
    acquire: vi.fn(),
    release: vi.fn(),
    requestTakeover: vi.fn(),
    requestTransfer: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useFinalize', () => ({
  useFinalize: () => ({
    mutateAsync: (vars: unknown) => {
      finalizeSpy(vars);
      return mockState.finalizeImpl();
    },
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock('../../../services/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'r@x', name: 'R' },
    tenant: { id: 't1' },
    permissions: mockState.permissions,
    isLoading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    challengeStepUp: vi.fn(),
  }),
}));

// PermissionContext fail-loud outside a provider; stub it so PermissionButton
// can resolve without mounting the provider tree.
vi.mock('../../../contexts/PermissionContext', () => ({
  useHasPermission: (perm: string) => mockState.permissions.includes(perm),
  usePermissions: () => new Set(mockState.permissions),
  usePermissionsLoading: () => false,
  usePermissionContext: () => ({
    permissions: new Set(mockState.permissions),
    loading: false,
    isAuthenticated: true,
  }),
  PermissionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// PACSPushPanel depends on its own hooks; stub to a visible marker.
vi.mock('../../../components/report/PACSPushPanel', () => ({
  PACSPushPanel: ({ reportId }: { reportId: string }) =>
    React.createElement('div', { 'data-testid': 'mock-pacs-push-panel' }, `pacs:${reportId}`),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderView(): Promise<void> {
  const { default: FinalizeWizardView } = await import('../FinalizeWizardView');
  renderWithProviders(
    React.createElement(
      Routes,
      null,
      React.createElement(Route, {
        path: '/cases/:id/finalize',
        element: React.createElement(FinalizeWizardView),
      }),
      React.createElement(Route, {
        path: '/cases/:id',
        element: React.createElement('div', { 'data-testid': 'case-detail-view' }, 'case detail'),
      }),
      React.createElement(Route, {
        path: '/reports/:id',
        element: React.createElement('div', { 'data-testid': 'report-view' }, 'report'),
      }),
    ),
    { initialEntries: ['/cases/case-42/finalize'] },
  );
  await waitFor(() => {
    // Either the wizard or the status-blocked fallback must mount.
    const wizard = screen.queryByTestId('finalize-wizard-view');
    const blocked = screen.queryByTestId('finalize-status-blocked');
    expect(wizard || blocked).toBeTruthy();
  });
}

function getNextButton(): HTMLButtonElement {
  return screen.getByTestId('finalize-next-button') as HTMLButtonElement;
}

function clickCheckbox(testId: string): void {
  // EMRCheckbox puts the data-testid on the hidden native <input>; clicking
  // the parent `<Group>` is what actually toggles the visual state, but
  // firing `change` directly on the input drives the controlled onChange.
  const el = screen.getByTestId(testId) as HTMLInputElement;
  const next = !el.checked;
  fireEvent.click(el.parentElement as HTMLElement);
  // Fallback: if the parent click didn't propagate (happy-dom quirks),
  // dispatch a change event directly.
  if (el.checked !== next) {
    fireEvent.change(el, { target: { checked: next } });
  }
}

async function advanceToStep(target: 'watermark' | 'pacs' | 'review' | 'ship'): Promise<void> {
  // Gate: check both checkboxes on step 1
  clickCheckbox('finalize-attest-reviewed');
  clickCheckbox('finalize-attest-ruo');
  await waitFor(() => expect(getNextButton().disabled).toBe(false));
  fireEvent.click(getNextButton()); // -> watermark
  if (target === 'watermark') return;
  await waitFor(() => expect(screen.getByTestId('finalize-step-watermark')).toBeTruthy());
  fireEvent.click(getNextButton()); // -> pacs
  if (target === 'pacs') return;
  await waitFor(() => expect(screen.getByTestId('finalize-step-pacs')).toBeTruthy());
  fireEvent.click(getNextButton()); // -> review
  if (target === 'review') return;
  await waitFor(() => expect(screen.getByTestId('finalize-step-review')).toBeTruthy());
  fireEvent.click(getNextButton()); // -> ship
  await waitFor(() => expect(screen.getByTestId('finalize-step-ship')).toBeTruthy());
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.permissions = ['report.finalize'];
  mockState.hasSeat = true;
  mockState.seatStatus = 'held';
  mockState.reviewId = 'review-abc';
  mockState.analysisStatus = 'completed';
  mockState.finalizeImpl = async () => ({
    report_id: 'report-new-1',
    status: 'finalizing',
    polling_url: '/api/v1/reports/report-new-1',
  });
  finalizeSpy.mockClear();
  // Silence console errors from expected rejection paths.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FinalizeWizardView', () => {
  it('renders two checkboxes on step 1 and disables Next until both are checked', async () => {
    await renderView();

    expect(screen.getByTestId('finalize-attest-reviewed')).toBeTruthy();
    expect(screen.getByTestId('finalize-attest-ruo')).toBeTruthy();
    expect(getNextButton().disabled).toBe(true);

    clickCheckbox('finalize-attest-reviewed');
    expect(getNextButton().disabled).toBe(true);

    clickCheckbox('finalize-attest-ruo');
    await waitFor(() => expect(getNextButton().disabled).toBe(false));
  });

  it('re-disables Next when a checkbox is unchecked after navigating back', async () => {
    await renderView();

    // Gate step 1 and advance.
    clickCheckbox('finalize-attest-reviewed');
    clickCheckbox('finalize-attest-ruo');
    await waitFor(() => expect(getNextButton().disabled).toBe(false));
    fireEvent.click(getNextButton()); // -> watermark
    await waitFor(() => expect(screen.getByTestId('finalize-step-watermark')).toBeTruthy());

    // Navigate back.
    fireEvent.click(screen.getByTestId('finalize-back-button'));
    await waitFor(() => expect(screen.getByTestId('finalize-step-attest')).toBeTruthy());

    // Uncheck one → Next is disabled again.
    clickCheckbox('finalize-attest-reviewed');
    await waitFor(() => expect(getNextButton().disabled).toBe(true));
  });

  it('advances from the watermark step without extra input', async () => {
    await renderView();

    await advanceToStep('watermark');
    expect(screen.getByTestId('finalize-watermark-preview')).toBeTruthy();
    // Next is always enabled on step 2.
    expect(getNextButton().disabled).toBe(false);
    fireEvent.click(getNextButton());
    await waitFor(() => expect(screen.getByTestId('finalize-step-pacs')).toBeTruthy());
  });

  it('defaults the PACS choice to "push"', async () => {
    await renderView();

    await advanceToStep('pacs');
    // Mantine Radio renders the <input type="radio"> as the target of
    // data-testid (when set via the Radio `data-testid` prop) or as a
    // descendant of the labelled wrapper. Search both.
    const group = screen.getByTestId('finalize-pacs-choice');
    const radios = group.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBe(2);
    const pushRadio = radios[0] as HTMLInputElement;
    expect(pushRadio.value).toBe('push');
    expect(pushRadio.checked).toBe(true);
  });

  it('accepts notes in the review step textarea', async () => {
    await renderView();

    await advanceToStep('review');
    // EMRTextarea forwards data-testid down to the native <textarea>.
    const textarea = screen.getByTestId('finalize-review-notes') as HTMLTextAreaElement;
    expect(textarea.tagName.toLowerCase()).toBe('textarea');
    fireEvent.change(textarea, { target: { value: 'Follow-up CT in 3 months.' } });
    expect(textarea.value).toContain('Follow-up CT');
  });

  it('disables the submit button when report.finalize permission is missing', async () => {
    mockState.permissions = []; // no finalize permission
    await renderView();

    await advanceToStep('ship');
    const submit = screen.getByTestId('finalize-submit-button') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('on submit success, renders the success screen with the report id', async () => {
    await renderView();

    await advanceToStep('ship');
    const submit = screen.getByTestId('finalize-submit-button');
    fireEvent.click(submit);

    await waitFor(() =>
      expect(screen.getByTestId('finalize-success-screen')).toBeTruthy(),
    );
    expect(finalizeSpy).toHaveBeenCalledWith({
      reviewId: 'review-abc',
      analysisId: 'case-42',
      tenantId: 't1',
    });
    expect(screen.getByTestId('finalize-success-report-id').textContent).toContain(
      'report-new-1',
    );
    // Since PACS default is 'push', the panel renders.
    expect(screen.getByTestId('mock-pacs-push-panel')).toBeTruthy();
  });

  it('renders an error alert with slug-specific copy when finalize fails with seat_expired', async () => {
    mockState.finalizeImpl = async () => {
      const err = new Error('seat expired') as Error & { slug?: string; status?: number };
      err.slug = 'seat_expired';
      err.status = 409;
      throw err;
    };
    await renderView();

    await advanceToStep('ship');
    fireEvent.click(screen.getByTestId('finalize-submit-button'));

    await waitFor(() =>
      expect(screen.getByTestId('finalize-error-alert')).toBeTruthy(),
    );
    // en/errors.json → errors.finalize.seat_expired
    expect(screen.getByTestId('finalize-error-alert').textContent).toMatch(
      /edit session expired/i,
    );
  });

  it('disables Next when the review seat is lost mid-wizard and shows RecordLockBanner', async () => {
    await renderView();

    // Advance to step 2 while we still hold the seat.
    clickCheckbox('finalize-attest-reviewed');
    clickCheckbox('finalize-attest-ruo');
    await waitFor(() => expect(getNextButton().disabled).toBe(false));
    fireEvent.click(getNextButton());
    await waitFor(() => expect(screen.getByTestId('finalize-step-watermark')).toBeTruthy());

    // Flip the seat away.
    mockState.hasSeat = false;
    mockState.seatStatus = 'lost';

    // Force a re-render by toggling a harmless input so the mocked hook
    // returns the new values.
    fireEvent.click(screen.getByTestId('finalize-back-button'));
    await waitFor(() => expect(screen.getByTestId('finalize-step-attest')).toBeTruthy());

    // RecordLockBanner renders a red "locked" alert (no override perm).
    await waitFor(() => {
      const alerts = document.querySelectorAll('[role="alert"]');
      expect(alerts.length).toBeGreaterThan(0);
    });
    // Next should be disabled regardless of checkbox state because seat is lost.
    expect(getNextButton().disabled).toBe(true);
  });

  it('renders the warning alert instead of the stepper when analysis is not complete', async () => {
    mockState.analysisStatus = 'running';
    await renderView();

    expect(screen.queryByTestId('finalize-wizard-stepper')).toBeNull();
    expect(screen.getByTestId('finalize-status-blocked')).toBeTruthy();
    expect(screen.getByTestId('finalize-status-alert')).toBeTruthy();
    expect(screen.getByTestId('finalize-status-alert').textContent).toMatch(/running/);
  });
});
