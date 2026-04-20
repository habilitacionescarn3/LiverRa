// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Progressive Loader — Smart loading for large DICOM studies (LiverRa)
// ============================================================================
// When a study has hundreds or thousands of images, loading them all at once
// would be slow and eat up memory. Think of this like Netflix buffering: you
// see the first few seconds instantly while it downloads the rest in the
// background.
//
// The loader:
//   1. Detects "large" studies (>100 instances by default)
//   2. Loads the first batch immediately (50 images) for instant display
//   3. Streams remaining images in the background, prioritized by where the
//      user is currently scrolling (so nearby frames load first)
//   4. Manages an LRU cache that evicts old images when memory gets full,
//      keeping at most 2000 images in memory
//
// This is a pure service — no React. The hook (useProgressiveLoader) wraps it.
//
// Ported drop-in from MediMind `services/pacs/progressiveLoader.ts`. Works
// against any DICOMweb backend; auth token (Cognito JWT in LiverRa) is
// supplied via `setAuthToken()`.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export type LoaderStatus =
  | 'idle'
  | 'loading-initial'
  | 'loading-background'
  | 'complete'
  | 'error';

export interface LoadProgress {
  total: number;
  loaded: number;
  /** Percentage complete (0-100) */
  percent: number;
  status: LoaderStatus;
}

export interface ProgressiveLoaderConfig {
  /** Threshold for "large study" detection (default: 100) */
  largeStudyThreshold?: number;
  /** Number of instances to load in the first batch (default: 50) */
  initialBatchSize?: number;
  /** Number of instances to load per background batch (default: 20) */
  backgroundBatchSize?: number;
  /** Maximum images to keep in memory (default: 2000) */
  maxImagesInMemory?: number;
  /** Eviction trigger: evict when cache reaches this % of max (default: 0.8) */
  evictionThreshold?: number;
  /** Delay between background batches in ms (default: 100) */
  batchDelayMs?: number;
}

interface CacheEntry {
  url: string;
  lastAccessed: number;
  index: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG: Required<ProgressiveLoaderConfig> = {
  largeStudyThreshold: 100,
  initialBatchSize: 50,
  backgroundBatchSize: 20,
  maxImagesInMemory: 2000,
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
 * loader.setPriorityIndex(42); // user scrolled to frame 42
 * loader.dispose();
 * ```
 */
export class ProgressiveLoader {
  private config: Required<ProgressiveLoaderConfig>;
  private cache: Map<string, CacheEntry>;
  private loadedIndices: Set<number>;
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
   * requests behind the nginx proxy.
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  isLargeStudy(instanceCount: number): boolean {
    return instanceCount > this.config.largeStudyThreshold;
  }

  setOnProgress(callback: (progress: LoadProgress) => void): void {
    this.onProgress = callback;
  }

  /**
   * Start loading a study progressively.
   *
   * Loads the first batch immediately, then resolves. Background loading of
   * remaining instances continues asynchronously. If the study is small
   * enough, loads everything in the initial batch.
   *
   * @param instanceUrls - Ordered array of all wadors: instance URLs
   */
  async loadStudy(instanceUrls: string[]): Promise<void> {
    this.cancel();

    this.cache.clear();
    this.loadedIndices.clear();
    this.allInstanceUrls = instanceUrls;
    this.priorityIndex = 0;
    this.abortController = new AbortController();

    if (instanceUrls.length === 0) {
      this.status = 'complete';
      this.emitProgress();
      return;
    }

    // Phase 1: Load initial batch immediately
    this.status = 'loading-initial';
    this.emitProgress();

    const initialCount = Math.min(this.config.initialBatchSize, instanceUrls.length);
    const initialIndices = Array.from({ length: initialCount }, (_, i) => i);

    try {
      await this.loadBatch(initialIndices);
    } catch {
      if (!this.abortController?.signal.aborted) {
        this.status = 'error';
        this.emitProgress();
      }
      return;
    }

    if (this.loadedIndices.size >= instanceUrls.length) {
      this.status = 'complete';
      this.emitProgress();
      return;
    }

    // Phase 2: Background loading (fire-and-forget)
    this.status = 'loading-background';
    this.emitProgress();
    this.runBackgroundLoader().catch(() => {
      // Background errors are non-fatal — partial loading is still useful
    });
  }

  /**
   * Update the priority index (call when the user scrolls to a new frame).
   * Background loading prioritizes frames near this index.
   */
  setPriorityIndex(index: number): void {
    this.priorityIndex = Math.max(0, Math.min(index, this.allInstanceUrls.length - 1));
  }

  /**
   * Record that an image was accessed — updates the LRU timestamp.
   * Call when Cornerstone3D actually displays an image.
   */
  touchImage(url: string): void {
    const entry = this.cache.get(url);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
  }

  isLoaded(index: number): boolean {
    return this.loadedIndices.has(index);
  }

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
   * Cancel any in-progress background loading. Already-loaded images stay
   * in the cache. Call dispose() to fully reset.
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
   */
  dispose(): void {
    this.cancel();
    this.cache.clear();
    this.loadedIndices.clear();
    this.allInstanceUrls = [];
    this.status = 'idle';
    this.priorityIndex = 0;
    this.onProgress = null;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async loadBatch(indices: number[]): Promise<void> {
    const signal = this.abortController?.signal;

    const fetches = indices
      .filter((i) => !this.loadedIndices.has(i) && i >= 0 && i < this.allInstanceUrls.length)
      .map(async (index) => {
        const rawUrl = this.allInstanceUrls[index];

        // Cornerstone3D uses a custom wadors: protocol prefix.
        // fetch() only works with http/https, so strip the prefix.
        const url = rawUrl.startsWith('wadors:') ? rawUrl.slice('wadors:'.length) : rawUrl;

        try {
          const headers: Record<string, string> = { Accept: 'application/dicom+json' };
          if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
          }
          await fetch(url, { headers, signal });
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
          }
          // Individual frame network errors are non-fatal
          return;
        }

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

  private async runBackgroundLoader(): Promise<void> {
    const signal = this.abortController?.signal;

    while (this.loadedIndices.size < this.allInstanceUrls.length) {
      if (signal?.aborted) {
        return;
      }

      const batch = this.getNextPriorityBatch();
      if (batch.length === 0) {
        break;
      }

      try {
        await this.loadBatch(batch);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Non-abort errors: continue with next batch (partial loading is fine)
      }

      this.emitProgress();

      if (signal && !signal.aborted) {
        await this.delay(this.config.batchDelayMs, signal);
      }
    }

    if (this.loadedIndices.size >= this.allInstanceUrls.length) {
      this.status = 'complete';
      this.emitProgress();
    }
  }

  /**
   * Get the next batch of indices to load, sorted by proximity to the
   * user's current scroll position (priorityIndex).
   */
  private getNextPriorityBatch(): number[] {
    const unloaded: number[] = [];
    for (let i = 0; i < this.allInstanceUrls.length; i++) {
      if (!this.loadedIndices.has(i)) {
        unloaded.push(i);
      }
    }

    if (unloaded.length === 0) {
      return [];
    }

    const priority = this.priorityIndex;
    unloaded.sort((a, b) => Math.abs(a - priority) - Math.abs(b - priority));

    return unloaded.slice(0, this.config.backgroundBatchSize);
  }

  /**
   * Evict LRU cache entries when the cache exceeds the eviction threshold.
   * Never evicts images near the user's current scroll position.
   */
  private evictIfNeeded(): void {
    const maxBeforeEviction = Math.floor(
      this.config.maxImagesInMemory * this.config.evictionThreshold
    );

    if (this.cache.size <= maxBeforeEviction) {
      return;
    }

    const safeStart = Math.max(0, this.priorityIndex - this.config.initialBatchSize);
    const safeEnd = Math.min(
      this.allInstanceUrls.length - 1,
      this.priorityIndex + this.config.initialBatchSize
    );

    const candidates: CacheEntry[] = [];
    for (const entry of this.cache.values()) {
      if (entry.index < safeStart || entry.index > safeEnd) {
        candidates.push(entry);
      }
    }

    candidates.sort((a, b) => a.lastAccessed - b.lastAccessed);

    const evictCount = this.cache.size - maxBeforeEviction;
    for (let i = 0; i < Math.min(evictCount, candidates.length); i++) {
      this.cache.delete(candidates[i].url);
      this.loadedIndices.delete(candidates[i].index);
    }
  }

  private emitProgress(): void {
    if (this.onProgress) {
      this.onProgress(this.getProgress());
    }
  }

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
