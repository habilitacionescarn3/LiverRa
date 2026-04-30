// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * useDicomWebClient.
 *
 * Plain-English: hands components a ready-to-use DICOMweb client. The client
 * speaks QIDO-RS (search), WADO-RS (retrieve), and STOW-RS (store) against
 * our Orthanc. In local dev, auth is added by the Vite proxy (Basic auth
 * injected server-side, see `vite.config.ts`), so the hook's getAccessToken
 * returns null and the client sends no Authorization header from the browser
 * — the proxy fills it in. In prod, the same callback will pull the Cognito
 * access token once that wiring lands.
 *
 * The client is memoised for the lifetime of the component; consumers can
 * keep the handle in useQuery keys without causing re-fetches.
 */

import { useMemo } from 'react';

import {
  createDicomWebClient,
  type DicomWebClientHandle,
} from '../services/pacs/dicomwebClient';
import { useAuth } from '../services/auth';

export function useDicomWebClient(): DicomWebClientHandle {
  const { tenant } = useAuth();
  const tenantId = tenant?.id ?? null;

  return useMemo(
    () =>
      createDicomWebClient({
        // Dev: Vite proxy injects Basic auth server-side.
        // Prod: swap this to `authStub.user?.access_token ?? null` once the
        //       access token is exposed from the auth module.
        getAccessToken: () => null,
        getTenantId: () => tenantId,
      }),
    [tenantId],
  );
}
