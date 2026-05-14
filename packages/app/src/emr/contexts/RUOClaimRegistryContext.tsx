// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RUOClaimRegistryContext (T185).
 *
 * Plain-English: each AI output LiverRa produces (FLR, Couinaud segments,
 * lesion detections, classifications, exports) carries its own regulatory
 * lifecycle. One might still be "Research Use Only" in DACH while another
 * is already "CE Class IIb cleared" in Germany — and the UI must treat
 * them differently (full disclaimer vs. narrowed, watermark on/off, gate
 * the finalize button behind a step-up MFA, etc.).
 *
 * This context is the single source of truth: it fetches the per-tenant
 * `RegulatoryClaimRegistry` from `GET /api/v1/compliance/claim-registry`,
 * caches the result in `localStorage` for offline fallback, and re-fetches
 * every 5 minutes. Every UI surface that renders an AI output consumes
 * `useRUOClaim(claimKey)` → gets the right disclaimer variant, watermark
 * flag, and UI gate.
 *
 * Fail-safe principle (FR-028a): if the registry fetch fails, we fall back
 * to full RUO semantics (watermark required, full disclaimer shown,
 * visible gate). Never relax claims silently.
 *
 * Spec refs: plan.md §Claim Registry as feature-flag source, FR-028a/b.
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

/**
 * Local mirror of `@liverra/core/types` regulatory types.
 *
 * Kept duplicated here (vs. a direct workspace import) to avoid a hard
 * runtime dependency on `@liverra/core` from the app bundle until the
 * workspace build graph is wired in Phase 1 cleanup. Source of truth:
 * `packages/core/src/types/regulatory.ts`. Keep in sync.
 */
export type ClaimKey =
  | 'flr_volumetry'
  | 'parenchyma_segmentation'
  | 'couinaud_segmentation'
  | 'lesion_detection'
  | 'lesion_classification'
  | 'mask_refinement'
  | 'dicom_export';

export type ClaimStatus = 'ruo' | 'ce_class_iib' | 'fda_510k';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type DisclaimerVariant = 'ruo' | 'ce' | 'fda';
export type UiGate = 'visible' | 'hidden' | 'watermarked';

export interface ClaimRegistryEntry {
  claimKey: ClaimKey;
  status: ClaimStatus;
  disclaimerVariant: DisclaimerVariant;
  watermarkRequired: boolean;
  uiGate: UiGate;
}

export interface RUOClaimRegistryContextValue {
  registry: Record<ClaimKey, ClaimRegistryEntry>;
  isLoading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Defaults (fail-safe RUO semantics)
// ---------------------------------------------------------------------------

const ALL_CLAIM_KEYS: ClaimKey[] = [
  'flr_volumetry',
  'parenchyma_segmentation',
  'couinaud_segmentation',
  'lesion_detection',
  'lesion_classification',
  'mask_refinement',
  'dicom_export',
];

export const DEFAULT_RUO_ENTRY = (claimKey: ClaimKey): ClaimRegistryEntry => ({
  claimKey,
  status: 'ruo',
  disclaimerVariant: 'ruo',
  watermarkRequired: true,
  uiGate: 'visible',
});

function defaultRegistry(): Record<ClaimKey, ClaimRegistryEntry> {
  return Object.fromEntries(ALL_CLAIM_KEYS.map((k) => [k, DEFAULT_RUO_ENTRY(k)])) as Record<
    ClaimKey,
    ClaimRegistryEntry
  >;
}

const RUOClaimRegistryContext = createContext<RUOClaimRegistryContextValue | null>(null);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_STORAGE_KEY = 'liverra.claim-registry.cache';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

/**
 * Derive UI semantics from the backend row. Kept pure so the same mapping
 * can be asserted in unit tests + re-used by the PDF export filter.
 */
function deriveEntry(row: { claimKey: ClaimKey; status: ClaimStatus }): ClaimRegistryEntry {
  switch (row.status) {
    case 'fda_510k':
      return {
        claimKey: row.claimKey,
        status: row.status,
        disclaimerVariant: 'fda',
        watermarkRequired: false,
        uiGate: 'visible',
      };
    case 'ce_class_iib':
      return {
        claimKey: row.claimKey,
        status: row.status,
        disclaimerVariant: 'ce',
        watermarkRequired: false,
        uiGate: 'visible',
      };
    case 'ruo':
    default:
      return {
        claimKey: row.claimKey,
        status: 'ruo',
        disclaimerVariant: 'ruo',
        watermarkRequired: true,
        uiGate: 'visible',
      };
  }
}

function loadCache(): Record<ClaimKey, ClaimRegistryEntry> | null {
  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Record<ClaimKey, ClaimRegistryEntry>;
  } catch (e) {
    // L-CATCH-4: cache is best-effort warmup; corruption is rare and
    // the registry falls back to defaults. Log to console.debug so
    // dev tools can see it but production stays quiet.
    // eslint-disable-next-line no-console
    console.debug('[RUOClaimRegistry] cache load failed', { e });
    return null;
  }
}

function saveCache(registry: Record<ClaimKey, ClaimRegistryEntry>): void {
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(registry));
  } catch (e) {
    // L-CATCH-4: privacy mode / quota — non-critical, the next
    // refresh will repopulate from network if storage stays unavailable.
    // eslint-disable-next-line no-console
    console.debug('[RUOClaimRegistry] cache save failed', { e });
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface RUOClaimRegistryProviderProps {
  children: ReactNode;
  /** Test hook: skip network + timers; seed registry directly. */
  testOverrides?: { registry?: Record<ClaimKey, ClaimRegistryEntry> };
}

export function RUOClaimRegistryProvider({
  children,
  testOverrides,
}: RUOClaimRegistryProviderProps): JSX.Element {
  // L-HOOK-1: pin ``testOverrides`` so neither ``refresh`` nor the
  // interval effect re-runs on a parent re-render that happens to
  // re-create the prop. Tests pass a stable object once; prod never
  // supplies one. Capturing the value into a ref makes the dep array
  // ``[]``-equivalent without lying to the linter.
  const testOverridesRef = useRef(testOverrides);
  const hasTestOverrides = testOverridesRef.current !== undefined;

  const [registry, setRegistry] = useState<Record<ClaimKey, ClaimRegistryEntry>>(
    () => testOverridesRef.current?.registry ?? loadCache() ?? defaultRegistry(),
  );
  const [isLoading, setIsLoading] = useState<boolean>(!hasTestOverrides);
  const [error, setError] = useState<Error | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (testOverridesRef.current) return;
    try {
      const baseUrl = readApiBaseUrl();
      const res = await fetch(`${baseUrl}/compliance/claim-registry`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ claimKey: ClaimKey; status: ClaimStatus }>;
      if (cancelledRef.current) return;
      const next = defaultRegistry();
      for (const row of rows) {
        if (ALL_CLAIM_KEYS.includes(row.claimKey)) {
          next[row.claimKey] = deriveEntry(row);
        }
      }
      setRegistry(next);
      saveCache(next);
      setError(null);
    } catch (e) {
      // Fail-safe: keep whatever's in state (cache or defaults), surface
      // the error so observability can count it, but do NOT relax claims.
      if (!cancelledRef.current) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (!cancelledRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (testOverridesRef.current) return;
    cancelledRef.current = false;
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [refresh]);

  const value = useMemo<RUOClaimRegistryContextValue>(
    () => ({ registry, isLoading, error, refresh }),
    [registry, isLoading, error, refresh],
  );

  return (
    <RUOClaimRegistryContext.Provider value={value}>{children}</RUOClaimRegistryContext.Provider>
  );
}

/**
 * Consumer hook. Throws outside the provider. Prefer `useRUOClaim(key)` in
 * components — it returns the single entry with fail-safe default.
 */
export function useRUOClaimRegistryContext(): RUOClaimRegistryContextValue {
  const ctx = useContext(RUOClaimRegistryContext);
  if (!ctx) {
    throw new Error('useRUOClaimRegistryContext must be used inside <RUOClaimRegistryProvider>');
  }
  return ctx;
}

/**
 * Convenience hook — returns the registry entry for one claim key, falling
 * back to fail-safe RUO semantics if the registry provider is absent (so
 * storybook stories / isolated tests can mount these components without
 * wiring the full registry). Components should prefer this over reading
 * the raw registry object.
 *
 * Spec refs: FR-028a (fail-closed default), FR-028b (narrow-claim reads).
 */
export function useRUOClaim(claimKey: ClaimKey): ClaimRegistryEntry {
  const ctx = useContext(RUOClaimRegistryContext);
  if (!ctx) {
    // Fail-safe: if the provider is absent, treat the claim as full RUO.
    return DEFAULT_RUO_ENTRY(claimKey);
  }
  return ctx.registry[claimKey] ?? DEFAULT_RUO_ENTRY(claimKey);
}

export { RUOClaimRegistryContext };
