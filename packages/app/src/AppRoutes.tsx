// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * AppRoutes (T105).
 *
 * Plain-English: the master map of where every URL goes. Think of this as
 * the building directory in a lobby — someone punches `/cases/123` into
 * the elevator, this file tells React Router which floor (component) to
 * take them to, and whether they need a keycard (`<ProtectedRoute>`)
 * first.
 *
 * Lazy-loading policy (plan.md §445-463):
 *   - Eager (initial bundle): auth, cases list, landing, profile,
 *     notifications, 404.
 *   - Lazy (`React.lazy()`): every admin / ops / compliance / erasure /
 *     onboarding / case-detail / help route. Keeps the initial JS under
 *     the 350 KB gzip budget.
 *
 * Permission guards (plan.md §593-620): every non-public route is wrapped
 * in `<ProtectedRoute requires={[...]}>`. Unauthorized users redirect to
 * /404 (FR-032a) — never 403.
 *
 * Suspense fallback is intentionally `null` here; visual skeletons are
 * rendered by the individual view components once they land.
 */

import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import ProtectedRoute from './emr/components/ProtectedRoute/ProtectedRoute';
import type { LiverraPermission } from './emr/constants/permissions.gen';
import { LIVERRA_ROUTES } from './emr/constants/routes';
import { EMRPage } from './emr/EMRPage';

// --- Eager routes (in initial bundle) ----------------------------------------
import LandingView from './emr/views/LandingView';
import NotFoundView from './emr/views/auth/NotFoundView';
import SigninView from './emr/views/auth/SigninView';
import AuthCallbackView from './emr/views/auth/AuthCallbackView';
import CasesListView from './emr/views/cases/CasesListView';
import NotificationPreferencesView from './emr/views/settings/NotificationPreferencesView';
import ProfileView from './emr/views/settings/ProfileView';

// --- Lazy routes (split into per-chunk bundles) ------------------------------
const OnboardingWizardView = lazy(() => import('./emr/views/onboarding/OnboardingWizardView'));
const AnalysisDetailView = lazy(() => import('./emr/views/cases/AnalysisDetailView'));
const LesionsPanelView = lazy(() => import('./emr/views/cases/LesionsPanelView'));
const RefinementView = lazy(() => import('./emr/views/cases/RefinementView'));
const FinalizeWizardView = lazy(() => import('./emr/views/cases/FinalizeWizardView'));
const ReportView = lazy(() => import('./emr/views/cases/ReportView'));

// Shared lazy views (also referenced by nav/route-registration modules —
// imported from the single-source registry to avoid duplicate chunks).
import {
  UserManagementView,
  PacsConfigView,
  AuditBrowserView,
  DemoCaseRunnerView,
} from './emr/views/lazy-registry';

const OpsQueueView = lazy(() => import('./emr/views/ops/OpsQueueView'));

const MBoMView = lazy(() => import('./emr/views/compliance/MBoMView'));
const AuditSummaryView = lazy(() => import('./emr/views/compliance/AuditSummaryView'));
const RUOSpotCheckView = lazy(() => import('./emr/views/compliance/RUOSpotCheckView'));
const ClaimRegistryView = lazy(() => import('./emr/views/compliance/ClaimRegistryView'));

const ErasureRequestListView = lazy(() => import('./emr/views/erasure/ErasureRequestListView'));
const ErasureWizardView = lazy(() => import('./emr/views/erasure/ErasureWizardView'));

const HelpIndexView = lazy(() => import('./emr/views/help/HelpIndexView'));
const GlossaryView = lazy(() => import('./emr/views/help/GlossaryView'));

// -----------------------------------------------------------------------------
// Helpers — keep the router tree compact + readable.
// -----------------------------------------------------------------------------

function Lazy({ children }: { children: ReactNode }): JSX.Element {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function Guarded({
  requires,
  children,
}: {
  requires?: readonly LiverraPermission[];
  children: ReactNode;
}): JSX.Element {
  return <ProtectedRoute requires={requires}>{children}</ProtectedRoute>;
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

export const appRouter = createBrowserRouter([
  // Public / auth routes (no shell, no guards)
  {
    path: LIVERRA_ROUTES.SIGNIN,
    element: <SigninView />,
    handle: { breadcrumb: () => 'Sign in' },
  },
  {
    path: LIVERRA_ROUTES.AUTH_CALLBACK,
    element: <AuthCallbackView />,
  },

  // Authenticated shell
  {
    path: '/',
    element: <EMRPage />,
    children: [
      { index: true, element: <LandingView /> },

      // Onboarding -----------------------------------------------------------
      {
        path: LIVERRA_ROUTES.ONBOARDING,
        element: (
          <Guarded>
            <Lazy>
              <OnboardingWizardView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Onboarding' },
      },

      // Cases + analysis -----------------------------------------------------
      {
        path: LIVERRA_ROUTES.CASES_LIST,
        element: (
          <Guarded requires={['study.view']}>
            <CasesListView />
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Cases' },
      },
      {
        path: LIVERRA_ROUTES.CASE_DETAIL,
        element: (
          <Guarded requires={['study.view']}>
            <Lazy>
              <AnalysisDetailView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Case' },
      },
      {
        path: LIVERRA_ROUTES.CASE_LESIONS,
        element: (
          <Guarded requires={['study.view']}>
            <Lazy>
              <LesionsPanelView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Lesions' },
      },
      {
        path: LIVERRA_ROUTES.CASE_REFINE,
        element: (
          <Guarded requires={['review.refine_mask']}>
            <Lazy>
              <RefinementView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Refine' },
      },
      {
        path: LIVERRA_ROUTES.CASE_FINALIZE,
        element: (
          <Guarded requires={['report.finalize']}>
            <Lazy>
              <FinalizeWizardView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Finalize' },
      },
      {
        path: LIVERRA_ROUTES.REPORT_VIEW,
        element: (
          <Guarded requires={['report.view']}>
            <Lazy>
              <ReportView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Report' },
      },

      // Admin ----------------------------------------------------------------
      {
        path: LIVERRA_ROUTES.ADMIN_USERS,
        element: (
          <Guarded requires={['admin.user_create']}>
            <Lazy>
              <UserManagementView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Users' },
      },
      {
        path: LIVERRA_ROUTES.ADMIN_PACS_CONFIG,
        element: (
          <Guarded requires={['pacs.config_read']}>
            <Lazy>
              <PacsConfigView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'PACS configuration' },
      },
      {
        path: LIVERRA_ROUTES.ADMIN_AUDIT,
        element: (
          <Guarded requires={['audit.view']}>
            <Lazy>
              <AuditBrowserView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Audit log' },
      },

      // Ops ------------------------------------------------------------------
      {
        path: LIVERRA_ROUTES.OPS_QUEUE,
        element: (
          <Guarded requires={['ops.queue_view']}>
            <Lazy>
              <OpsQueueView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Ops queue' },
      },

      // Compliance -----------------------------------------------------------
      {
        path: LIVERRA_ROUTES.COMPLIANCE_MBOM,
        element: (
          <Guarded requires={['mbom.view']}>
            <Lazy>
              <MBoMView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Model BoM' },
      },
      {
        path: LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY,
        element: (
          <Guarded requires={['audit.view']}>
            <Lazy>
              <AuditSummaryView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Audit summary' },
      },
      {
        path: LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK,
        element: (
          <Guarded requires={['compliance.view']}>
            <Lazy>
              <RUOSpotCheckView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'RUO spot-check' },
      },
      {
        path: LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY,
        element: (
          <Guarded requires={['claim_registry.view']}>
            <Lazy>
              <ClaimRegistryView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Claim registry' },
      },

      // Erasure (DPO) --------------------------------------------------------
      {
        path: LIVERRA_ROUTES.ERASURE,
        element: (
          <Guarded requires={['erasure.execute']}>
            <Lazy>
              <ErasureRequestListView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Erasure requests' },
      },
      {
        path: LIVERRA_ROUTES.ERASURE_NEW,
        element: (
          <Guarded requires={['erasure.execute']}>
            <Lazy>
              <ErasureWizardView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'New erasure request' },
      },

      // Help / settings / demo ----------------------------------------------
      {
        path: LIVERRA_ROUTES.HELP,
        element: (
          <Guarded>
            <Lazy>
              <HelpIndexView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Help' },
      },
      {
        path: LIVERRA_ROUTES.HELP_GLOSSARY,
        element: (
          <Guarded>
            <Lazy>
              <GlossaryView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Glossary' },
      },
      {
        path: LIVERRA_ROUTES.SETTINGS_NOTIFICATIONS,
        element: (
          <Guarded>
            <NotificationPreferencesView />
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Notifications' },
      },
      {
        path: LIVERRA_ROUTES.PROFILE,
        element: (
          <Guarded>
            <ProfileView />
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Profile' },
      },
      {
        path: LIVERRA_ROUTES.DEMO_CASE,
        element: (
          <Guarded>
            <Lazy>
              <DemoCaseRunnerView />
            </Lazy>
          </Guarded>
        ),
        handle: { breadcrumb: () => 'Demo case' },
      },

      // 404 under the shell -- also the target of permission-deny redirects.
      { path: LIVERRA_ROUTES.NOT_FOUND, element: <NotFoundView /> },
    ],
  },

  // Catch-all → shell-less 404 (for paths that don't even resolve inside the shell)
  { path: '*', element: <Navigate to={LIVERRA_ROUTES.NOT_FOUND} replace /> },
]);

export default appRouter;
