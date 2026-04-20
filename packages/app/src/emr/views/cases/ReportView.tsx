// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0
// Re-export of T272 ReportView. The canonical implementation lives at
// `packages/app/src/emr/views/reports/ReportView.tsx`; this thin
// shim exists so the lazy-import target wired in T105 `AppRoutes.tsx`
// (LIVERRA_ROUTES.REPORT_VIEW → this file) stays stable.
export { default } from '../reports/ReportView';
