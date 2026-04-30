// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test utilities for component and hook tests.
 *
 * Provides a `renderWithProviders` helper that wraps the given UI in the
 * minimum set of providers needed for most views: MantineProvider,
 * QueryClientProvider, MemoryRouter, and TranslationProvider.
 *
 * Callers can opt-in to additional providers (AuthContext, PermissionContext)
 * by passing pre-mocked values.
 */

import type { ReactElement, ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TranslationProvider } from './emr/contexts/TranslationContext';
import type { Locale } from './emr/services/localeService';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial URL for MemoryRouter. Defaults to `/`. */
  initialEntries?: string[];
  /** Initial locale. Defaults to `en`. */
  locale?: Locale;
  /** Optional pre-configured QueryClient. One is created if omitted. */
  queryClient?: QueryClient;
  /** Optional extra provider wrapper applied between MantineProvider and children. */
  wrapProviders?: (children: ReactNode) => ReactNode;
}

/**
 * Build a test QueryClient with sensible defaults: no retries, no cache,
 * silent logger (React Query v5 removed the logger option).
 */
export function buildTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Render a component with the standard provider stack. Returns the standard
 * RTL result plus the QueryClient in use (useful for invalidation assertions).
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const {
    initialEntries = ['/'],
    locale = 'en',
    queryClient = buildTestQueryClient(),
    wrapProviders = (c) => c,
    ...rest
  } = options;

  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <TranslationProvider initialLocale={locale}>
            {wrapProviders(children)}
          </TranslationProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );

  const result = render(ui, { wrapper: Wrapper, ...rest });
  return Object.assign(result, { queryClient });
}

/**
 * Build a `Response`-compatible fixture for `vi.spyOn(global, 'fetch')` mocks.
 */
export function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}
