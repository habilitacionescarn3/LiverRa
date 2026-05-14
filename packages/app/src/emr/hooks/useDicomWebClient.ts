// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useDicomWebClient.
 *
 * Plain-English: hands components a ready-to-use DICOMweb client. The client
 * speaks QIDO-RS (search), WADO-RS (retrieve), and STOW-RS (store) against
 * our Orthanc. The hook wires the live Cognito session into the client's
 * per-request auth callback, so every QIDO/WADO/STOW request leaves the
 * browser with ``Authorization: Bearer <token>``.
 *
 * Earlier code hardcoded ``getAccessToken: () => null`` and relied on the
 * Vite dev-proxy to inject Basic auth server-side. That meant production
 * QIDO/WADO/STOW requests went out with NO Authorization header (audit
 * B-PACS-3). We now resolve the real access token from the auth module
 * AND assert at request time that production never sees a missing token.
 *
 * The client is memoised for the lifetime of the component; consumers can
 * keep the handle in useQuery keys without causing re-fetches.
 */

import { useMemo } from 'react';

import {
  createDicomWebClient,
  type DicomWebClientHandle,
} from '../services/pacs/dicomwebClient';
import { useAuth, getCurrentAccessToken } from '../services/auth';

export function useDicomWebClient(): DicomWebClientHandle {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? null;

  return useMemo(
    () =>
      createDicomWebClient({
        getAccessToken: () => {
          const token = getCurrentAccessToken();
          if (!token && import.meta.env.PROD) {
            // Production-only fail-loud guard. If a developer forgets to
            // wire auth before the next deploy, the runtime throw here
            // surfaces the misconfiguration BEFORE Orthanc receives an
            // unauthenticated request.
            throw new Error(
              'useDicomWebClient: PACS auth token missing in production. ' +
                'AuthContext must populate __setAuthStub({ user }) before ' +
                'any DICOMweb call.',
            );
          }
          return token;
        },
        getTenantId: () => tenantId,
      }),
    [tenantId],
  );
}
