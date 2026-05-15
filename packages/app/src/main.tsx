// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa app entry (T111 + T117 wiring).
 *
 * Provider nesting (outer → inner), mirroring plan.md §Contexts graph:
 *
 *   Mantine (theme primitives)
 *     QueryClient (TanStack Query cache)
 *       Translation (i18n bundles)
 *         Auth (OIDC + /auth/me)
 *           Permission (Set<LiverraPermission>)
 *             Theme (light/dark/auto + <html data-*>)
 *               Mobile (breakpoint + touch)
 *                 Accessibility (reduced-motion + live region)
 *                   Router (createBrowserRouter)
 *
 * Why this order:
 *   - Auth is highest so every descendant can ask "who am I?".
 *   - Permission depends on Auth.
 *   - Theme/Mobile/A11y are leaf contexts — they don't depend on Auth
 *     or Permission but are kept inside so Router-level consumers get
 *     them without re-mounting.
 *   - Router is innermost so the providers wrap every route.
 */

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import './emr/styles/theme.css';
import './emr/utils/installConsoleFilters';

import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { appRouter } from './AppRoutes';
import { AccessibilityProvider } from './emr/contexts/AccessibilityContext';
import { AuthProvider } from './emr/contexts/AuthContext';
import { MobileProvider } from './emr/contexts/MobileContext';
import { PermissionProvider } from './emr/contexts/PermissionContext';
import { ThemeProvider } from './emr/contexts/ThemeContext';
import { TranslationProvider } from './emr/contexts/TranslationContext';
import { fhirClient } from './emr/services/fhirClient';
import { initAuditService } from './emr/services/pacs/auditService';

// C-AUDIT-1 + C-PACS-2 fix: bootstrap the audit retry pipeline at app start.
// Before this call, every imaging-PHI access (study view, break-glass,
// annotation save) emitted ZERO events because the audit service was never
// initialised. Calling this first means even a buffered event from a prior
// tab (durable in IndexedDB) drains on next startup.
initAuditService(fhirClient);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: unknown) => {
        // errorClient.ts throws LiverraApiError with a typed `status`.
        // 4xx (except 429) should not retry; 429/5xx use jittered back-off.
        const status = (error as { status?: number } | undefined)?.status;
        if (status && status >= 400 && status < 500 && status !== 429) return false;
        return failureCount < 3;
      },
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('LiverRa root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <TranslationProvider>
          <AuthProvider>
            <PermissionProvider>
              <ThemeProvider>
                <MobileProvider>
                  <AccessibilityProvider>
                    <RouterProvider router={appRouter} />
                  </AccessibilityProvider>
                </MobileProvider>
              </ThemeProvider>
            </PermissionProvider>
          </AuthProvider>
        </TranslationProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
