// SPDX-FileCopyrightText: Copyright LiverRa (ported from MediMind, original Orangebot/Medplum)
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// SeriesBrowser Component
// ============================================================================
// A horizontally scrollable filmstrip of series thumbnails — like the thumbnail
// strip at the bottom of a photo editing app. Shows all series in a study so
// the user can quickly navigate between them.
//
// Each thumbnail shows:
//   - A preview image (lazy-loaded for performance)
//   - A modality badge (e.g., "CT", "MR") in the top-right corner
//   - The series description below the image
//   - The instance count (e.g., "128 images")
//
// The currently active series is highlighted with a blue border.
//
// NOTE: This is a purely presentational component — callers pass series data
// via the `series` prop. MediMind wired this into `useMedplum()` in a couple
// of call sites; the LiverRa version keeps the prop-driven API unchanged so
// no Medplum dependency is needed here.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';
import './SeriesBrowser.css';

// ============================================================================
// Types
// ============================================================================

/** Metadata for a single series in the filmstrip */
export interface SeriesItem {
  /** DICOM SeriesInstanceUID */
  seriesUid: string;
  /** Imaging modality (e.g., 'CT', 'MR', 'CR', 'US') */
  modality: string;
  /** Series description from DICOM tags (may be empty) */
  description?: string;
  /** Number of instances (images) in this series */
  instanceCount: number;
  /** URL for the series thumbnail (WADO-RS rendered endpoint) */
  thumbnailUrl?: string;
}

export interface SeriesBrowserProps {
  /** List of series in the current study */
  series: SeriesItem[];
  /** SeriesInstanceUID of the currently active (displayed) series */
  activeSeriesUid?: string;
  /** Called when the user clicks a series thumbnail */
  onSeriesSelect?: (seriesUid: string) => void;
}

// ============================================================================
// LazyThumbnail — loads image only when visible in the viewport
// ============================================================================

interface LazyThumbnailProps {
  src?: string;
  alt: string;
  modality: string;
}

function LazyThumbnail({ src, alt, modality }: LazyThumbnailProps): JSX.Element {
  const imgRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);

  // IntersectionObserver: only start loading the image when the thumbnail
  // scrolls into view. This prevents dozens of unnecessary HTTP requests
  // for series that the user hasn't scrolled to yet.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !src) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' } // Start loading 100px before the element is visible
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [src]);

  return (
    <div className="series-thumb-image" ref={imgRef}>
      {/* Modality badge — always visible */}
      <span className="series-thumb-modality">{modality}</span>

      {shouldLoad && src && !error ? (
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.2s ease' }}
        />
      ) : (
        <span className="series-thumb-image-placeholder">
          {modality}
        </span>
      )}
    </div>
  );
}

// ============================================================================
// SeriesBrowser Component
// ============================================================================

export function SeriesBrowser({
  series,
  activeSeriesUid,
  onSeriesSelect,
}: SeriesBrowserProps): JSX.Element {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll the active series into view when it changes
  useEffect(() => {
    if (!activeSeriesUid || !containerRef.current) {
      return;
    }

    const activeEl = containerRef.current.querySelector(
      `[data-series-uid="${activeSeriesUid}"]`
    );
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [activeSeriesUid]);

  const handleClick = useCallback(
    (seriesUid: string) => {
      onSeriesSelect?.(seriesUid);
    },
    [onSeriesSelect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, seriesUid: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSeriesSelect?.(seriesUid);
      }
    },
    [onSeriesSelect]
  );

  // Empty state
  if (series.length === 0) {
    return (
      <div className="series-browser" role="listbox" aria-label={t('pacs.seriesBrowser.label')}>
        <div className="series-browser-empty">
          {t('pacs.seriesBrowser.noSeries')}
        </div>
      </div>
    );
  }

  return (
    <div
      className="series-browser"
      ref={containerRef}
      role="listbox"
      aria-label={t('pacs.seriesBrowser.label')}
    >
      {series.map((s) => {
        const isActive = s.seriesUid === activeSeriesUid;
        const desc = s.description || t('pacs.seriesBrowser.unnamed');

        return (
          <div
            key={s.seriesUid}
            className="series-thumb"
            data-active={isActive ? 'true' : 'false'}
            data-series-uid={s.seriesUid}
            role="option"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => handleClick(s.seriesUid)}
            onKeyDown={(e) => handleKeyDown(e, s.seriesUid)}
            title={desc}
          >
            <LazyThumbnail
              src={s.thumbnailUrl}
              alt={`${desc} - ${s.modality}`}
              modality={s.modality}
            />
            <div className="series-thumb-info">
              <div className="series-thumb-desc">{desc}</div>
              <div className="series-thumb-count">
                {s.instanceCount} {t('pacs.images')}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
