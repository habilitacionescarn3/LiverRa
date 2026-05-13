// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * RefineTools (T237).
 *
 * Plain-English: the tiny tool palette that sits above the 3D viewer in
 * the refinement drawer. Four buttons — add brush, subtract brush, lesion
 * prompt, single marker — map 1:1 to Cornerstone3D tool modes via the
 * shared viewer-state context. The active tool is highlighted and echoed
 * back to the parent via `onToolChange` so the viewer can set the cursor.
 *
 * The palette is DISABLED when the current user does not hold the reviewer
 * seat (`hasSeat=false`) so a read-only viewer cannot accidentally mutate
 * masks (FR-017a).
 *
 * Spec refs: FR-015, FR-016; plan §Review seat concurrency.
 */

import { Group, Tooltip } from '@mantine/core';
import {
  IconEraser,
  IconMapPin,
  IconPencilPlus,
  IconTarget,
} from '@tabler/icons-react';
import { useCallback, type ReactElement } from 'react';

import { useTranslation } from '../../contexts/TranslationContext';
import { EMRButton } from '../common';

export type RefineToolId = 'add' | 'subtract' | 'prompt' | 'marker';

export interface RefineToolsProps {
  activeTool: RefineToolId | null;
  onToolChange(tool: RefineToolId | null): void;
  /** Gate from `useReviewSeat().hasSeat`. */
  disabled?: boolean;
  'data-testid'?: string;
}

interface ToolDef {
  id: RefineToolId;
  label: string;
  icon: ReactElement;
  /** Cornerstone3D tool name — wired by parent view via setCornerstoneTool. */
  cornerstoneTool: string;
}

// Translation keys use the `refine:` namespace + nested-path syntax
// (`refine:tools.<key>`) — `refine.json` nests its tool labels under a
// `tools` object. Previously these read `refine.tools.X` (no colon),
// which the i18n resolver treats as a missing key in the `common`
// namespace and renders the raw string on screen (FR-024 violation).
const TOOL_DEFS: readonly ToolDef[] = [
  {
    id: 'add',
    label: 'refine:tools.addMask',
    icon: <IconPencilPlus size={18} />,
    cornerstoneTool: 'BrushAdd',
  },
  {
    id: 'subtract',
    label: 'refine:tools.subtractMask',
    icon: <IconEraser size={18} />,
    cornerstoneTool: 'BrushSubtract',
  },
  {
    id: 'prompt',
    label: 'refine:tools.lesionPrompt',
    icon: <IconTarget size={18} />,
    cornerstoneTool: 'SegmentPromptClick',
  },
  {
    id: 'marker',
    label: 'refine:tools.marker',
    icon: <IconMapPin size={18} />,
    cornerstoneTool: 'ProbePick',
  },
];

export function RefineTools({
  activeTool,
  onToolChange,
  disabled = false,
  'data-testid': testId = 'refine-tools',
}: RefineToolsProps): ReactElement {
  const { t } = useTranslation();

  const handlePick = useCallback(
    (id: RefineToolId): void => {
      onToolChange(activeTool === id ? null : id);
    },
    [activeTool, onToolChange],
  );

  return (
    <Group
      gap="xs"
      wrap="wrap"
      data-testid={testId}
      aria-label={t('refine:tools.ariaLabel')}
      role="toolbar"
    >
      {TOOL_DEFS.map((tool) => {
        const isActive = activeTool === tool.id;
        return (
          <Tooltip key={tool.id} label={t(tool.label)} withArrow>
            <EMRButton
              size="sm"
              variant={isActive ? 'filled' : 'outline'}
              leftSection={tool.icon}
              disabled={disabled}
              aria-pressed={isActive}
              aria-label={t(tool.label)}
              data-cornerstone-tool={tool.cornerstoneTool}
              onClick={() => handlePick(tool.id)}
            >
              {t(tool.label)}
            </EMRButton>
          </Tooltip>
        );
      })}
    </Group>
  );
}

export default RefineTools;
