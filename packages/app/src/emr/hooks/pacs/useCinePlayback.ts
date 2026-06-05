// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCinePlayback Hook
// ============================================================================
// Manages cine (video-like) playback for multi-frame DICOM images such as
// cardiac ultrasounds and fluoroscopy clips. Think of it like a music player's
// internal logic — it tracks the current frame, play/pause state, speed (FPS),
// and loops back to the start when playback reaches the last frame.
//
// Key design decisions:
// - Uses requestAnimationFrame for precise timing and auto-pause in background tabs
// - Refs for mutable state accessed inside the rAF callback to avoid stale closures
// - Cancels rAF on unmount to prevent memory leaks
// - Frame numbers are 0-based internally, displayed as 1-based in the UI
// ============================================================================

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { hasWebVideoEncoder } from '../../services/pacs/cornerstoneGlobals';

// ============================================================================
// Types
// ============================================================================

/** Playback direction mode — 'forward' loops normally, 'pingpong' bounces back and forth */
export type PlaybackMode = 'forward' | 'pingpong';

/** Allowed speed multiplier presets (e.g., 0.5x = half speed, 2x = double speed) */
export type SpeedMultiplier = 0.25 | 0.5 | 1 | 2 | 4;

/**
 * Callback to render a specific frame onto the viewport canvas.
 * The caller (PACSViewer) implements this to seek Cornerstone3D to a given frame,
 * wait for rendering, and return the canvas element showing that frame.
 */
export type RenderFrameCallback = (frameIndex: number) => Promise<HTMLCanvasElement>;

export interface UseCinePlaybackReturn {
  /** Whether cine playback is currently running */
  isPlaying: boolean;
  /** Current frame index (0-based) */
  currentFrame: number;
  /** Total number of frames in the active image */
  totalFrames: number;
  /** Playback speed in frames per second */
  fps: number;
  /** Whether the active image has multiple frames (totalFrames > 1) */
  isMultiFrame: boolean;
  /** Current playback mode */
  playbackMode: PlaybackMode;
  /** Current speed multiplier preset */
  speedMultiplier: SpeedMultiplier;
  /** Native frame rate detected from DICOM metadata; undefined when timing is unknown */
  nativeFrameRate?: number;
  /** Whether video export is in progress */
  isExporting: boolean;
  /** Export progress percentage (0-100) */
  exportProgress: number;
  /** Whether the browser supports WebCodecs (false on Firefox) */
  isWebCodecsSupported: boolean;
  /** Start playback */
  play: () => void;
  /** Stop playback */
  pause: () => void;
  /** Toggle between play and pause */
  togglePlayPause: () => void;
  /** Advance to the next frame (loops to first if at end) */
  stepForward: () => void;
  /** Go back to the previous frame (loops to last if at start) */
  stepBackward: () => void;
  /** Jump to a specific frame index */
  seekToFrame: (frame: number) => void;
  /** Change playback speed (1-60 fps) */
  setFps: (fps: number) => void;
  /** Set the total number of frames (called when a multi-frame image is loaded) */
  setTotalFrames: (total: number) => void;
  /** Switch between forward and ping-pong playback modes */
  setPlaybackMode: (mode: PlaybackMode) => void;
  /** Set the speed multiplier preset (0.25x to 4x) */
  setSpeedMultiplier: (multiplier: SpeedMultiplier) => void;
  /** Set the native frame rate (typically from detectNativeFps) */
  setNativeFrameRate: (fps: number | undefined) => void;
  /** Export cine frames as an MP4 video using WebCodecs + mp4-muxer */
  exportVideo: (renderFrame: RenderFrameCallback) => Promise<void>;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_FPS = 15;
export const MIN_FPS = 1;
export const MAX_FPS = 60;

/**
 * Detect mobile or low-memory devices that should not run cine at 60+ fps.
 * Triggered when the userAgent matches mobile, deviceMemory <= 4, or the user
 * has requested reduced motion (`prefers-reduced-motion: reduce`). Used to
 * clamp the upper FPS bound so devices don't thermal-throttle (PACS-B4).
 */
export function isLowPowerDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const lowMemory = typeof memory === 'number' && memory <= 4;
  let reducedMotion = false;
  try {
    reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch (err) {
    console.warn('[useCinePlayback] reduced-motion media query failed:', err);
  }
  return isMobile || lowMemory || reducedMotion;
}

/**
 * Returns true when the user has explicitly requested reduced motion.
 * Cine playback should default to paused in this case (PACS-B4).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch (err) {
    console.warn('[useCinePlayback] reduced-motion check failed:', err);
    return false;
  }
}

/**
 * Absolute upper bound for DICOM-derived FPS.
 * - Desktop / high-power devices: 120 fps
 * - Mobile / deviceMemory ≤ 4 GB / prefers-reduced-motion: 30 fps (PACS-B4)
 *
 * Capping on low-power devices prevents thermal throttling and battery drain
 * (Snapdragon 7-series mid-range devices hit ~12 W under sustained 60 fps cine).
 */
export const CLAMP_MAX_FPS = isLowPowerDevice() ? 30 : 120;

/**
 * Whether the browser supports WebCodecs VideoEncoder.
 * Firefox (as of 2025-2026) does not support WebCodecs — we hide the export
 * button rather than crashing or showing errors.
 */
export const isWebCodecsSupported: boolean =
  hasWebVideoEncoder();

// ============================================================================
// DICOM FrameTime Detection
// ============================================================================

/**
 * Detects the native FPS from DICOM metadata tags.
 *
 * Priority:
 * 1. FrameTime (0018,1063) — milliseconds per frame → fps = 1000 / FrameTime
 * 2. RecommendedDisplayFrameRate (0008,2144) — direct fps value
 * 3. CineRate (0018,0040) — direct fps value
 * 4. ActualFrameDuration (0018,1242) — microseconds per frame
 * 5. FrameTimeVector (0018,1065) — milliseconds per frame, averaged
 * 6. Returns undefined when no timing tags are present.
 *
 * Result is clamped between MIN_FPS and CLAMP_MAX_FPS.
 *
 * @param getMetaValue - A function that reads a DICOM tag value by keyword.
 *   Typically wraps cornerstone metaData.get('dicomTag', imageId).
 * @returns Native FPS when timing metadata exists; undefined when timing is unknown.
 */
export function detectNativeFps(
  getMetaValue: (keyword: string) => number | number[] | undefined
): number | undefined {
  // Try FrameTime first (ms per frame)
  const frameTime = getMetaValue('FrameTime');
  if (typeof frameTime === 'number' && frameTime > 0) {
    const fps = 1000 / frameTime;
    return Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, Math.round(fps * 100) / 100));
  }

  // Try RecommendedDisplayFrameRate (direct fps)
  const recommendedRate = getMetaValue('RecommendedDisplayFrameRate');
  if (typeof recommendedRate === 'number' && recommendedRate > 0) {
    return Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, recommendedRate));
  }

  const cineRate = getMetaValue('CineRate');
  if (typeof cineRate === 'number' && cineRate > 0) {
    return Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, cineRate));
  }

  const actualFrameDuration = getMetaValue('ActualFrameDuration');
  if (typeof actualFrameDuration === 'number' && actualFrameDuration > 0) {
    const fps = 1_000_000 / actualFrameDuration;
    return Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, Math.round(fps * 100) / 100));
  }

  const frameTimeVector = getMetaValue('FrameTimeVector');
  if (Array.isArray(frameTimeVector)) {
    const positiveTimes = frameTimeVector.filter((value) => value > 0);
    if (positiveTimes.length > 0) {
      const averageFrameTime = positiveTimes.reduce((sum, value) => sum + value, 0) / positiveTimes.length;
      const fps = 1000 / averageFrameTime;
      return Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, Math.round(fps * 100) / 100));
    }
  }

  return undefined;
}

// ============================================================================
// Hook
// ============================================================================

export function useCinePlayback(): UseCinePlaybackReturn {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [totalFrames, setTotalFramesState] = useState(1);
  const [fps, setFpsState] = useState(DEFAULT_FPS);
  const [playbackMode, setPlaybackModeState] = useState<PlaybackMode>('forward');
  const [speedMultiplier, setSpeedMultiplierState] = useState<SpeedMultiplier>(1);
  const [nativeFrameRate, setNativeFrameRateState] = useState<number | undefined>(undefined);

  // Refs to access current values inside the interval callback
  // without causing stale closures (the interval is set once and reads refs)
  const currentFrameRef = useRef(currentFrame);
  currentFrameRef.current = currentFrame;

  const totalFramesRef = useRef(totalFrames);
  totalFramesRef.current = totalFrames;

  const fpsRef = useRef(fps);
  fpsRef.current = fps;

  // Direction ref for ping-pong: +1 = forward, -1 = backward
  const directionRef = useRef<1 | -1>(1);

  const playbackModeRef = useRef(playbackMode);
  playbackModeRef.current = playbackMode;

  const speedMultiplierRef = useRef(speedMultiplier);
  speedMultiplierRef.current = speedMultiplier;

  const nativeFrameRateRef = useRef<number | undefined>(nativeFrameRate);
  nativeFrameRateRef.current = nativeFrameRate;

  // rAF-based playback: stores the animation frame ID for cancellation
  const rafIdRef = useRef<number | null>(null);
  // Tracks when the last frame was advanced (performance.now() timestamp)
  const lastFrameTimeRef = useRef(0);

  // Derived state
  const isMultiFrame = totalFrames > 1;

  // --------------------------------------------------------------------------
  // Internal: start/stop the playback timer (rAF-based)
  // --------------------------------------------------------------------------
  // Uses requestAnimationFrame instead of setInterval for two key benefits:
  // 1. rAF automatically pauses when the tab is backgrounded → saves CPU
  // 2. Frame timing is based on elapsed time → no drift at high FPS
  const startTimer = useCallback(() => {
    // Cancel any existing rAF loop first
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    lastFrameTimeRef.current = performance.now();

    const tick = (now: number): void => {
      // Calculate how much time has passed since the last frame advance
      const baseInterval = 1000 / (nativeFrameRateRef.current ?? fpsRef.current);
      const effectiveInterval = baseInterval / speedMultiplierRef.current;
      const elapsed = now - lastFrameTimeRef.current;

      if (elapsed >= effectiveInterval) {
        lastFrameTimeRef.current = now;

        setCurrentFrame((prev) => {
          const total = totalFramesRef.current;

          if (playbackModeRef.current === 'pingpong') {
            // Ping-pong: bounce back and forth between first and last frame
            const next = prev + directionRef.current;
            if (next >= total) {
              directionRef.current = -1;
              return total - 2 >= 0 ? total - 2 : 0;
            }
            if (next < 0) {
              directionRef.current = 1;
              return 1 < total ? 1 : 0;
            }
            return next;
          }

          // Forward mode: loop back to frame 0 at the end
          const next = prev + 1;
          return next >= total ? 0 : next;
        });
      }

      // Schedule the next tick — rAF fires at display refresh rate (~60Hz),
      // but we only advance frames when enough time has passed for the target FPS
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const stopTimer = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------
  const play = useCallback(() => {
    if (totalFramesRef.current <= 1) {
      return; // No point playing a single-frame image
    }
    // PACS-B4: honour `prefers-reduced-motion: reduce` — never auto-start
    // playback for users who have requested reduced motion. They can still
    // step frame-by-frame manually.
    if (prefersReducedMotion()) {
      return;
    }
    setIsPlaying(true);
    startTimer();
  }, [startTimer]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    stopTimer();
  }, [stopTimer]);

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const stepForward = useCallback(() => {
    if (totalFramesRef.current <= 1) {
      return;
    }
    // Pause if playing — stepping implies manual control
    if (rafIdRef.current !== null) {
      pause();
    }
    setCurrentFrame((prev) => (prev + 1 >= totalFramesRef.current ? 0 : prev + 1));
  }, [pause]);

  const stepBackward = useCallback(() => {
    if (totalFramesRef.current <= 1) {
      return;
    }
    if (rafIdRef.current !== null) {
      pause();
    }
    setCurrentFrame((prev) => (prev - 1 < 0 ? totalFramesRef.current - 1 : prev - 1));
  }, [pause]);

  const seekToFrame = useCallback((frame: number) => {
    const clamped = Math.max(0, Math.min(frame, totalFramesRef.current - 1));
    setCurrentFrame(clamped);
  }, []);

  const setFps = useCallback(
    (newFps: number) => {
      const clamped = Math.max(MIN_FPS, Math.min(MAX_FPS, newFps));
      setFpsState(clamped);
      fpsRef.current = clamped;
      // Manual FPS is a playback override, not DICOM native timing.
      setNativeFrameRateState(undefined);
      nativeFrameRateRef.current = undefined;

      // If currently playing, restart the timer with the new speed
      if (rafIdRef.current !== null) {
        stopTimer();
        startTimer();
      }
    },
    [stopTimer, startTimer]
  );

  const setPlaybackMode = useCallback(
    (mode: PlaybackMode) => {
      setPlaybackModeState(mode);
      playbackModeRef.current = mode;
      // Reset direction to forward when switching modes
      directionRef.current = 1;

      // If currently playing, restart timer to apply new mode
      if (rafIdRef.current !== null) {
        stopTimer();
        startTimer();
      }
    },
    [stopTimer, startTimer]
  );

  const setSpeedMultiplier = useCallback(
    (multiplier: SpeedMultiplier) => {
      setSpeedMultiplierState(multiplier);
      speedMultiplierRef.current = multiplier;

      // If currently playing, restart timer with new effective interval
      if (rafIdRef.current !== null) {
        stopTimer();
        startTimer();
      }
    },
    [stopTimer, startTimer]
  );

  const setNativeFrameRate = useCallback(
    (newFps: number | undefined) => {
      if (newFps === undefined) {
        setNativeFrameRateState(undefined);
        nativeFrameRateRef.current = undefined;
        return;
      }
      const clamped = Math.max(MIN_FPS, Math.min(CLAMP_MAX_FPS, newFps));
      setNativeFrameRateState(clamped);
      nativeFrameRateRef.current = clamped;
      // Also update the displayed fps to match native rate
      const displayFps = Math.min(clamped, MAX_FPS);
      setFpsState(displayFps);
      fpsRef.current = displayFps;

      // If currently playing, restart the timer with the new base rate
      if (rafIdRef.current !== null) {
        stopTimer();
        startTimer();
      }
    },
    [stopTimer, startTimer]
  );

  const setTotalFrames = useCallback(
    (total: number) => {
      const safeTotal = Math.max(1, total);
      setTotalFramesState(safeTotal);
      totalFramesRef.current = safeTotal;

      // Reset current frame if it's now out of bounds
      if (currentFrameRef.current >= safeTotal) {
        setCurrentFrame(0);
      }

      // Stop playback if new image is single-frame
      if (safeTotal <= 1 && rafIdRef.current !== null) {
        pause();
      }
    },
    [pause]
  );

  // --------------------------------------------------------------------------
  // Video Export (WebCodecs + mp4-muxer)
  // --------------------------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  // PACS-M10: track mounted state so unmount-during-export aborts the encode
  // loop and prevents calling `setIsExporting`/`setExportProgress` on a
  // disposed component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Export all cine frames as an MP4 video.
   *
   * How it works:
   * 1. Iterates through every frame (0 to totalFrames-1)
   * 2. Uses the provided renderFrame callback to draw each frame on the canvas
   * 3. Captures each rendered canvas as a VideoFrame
   * 4. Encodes with WebCodecs VideoEncoder (H.264 baseline profile)
   * 5. Muxes the encoded chunks into an MP4 container using mp4-muxer
   * 6. Triggers a browser download of the resulting .mp4 file
   *
   * @param renderFrame - Callback provided by the viewer that renders frame N
   *   onto the viewport canvas and returns the canvas element.
   */
  const exportVideo = useCallback(
    async (renderFrame: RenderFrameCallback): Promise<void> => {
      if (!isWebCodecsSupported || isExporting || totalFramesRef.current <= 1) {
        return;
      }

      // Pause playback during export so we can control frame-by-frame rendering
      if (rafIdRef.current !== null) {
        pause();
      }

      setIsExporting(true);
      setExportProgress(0);

      try {
        // Dynamic import — mp4-muxer is only loaded when the user actually exports
        const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

        const total = totalFramesRef.current;
        const exportFps = nativeFrameRateRef.current ?? fpsRef.current;

        // Render the first frame to determine canvas dimensions
        const firstCanvas = await renderFrame(0);
        const width = firstCanvas.width;
        const height = firstCanvas.height;

        // Ensure width/height are even (H.264 requires even dimensions)
        const encWidth = width % 2 === 0 ? width : width + 1;
        const encHeight = height % 2 === 0 ? height : height + 1;

        // Set up the MP4 muxer with an ArrayBuffer target (in-memory)
        const target = new ArrayBufferTarget();
        const muxer = new Muxer({
          target,
          video: {
            codec: 'avc',
            width: encWidth,
            height: encHeight,
          },
          fastStart: 'in-memory',
        });

        // Set up the WebCodecs VideoEncoder
        const encodedChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];

        const encoder = new VideoEncoder({
          output: (chunk, meta) => {
            muxer.addVideoChunk(chunk, meta);
            encodedChunks.push({ chunk, meta });
          },
          error: (err) => {
            console.warn('VideoEncoder error:', err);
          },
        });

        encoder.configure({
          codec: 'avc1.42001E', // H.264 Baseline Level 3.0
          width: encWidth,
          height: encHeight,
          bitrate: 2_000_000, // 2 Mbps — good quality for medical imaging
          framerate: exportFps,
        });

        // Encode each frame
        for (let i = 0; i < total; i++) {
          // PACS-M10: bail out of the encode loop if the component unmounted.
          if (!mountedRef.current) {
            try { encoder.close(); } catch (err) {
              console.warn('[useCinePlayback] best-effort PACS operation failed:', err);
            }
            return;
          }
          const canvas = await renderFrame(i);

          // Create a VideoFrame from the canvas (timestamp in microseconds)
          const timestampUs = (i / exportFps) * 1_000_000;
          const frame = new VideoFrame(canvas, { timestamp: timestampUs });

          // Every 10th frame is a keyframe for seeking capability
          const keyFrame = i % 10 === 0;
          encoder.encode(frame, { keyFrame });
          frame.close();

          // Update progress
          if (mountedRef.current) {
            setExportProgress(Math.round(((i + 1) / total) * 100));
          }
        }

        // Flush remaining frames and finalize
        await encoder.flush();
        encoder.close();
        muxer.finalize();

        // Create a downloadable blob from the muxed MP4 data
        const buffer = target.buffer;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);

        // Trigger download
        const link = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        link.download = `cine_export_${date}.mp4`;
        link.href = url;
        link.click();

        // Clean up the object URL after a short delay
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (err) {
        console.warn('Video export failed:', err);
      } finally {
        // PACS-M10: only update state if still mounted.
        if (mountedRef.current) {
          setIsExporting(false);
          setExportProgress(0);
        }
      }
    },
    [isExporting, pause]
  );

  // --------------------------------------------------------------------------
  // Cleanup on unmount
  // --------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // Memoize the return object so consumers don't re-render from a new
  // object reference on every parent render — only when individual values change
  return useMemo(() => ({
    isPlaying,
    currentFrame,
    totalFrames,
    fps,
    isMultiFrame,
    playbackMode,
    speedMultiplier,
    nativeFrameRate,
    isExporting,
    exportProgress,
    isWebCodecsSupported,
    play,
    pause,
    togglePlayPause,
    stepForward,
    stepBackward,
    seekToFrame,
    setFps,
    setTotalFrames,
    setPlaybackMode,
    setSpeedMultiplier,
    setNativeFrameRate,
    exportVideo,
  }), [
    isPlaying, currentFrame, totalFrames, fps, isMultiFrame,
    playbackMode, speedMultiplier, nativeFrameRate, isExporting,
    exportProgress, play, pause, togglePlayPause, stepForward,
    stepBackward, seekToFrame, setFps, setTotalFrames,
    setPlaybackMode, setSpeedMultiplier, setNativeFrameRate, exportVideo,
  ]);
}
