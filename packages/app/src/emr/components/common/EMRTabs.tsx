// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * EMRTabs — segmented-pill tab strip + panels, written without Mantine.
 *
 * Plain English: the row of buttons at the top of a panel (Segments /
 * Lesions / Measurements / Notes) plus the content area below. Click a
 * pill, see its panel.
 *
 * Two variants:
 *   - `pills` (default) — rounded pills inside a tinted track.
 *   - `flush` — no track, used inline above content with a bottom border.
 *
 * `grow` makes pills share the row evenly (good for top-level navigation).
 */

import type { ComponentType, ReactNode } from 'react';
import { useId } from 'react';
import styles from './EMRTabs.module.css';

export interface EMRTabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Optional leading icon component. */
  icon?: ComponentType<{ size?: number; stroke?: number }>;
  /** Optional trailing badge / count node. */
  right?: ReactNode;
  /** Optional aria-label override (default: stringified label). */
  ariaLabel?: string;
}

export interface EMRTabsProps<V extends string = string> {
  /** Active tab value. */
  value: V;
  onChange: (value: V) => void;
  items: ReadonlyArray<EMRTabItem<V>>;
  /** Visual variant. */
  variant?: 'pills' | 'flush';
  /** Whether tabs share the row evenly. */
  grow?: boolean;
  /** Optional accessibility label for the tab list. */
  'aria-label'?: string;
  className?: string;
  /** Optional id prefix for tab/panel ARIA wiring. */
  idPrefix?: string;
}

export function EMRTabs<V extends string = string>({
  value,
  onChange,
  items,
  variant = 'pills',
  grow,
  'aria-label': ariaLabel,
  className,
  idPrefix,
}: EMRTabsProps<V>): React.ReactElement {
  const autoId = useId();
  const prefix = idPrefix ?? autoId;
  const listClass = [
    variant === 'flush' ? styles.listFlush : styles.list,
    grow ? styles.grow : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div role="tablist" aria-label={ariaLabel} className={listClass}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${prefix}-tab-${item.value}`}
            aria-selected={active}
            aria-controls={`${prefix}-panel-${item.value}`}
            tabIndex={active ? 0 : -1}
            className={[styles.tab, active ? styles.tabActive : null].filter(Boolean).join(' ')}
            onClick={() => onChange(item.value)}
            aria-label={item.ariaLabel}
            data-testid={`emr-tab-${item.value}`}
          >
            {Icon && (
              <span className={styles.icon} aria-hidden="true">
                <Icon size={14} stroke={2} />
              </span>
            )}
            <span className={styles.label}>{item.label}</span>
            {item.right ? <span className={styles.right}>{item.right}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Helper to build the standard `aria-` props for the matching tab panel. */
export function emrTabPanelProps(
  prefix: string,
  value: string,
): { role: 'tabpanel'; id: string; 'aria-labelledby': string; tabIndex: 0 } {
  return {
    role: 'tabpanel',
    id: `${prefix}-panel-${value}`,
    'aria-labelledby': `${prefix}-tab-${value}`,
    tabIndex: 0,
  };
}

export default EMRTabs;
