// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// CineControls Component
// ============================================================================
// A playback bar for multi-frame DICOM images (cardiac echo, fluoroscopy, etc.).
// Think of it like a video player's transport bar — play/pause, skip forward/back,
// a progress slider to scrub through frames, and a speed knob.
//
// Sits at the bottom of each viewport cell. Completely hidden for single-frame
// images so it doesn't clutter the view when looking at a regular X-ray.
//
// Layout: [⏮] [▶/⏸] [⏭]  ━━━━●━━━━  12/45  Speed: [====●====] 15fps
// ============================================================================

import { ActionIcon, Slider, Tooltip } from '@mantine/core';
import {
  IconPlayerPlay,
  IconPlayerPause,
  IconPlayerSkipForward,
  IconPlayerSkipBack,
  IconArrowsRightLeft,
  IconDownload,
} from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
import './CineControls.css';

// ============================================================================
// Constants
// ============================================================================

// TODO(phase-4): Import PlaybackMode/SpeedMultiplier from
// `../../hooks/pacs/useCinePlayback` once that hook is ported. Types inlined
// so this presentational bar can ship before the hook lands.
export type PlaybackMode = 'forward' | 'pingpong';
export type SpeedMultiplier = 0.25 | 0.5 | 1 | 2 | 4;

const SPEED_PRESETS: SpeedMultiplier[] = [0.25, 0.5, 1, 2, 4];

// ============================================================================
// Types
// ============================================================================

export interface CineControlsProps {
  /** Whether the active image has multiple frames */
  isMultiFrame: boolean;
  /** Whether playback is currently running */
  isPlaying: boolean;
  /** Current frame index (0-based) */
  currentFrame: number;
  /** Total number of frames */
  totalFrames: number;
  /** Playback speed in frames per second */
  fps: number;
  /** Current playback mode */
  playbackMode?: PlaybackMode;
  /** Current speed multiplier */
  speedMultiplier?: SpeedMultiplier;
  /** Native frame rate from DICOM metadata */
  nativeFrameRate?: number;
  /** Toggle play/pause */
  onTogglePlay: () => void;
  /** Go to next frame */
  onStepForward: () => void;
  /** Go to previous frame */
  onStepBackward: () => void;
  /** Seek to a specific frame (0-based index) */
  onSeek: (frame: number) => void;
  /** Change playback speed */
  onFpsChange: (fps: number) => void;
  /** Change playback mode */
  onPlaybackModeChange?: (mode: PlaybackMode) => void;
  /** Change speed multiplier */
  onSpeedMultiplierChange?: (multiplier: SpeedMultiplier) => void;
  /** Whether WebCodecs video export is supported in this browser */
  isWebCodecsSupported?: boolean;
  /** Whether a video export is currently in progress */
  isExporting?: boolean;
  /** Export progress percentage (0-100) */
  exportProgress?: number;
  /** Called when the user clicks the Export Video button */
  onExportVideo?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function CineControls({
  isMultiFrame,
  isPlaying,
  currentFrame,
  totalFrames,
  fps,
  playbackMode = 'forward',
  speedMultiplier = 1,
  nativeFrameRate,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onSeek,
  onFpsChange,
  onPlaybackModeChange,
  onSpeedMultiplierChange,
  isWebCodecsSupported = false,
  isExporting = false,
  exportProgress = 0,
  onExportVideo,
}: CineControlsProps): JSX.Element | null {
  const { t } = useTranslation();

  // Don't render anything for single-frame images
  if (!isMultiFrame) {
    return null;
  }

  // Display frame numbers as 1-based for clinicians (humans count from 1)
  const displayCurrent = currentFrame + 1;
  const displayTotal = totalFrames;
  const isPingPong = playbackMode === 'pingpong';

  return (
    <div
      className="cine-controls"
      // Stop click events from propagating to the viewport cell behind us
      // (otherwise clicking play would also select/focus the viewport)
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="toolbar"
      aria-label={t('pacs.cineControls')}
    >
      {/* ---- Transport: Prev / Play-Pause / Next / PingPong ---- */}
      <div className="cine-controls-transport">
        <Tooltip label={t('pacs.cine.prevFrame')} withArrow position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={onStepBackward}
            aria-label={t('pacs.cine.prevFrame')}
          >
            <IconPlayerSkipBack size={18} color="var(--emr-text-inverse)" />
          </ActionIcon>
        </Tooltip>

        <Tooltip
          label={isPlaying ? t('pacs.cine.pause') : t('pacs.cine.play')}
          withArrow
          position="top"
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={onTogglePlay}
            aria-label={isPlaying ? t('pacs.cine.pause') : t('pacs.cine.play')}
          >
            {isPlaying ? (
              <IconPlayerPause size={18} color="var(--emr-text-inverse)" />
            ) : (
              <IconPlayerPlay size={18} color="var(--emr-text-inverse)" />
            )}
          </ActionIcon>
        </Tooltip>

        <Tooltip label={t('pacs.cine.nextFrame')} withArrow position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            onClick={onStepForward}
            aria-label={t('pacs.cine.nextFrame')}
          >
            <IconPlayerSkipForward size={18} color="var(--emr-text-inverse)" />
          </ActionIcon>
        </Tooltip>

        {/* Ping-pong toggle — switches between forward-loop and bounce modes */}
        {onPlaybackModeChange && (
          <Tooltip
            label={isPingPong ? t('pacs.cine.forwardMode') : t('pacs.cine.pingpongMode')}
            withArrow
            position="top"
          >
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              onClick={() => onPlaybackModeChange(isPingPong ? 'forward' : 'pingpong')}
              aria-label={isPingPong ? t('pacs.cine.forwardMode') : t('pacs.cine.pingpongMode')}
              className={isPingPong ? 'cine-controls-active' : undefined}
            >
              <IconArrowsRightLeft size={18} color={isPingPong ? 'var(--emr-accent)' : 'var(--emr-text-inverse)'} />
            </ActionIcon>
          </Tooltip>
        )}

        {/* Export Video — only shown when WebCodecs is available */}
        {isWebCodecsSupported && onExportVideo && (
          <Tooltip
            label={isExporting ? `${t('pacs.cine.exporting')} ${exportProgress}%` : t('pacs.cine.exportVideo')}
            withArrow
            position="top"
          >
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              onClick={onExportVideo}
              disabled={isExporting}
              aria-label={t('pacs.cine.exportVideo')}
              className={isExporting ? 'cine-controls-active' : undefined}
              style={{ minWidth: 44, minHeight: 44 }}
            >
              <IconDownload size={18} color={isExporting ? 'var(--emr-accent)' : 'var(--emr-text-inverse)'} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>

      {/* ---- Progress slider ---- */}
      <div className="cine-controls-progress">
        <Slider
          min={0}
          max={totalFrames - 1}
          value={currentFrame}
          onChange={onSeek}
          size="sm"
          color="var(--emr-accent)"
          label={(val) => `${val + 1}`}
          aria-label={t('pacs.cine.frameSlider')}
          styles={{
            track: { background: 'rgba(255,255,255,0.2)' },
            bar: { background: 'var(--emr-accent)' },
            thumb: {
              background: 'var(--emr-accent)',
              borderColor: 'var(--emr-accent)',
              width: 12,
              height: 12,
            },
          }}
        />
      </div>

      {/* ---- Frame counter ---- */}
      <div className="cine-controls-frame-counter">
        {displayCurrent} / {displayTotal}
      </div>

      {/* ---- Speed multiplier presets ---- */}
      {onSpeedMultiplierChange && (
        <div className="cine-controls-speed-presets">
          {SPEED_PRESETS.map((preset) => (
            <Tooltip key={preset} label={`${t('pacs.cine.speed')}: ${preset}x`} withArrow position="top">
              <button
                type="button"
                className={`cine-speed-btn${speedMultiplier === preset ? ' cine-speed-btn-active' : ''}`}
                onClick={() => onSpeedMultiplierChange(preset)}
                aria-label={`${preset}x`}
              >
                {preset}x
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      {/* ---- Speed control (fps slider) ---- */}
      <div className="cine-controls-speed">
        <span className="cine-controls-speed-label">
          {nativeFrameRate ?? fps} {t('pacs.cine.fps')}
        </span>
        <Slider
          min={1}
          max={60}
          value={fps}
          onChange={onFpsChange}
          size="xs"
          color="var(--emr-accent)"
          w={80}
          label={(val) => `${val} fps`}
          aria-label={t('pacs.cine.speedSlider')}
          styles={{
            track: { background: 'rgba(255,255,255,0.2)' },
            bar: { background: 'var(--emr-accent)' },
            thumb: {
              background: 'var(--emr-accent)',
              borderColor: 'var(--emr-accent)',
              width: 10,
              height: 10,
            },
          }}
        />
      </div>
    </div>
  );
}
