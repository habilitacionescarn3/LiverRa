// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useTriggerAnalysis.
 *
 * Plain-English: lets a button say "run AI on this study". Takes a DICOM
 * StudyInstanceUID (the OID-shaped string that identifies a study on
 * Orthanc), POSTs it to the backend's `/analyses/from-orthanc` endpoint,
 * which finds-or-creates the matching Postgres Study row and enqueues
 * the cascade. Returns the new (or existing — idempotent) analysis id
 * so the caller can navigate the user to the live progress view.
 *
 * Why a separate endpoint from `POST /analyses`? The canonical endpoint
 * expects a Postgres UUID (`study_id`). The PACS browser only knows the
 * DICOM StudyInstanceUID. `from-orthanc` bridges the two.
 */

import { useMutation } from '@tanstack/react-query';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export interface TriggerAnalysisInput {
  studyInstanceUid: string;
  patientRef?: string;
}

export interface TriggerAnalysisResult {
  analysisId: string;
  status: string;
  queuedAt: string;
}

async function triggerAnalysis(input: TriggerAnalysisInput): Promise<TriggerAnalysisResult> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/analyses/from-orthanc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      study_instance_uid: input.studyInstanceUid,
      patient_ref: input.patientRef ?? null,
    }),
  });
  if (!res.ok) {
    let detail: string;
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body?.detail ?? `HTTP ${res.status}`;
    } catch {
      detail = `HTTP ${res.status}`;
    }
    throw new Error(`Run AI failed: ${detail}`);
  }
  const body = (await res.json()) as {
    analysis_id: string;
    status: string;
    queued_at: string;
  };
  return {
    analysisId: body.analysis_id,
    status: body.status,
    queuedAt: body.queued_at,
  };
}

export function useTriggerAnalysis() {
  return useMutation({ mutationFn: triggerAnalysis });
}
