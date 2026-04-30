// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionsPanelView tests.
 *
 * We mock the heavy children (`LesionList`, `LesionDetailPanel`,
 * `ClassificationOverride`, `RUODisclaimerClaimAware`) so the tests do not
 * have to mount ViewerStateProvider / AccessibilityProvider / RUO registry
 * — those components are unit-tested elsewhere. The mocks expose the
 * minimum surface the view contracts with: row click → `onSelect`, close,
 * and override submit.
 *
 * Fetch is spied globally so we can (a) stub the lesion-list GET with
 * the `case-2026-0412` fixture and (b) assert the classification-override
 * POST body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { renderWithProviders, jsonResponse } from '../../../../test-utils';

// ---------------------------------------------------------------------------
// Fixture — four lesions per the brief (HCC, metastasis, abstained, cyst).
// ---------------------------------------------------------------------------

const CASE_ID = 'case-2026-0412';

const FIXTURE_LESIONS = [
  {
    id: 'lesion-1',
    couinaud_location: 'V',
    longest_diameter_mm: 24,
    volume_ml: 7.2,
    discovery_source: 'ai_detected',
    classification: {
      suggested_class: 'hcc',
      confidence_vector: { hcc: 0.82, icc: 0.05, metastasis: 0.04, fnh: 0.03, hemangioma: 0.03, cyst: 0.03 },
      abstention_threshold_used: 0.4,
      temperature_applied: 1.1,
      model_version: 'lilnet-v1',
    },
  },
  {
    id: 'lesion-2',
    couinaud_location: 'VII',
    longest_diameter_mm: 12,
    volume_ml: 0.9,
    discovery_source: 'ai_detected',
    classification: {
      suggested_class: 'metastasis',
      confidence_vector: { hcc: 0.1, icc: 0.08, metastasis: 0.7, fnh: 0.04, hemangioma: 0.04, cyst: 0.04 },
      abstention_threshold_used: 0.4,
      temperature_applied: 1.1,
      model_version: 'lilnet-v1',
    },
  },
  {
    id: 'lesion-3',
    couinaud_location: 'IV',
    longest_diameter_mm: 8,
    volume_ml: 0.3,
    discovery_source: 'ai_detected',
    classification: {
      suggested_class: 'abstained',
      confidence_vector: { hcc: 0.2, icc: 0.2, metastasis: 0.2, fnh: 0.15, hemangioma: 0.15, cyst: 0.1 },
      abstention_threshold_used: 0.4,
      temperature_applied: 1.1,
      model_version: 'lilnet-v1',
    },
  },
  {
    id: 'lesion-4',
    couinaud_location: 'VIII',
    longest_diameter_mm: 18,
    volume_ml: 3.1,
    discovery_source: 'ai_detected',
    classification: {
      suggested_class: 'cyst',
      confidence_vector: { hcc: 0.03, icc: 0.03, metastasis: 0.03, fnh: 0.03, hemangioma: 0.08, cyst: 0.8 },
      abstention_threshold_used: 0.4,
      temperature_applied: 1.1,
      model_version: 'lilnet-v1',
    },
  },
];

// ---------------------------------------------------------------------------
// Mocks — shared state between test cases.
// ---------------------------------------------------------------------------

const permissionsRef: { current: string[] } = {
  current: ['review.override_classification', 'review.reprompt_lesion'],
};

const seatRef: { current: { reviewId: string | null } } = {
  current: { reviewId: 'review-abc' },
};

const dispatchOverrideSpy = vi.fn().mockResolvedValue('edit-1');

vi.mock('../../../services/auth', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'r@x', name: 'R', cognito_sub: 'u1' },
    tenant: { id: 't1' },
    permissions: permissionsRef.current,
    isLoading: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    refresh: vi.fn(),
    challengeStepUp: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useReviewSeat', () => ({
  useReviewSeat: () => ({
    ...seatRef.current,
    status: 'held',
    analysisId: CASE_ID,
    seatHeldUntil: null,
    isLoading: false,
    holderDisplayName: null,
    hasSeat: Boolean(seatRef.current.reviewId),
    acquire: vi.fn(),
    release: vi.fn(),
    requestTakeover: vi.fn(),
    requestTransfer: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useRefinementDispatch', () => ({
  useRefinementDispatch: () => ({
    dispatchMaskRefine: vi.fn(),
    dispatchClassificationOverride: dispatchOverrideSpy,
  }),
}));

// Permission context — fail-loud outside provider normally; stub here so the
// access-control `PermissionButton` resolves without mounting the provider.
vi.mock('../../../contexts/PermissionContext', () => ({
  useHasPermission: (perm: string) => permissionsRef.current.includes(perm),
  usePermissions: () => new Set(permissionsRef.current),
  usePermissionsLoading: () => false,
  usePermissionContext: () => ({
    permissions: new Set(permissionsRef.current),
    loading: false,
    isAuthenticated: true,
  }),
  PermissionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Swap heavy children for inert stubs so tests don't need ViewerState /
// Accessibility / RUO registry providers.
// Mock the direct ClassificationOverride path (view imports it from the
// sibling file, not the barrel).
vi.mock('../../../components/liver/ClassificationOverride', async () => {
  const React = await import('react');
  return {
    ClassificationOverride: ({
      opened,
      lesionId,
      onSubmit,
      onClose,
    }: {
      opened: boolean;
      lesionId: string | null;
      onSubmit: (args: { lesionId: string; newClass: string; reason: string }) => Promise<void> | void;
      onClose: () => void;
    }) =>
      opened
        ? React.createElement(
            'div',
            { role: 'dialog', 'data-testid': 'mock-override-modal' },
            React.createElement('h2', null, 'Override classification'),
            React.createElement(
              'button',
              {
                type: 'button',
                'data-testid': 'mock-override-submit',
                onClick: async () => {
                  if (lesionId) {
                    await onSubmit({
                      lesionId,
                      newClass: 'metastasis',
                      reason: 'prior imaging confirms metastatic disease',
                    });
                  }
                  onClose();
                },
              },
              'Record override',
            ),
          )
        : null,
  };
});

vi.mock('../../../components/liver', async () => {
  const React = await import('react');
  type LesionStub = {
    id: string;
    index: number;
    suggestedClass: string | null;
    couinaudLocation: string;
    locationLabel: string;
    longestDiameterMm: number;
  };
  return {
    LesionList: ({
      lesions,
      onSelect,
      selectedId,
    }: {
      lesions: LesionStub[];
      onSelect?: (l: LesionStub) => void;
      selectedId?: string | null;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'mock-lesion-list' },
        lesions.map((l) =>
          React.createElement(
            'button',
            {
              key: l.id,
              type: 'button',
              'data-testid': `mock-row-${l.id}`,
              'aria-pressed': selectedId === l.id,
              onClick: () => onSelect?.(l),
            },
            `#${l.index} ${l.locationLabel} ${l.longestDiameterMm}mm ${
              l.suggestedClass ?? 'Uncertain'
            }`,
          ),
        ),
      ),
    LesionDetailPanel: ({
      lesion,
      onClose,
      onOverride,
    }: {
      lesion: LesionStub;
      onClose: () => void;
      onOverride?: (l: LesionStub) => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'mock-lesion-detail' },
        React.createElement('span', { 'data-testid': 'detail-id' }, lesion.id),
        React.createElement(
          'button',
          { type: 'button', onClick: onClose, 'data-testid': 'detail-close' },
          'close',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => onOverride?.(lesion),
            disabled: !onOverride,
            'data-testid': 'detail-override-btn',
          },
          'Override classification',
        ),
      ),
    ClassificationOverride: ({
      opened,
      lesionId,
      onSubmit,
      onClose,
    }: {
      opened: boolean;
      lesionId: string | null;
      onSubmit: (args: { lesionId: string; newClass: string; reason: string }) => Promise<void> | void;
      onClose: () => void;
    }) =>
      opened
        ? React.createElement(
            'div',
            { role: 'dialog', 'data-testid': 'mock-override-modal' },
            React.createElement('h2', null, 'Override classification'),
            React.createElement(
              'button',
              {
                type: 'button',
                'data-testid': 'mock-override-submit',
                onClick: async () => {
                  if (lesionId) {
                    await onSubmit({
                      lesionId,
                      newClass: 'metastasis',
                      reason: 'prior imaging confirms metastatic disease',
                    });
                  }
                  onClose();
                },
              },
              'Record override',
            ),
          )
        : null,
    LESION_CLASS_ORDER: ['HCC', 'ICC', 'MET', 'FNH', 'HEM', 'CYST'],
  };
});

vi.mock('../../../components/ruo/RUODisclaimerClaimAware', () => ({
  RUODisclaimerClaimAware: () => null,
}));

// Suppress EMRToast DOM — it needs the Mantine notifications provider.
vi.mock('../../../components/common/EMRToast', () => ({
  EMRToast: {
    show: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function stubLesionFetch(lesions: unknown[] = FIXTURE_LESIONS): void {
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/analyses/') && url.endsWith('/results') && method === 'GET') {
      return jsonResponse({ lesions });
    }
    if (url.includes('/classification-override') && method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (url.includes('/lesion-prompt') && method === 'POST') {
      return jsonResponse({ ok: true });
    }
    if (url.endsWith('/stream')) {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  return;
}

// EventSource stub — happy-dom has none. Minimal no-op that addEventListener
// can be invoked against without throwing.
class NoopEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  permissionsRef.current = [
    'review.override_classification',
    'review.reprompt_lesion',
  ];
  seatRef.current = { reviewId: 'review-abc' };
  dispatchOverrideSpy.mockClear();
  (globalThis as unknown as { EventSource: unknown }).EventSource = NoopEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderView(opts?: { id?: string }): Promise<void> {
  const id = opts?.id ?? CASE_ID;
  const { default: LesionsPanelView } = await import('../LesionsPanelView');
  const React = await import('react');
  const { Routes, Route } = await import('react-router-dom');
  renderWithProviders(
    React.createElement(
      Routes,
      null,
      React.createElement(Route, {
        path: '/cases/:id/lesions',
        element: React.createElement(LesionsPanelView),
      }),
    ),
    { initialEntries: [`/cases/${id}/lesions`] },
  );
  // Wait until the list finishes its initial fetch cycle.
  await waitFor(() =>
    expect(screen.getByTestId('lesions-panel-view')).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LesionsPanelView', () => {
  it('renders all four lesions from the fixture', async () => {
    stubLesionFetch();
    await renderView();

    await waitFor(() => {
      expect(screen.getByTestId('mock-row-lesion-1')).toBeTruthy();
    });
    expect(screen.getByTestId('mock-row-lesion-2')).toBeTruthy();
    expect(screen.getByTestId('mock-row-lesion-3')).toBeTruthy();
    expect(screen.getByTestId('mock-row-lesion-4')).toBeTruthy();
  });

  it('shows an Uncertain label for the abstained lesion', async () => {
    stubLesionFetch();
    await renderView();

    await waitFor(() => {
      const row = screen.getByTestId('mock-row-lesion-3');
      expect(row.textContent).toContain('Uncertain');
    });
  });

  it('selects a lesion on row click and renders the detail panel', async () => {
    stubLesionFetch();
    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('mock-row-lesion-1')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('mock-row-lesion-1'));

    await waitFor(() =>
      expect(screen.getByTestId('mock-lesion-detail')).toBeTruthy(),
    );
    expect(screen.getByTestId('detail-id').textContent).toBe('lesion-1');
  });

  it('hides the override affordance when permission is missing', async () => {
    permissionsRef.current = ['review.reprompt_lesion'];
    stubLesionFetch();
    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('mock-row-lesion-1')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('mock-row-lesion-1'));

    await waitFor(() =>
      expect(screen.getByTestId('mock-lesion-detail')).toBeTruthy(),
    );
    const btn = screen.getByTestId('detail-override-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('opens the override modal when the detail override button is clicked', async () => {
    stubLesionFetch();
    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('mock-row-lesion-1')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('mock-row-lesion-1'));

    await waitFor(() =>
      expect(screen.getByTestId('detail-override-btn')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('detail-override-btn'));

    await waitFor(() => {
      const modal = screen.getByTestId('mock-override-modal');
      expect(modal).toBeTruthy();
      expect(within(modal).getByText('Override classification')).toBeTruthy();
    });
  });

  it('dispatches classification override with the correct payload on submit', async () => {
    stubLesionFetch();
    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('mock-row-lesion-1')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('mock-row-lesion-1'));
    await waitFor(() =>
      expect(screen.getByTestId('detail-override-btn')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('detail-override-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('mock-override-submit')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('mock-override-submit'));

    await waitFor(() => expect(dispatchOverrideSpy).toHaveBeenCalledTimes(1));
    const payload = dispatchOverrideSpy.mock.calls[0][0] as {
      lesionId: string;
      newClass: string;
      reason: string;
      priorClass: string | null;
      analysisId: string;
    };
    expect(payload.lesionId).toBe('lesion-1');
    expect(payload.newClass).toBe('MET'); // 'metastasis' → MET
    expect(payload.reason).toMatch(/metastatic/);
    expect(payload.priorClass).toBe('HCC'); // fixture lesion-1 was HCC
    expect(payload.analysisId).toBe(CASE_ID);
  });

  it('renders the empty state when the fixture has zero lesions', async () => {
    stubLesionFetch([]);
    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('lesions-empty-state')).toBeTruthy(),
    );
  });

  it('renders the error alert with retry when the results endpoint fails', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/analyses/') && url.endsWith('/results')) {
        return new Response('boom', { status: 500 });
      }
      if (url.endsWith('/stream')) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    });

    await renderView();

    await waitFor(() =>
      expect(screen.getByTestId('lesions-error-alert')).toBeTruthy(),
    );
    expect(screen.getByTestId('lesions-retry-button')).toBeTruthy();
  });
});
