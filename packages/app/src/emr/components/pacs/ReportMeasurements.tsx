// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ReportMeasurements — Insert viewer measurements into the report
// ============================================================================
// Collapsible section that lists measurements (Length, Angle, ROI) from the
// viewer's annotations. Each measurement has an "Insert" button that places
// the value at the cursor position in the report editor.
//
// Phase-2 status (LiverRa):
//   Depends on `useAnnotations` + `StoredAnnotations` from the sibling
//   agent's measurements/annotations port (`hooks/pacs/useAnnotations.ts` +
//   `services/pacs/annotationService.ts`). The import below is expected to
//   resolve lazily once the sibling work lands.
//
// Ported from MediMind (components/pacs/ReportMeasurements.tsx) with
// translation namespace changed from `imaging.report.*` → `pacs.report.*`.
// ============================================================================

import React, { useCallback, useMemo } from 'react';
import { ActionIcon, Collapse, Tooltip } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconPlus, IconRuler } from '@tabler/icons-react';
import { useTranslation } from '../../contexts/TranslationContext';
// TODO(phase-2-merge): sibling agent will create `hooks/pacs/useAnnotations.ts`
// and `services/pacs/annotationService.ts`. `StoredAnnotations` is expected to
// expose a `data` field containing the serialised Cornerstone3D annotation JSON.
import { useAnnotations } from '../../hooks/pacs/useAnnotations';
import type { StoredAnnotations } from '../../services/pacs/annotationService';
import type { Editor } from '@tiptap/react';
import panelStyles from './ReportPanel.module.css';

export interface ReportMeasurementsProps {
  /** FHIR ImagingStudy resource ID. */
  studyId: string;
  /** TipTap Editor ref for cursor-position insertion. */
  editorRef: React.MutableRefObject<Editor | null>;
  /** Whether the report is read-only (signed). */
  disabled?: boolean;
  /**
   * Pre-loaded annotations from parent. When provided, avoids creating a
   * duplicate useAnnotations hook instance (prevents double API calls and
   * conflicting auto-saves).
   */
  preloadedAnnotations?: StoredAnnotations[];
}

interface ParsedMeasurement {
  type: string;
  value: string;
  unit: string;
}

/**
 * Parse Cornerstone3D annotation JSON to extract human-readable measurements.
 */
function parseMeasurements(annotationData: string): ParsedMeasurement[] {
  try {
    const data = JSON.parse(annotationData);
    const measurements: ParsedMeasurement[] = [];

    // Cornerstone3D annotations are stored by tool name
    const toolNames = Object.keys(data);
    for (const toolName of toolNames) {
      const toolAnnotations = data[toolName];
      if (!Array.isArray(toolAnnotations)) { continue; }

      for (const annotation of toolAnnotations) {
        const cachedStats = annotation?.data?.cachedStats;
        if (!cachedStats) { continue; }

        // Extract measurement based on tool type
        const statKeys = Object.keys(cachedStats);
        for (const key of statKeys) {
          const stat = cachedStats[key];
          if (toolName === 'Length' && stat?.length !== undefined) {
            measurements.push({
              type: 'Length',
              value: stat.length.toFixed(1),
              unit: 'mm',
            });
          } else if (toolName === 'Angle' && stat?.angle !== undefined) {
            measurements.push({
              type: 'Angle',
              value: stat.angle.toFixed(1),
              unit: '\u00B0',
            });
          } else if (toolName === 'EllipticalROI' && stat?.mean !== undefined) {
            measurements.push({
              type: 'ROI',
              value: `Mean: ${stat.mean.toFixed(1)}, Area: ${(stat.area || 0).toFixed(1)}`,
              unit: 'HU / mm\u00B2',
            });
          }
        }
      }
    }

    return measurements;
  } catch (e) {
    // L-CATCH-9: parseMeasurements is best-effort enrichment for the
    // radiology-report surface — corrupted Cornerstone3D annotation
    // JSON yields an empty measurement list rather than blocking
    // report render. Trace to debug so the issue is visible in dev.
    // eslint-disable-next-line no-console
    console.debug('[ReportMeasurements] annotation JSON parse failed', { e });
    return [];
  }
}

export function ReportMeasurements({
  studyId,
  editorRef,
  disabled,
  preloadedAnnotations,
}: ReportMeasurementsProps): React.ReactElement | null {
  const { t } = useTranslation();
  // Use preloaded annotations from parent if available — avoids creating a
  // duplicate hook instance that would double API calls and conflict on auto-save.
  const hookResult = useAnnotations(preloadedAnnotations ? '' : studyId);
  const annotations = preloadedAnnotations ?? hookResult.annotations;
  const isLoading = preloadedAnnotations ? false : hookResult.isLoading;
  const [expanded, setExpanded] = React.useState(true);

  // Parse all annotations into measurements
  const measurements = useMemo(() => {
    const all: ParsedMeasurement[] = [];
    for (const ann of annotations) {
      all.push(...parseMeasurements(ann.data));
    }
    return all;
  }, [annotations]);

  const handleInsert = useCallback(
    (measurement: ParsedMeasurement) => {
      if (editorRef.current) {
        const text = `${measurement.type}: ${measurement.value} ${measurement.unit}`;
        editorRef.current.commands.insertContent(text + ' ');
      }
    },
    [editorRef],
  );

  // Don't render if no measurements and not loading
  if (!isLoading && measurements.length === 0) {
    return null;
  }

  return (
    <div className={panelStyles.sectionDivider}>
      <button
        className={panelStyles.sectionHeader}
        onClick={() => setExpanded((prev) => !prev)}
        type="button"
      >
        {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        <span className={panelStyles.sectionHeaderIcon}>
          <IconRuler size={12} />
        </span>
        <span>{t('pacs.report.measurements')}</span>
        <span className={panelStyles.sectionBadge}>{measurements.length}</span>
      </button>

      <Collapse in={expanded}>
        <div className={panelStyles.sectionContent}>
          {measurements.map((m, i) => (
            <div key={i} className={panelStyles.measurementRow}>
              <span className={panelStyles.measurementType}>{m.type}:</span>
              <span className={panelStyles.measurementValue}>
                {m.value} {m.unit}
              </span>
              {!disabled && (
                <Tooltip label={t('common.insert')} position="left" withArrow>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="var(--emr-accent)"
                    onClick={() => handleInsert(m)}
                    aria-label={`Insert ${m.type}`}
                  >
                    <IconPlus size={12} />
                  </ActionIcon>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  );
}
