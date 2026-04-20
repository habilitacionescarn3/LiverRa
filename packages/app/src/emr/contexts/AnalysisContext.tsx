// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AnalysisContext (T180).
 *
 * Plain-English: while the user is sitting on `/cases/:id`, the pipeline is
 * still churning in the background — parenchyma, vessels, segments, lesions,
 * FLR, report — one stage at a time. This context is the live ticker tape.
 * It opens a Server-Sent-Events (SSE) connection to
 * `GET /api/v1/analyses/{id}/stream`, pushes each `stage-complete` event
 * into `stageCheckpoints`, and merges the fresh snapshot of partial results
 * into `partialResults` so every child panel (FLR, lesion list, 3D viewer)
 * re-renders as results land — no full page refresh, no round-trip for each
 * stage.
 *
 * Analogy: the context is a newsroom wire feed. Reporters (the backend)
 * file stories as they come in; subscribers (child panels) see each new
 * headline the moment it hits the wire.
 *
 * Design notes:
 *   - Route-scoped provider (mounted in `AnalysisDetailView` via
 *     `AnalysisDetailProviders`, not at app root) so unmounting the view
 *     automatically closes the SSE connection.
 *   - Reconnects on transport errors with exponential backoff
 *     (1s → 2s → 4s → … → 30s cap) and replays missed events using the
 *     `Last-Event-ID` header per the SSE spec.
 *   - Hydrates `partialResults` on every `stage-complete` by refetching
 *     `GET /api/v1/analyses/{id}/results` — cheap, idempotent, and avoids
 *     bundling full result payloads into every SSE frame.
 *
 * Spec refs: plan.md §Contexts graph, §Data Fetching Strategy (SSE
 * streaming), research §C.2 (PipelineCheckpoint), FR-014a/b.
 */

import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Minimal analysis handle. The full typed shape comes from the generated
 * OpenAPI client (`useAnalysis` hook); this context only needs the id +
 * status so components without the full payload can still render skeletons.
 */
export interface Analysis {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial';
  stage?: string;
}

/**
 * One row of the pipeline checkpoint ledger (research §C.2).
 *
 * Emitted by the backend as an SSE `stage-complete` event; we keep the
 * ordered list in memory so the progress timeline UI (T177) can render.
 */
export interface PipelineCheckpoint {
  stage:
    | 'anonymization'
    | 'parenchyma'
    | 'vessels'
    | 'couinaud'
    | 'lesion_detection'
    | 'classification'
    | 'flr_init'
    | string;
  startedAt: string;
  completedAt: string;
  outcome: 'ok' | 'partial' | 'failed';
  durationMs: number;
  outputHash?: string;
}

/**
 * Partial-result bag. Opaque on purpose — the real typed payload is owned
 * by `useAnalysis` (TanStack Query cache). This bag is just what SSE has
 * pushed since the current connection opened.
 */
export interface AnalysisResults {
  [key: string]: unknown;
}

export interface AnalysisContextValue {
  analysisId: string;
  analysis: Analysis | null;
  isStreaming: boolean;
  stageCheckpoints: PipelineCheckpoint[];
  partialResults: AnalysisResults;
  subscribeSSE: () => void;
  unsubscribeSSE: () => void;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AnalysisProviderProps {
  analysisId: string;
  children: ReactNode;
  /** When `false`, do not open the SSE stream on mount. Tests use this. */
  autoSubscribe?: boolean;
}

export function AnalysisProvider({
  analysisId,
  children,
  autoSubscribe = true,
}: AnalysisProviderProps): JSX.Element {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stageCheckpoints, setStageCheckpoints] = useState<PipelineCheckpoint[]>([]);
  const [partialResults, setPartialResults] = useState<AnalysisResults>({});

  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef<number>(BACKOFF_MIN_MS);
  const lastEventIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manuallyClosedRef = useRef(false);

  // --- result hydration (separate network request after each stage) -------
  const hydrateResults = useCallback(async () => {
    try {
      const baseUrl = readApiBaseUrl();
      const res = await fetch(`${baseUrl}/analyses/${encodeURIComponent(analysisId)}/results`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const json = (await res.json()) as AnalysisResults;
      setPartialResults(json);
    } catch {
      // Transient fetch errors are swallowed — next stage-complete retries.
    }
  }, [analysisId]);

  // --- SSE lifecycle -----------------------------------------------------
  const openStream = useCallback(() => {
    if (esRef.current) return; // already open
    manuallyClosedRef.current = false;
    const baseUrl = readApiBaseUrl();
    // Native EventSource has no header API; `Last-Event-ID` is sent
    // automatically by browsers on reconnect, but we also expose it as a
    // query param as a belt-and-braces measure for proxies that strip it.
    const url = new URL(
      `${baseUrl}/analyses/${encodeURIComponent(analysisId)}/stream`,
      window.location.origin,
    );
    if (lastEventIdRef.current) url.searchParams.set('last_event_id', lastEventIdRef.current);

    const es = new EventSource(url.toString(), { withCredentials: true });
    esRef.current = es;
    setIsStreaming(true);

    const track = (ev: MessageEvent<string>): void => {
      if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
      backoffRef.current = BACKOFF_MIN_MS; // healthy traffic resets backoff
    };

    es.addEventListener('open', () => {
      backoffRef.current = BACKOFF_MIN_MS;
    });

    es.addEventListener('analysis-update', (ev) => {
      track(ev as MessageEvent<string>);
      try {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as Analysis;
        setAnalysis(parsed);
      } catch {
        // ignore malformed frames
      }
    });

    es.addEventListener('stage-complete', (ev) => {
      track(ev as MessageEvent<string>);
      try {
        const parsed = JSON.parse((ev as MessageEvent<string>).data) as PipelineCheckpoint;
        setStageCheckpoints((prev) => {
          // De-dup on (stage, completedAt) — SSE can replay on reconnect.
          const key = `${parsed.stage}|${parsed.completedAt}`;
          if (prev.some((c) => `${c.stage}|${c.completedAt}` === key)) return prev;
          return [...prev, parsed];
        });
      } catch {
        // ignore
      }
      void hydrateResults();
    });

    es.addEventListener('error', () => {
      // Native EventSource would auto-reconnect, but we want bounded
      // exponential backoff + to surface `isStreaming=false` to the UI.
      if (manuallyClosedRef.current) return;
      es.close();
      esRef.current = null;
      setIsStreaming(false);

      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, BACKOFF_MAX_MS);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        openStream();
      }, delay);
    });
  }, [analysisId, hydrateResults]);

  const closeStream = useCallback(() => {
    manuallyClosedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  useEffect(() => {
    if (autoSubscribe) openStream();
    return () => closeStream();
    // Re-open when analysisId changes (route param swap).
  }, [analysisId, autoSubscribe, openStream, closeStream]);

  const value = useMemo<AnalysisContextValue>(
    () => ({
      analysisId,
      analysis,
      isStreaming,
      stageCheckpoints,
      partialResults,
      subscribeSSE: openStream,
      unsubscribeSSE: closeStream,
    }),
    [analysisId, analysis, isStreaming, stageCheckpoints, partialResults, openStream, closeStream],
  );

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

/**
 * Consumer hook. Throws when called outside `<AnalysisProvider>` to catch
 * wiring bugs at dev-time rather than silently rendering stale data.
 */
export function useAnalysisContext(): AnalysisContextValue {
  const ctx = useContext(AnalysisContext);
  if (!ctx) {
    throw new Error('useAnalysisContext must be used inside <AnalysisProvider>');
  }
  return ctx;
}

export { AnalysisContext };
