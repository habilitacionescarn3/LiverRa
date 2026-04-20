// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useRUOSpotCheck (T350).
 *
 * Plain-English: when the reviewer clicks "Sample 20 artifacts" in the
 * compliance view, this hook POSTs to `/compliance/ruo-spot-check` and
 * returns a list of {artifactUrl, watermarkBbox, pass}. The `pass`
 * field stays `null` until the reviewer manually flips each thumbnail
 * — that state is held locally in the view (T348) and POST-ed back
 * separately once the whole batch is reviewed.
 *
 * Uses `useMutation` not `useQuery` because the request is intent-driven
 * (reviewer clicks "sample"), not a passive read.
 *
 * Spec refs: SC-009, contracts/api-openapi.yaml §/compliance/ruo-spot-check.
 */

import { useCallback, useState } from 'react';
import { useMutation } from '@tanstack/react-query';

export interface SpotCheckItem {
  artifact_url: string;
  watermark_bbox: number[];
  pass: boolean | null;
  artifact_kind?: string;
  artifact_id?: string;
}

export interface UseRUOSpotCheckResult {
  items: SpotCheckItem[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /** Trigger a new sample. Default size = 20 (SC-009). */
  sample: (sampleSize?: number) => Promise<SpotCheckItem[]>;
  /** Reviewer-local pass/fail toggle for one item (kept in hook state). */
  setPassFlag: (artifactId: string, pass: boolean | null) => void;
  reset: () => void;
}

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

async function postSample(sampleSize: number): Promise<SpotCheckItem[]> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/compliance/ruo-spot-check`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sample_size: sampleSize }),
  });
  if (!res.ok) throw new Error(`RUO spot-check failed: HTTP ${res.status}`);
  return (await res.json()) as SpotCheckItem[];
}

export function useRUOSpotCheck(): UseRUOSpotCheckResult {
  const [items, setItems] = useState<SpotCheckItem[]>([]);

  const mutation = useMutation<SpotCheckItem[], Error, number>({
    mutationFn: (sampleSize: number) => postSample(sampleSize),
    onSuccess: (data) => setItems(data),
  });

  const sample = useCallback(
    (sampleSize: number = 20) => mutation.mutateAsync(sampleSize),
    [mutation],
  );

  const setPassFlag = useCallback((artifactId: string, pass: boolean | null) => {
    setItems((prev) =>
      prev.map((it) =>
        it.artifact_id === artifactId || it.artifact_url === artifactId
          ? { ...it, pass }
          : it,
      ),
    );
  }, []);

  const reset = useCallback(() => setItems([]), []);

  return {
    items,
    isLoading: mutation.isPending,
    isError: mutation.isError,
    error: (mutation.error as Error | null) ?? null,
    sample,
    setPassFlag,
    reset,
  };
}
