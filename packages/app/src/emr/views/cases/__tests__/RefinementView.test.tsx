// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RefinementView tests.
 *
 * Strategy:
 *   - Mock the heavy children (LiverViewer3D, RefineTools, ReviewTools,
 *     CouinaudLegend, LayerToggle, TakeoverRequestToast,
 *     ConflictResolutionModal) with inert stubs so tests run without the
 *     Cornerstone3D stack or ViewerState/Accessibility providers.
 *   - Mock hooks (`useAnalysis`, `useReviewSeat`, `useRefinementDispatch`,
 *     `useRefinementUndo`, `useSync`, `useAuth`) via a mutable `mockState`
 *     block reset per test.
 *   - All tests go through `renderWithProviders` + a minimal Routes tree so
 *     `useParams()` resolves `:id` to a real value.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders } from '../../../../test-utils';

// ---------------------------------------------------------------------------
// Mutable mock state (reset in beforeEach)
// ---------------------------------------------------------------------------

interface MockSeat {
  status: 'idle' | 'acquiring' | 'held' | 'degraded' | 'lost';
  hasSeat: boolean;
  holderDisplayName: string | null;
  reviewId: string | null;
}

interface MockSync {
  status: 'online' | 'offline' | 'syncing';
  queueDepth: number;
}

interface MockState {
  permissions: string[];
  seat: MockSeat;
  sync: MockSync;
  dispatchImpl: () => Promise<string>;
  undoStack: Array<{
    id: string;
    analysisId: string;
    editType: string;
    inverse: Record<string, unknown>;
    label: string;
    createdAt: string;
  }>;
}

const mockState: MockState = {
  permissions: ['review.refine_mask'],
  seat: {
    status: 'held',
    hasSeat: true,
    holderDisplayName: null,
    reviewId: 'review-abc',
  },
  sync: { status: 'online', queueDepth: 0 },
  dispatchImpl: async () => 'edit-1',
  undoStack: [],
};

const acquireSpy = vi.fn().mockResolvedValue(undefined);
const releaseSpy = vi.fn().mockResolvedValue(undefined);
const dispatchMaskSpy = vi.fn();
const dispatchLesionPromptSpy = vi.fn().mockResolvedValue('edit-lesion-prompt-1');
const dispatchMarkerSpy = vi.fn().mockResolvedValue('edit-marker-1');
const dispatchOverrideSpy = vi.fn().mockResolvedValue('edit-override-1');
const undoSpy = vi.fn().mockResolvedValue(null);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useAnalysis', () => ({
  useAnalysis: () => ({
    analysis: { id: 'case-42', status: 'completed' },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useReviewSeat', () => ({
  useReviewSeat: () => ({
    status: mockState.seat.status,
    hasSeat: mockState.seat.hasSeat,
    holderDisplayName: mockState.seat.holderDisplayName,
    reviewId: mockState.seat.reviewId,
    analysisId: 'case-42',
    seatHeldUntil: null,
    isLoading: false,
    acquire: acquireSpy,
    release: releaseSpy,
    requestTakeover: vi.fn(),
    requestTransfer: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useRefinementDispatch', () => ({
  useRefinementDispatch: () => ({
    dispatchMaskRefine: dispatchMaskSpy,
    dispatchLesionPrompt: dispatchLesionPromptSpy,
    dispatchMarker: dispatchMarkerSpy,
    dispatchClassificationOverride: dispatchOverrideSpy,
  }),
}));

vi.mock('../../../contexts/RefinementUndoContext', () => ({
  useRefinementUndo: () => ({
    stack: mockState.undoStack,
    isUndoing: false,
    push: vi.fn().mockResolvedValue(undefined),
    undo: undoSpy,
    clear: vi.fn().mockResolvedValue(undefined),
  }),
  RefinementUndoProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock('../../../contexts/SyncContext', () => ({
  useSync: () => ({
    status: mockState.sync.status,
    queueDepth: mockState.sync.queueDepth,
    lastSyncAt: null,
    nudge: vi.fn(),
  }),
  SYNC_WORKER_EVENT: 'liverra:sync-worker-tick',
  SyncProvider: ({ children }: { children: React.ReactNode }) => children,
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

// Heavy / provider-dependent component stubs.
vi.mock('../../../components/liver/LiverViewer3D', () => ({
  LiverViewer3D: () =>
    React.createElement('div', { 'data-testid': 'viewer-stub' }, 'viewer'),
}));

vi.mock('../../../components/liver/RefineTools', () => ({
  RefineTools: ({
    activeTool,
    onToolChange,
    disabled,
  }: {
    activeTool: string | null;
    onToolChange: (t: string | null) => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'refine-tools-stub' },
      React.createElement(
        'span',
        { 'data-testid': 'refine-tools-active' },
        activeTool ?? 'none',
      ),
      React.createElement(
        'span',
        { 'data-testid': 'refine-tools-disabled' },
        disabled ? 'true' : 'false',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'tool-vista-add',
          onClick: () => onToolChange('add'),
          disabled,
        },
        'VISTA add',
      ),
    ),
}));

vi.mock('../../../components/liver/ReviewTools', () => ({
  ReviewTools: () =>
    React.createElement('div', { 'data-testid': 'review-tools-stub' }),
}));

vi.mock('../../../components/liver/CouinaudLegend', () => ({
  CouinaudLegend: () =>
    React.createElement('div', { 'data-testid': 'couinaud-legend-stub' }),
}));

vi.mock('../../../components/liver/LayerToggle', () => ({
  LayerToggle: () =>
    React.createElement('div', { 'data-testid': 'layer-toggle-stub' }),
}));

vi.mock('../../../components/liver/TakeoverRequestToast', () => ({
  TakeoverRequestToast: () =>
    React.createElement('div', { 'data-testid': 'takeover-toast-stub' }),
}));

const conflictModalOpenedRef = { current: false };
vi.mock('../../../components/offline/ConflictResolutionModal', () => {
  // Self-mount on the same event the real modal listens to — just enough
  // signal for the "409 opens the modal" assertion.
  const { useEffect, useState } = React;
  return {
    ConflictResolutionModal: () => {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const onConflict = (): void => {
          conflictModalOpenedRef.current = true;
          setOpen(true);
        };
        window.addEventListener(
          'liverra:conflict-resolution',
          onConflict as EventListener,
        );
        return () => {
          window.removeEventListener(
            'liverra:conflict-resolution',
            onConflict as EventListener,
          );
        };
      }, []);
      return open
        ? React.createElement('div', {
            'data-testid': 'conflict-resolution-modal-stub',
          })
        : null;
    },
  };
});

vi.mock('../../../components/access-control', async () => {
  const actual = await vi.importActual<typeof import('../../../components/access-control')>(
    '../../../components/access-control',
  );
  return {
    ...actual,
    RecordLockBanner: () =>
      React.createElement('div', { 'data-testid': 'record-lock-banner-stub' }),
  };
});

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderView(opts?: {
  id?: string;
  initialEntries?: string[];
}): Promise<void> {
  const id = opts?.id ?? 'case-42';
  const entries = opts?.initialEntries ?? [`/cases/${id}/refine`];
  const { default: RefinementView } = await import('../RefinementView');
  renderWithProviders(
    React.createElement(
      Routes,
      null,
      React.createElement(Route, {
        path: '/cases/:id/refine',
        element: React.createElement(RefinementView),
      }),
    ),
    { initialEntries: entries },
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockState.permissions = ['review.refine_mask'];
  mockState.seat = {
    status: 'held',
    hasSeat: true,
    holderDisplayName: null,
    reviewId: 'review-abc',
  };
  mockState.sync = { status: 'online', queueDepth: 0 };
  mockState.dispatchImpl = async () => 'edit-1';
  mockState.undoStack = [];
  acquireSpy.mockClear();
  acquireSpy.mockResolvedValue(undefined);
  releaseSpy.mockClear();
  dispatchMaskSpy.mockReset();
  dispatchMaskSpy.mockImplementation(() => mockState.dispatchImpl());
  dispatchOverrideSpy.mockClear();
  undoSpy.mockReset();
  undoSpy.mockResolvedValue(null);
  conflictModalOpenedRef.current = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RefinementView', () => {
  it('calls useReviewSeat.acquire(analysisId) on mount when the seat is not yet held', async () => {
    // Start in an idle, no-seat state so the effect actually triggers acquire.
    mockState.seat = {
      status: 'idle',
      hasSeat: false,
      holderDisplayName: null,
      reviewId: null,
    };
    await renderView();
    await waitFor(() => {
      expect(acquireSpy).toHaveBeenCalledWith('case-42');
    });
  });

  it('calls useReviewSeat.release() on unmount', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByTestId('refinement-view')).toBeTruthy());
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    await waitFor(() => {
      expect(releaseSpy).toHaveBeenCalled();
    });
  });

  it('renders the seat-taken warning and hides the viewer when acquire fails', async () => {
    mockState.seat = {
      status: 'idle',
      hasSeat: false,
      holderDisplayName: 'Dr. Other',
      reviewId: null,
    };
    await renderView();
    await waitFor(() =>
      expect(screen.getByTestId('refinement-view-seat-taken')).toBeTruthy(),
    );
    expect(screen.queryByTestId('viewer-stub')).toBeNull();
    expect(screen.queryByTestId('refinement-view-refine-tools')).toBeNull();
  });

  it('activates the VISTA add tool when V is pressed', async () => {
    await renderView();
    await waitFor(() =>
      expect(screen.getByTestId('refine-tools-stub')).toBeTruthy(),
    );
    expect(screen.getByTestId('refine-tools-active').textContent).toBe('none');
    fireEvent.keyDown(window, { key: 'v' });
    await waitFor(() =>
      expect(screen.getByTestId('refine-tools-active').textContent).toBe('add'),
    );
  });

  it('triggers undo on Ctrl+Z', async () => {
    mockState.undoStack = [
      {
        id: 'edit-1',
        analysisId: 'case-42',
        editType: 'mask_refine',
        inverse: {},
        label: 'add @ (1,2,3)',
        createdAt: new Date().toISOString(),
      },
    ];
    await renderView();
    await waitFor(() => expect(screen.getByTestId('refinement-view')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
  });

  it('calls dispatchMaskRefine with the correct payload on a viewer-click event', async () => {
    await renderView();
    await waitFor(() => expect(screen.getByTestId('refinement-view')).toBeTruthy());
    // Activate the add tool so clickType resolves correctly.
    fireEvent.click(screen.getByTestId('tool-vista-add'));
    // Simulate a click the viewer would normally emit.
    window.dispatchEvent(
      new CustomEvent('liverra:viewer-click', {
        detail: {
          voxel: [10, 20, 30],
          segmentationId: 'parenchyma',
          clickType: 'add',
        },
      }),
    );
    await waitFor(() => expect(dispatchMaskSpy).toHaveBeenCalledTimes(1));
    const payload = dispatchMaskSpy.mock.calls[0][0] as {
      analysisId: string;
      segmentationId: string;
      clickType: string;
      voxel: [number, number, number];
    };
    expect(payload.analysisId).toBe('case-42');
    expect(payload.segmentationId).toBe('parenchyma');
    expect(payload.clickType).toBe('add');
    expect(payload.voxel).toEqual([10, 20, 30]);
  });

  it('opens the conflict modal when dispatch rejects with a 409 conflict event', async () => {
    // dispatchMaskRefine triggers a 409 → worker → conflictResolver, which
    // fires `liverra:conflict-resolution`. We simulate that event directly
    // since the mock dispatch does not really hit the queue.
    dispatchMaskSpy.mockImplementation(async () => {
      window.dispatchEvent(
        new CustomEvent('liverra:conflict-resolution', {
          detail: {
            conflictId: 'conflict-1',
            analysisId: 'case-42',
            clientVersion: 1,
            serverVersion: 2,
          },
        }),
      );
      return 'edit-409';
    });
    await renderView();
    await waitFor(() => expect(screen.getByTestId('refinement-view')).toBeTruthy());
    window.dispatchEvent(
      new CustomEvent('liverra:viewer-click', {
        detail: { voxel: [1, 2, 3] },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('conflict-resolution-modal-stub')).toBeTruthy(),
    );
    expect(conflictModalOpenedRef.current).toBe(true);
  });

  it('shows the record-lock banner when the seat is lost and disables tools', async () => {
    mockState.seat = {
      status: 'lost',
      hasSeat: false,
      holderDisplayName: null,
      reviewId: null,
    };
    await renderView();
    await waitFor(() =>
      expect(screen.getByTestId('record-lock-banner-stub')).toBeTruthy(),
    );
    expect(screen.getByTestId('refine-tools-disabled').textContent).toBe('true');
    // The VISTA add button is disabled too.
    const addBtn = screen.getByTestId('tool-vista-add') as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('shows the offline banner when sync is offline with queued edits', async () => {
    mockState.sync = { status: 'offline', queueDepth: 3 };
    await renderView();
    await waitFor(() =>
      expect(screen.getByTestId('refinement-view-offline-banner')).toBeTruthy(),
    );
  });

  it('disables tool buttons when the user lacks review.refine_mask', async () => {
    mockState.permissions = [];
    await renderView();
    await waitFor(() =>
      expect(screen.getByTestId('refine-tools-stub')).toBeTruthy(),
    );
    expect(screen.getByTestId('refine-tools-disabled').textContent).toBe('true');
  });

  it('renders the synthetic overlay when ?devMockMask=1 and a dispatch succeeds', async () => {
    await renderView({
      initialEntries: ['/cases/case-42/refine?devMockMask=1'],
    });
    await waitFor(() => expect(screen.getByTestId('refinement-view')).toBeTruthy());
    // Overlay should be present but inactive initially.
    const overlay = screen.getByTestId('refinement-view-synthetic-overlay');
    expect(overlay.getAttribute('data-flash-active')).toBe('false');

    window.dispatchEvent(
      new CustomEvent('liverra:viewer-click', {
        detail: { voxel: [1, 2, 3] },
      }),
    );
    await waitFor(() => expect(dispatchMaskSpy).toHaveBeenCalled());
    await waitFor(() => {
      expect(
        screen
          .getByTestId('refinement-view-synthetic-overlay')
          .getAttribute('data-flash-active'),
      ).toBe('true');
    });
  });
});
