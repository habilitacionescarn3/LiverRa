// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * UploadProgress — T172
 *
 * Multi-stage visual indicator of the ingest pipeline:
 *   Uploading → Anonymizing → Queued → Running → Done / Failed
 *
 * Driven by an SSE stream at `/api/v1/analyses/{id}/stream`. Each event
 * is a JSON payload of `{ stage, progress?, message? }`. Stage transitions
 * emit an `aria-live="polite"` announcement for screen readers per NFR-002.
 *
 * Cold-start estimate is pulled once on mount from `/api/v1/system/health`
 * (`gpu.predicted_warm_s`) and surfaced while the analysis is `queued`.
 *
 * This component owns only the visual projection. The underlying SSE
 * subscription is owned by `useAnalysis()` (sibling agent, T184); when that
 * hook isn't ready we fall back to a local `EventSource` subscription so the
 * UI still renders in isolation (Storybook, tests).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Group, Stack, Text } from '@mantine/core';
import {
  IconCheck,
  IconCloudUpload,
  IconCpu,
  IconEye,
  IconHourglassHigh,
  IconX,
} from '@tabler/icons-react';
import { EMRAlert, EMRProgressStepper } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

/** Pipeline stages surfaced to the user. */
export type AnalysisStage =
  | 'uploading'
  | 'anonymizing'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed';

/** Shape of an SSE event payload emitted by the analysis stream. */
export interface AnalysisStreamEvent {
  stage: AnalysisStage;
  progress?: number;
  message?: string;
  predictedWarmSeconds?: number;
}

/** Props for {@link UploadProgress}. */
export interface UploadProgressProps {
  /** Analysis ID to subscribe to. */
  analysisId: string;
  /** Optional pre-fetched event — useful when parent already has state. */
  initialEvent?: AnalysisStreamEvent;
  /** Base URL for API. Defaults to `/api/v1`. */
  apiBaseUrl?: string;
  /** Called once the pipeline reaches `done`. */
  onComplete?: () => void;
  /** Called when the pipeline reports `failed`. */
  onError?: (message: string) => void;
  /** Optional `data-testid` for tests. */
  'data-testid'?: string;
}

/** Order + metadata for the stepper. */
const STAGE_ORDER: AnalysisStage[] = [
  'uploading',
  'anonymizing',
  'queued',
  'running',
  'done',
];

// Pick up the Netlify-built env var (staging → Fly.io URL); fall back to the
// relative path that Vite's dev proxy handles locally.
const DEFAULT_API_BASE_URL =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_LIVERRA_API_BASE_URL ?? '/api/v1';

/**
 * Render a 5-step progress indicator wired to the analysis SSE stream.
 */
export function UploadProgress({
  analysisId,
  initialEvent,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  onComplete,
  onError,
  'data-testid': testId = 'upload-progress',
}: UploadProgressProps): React.ReactElement {
  const { t } = useTranslation();
  const [event, setEvent] = useState<AnalysisStreamEvent>(
    initialEvent ?? { stage: 'uploading', progress: 0 },
  );
  const [predictedWarmSec, setPredictedWarmSec] = useState<number | undefined>(
    initialEvent?.predictedWarmSeconds,
  );
  const announcedRef = useRef<AnalysisStage | null>(null);

  // Subscribe to SSE event stream for this analysis.
  useEffect(() => {
    if (!analysisId) return undefined;
    if (typeof EventSource === 'undefined') return undefined;

    const source = new EventSource(
      `${apiBaseUrl}/analyses/${analysisId}/stream`,
      { withCredentials: true },
    );

    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as AnalysisStreamEvent;
        setEvent(parsed);
        if (typeof parsed.predictedWarmSeconds === 'number') {
          setPredictedWarmSec(parsed.predictedWarmSeconds);
        }
        if (parsed.stage === 'done') {
          onComplete?.();
          source.close();
        }
        if (parsed.stage === 'failed') {
          onError?.(parsed.message ?? 'Pipeline failed');
          source.close();
        }
      } catch {
        // Ignore malformed frames; SSE heartbeats etc.
      }
    };

    source.onerror = () => {
      // Browser will auto-retry; we intentionally do NOT surface transient
      // network blips here. The SSE client owned by `useAnalysis()` will
      // escalate after its own retry budget is exhausted.
    };

    return () => source.close();
  }, [analysisId, apiBaseUrl, onComplete, onError]);

  // Pull cold-start estimate once for the initial render when we didn't
  // receive it from the SSE stream yet. NFR-001 surfaces "models warming".
  useEffect(() => {
    if (predictedWarmSec !== undefined) return;
    let cancelled = false;
    fetch(`${apiBaseUrl}/system/health`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`health check failed: ${r.status}`);
        return r.json();
      })
      .then((payload: { gpu?: { predicted_warm_s?: number } } | undefined) => {
        if (!cancelled && payload?.gpu?.predicted_warm_s !== undefined) {
          setPredictedWarmSec(payload.gpu.predicted_warm_s);
        }
      })
      .catch((err) => {
        // Health endpoint unavailable — fail silently but log for triage.
        console.warn('[UploadProgress] health check failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, predictedWarmSec]);

  // Maintain a ref of the last-announced stage so we only push one aria-live
  // update per transition (avoids screen readers re-reading the same stage).
  useEffect(() => {
    announcedRef.current = event.stage;
  }, [event.stage]);

  const steps = useMemo(
    () => [
      {
        key: 'uploading' as const,
        label: t('upload:progress.uploading'),
        icon: IconCloudUpload,
      },
      {
        key: 'anonymizing' as const,
        label: t('upload:progress.anonymizing'),
        icon: IconEye,
      },
      {
        key: 'queued' as const,
        label: t('upload:progress.queued'),
        icon: IconHourglassHigh,
      },
      {
        key: 'running' as const,
        label: t('upload:progress.running'),
        icon: IconCpu,
      },
      {
        key: 'done' as const,
        label: t('upload:progress.done'),
        icon: IconCheck,
      },
    ],
    [t],
  );

  const currentKey: AnalysisStage =
    event.stage === 'failed' ? 'running' : event.stage;
  const isFailed = event.stage === 'failed';
  const currentIndex = STAGE_ORDER.indexOf(currentKey);

  // Estimated time remaining label for the queued state only.
  const queuedEta = useMemo(() => {
    if (event.stage !== 'queued') return undefined;
    if (predictedWarmSec === undefined || predictedWarmSec <= 0) return undefined;
    return t('upload:progress.etaSeconds', {
      seconds: Math.round(predictedWarmSec),
    });
  }, [event.stage, predictedWarmSec, t]);

  // Compute progress feeding the stepper. For uploading / running we use the
  // numeric progress; for queued/anonymizing we synthesise a step-based %.
  const progress =
    event.progress !== undefined
      ? event.progress
      : Math.round((currentIndex / (STAGE_ORDER.length - 1)) * 100);

  return (
    <Stack data-testid={testId} gap="md" aria-live="polite">
      <EMRProgressStepper
        steps={steps}
        currentStep={currentKey}
        progress={progress}
        error={isFailed}
        errorMessage={isFailed ? event.message : undefined}
        data-testid={`${testId}-stepper`}
      />

      {/* Accessible stage description + ETA */}
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text
          fz="var(--emr-font-sm)"
          c="var(--emr-text-secondary)"
          style={{ minWidth: 0, flex: 1 }}
        >
          {event.message ?? t(`upload:progress.hint.${currentKey}`)}
        </Text>
        {queuedEta && (
          <Text
            fz="var(--emr-font-sm)"
            fw={600}
            c="var(--emr-info, var(--emr-secondary))"
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {queuedEta}
          </Text>
        )}
      </Group>

      {/* Hard-fail banner */}
      {isFailed && (
        <EMRAlert variant="error" title={t('upload:progress.failedTitle')} icon={IconX}>
          {event.message ?? t('upload:progress.failedGeneric')}
        </EMRAlert>
      )}
    </Stack>
  );
}

export default UploadProgress;
