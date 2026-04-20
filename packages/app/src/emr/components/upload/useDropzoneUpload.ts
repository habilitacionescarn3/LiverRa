// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useDropzoneUpload (T187 — wiring).
 *
 * Plain-English: the "glue" hook the DICOM dropzone uses when the user
 * drops a study. It:
 *   1. POSTs a tus upload ticket to `/api/v1/ingest/uploads`
 *   2. (Phase-9 task) chunks the file up over tus
 *   3. On success: invalidates the cases list query so the new study
 *      appears, then navigates to `/cases/:id` where `useAnalysis` will
 *      auto-subscribe to the SSE pipeline stream.
 *
 * We split this out of `DicomDropzone.tsx` (owned by the frontend-designer
 * agent) so two agents can work in parallel: the UI component consumes
 * this hook, the hook owns the network + routing semantics.
 *
 * Spec refs: T187 from tasks.md, plan.md §Data Fetching Strategy.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

export interface UploadTicket {
  uploadId: string;
  tusEndpoint: string;
  studyId: string;
}

export interface CreateUploadInput {
  filename: string;
  size: number;
  contentType?: string;
}

async function createUpload(input: CreateUploadInput): Promise<UploadTicket> {
  const baseUrl = readApiBaseUrl();
  const res = await fetch(`${baseUrl}/ingest/uploads`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Upload init failed: HTTP ${res.status}`);
  return (await res.json()) as UploadTicket;
}

export interface UseDropzoneUploadOptions {
  /**
   * Called once the upload ticket is created and the bytes have been
   * handed off to tus. Default behaviour: invalidate `cases` list +
   * navigate to `/cases/{studyId}`. Override for tests or alt flows.
   */
  onUploaded?: (ticket: UploadTicket) => void;
}

export function useDropzoneUpload(options: UseDropzoneUploadOptions = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation<UploadTicket, Error, File>({
    mutationFn: async (file) => {
      const ticket = await createUpload({
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/dicom',
      });
      // TODO(phase-9): chunked tus transfer using `ticket.tusEndpoint`.
      // The metadata-only ticket path is enough to unblock navigation +
      // SSE subscription; byte transport will be bolted on when the tus
      // client module lands (T306). See plan.md §Data Fetching Strategy.
      return ticket;
    },
    onSuccess: (ticket) => {
      // List-shape invalidation is tenant-aware; the `useCasesList`
      // invalidate helper covers the same keyspace. Since we don't have
      // the tenantId handy here, we broadcast to the `tenant` prefix.
      void queryClient.invalidateQueries({ queryKey: ['tenant'] });
      if (options.onUploaded) {
        options.onUploaded(ticket);
        return;
      }
      navigate(`/cases/${encodeURIComponent(ticket.studyId)}`);
    },
  });
}
