// SPDX-License-Identifier: Apache-2.0
// TODO: full port once MediMind upstream splits this out — for now LiverRa
// re-exports the table skeleton implementation that already lives inside
// the EMRSkeleton barrel file so callers get a single canonical symbol.

export { EMRTableSkeleton, type EMRTableSkeletonProps } from './EMRSkeleton';
