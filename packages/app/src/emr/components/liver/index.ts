// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Barrel for liver-specific UI components (lesion + viewer layers).
 *
 * Keep this file thin — it only re-exports. Consumers should prefer
 * `import { LesionList } from '../components/liver'` over reaching into
 * individual files.
 */

export { LesionBadge } from './LesionBadge';
export type { LesionBadgeProps } from './LesionBadge';

export { LesionList } from './LesionList';
export type {
  LesionListProps,
  LesionListFilters,
  SizeBucket,
} from './LesionList';

export { LesionDetailPanel } from './LesionDetailPanel';
export type { LesionDetailPanelProps } from './LesionDetailPanel';

export { LesionLayer } from './LesionLayer';
export type { LesionLayerProps } from './LesionLayer';

export type {
  BBox3D,
  CouinaudSegment,
  DiscoverySource,
  LesionClass,
  LesionConfidenceVector,
  LesionMalignancy,
  LesionUI,
} from './types';
export { LESION_CLASS_ORDER, LESION_MALIGNANCY } from './types';
