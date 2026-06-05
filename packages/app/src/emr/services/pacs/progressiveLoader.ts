// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Progressive Loader — Smart loading for large DICOM studies (LiverRa)
// ============================================================================
// When a study has hundreds or thousands of images, loading them all at once
// would be slow and eat up memory. Think of this like Netflix buffering: you
// see the first few seconds instantly while it downloads the rest in the
// background. The loader:
//   1. Detects "large" studies (>100 instances by default)
//   2. Loads the first batch immediately (50 images) for instant display
//   3. Streams remaining images in the background, prioritized by where the
//      user is currently scrolling (so nearby frames load first)
//   4. Manages an LRU (Least Recently Used) cache that evicts old images
//      when memory gets full, keeping at most 2000 images in memory
//
// This is a pure service — no React. The hook (useProgressiveLoader) wraps it.
//
// Ported from MediMind `services/pacs/progressiveLoader.ts`. Works against any
// DICOMweb backend; auth token (Cognito JWT in LiverRa) is supplied via
// `setAuthToken()`.
// ============================================================================

import { getDicomInstanceAcceptHeader } from './cornerstoneInit';

// ============================================================================
// Types
// ============================================================================

/** Status of the progressive loader */
export type LoaderStatus = 'idle' | 'loading-initial' | 'loading-background' | 'complete' | 'error';

/** Progress data emitted via callback so the UI can show a progress bar */
export interface LoadProgress {
  /** Total instances in the study */
  total: number;
  /** Number of instances loaded so far */
  loaded: number;
  /** Percentage complete (0-100) */
  percent: number;
  /** Current loader status */
  status: LoaderStatus;
}

/** Configuration for the progressive loader */
export interface ProgressiveLoaderConfig {
  /** Threshold for "large study" detection (default: 100) */
  largeStudyThreshold?: number;
  /** Number of instances to load in the first batch (default: 50) */
  initialBatchSize?: number;
  /** Number of instances to load per background batch (default: 20) */
  backgroundBatchSize?: number;
  /** Maximum images to keep in memory (default: 2000) */
  maxImagesInMemory?: number;
  /** Eviction trigger: evict when cache reaches this % of max (default: 0.8 = 80%) */
  evictionThreshold?: number;
  /** Delay between background batches in ms (default: 100) */
  batchDelayMs?: number;
}

/** An image entry in the LRU cache */
interface CacheEntry {
  /** Instance URL (wadors: URL for Cornerstone3D) */
  url: string;
  /** When this entry was last accessed (for LRU eviction) */
  lastAccessed: number;
  /** Index in the study's instance list */
  index: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * PACS-C10: choose a sensible image-cache cap based on device class.
 * - Desktop (deviceMemory > 4 GB or unknown): keep historical 2000 max
 *   (radiologists with workstation-class hardware).
 * - Mobile / deviceMemory <= 4: cap at 200. 2000 × ~150 KB/frame ≈ 300 MB,
 *   which OOM-kills iPhone 13 Mini and similar mid-range phones.
 */
function defaultMaxImages(): number {
  if (typeof navigator === 'undefined') return 2000;
  const ua = navigator.userAgent || '';
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (isMobile || (typeof memory === 'number' && memory <= 4)) {
    return 200;
  }
  return 2000;
}

const DEFAULT_CONFIG: Required<ProgressiveLoaderConfig> = {
  largeStudyThreshold: 100,
  initialBatchSize: 50,
  backgroundBatchSize: 20,
  maxImagesInMemory: defaultMaxImages(),
  evictionThreshold: 0.8,
  batchDelayMs: 100,
};

// ============================================================================
// ProgressiveLoader Class
// ============================================================================

/**
 * Manages progressive loading of DICOM instances for large studies.
 *
 * Usage:
 * ```ts
 * const loader = new ProgressiveLoader({ initialBatchSize: 50 });
 * loader.setAuthToken(getAccessToken());
 * loader.setOnProgress((p) => console.log(`${p.percent}% loaded`));
 * await loader.loadStudy(instanceUrls);
 * // Background loading continues automatically
 * loader.setPriorityIndex(42); // user scrolled to frame 42
 * loader.dispose(); // cleanup when done
 * ```
 */
export class ProgressiveLoader {
  private config: Required<ProgressiveLoaderConfig>;
  private cache: Map<string, CacheEntry>;
  private loadedIndices: Set<number>;
  private skippedFrameIndices: Set<number>;
  private allInstanceUrls: string[];
  private status: LoaderStatus;
  private abortController: AbortController | null;
  private priorityIndex: number;
  private onProgress: ((progress: LoadProgress) => void) | null;
  private authToken: string | null;

  constructor(config?: ProgressiveLoaderConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
    this.loadedIndices = new Set();
    this.skippedFrameIndices = new Set();
    this.allInstanceUrls = [];
    this.status = 'idle';
    this.abortController = null;
    this.priorityIndex = 0;
    this.onProgress = null;
    this.authToken = null;
  }

  /**
   * Set the auth token for prefetch requests (Cognito JWT in LiverRa).
   * Must be called before loadStudy() since Orthanc rejects unauthenticated
   * requests behind the nginx proxy. Pass null to clear the token.
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Check if a study is large enough to benefit from progressive loading.
   * Studies under the threshold can be loaded all at once normally.
   */
  isLargeStudy(instanceCount: number): boolean {
    return instanceCount > this.config.largeStudyThreshold;
  }

  /**
   * Set the progress callback. Called whenever loading status or count changes.
   * The UI can use this to render a progress bar.
   */
  setOnProgress(callback: (progress: LoadProgress) => void): void {
    this.onProgress = callback;
  }

  /**
   * Start loading a study progressively.
   *
   * Loads the first batch (initialBatchSize) immediately, then resolves.
   * Background loading of remaining instances continues asynchronously.
   * If the study is small enough, loads everything in the initial batch.
   *
   * @param instanceUrls - Ordered array of all wadors: instance URLs in the study
   */
  async loadStudy(instanceUrls: string[]): Promise<void> {
    // Cancel any in-flight loading from a previous study
    this.cancel();

    // Reset state for the new study
    this.cache.clear();
    this.loadedIndices.clear();
    this.skippedFrameIndices.clear();
    this.allInstanceUrls = instanceUrls;
    this.priorityIndex = 0;
    this.abortController = new AbortController();

    if (instanceUrls.length === 0) {
      this.status = 'complete';
      this.emitProgress();
      return;
    }

    // Phase 1: Load the initial batch immediately
    this.status = 'loading-initial';
    this.emitProgress();

    const initialCount = Math.min(this.config.initialBatchSize, instanceUrls.length);
    const initialIndices = Array.from({ length: initialCount }, (_, i) => i);

    try {
      await this.loadBatch(initialIndices);
    } catch (err) {
      // If initial load fails and it wasn't a cancellation, mark as error
      if (!this.abortController?.signal.aborted) {
        console.warn('[progressiveLoader] PACS fallback path failed:', err);
        this.status = 'error';
        this.emitProgress();
      }
      return;
    }

    if (this.loadedIndices.size === 0) {
      this.status = this.skippedFrameIndices.size > 0 ? 'idle' : 'error';
      this.emitProgress();
      return;
    }

    // If all instances fit in the initial batch, we're done
    if (this.loadedIndices.size >= instanceUrls.length) {
      this.status = 'complete';
      this.emitProgress();
      return;
    }

    // Phase 2: Start background loading (fire-and-forget from caller's perspective)
    this.status = 'loading-background';
    this.emitProgress();
    this.runBackgroundLoader().catch((err: unknown) => {
      console.warn('[progressiveLoader] best-effort PACS operation failed:', err);
      // Background errors are non-fatal — partial loading is still useful
    });
  }

  /**
   * Update the priority index (call when the user scrolls to a new frame).
   * Background loading will prioritize fetching frames near this index so
   * the images around where the user is looking load first.
   */
  setPriorityIndex(index: number): void {
    this.priorityIndex = Math.max(0, Math.min(index, this.allInstanceUrls.length - 1));
  }

  /**
   * Record that an image was accessed — updates the LRU timestamp.
   * Call this when Cornerstone3D actually displays an image so the cache
   * knows it's "recently used" and won't evict it prematurely.
   */
  touchImage(url: string): void {
    const entry = this.cache.get(url);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
  }

  /**
   * Check if a specific instance index has been loaded into the cache.
   */
  isLoaded(index: number): boolean {
    return this.loadedIndices.has(index);
  }

  /**
   * Get the current loading progress snapshot.
   */
  getProgress(): LoadProgress {
    const total = this.allInstanceUrls.length;
    const loaded = this.loadedIndices.size;
    return {
      total,
      loaded,
      percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
      status: this.status,
    };
  }

  /**
   * Cancel any in-progress background loading.
   * Already-loaded images stay in the cache. Call dispose() to fully reset.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.status === 'loading-initial' || this.status === 'loading-background') {
      this.status = 'idle';
      this.emitProgress();
    }
  }

  /**
   * Clear all cached images and reset the loader to its initial state.
   * Call this when the viewer is closed or switching to a different study.
   */
  dispose(): void {
    this.cancel();
    this.cache.clear();
    this.loadedIndices.clear();
    this.skippedFrameIndices.clear();
    this.allInstanceUrls = [];
    this.status = 'idle';
    this.priorityIndex = 0;
    this.onProgress = null;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  /**
   * Load a batch of instances by their indices.
   *
   * Each "load" issues a prefetch request to warm the browser's HTTP cache.
   * When Cornerstone3D later requests the wadors: URL, the browser serves it
   * from its cache instead of making a new network request.
   */
  private async loadBatch(indices: number[]): Promise<void> {
    const signal = this.abortController?.signal;

    const fetches = indices
      .filter((i) =>
        !this.loadedIndices.has(i) &&
        !this.skippedFrameIndices.has(i) &&
        i >= 0 &&
        i < this.allInstanceUrls.length
      )
      .map(async (index) => {
        const rawUrl = this.allInstanceUrls[index];

        // Cornerstone3D uses a custom wadors: protocol prefix.
        // fetch() only works with http/https, so strip the prefix.
        const url = rawUrl.startsWith('wadors:') ? rawUrl.slice('wadors:'.length) : rawUrl;

        // Per-frame WADO-RS URLs (`.../instances/<sop>/frames/<n>`) are
        // fetched by Cornerstone's image-load pool with a frame-specific Accept
        // header. This HTTP-cache warmer cannot reproduce that request safely,
        // so track them as skipped instead of reporting them as loaded.
        if (url.includes('/frames/')) {
          this.skippedFrameIndices.add(index);
          return;
        }

        try {
          // Prefetch the DICOM instance to warm the browser HTTP cache
          const headers: Record<string, string> = { Accept: getDicomInstanceAcceptHeader() };
          if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
          }
          const response = await fetch(url, { headers, signal });
          if (!response.ok) {
            throw new Error(`DICOM prefetch failed (${response.status})`);
          }
        } catch (err: unknown) {
          // Abort errors are expected during cancellation — rethrow
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          console.warn('[progressiveLoader] best-effort PACS operation failed:', err);
          // Network errors for individual frames are non-fatal — skip
          return;
        }

        // Register in our cache
        const entry: CacheEntry = {
          url,
          lastAccessed: Date.now(),
          index,
        };
        this.cache.set(url, entry);
        this.loadedIndices.add(index);
      });

    await Promise.all(fetches);
    this.evictIfNeeded();
  }

  /**
   * Background loading loop — loads remaining instances in batches,
   * prioritized by distance from the user's current scroll position.
   */
  private async runBackgroundLoader(): Promise<void> {
    const signal = this.abortController?.signal;

    while (this.getSettledIndexCount() < this.allInstanceUrls.length) {
      // Check for cancellation
      if (signal?.aborted) {
        return;
      }

      const batch = this.getNextPriorityBatch();
      if (batch.length === 0) {
        break; // All loaded
      }

      try {
        await this.loadBatch(batch);
      } catch (err: unknown) {
        // Abort errors mean we were cancelled — stop quietly
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        console.warn('[progressiveLoader] PACS fallback path failed:', err);
        // Other errors: continue with next batch (partial loading is fine)
      }

      this.emitProgress();

      // Pause between batches to avoid flooding the network and blocking the UI
      if (signal && !signal.aborted) {
        await this.delay(this.config.batchDelayMs, signal);
      }
    }

    // Mark as complete only if every index was actually warmed.
    if (this.loadedIndices.size >= this.allInstanceUrls.length) {
      this.status = 'complete';
      this.emitProgress();
    } else if (this.getSettledIndexCount() >= this.allInstanceUrls.length) {
      this.status = 'idle';
      this.emitProgress();
    }
  }

  private getSettledIndexCount(): number {
    return this.loadedIndices.size + this.skippedFrameIndices.size;
  }

  private isSettledIndex(index: number): boolean {
    return this.loadedIndices.has(index) || this.skippedFrameIndices.has(index);
  }

  /**
   * Get the next batch of indices to load, sorted by proximity to the
   * user's current scroll position (priorityIndex). Frames closest to
   * where the user is viewing get loaded first.
   *
   * PACS-C10: avoid the previous O(n) full scan + O(n log n) sort every
   * batch (≈22 000 ops/batch on a 2000-image study). Walk outward from
   * the priority index — the first N unloaded slots within `backgroundBatchSize`
   * are exactly the ones we want, so we never sort the full list.
   */
  private getNextPriorityBatch(): number[] {
    const total = this.allInstanceUrls.length;
    if (total === 0) return [];

    const target = this.config.backgroundBatchSize;
    const out: number[] = [];

    // Walk outward from priorityIndex: 0, ±1, ±2, ... so the closest unloaded
    // index is always picked first without sorting the entire pool.
    const priority = Math.min(Math.max(0, this.priorityIndex), total - 1);
    const maxDistance = Math.max(priority, total - 1 - priority);

    // distance 0
    if (!this.isSettledIndex(priority)) {
      out.push(priority);
    }

    for (let d = 1; d <= maxDistance && out.length < target; d++) {
      const left = priority - d;
      if (left >= 0 && !this.isSettledIndex(left)) {
        out.push(left);
        if (out.length >= target) break;
      }
      const right = priority + d;
      if (right < total && !this.isSettledIndex(right)) {
        out.push(right);
      }
    }

    return out;
  }

  /**
   * Evict least-recently-used cache entries when the cache exceeds the
   * eviction threshold (default 80% of maxImagesInMemory).
   *
   * Never evicts images near the user's current scroll position (within
   * initialBatchSize range) — those are likely needed soon.
   */
  private evictIfNeeded(): void {
    const maxBeforeEviction = Math.floor(
      this.config.maxImagesInMemory * this.config.evictionThreshold
    );

    if (this.cache.size <= maxBeforeEviction) {
      return;
    }

    // Determine the "safe zone" around the user's current position
    const safeStart = Math.max(0, this.priorityIndex - this.config.initialBatchSize);
    const safeEnd = Math.min(
      this.allInstanceUrls.length - 1,
      this.priorityIndex + this.config.initialBatchSize
    );

    // Collect eviction candidates (entries outside the safe zone)
    const candidates: CacheEntry[] = [];
    for (const entry of this.cache.values()) {
      if (entry.index < safeStart || entry.index > safeEnd) {
        candidates.push(entry);
      }
    }

    // Sort by lastAccessed ascending — oldest first
    candidates.sort((a, b) => a.lastAccessed - b.lastAccessed);

    // Evict until we're under the threshold
    const evictCount = this.cache.size - maxBeforeEviction;
    for (let i = 0; i < Math.min(evictCount, candidates.length); i++) {
      this.cache.delete(candidates[i].url);
      this.loadedIndices.delete(candidates[i].index);
    }
  }

  /** Emit the current progress to the callback (if registered) */
  private emitProgress(): void {
    if (this.onProgress) {
      this.onProgress(this.getProgress());
    }
  }

  /** Promise-based delay that respects the AbortSignal */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
