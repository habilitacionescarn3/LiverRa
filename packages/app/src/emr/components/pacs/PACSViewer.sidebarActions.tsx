// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { ActionIcon } from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconMaximize,
  IconMinimize,
  IconPalette,
  IconRulerMeasure,
  IconStar,
  IconX,
} from '@tabler/icons-react';
import { EMRTooltip } from '../common/EMRTooltip';

// LiverRa adaptation: the target useTranslation().t takes (key, params?) — no
// string-fallback second arg — so the prop type mirrors that exact signature.
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface PACSSidebarActionsProps {
  t: Translate;
  onPrevStudy?: () => void;
  onNextStudy?: () => void;
  hasPrevStudy?: boolean;
  hasNextStudy?: boolean;
  showMeasurements: boolean;
  onToggleMeasurements: () => void;
  showKeyImages: boolean;
  onToggleKeyImages: () => void;
  showColorBar: boolean;
  onToggleColorBar: () => void;
  isFullScreen?: boolean;
  onToggleFullScreen?: () => void;
  onClose?: () => void;
}

// NOTE (Wave 8G.13 compliance, 2026-06-03):
// The raw Mantine `Tooltip` was replaced with the themed `EMRTooltip` wrapper on
// every button (in-scope, behaviour-identical). The buttons themselves stay as
// Mantine `ActionIcon` ON PURPOSE: this row lives inside the fixed-dark PACS top
// bar, whose legibility ("--pacs-chrome-text" light-on-dark) AND the active-
// toggle accent ('.pacs-viewer-measurements-btn[data-active="true"]') are
// applied in PACSViewer.css via selectors that key on `.mantine-ActionIcon-root`
// and the `data-active` attribute. `EMRIconButton` renders a plain <button>,
// carries neither hook (no className / data-active passthrough), and its default
// variant uses --emr-text-secondary (a mid-gray that is illegible on the dark
// chrome in light mode). A faithful EMRIconButton swap would therefore require
// editing PACSViewer.css and/or EMRIconButton.tsx — both OUT of this task's
// scope — so it is intentionally deferred (see report) to avoid a visual
// regression.
export function PACSSidebarActions({
  t,
  onPrevStudy,
  onNextStudy,
  hasPrevStudy,
  hasNextStudy,
  showMeasurements,
  onToggleMeasurements,
  showKeyImages,
  onToggleKeyImages,
  showColorBar,
  onToggleColorBar,
  isFullScreen,
  onToggleFullScreen,
  onClose,
}: PACSSidebarActionsProps): JSX.Element {
  return (
    <div className="pacs-sidebar-actions">
      {onPrevStudy && (
        <EMRTooltip label={`${t('pacs.viewer.prevStudy')} (PageUp)`} position="bottom">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onPrevStudy}
            disabled={!hasPrevStudy}
            aria-label={t('pacs.viewer.prevStudy')}
            data-testid="pacs-prev-study"
          >
            <IconChevronLeft size={20} />
          </ActionIcon>
        </EMRTooltip>
      )}
      {onNextStudy && (
        <EMRTooltip label={`${t('pacs.viewer.nextStudy')} (PageDown)`} position="bottom">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onNextStudy}
            disabled={!hasNextStudy}
            aria-label={t('pacs.viewer.nextStudy')}
            data-testid="pacs-next-study"
          >
            <IconChevronRight size={20} />
          </ActionIcon>
        </EMRTooltip>
      )}

      <EMRTooltip label={t('pacs.measurements.title')} position="bottom">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onToggleMeasurements}
          aria-label={t('pacs.measurements.title')}
          data-testid="pacs-measurements-toggle"
          data-active={showMeasurements ? 'true' : 'false'}
          className="pacs-viewer-measurements-btn"
        >
          <IconRulerMeasure size={20} />
        </ActionIcon>
      </EMRTooltip>

      <EMRTooltip label={t('pacs.keyImages')} position="bottom">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onToggleKeyImages}
          aria-label={t('pacs.keyImages')}
          data-testid="pacs-key-images-toggle"
          data-active={showKeyImages ? 'true' : 'false'}
          className="pacs-viewer-measurements-btn"
        >
          <IconStar size={20} />
        </ActionIcon>
      </EMRTooltip>

      <EMRTooltip label={t('pacs.colorBar')} position="bottom">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onToggleColorBar}
          aria-label={t('pacs.colorBar')}
          data-testid="pacs-colorbar-toggle"
          data-active={showColorBar ? 'true' : 'false'}
          className="pacs-viewer-measurements-btn"
        >
          <IconPalette size={20} />
        </ActionIcon>
      </EMRTooltip>

      {onToggleFullScreen && (
        <EMRTooltip
          label={isFullScreen ? `${t('pacs.viewer.exitFullScreen')} (F)` : `${t('pacs.viewer.fullScreen')} (F)`}
          position="bottom"
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            onClick={onToggleFullScreen}
            aria-label={isFullScreen ? t('pacs.viewer.exitFullScreen') : t('pacs.viewer.fullScreen')}
            data-testid="pacs-fullscreen-toggle"
          >
            {isFullScreen ? <IconMinimize size={20} /> : <IconMaximize size={20} />}
          </ActionIcon>
        </EMRTooltip>
      )}

      {onClose && (
        <ActionIcon
          className="pacs-viewer-close-btn"
          variant="subtle"
          color="gray"
          size="sm"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <IconX size={20} />
        </ActionIcon>
      )}
    </div>
  );
}
