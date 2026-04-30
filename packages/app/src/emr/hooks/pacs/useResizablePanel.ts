// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useResizablePanel — Draggable panel resizer hook
// ============================================================================
// Like VS Code's sidebar resize: click and drag the divider between panels
// to adjust their widths. Persists the user's preferred width to localStorage.
//
// Ported from MediMind (hooks/pacs/useResizablePanel.ts). No Medplum.
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from '../../contexts/TranslationContext';

export interface UseResizablePanelOptions {
  /** Default panel width in px */
  defaultWidth?: number;
  /** Minimum panel width in px */
  minWidth?: number;
  /** Maximum panel width in px */
  maxWidth?: number;
  /** localStorage key to persist width */
  storageKey?: string;
}

export interface UseResizablePanelReturn {
  /** Current panel width in px */
  panelWidth: number;
  /** Whether the user is actively dragging the divider */
  isDragging: boolean;
  /** Whether the panel is collapsed (hidden) */
  isCollapsed: boolean;
  /** Toggle collapsed state */
  toggleCollapsed: () => void;
  /** Props to spread on the divider element */
  dividerProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    style: React.CSSProperties;
    role: string;
    'aria-label': string;
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
  };
}

function loadWidth(key: string | undefined, defaultWidth: number): number {
  if (!key) {
    return defaultWidth;
  }
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n) && n > 0) {
        return n;
      }
    }
  } catch {
    // ignore
  }
  return defaultWidth;
}

export function useResizablePanel(options: UseResizablePanelOptions = {}): UseResizablePanelReturn {
  const {
    defaultWidth = 320,
    minWidth = 200,
    maxWidth = 500,
    storageKey,
  } = options;

  const { t } = useTranslation();
  const [panelWidth, setPanelWidth] = useState(() => loadWidth(storageKey, defaultWidth));
  const [isDragging, setIsDragging] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta));
      setPanelWidth(newWidth);
    },
    [minWidth, maxWidth]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  // Attach/detach global mouse listeners when dragging
  useEffect(() => {
    if (!isDragging) {
      return;
    }
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // Clean up body styles if component unmounts mid-drag
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Persist width when dragging stops
  useEffect(() => {
    if (isDragging || !storageKey) {
      return;
    }
    try {
      localStorage.setItem(storageKey, String(panelWidth));
    } catch {
      // ignore
    }
  }, [isDragging, panelWidth, storageKey]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = panelWidth;
      setIsDragging(true);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [panelWidth]
  );

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const dividerProps = {
    onMouseDown: handleMouseDown,
    style: {
      width: '6px',
      cursor: 'col-resize' as const,
      flexShrink: 0,
      background: isDragging ? 'var(--emr-accent)' : 'var(--emr-border-color)',
      transition: isDragging ? 'none' : 'background 0.15s ease',
    } as React.CSSProperties,
    role: 'separator',
    'aria-label': t('imaging.aria.resizePanel'),
    'aria-valuenow': panelWidth,
    'aria-valuemin': minWidth,
    'aria-valuemax': maxWidth,
  };

  return {
    panelWidth,
    isDragging,
    isCollapsed,
    toggleCollapsed,
    dividerProps,
  };
}
