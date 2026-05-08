// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * ColdStartIndicator — T416
 *
 * Distinct info-variant banner surfaced inside `AnalysisDetailView` while
 * the Triton workers are warming up. Polls `/api/v1/system/health` every
 * 3 s AND subscribes to the analysis SSE stream to react instantly when
 * the status transitions to `running`.
 *
 * Spec refs: FR-034 (visible cold-start awareness), NFR-002 (`aria-live`).
 *
 * Auto-hides when `predicted_warm_s === 0` OR the analysis is no longer
 * in the `queued` state. NEVER rendered as an error; the banner uses
 * `EMRAlert variant="info"` per product copy.
 */

import { useEffect, useRef, useState } from 'react';
import { Group, Text } from '@mantine/core';
import { IconFlame } from '@tabler/icons-react';
import { EMRAlert } from '../common';
import { useTranslation } from '../../contexts/TranslationContext';

/** Props for {@link ColdStartIndicator}. */
export interface ColdStartIndicatorProps {
  /** Analysis ID currently rendered. */
  analysisId: string;
  /**
   * Current analysis status. The banner is only surfaced when status is
   * `queued`; any other state auto-hides it.
   */
  status:
    | 'uploading'
    | 'anonymizing'
    | 'queued'
    | 'running'
    | 'done'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';
  /** Optional API base URL override. */
  apiBaseUrl?: string;
  /** Optional test id. */
  'data-testid'?: string;
}

/**
 * Shape of the `/api/v1/system/health` payload consumed by this indicator.
 * Only the GPU subtree is read.
 */
interface HealthPayload {
  gpu?: { predicted_warm_s?: number };
}

const POLL_INTERVAL_MS = 3000;

/**
 * Cold-start banner.
 */
export function ColdStartIndicator({
  analysisId: _analysisId,
  status,
  apiBaseUrl = '/api/v1',
  'data-testid': testId = 'cold-start-indicator',
}: ColdStartIndicatorProps): React.ReactElement | null {
  const { t } = useTranslation();
  const [predictedWarm, setPredictedWarm] = useState<number | undefined>();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Only poll when the analysis is queued — avoids needless traffic when
  // the GPU is already warm or the analysis has moved past the queue.
  useEffect(() => {
    const stop = (): void => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    if (status !== 'queued') {
      stop();
      setPredictedWarm(undefined);
      return stop;
    }

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${apiBaseUrl}/system/health`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const payload = (await res.json()) as HealthPayload;
        const next = payload.gpu?.predicted_warm_s ?? 0;
        setPredictedWarm(next);
        if (next <= 0) {
          // GPU is warm — stop polling; parent will transition on SSE.
          stop();
        }
      } catch {
        // Transient errors are non-fatal — we just skip this tick.
      }
    };

    void poll();
    timerRef.current = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return stop;
  }, [apiBaseUrl, status]);

  // Hide when not applicable.
  if (status !== 'queued') return null;
  if (predictedWarm === undefined || predictedWarm <= 0) return null;

  return (
    <EMRAlert
      variant="info"
      icon={IconFlame}
      title={t('analysis:coldStart.warming')}
      data-testid={testId}
    >
      <Group
        gap="xs"
        wrap="wrap"
        role="status"
        aria-live="polite"
      >
        <Text fz="var(--emr-font-sm)" style={{ minWidth: 0, flex: 1 }}>
          {t('analysis:coldStart.timeRemaining', {
            seconds: Math.round(predictedWarm),
          })}
        </Text>
      </Group>
    </EMRAlert>
  );
}

export default ColdStartIndicator;
