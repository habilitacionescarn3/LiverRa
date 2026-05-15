// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * LesionsPanelView — `/cases/:id/lesions`.
 *
 * Plain-English: for a specific analysis, the reviewer sees every focal
 * liver lesion the AI found on the left, and a detail card for whichever
 * lesion they clicked on the right. They can override the AI's
 * classification (audited, step-up-MFA) or — while holding a review seat —
 * prompt a new lesion via MedSAM-2.
 *
 * A few intentional mismatches this file accepts (instead of editing the
 * shared components):
 *   - `useLesions(id)` returns the raw API shape `{ couinaud_location,
 *     longest_diameter_mm, ... }`, but `LesionList`/`LesionDetailPanel`
 *     expect the richer `LesionUI` type. We adapt inline via
 *     `apiLesionToLesionUI()` rather than changing the hook (which is
 *     owned by another task) or the liver components.
 *   - `ViewerStateContext.focusOnVoxel` does not exist in this codebase,
 *     so the "recenter viewer on click" action is a no-op at the view
 *     layer — `LesionList` itself already calls `setCamera()` on row
 *     click via the ViewerStateProvider when one is mounted.
 *   - There is no i18n key for "Select a lesion" in the `lesions`
 *     namespace; we reuse `lesions:list.emptyState.title` with a neutral
 *     description from the same namespace so we do not add keys to every
 *     locale file (the namespace is authored complete per the task).
 *
 * Spec refs: FR-010, FR-011, FR-016, FR-017a, FR-020, US3.
 */

import { Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconInfoCircle,
  IconPlus,
  IconTarget,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import lesionsStyles from './LesionsPanelView.module.css';
import { PermissionButton } from '../../components/access-control';
import {
  EMRAlert,
  EMRButton,
  EMREmptyState,
  EMRErrorBoundary,
  EMRListSkeleton,
  EMRPageHeader,
  EMRToast,
} from '../../components/common';
import {
  LESION_CLASS_ORDER,
  LesionDetailPanel,
  LesionList,
  type LesionUI,
} from '../../components/liver';
// ClassificationOverride is not re-exported from the liver barrel; import direct.
import { ClassificationOverride } from '../../components/liver/ClassificationOverride';
import type {
  BBox3D,
  CouinaudSegment,
  DiscoverySource,
  LesionClass,
  LesionConfidenceVector,
} from '../../components/liver';
import { RUODisclaimerClaimAware } from '../../components/ruo/RUODisclaimerClaimAware';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  useLesions,
  lesionsQueryKey,
  type Lesion as ApiLesion,
} from '../../hooks/useLesions';
import { useRefinementDispatch } from '../../hooks/useRefinementDispatch';
import { useReviewSeat } from '../../hooks/useReviewSeat';
import { useAuth } from '../../services/auth';
import type { LesionClass as OverrideLesionClass } from '../../components/liver/ClassificationOverride';

// ---------------------------------------------------------------------------
// Adapter: API Lesion → LesionUI
//
// The API returns lowercase class names ('hcc', 'metastasis', ...) and
// snake_case fields; the UI components expect uppercase enums ('HCC',
// 'MET', ...) and camelCase. We adapt inline so this view remains the
// single site that knows about both shapes.
// ---------------------------------------------------------------------------

const API_TO_UI_CLASS: Readonly<Record<string, LesionClass>> = {
  hcc: 'HCC',
  icc: 'ICC',
  metastasis: 'MET',
  fnh: 'FNH',
  hemangioma: 'HEM',
  cyst: 'CYST',
};

const ROMAN_SEGMENTS: readonly CouinaudSegment[] = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
];

function toCouinaud(raw: string | undefined): CouinaudSegment {
  if (!raw) return 'multi_segment';
  const r = raw.toUpperCase();
  return (ROMAN_SEGMENTS as readonly string[]).includes(r)
    ? (r as CouinaudSegment)
    : 'multi_segment';
}

function toClassEnum(raw: string | null | undefined): LesionClass | null {
  if (!raw || raw === 'abstained') return null;
  return API_TO_UI_CLASS[raw] ?? null;
}

function normalizeConfidenceVector(
  vec: Record<string, number> | undefined,
): LesionConfidenceVector {
  const v = vec ?? {};
  return {
    HCC: v.hcc ?? v.HCC ?? 0,
    ICC: v.icc ?? v.ICC ?? 0,
    MET: v.metastasis ?? v.MET ?? 0,
    FNH: v.fnh ?? v.FNH ?? 0,
    HEM: v.hemangioma ?? v.HEM ?? 0,
    CYST: v.cyst ?? v.CYST ?? 0,
  };
}

/**
 * L-REFINE-1: read the bounding box from the API payload when present
 * instead of synthesising a zero-span tuple. The API now surfaces
 * ``bbox3d`` as a 6-element array ``[x0,y0,z0,x1,y1,z1]``.
 */
function parseBbox(raw: unknown): BBox3D {
  if (Array.isArray(raw) && raw.length === 6 && raw.every((n) => typeof n === 'number')) {
    return raw as unknown as BBox3D;
  }
  // Legacy payloads without bbox — fall back to zero-span. Recenter is a
  // no-op in that case (viewer holds framing).
  return [0, 0, 0, 0, 0, 0];
}

function apiLesionToLesionUI(
  api: ApiLesion & {
    bbox3d?: unknown;
    classification?: {
      override_reviewer_role?: string | null;
      override_reviewer_user_id?: string | null;
      override_created_at?: string | null;
    };
  },
  idx: number,
  analysisId: string,
): LesionUI {
  const cls = api.classification ?? {};
  const suggestedClass = toClassEnum(cls.suggested_class ?? null);
  const confidenceVector = normalizeConfidenceVector(cls.confidence_vector);
  const confidence = suggestedClass
    ? (confidenceVector[suggestedClass] ?? null)
    : null;
  const couinaud = toCouinaud(api.couinaud_location);
  const diameterMm = api.longest_diameter_mm ?? 0;
  const volumeMl = api.volume_ml ?? 0;
  // L-REFINE-1: bbox now comes from the API.
  const bbox: BBox3D = parseBbox(api.bbox3d);
  const reviewerOverrideClass = cls.reviewer_override_class
    ? toClassEnum(cls.reviewer_override_class)
    : null;
  // H-REFINE-4 / M-REFINE-3: real reviewer attribution from the JOIN
  // in analysis.py. If the audit columns aren't present (legacy row)
  // we omit ``reviewerOverride`` entirely rather than fabricate.
  const overrideReviewerUserId =
    (cls as { override_reviewer_user_id?: string | null }).override_reviewer_user_id ?? null;
  const overrideCreatedAt =
    (cls as { override_created_at?: string | null }).override_created_at ?? null;

  const ui: LesionUI = {
    id: api.id ?? `lesion-${idx}`,
    analysisId,
    displayOrder: idx,
    index: idx + 1,
    couinaudLocation: couinaud,
    locationLabel:
      couinaud === 'multi_segment' ? couinaud : `Segment ${couinaud}`,
    longestDiameterMm: diameterMm,
    volumeMl,
    discoverySource: (api.discovery_source ?? 'ai_detected') as DiscoverySource,
    bbox3d: bbox,
    suggestedClass,
    confidence,
    confidenceVector,
    abstentionThreshold: cls.abstention_threshold_used ?? 0.4,
    temperatureApplied: cls.temperature_applied ?? 1,
    modelVersion: cls.model_version ?? 'unknown',
    ...(reviewerOverrideClass && overrideReviewerUserId && overrideCreatedAt
      ? {
          reviewerOverride: {
            classValue: reviewerOverrideClass,
            reviewerUserId: overrideReviewerUserId,
            at: overrideCreatedAt,
          },
        }
      : {}),
  };
  return ui;
}

/** Map UI enum class → override-modal lowercase enum. */
const UI_TO_OVERRIDE_CLASS: Readonly<Record<LesionClass, OverrideLesionClass>> = {
  HCC: 'hcc',
  ICC: 'cholangiocarcinoma',
  MET: 'metastasis',
  FNH: 'fnh',
  HEM: 'hemangioma',
  CYST: 'cyst',
};

const OVERRIDE_TO_UI_CLASS: Readonly<Record<OverrideLesionClass, LesionClass>> = {
  hcc: 'HCC',
  cholangiocarcinoma: 'ICC',
  metastasis: 'MET',
  fnh: 'FNH',
  hemangioma: 'HEM',
  cyst: 'CYST',
};

function readApiBaseUrl(): string {
  const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return (meta.VITE_LIVERRA_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function LesionsPanelViewBody(): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id: analysisId = '' } = useParams<{ id: string }>();
  const { permissions } = useAuth();
  const hasOverridePerm = permissions.includes('review.override_classification');

  const { lesions: apiLesions, isLoading, error } = useLesions(analysisId);
  const seat = useReviewSeat(analysisId);
  const { dispatchClassificationOverride } = useRefinementDispatch();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState<boolean>(false);
  const [addingLesion, setAddingLesion] = useState<boolean>(false);
  // B-REFINE-3: viewer-click sets ``pendingVoxel``; Add Lesion is
  // disabled until the user has clicked the viewer to pick a seed.
  const [pendingVoxel, setPendingVoxel] = useState<[number, number, number] | null>(null);

  // Listen for the same ``liverra:viewer-click`` event RefinementView
  // dispatches. The viewer is the single source of voxel coordinates;
  // we never invent them on the panel side.
  useEffect(() => {
    const onViewerClick = (ev: Event): void => {
      const detail = (
        ev as CustomEvent<{ voxel?: [number, number, number] }>
      ).detail;
      if (detail?.voxel) setPendingVoxel(detail.voxel);
    };
    window.addEventListener('liverra:viewer-click', onViewerClick as EventListener);
    return () =>
      window.removeEventListener(
        'liverra:viewer-click',
        onViewerClick as EventListener,
      );
  }, []);

  // Adapt API → UI shape. Memoised so the list/detail don't rerun virtualiser
  // setup on every keystroke.
  const lesions = useMemo<LesionUI[]>(
    () => apiLesions.map((l, i) => apiLesionToLesionUI(l, i, analysisId)),
    [apiLesions, analysisId],
  );

  const selectedLesion = useMemo<LesionUI | null>(
    () => lesions.find((l) => l.id === selectedId) ?? null,
    [lesions, selectedId],
  );

  const anyAbstained = useMemo(
    () => lesions.some((l) => l.suggestedClass === null),
    [lesions],
  );

  const handleSelect = useCallback((lesion: LesionUI) => {
    setSelectedId(lesion.id);
  }, []);

  const handleOverrideClick = useCallback(() => {
    if (!selectedLesion) return;
    setOverrideOpen(true);
  }, [selectedLesion]);

  const handleOverrideSubmit = useCallback(
    async (args: {
      lesionId: string;
      newClass: OverrideLesionClass;
      reason: string;
    }): Promise<void> => {
      const priorClass = selectedLesion?.suggestedClass ?? null;
      const newUiClass = OVERRIDE_TO_UI_CLASS[args.newClass];
      // H-LOCK-3: pass the lesion version the UI last observed so the
      // backend can CAS-bump and reject stale overwrites.
      const apiHit = apiLesions.find((l) => l.id === args.lesionId) as
        | (ApiLesion & { client_version?: number })
        | undefined;
      await dispatchClassificationOverride({
        analysisId,
        lesionId: args.lesionId,
        newClass: newUiClass,
        priorClass,
        reason: args.reason,
        clientVersion: apiHit?.client_version ?? 1,
      });
      EMRToast.success(t('common:save'));
    },
    [analysisId, apiLesions, dispatchClassificationOverride, selectedLesion, t],
  );

  const handleAddLesion = useCallback(async () => {
    if (!seat.reviewId) return;
    // B-REFINE-3: backend requires ``{ analysis_id, voxel:[x,y,z], label? }``.
    // The previous body ``{ segment: 'V' }`` always 422'd; reviewers
    // received a success toast that wasn't true. We now require the
    // viewer to have surfaced a click coordinate before we POST.
    if (!pendingVoxel) {
      EMRToast.info(
        t('refine:tools.pickVoxelBeforeAdd', {
          defaultValue: 'Click the viewer to pick a seed before adding a lesion.',
        }),
      );
      return;
    }
    setAddingLesion(true);
    try {
      const res = await fetch(
        `${readApiBaseUrl()}/reviews/${encodeURIComponent(seat.reviewId)}/lesion-prompt`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            analysis_id: analysisId,
            voxel: pendingVoxel,
            client_version: 1,
          }),
        },
      );
      if (!res.ok) {
        // M-REFINE-4: surface the actual reason — try problem+json,
        // then fall back to HTTP-status. The previous silent toast
        // masked 409 stale-version / 422 validation errors.
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && typeof body === 'object' && 'detail' in body) {
            detail = String((body as { detail?: unknown }).detail ?? detail);
          }
        } catch {
          /* not JSON */
        }
        throw new Error(detail);
      }
      EMRToast.success(t('refine:tools.addLesion'));
      setPendingVoxel(null);
      // Pull the new lesion into the cached list.
      void queryClient.invalidateQueries({ queryKey: lesionsQueryKey(analysisId) });
    } catch (err) {
      // M-REFINE-4: route to console.warn + Sentry rather than swallow.
      // eslint-disable-next-line no-console
      console.warn('LesionsPanelView.handleAddLesion failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      EMRToast.error(msg);
    } finally {
      setAddingLesion(false);
    }
  }, [seat.reviewId, t, pendingVoxel, analysisId, queryClient]);

  const handleBack = useCallback(() => navigate(-1), [navigate]);

  // Page header actions — Add lesion is hidden if the user lacks
  // `review.reprompt_lesion`; disabled (wrapped in a tooltip) if they
  // hold no review seat. We pick the wrapper BEFORE rendering so the
  // single source of truth is the `pageActions` element passed to the
  // page header.
  const canReprompt = permissions.includes('review.reprompt_lesion');
  const hasSeat = Boolean(seat.reviewId);

  const pageActions = !canReprompt ? null : hasSeat ? (
    <PermissionButton
      permission="review.reprompt_lesion"
      hiddenIfDenied
      onClick={() => {
        void handleAddLesion();
      }}
      leftSection={<IconPlus size={16} stroke={2} />}
      loading={addingLesion}
      data-testid="lesions-add-button"
    >
      {t('refine:tools.addLesion')}
    </PermissionButton>
  ) : (
    <Tooltip label={t('refine:tools.acquireSeatTooltip')} withArrow>
      <span>
        <EMRButton
          variant="outline"
          leftSection={<IconPlus size={16} stroke={2} />}
          disabled
          data-testid="lesions-add-button"
        >
          {t('refine:tools.addLesion')}
        </EMRButton>
      </span>
    </Tooltip>
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <Box
      p={{ base: 'md', md: 'xl' }}
      style={{ maxWidth: 1480, margin: '0 auto' }}
      data-testid="lesions-panel-view"
    >
      <Stack gap="lg">
        <EMRPageHeader
          icon={IconTarget}
          title={t('lesions:list.heading')}
          subtitle={analysisId ? `#${analysisId}` : undefined}
          showBack
          onBack={handleBack}
          actions={pageActions}
          data-testid="lesions-page-header"
        />

        {/* Abstention advisory (FR-011) */}
        {anyAbstained && !isLoading && !error && (
          <EMRAlert
            variant="info"
            icon={IconInfoCircle}
            data-testid="lesions-abstention-alert"
          >
            {t('lesions:abstention.help')}
          </EMRAlert>
        )}

        {/* Error */}
        {error && (
          <EMRAlert
            variant="error"
            icon={IconAlertCircle}
            title={t('common:error')}
            data-testid="lesions-error-alert"
          >
            <Stack gap="sm">
              <Text size="sm">{error.message}</Text>
              <Group gap="sm">
                <EMRButton
                  variant="outline"
                  leftSection={<IconArrowLeft size={16} stroke={2} />}
                  onClick={handleBack}
                >
                  {t('common:back')}
                </EMRButton>
                <EMRButton
                  onClick={() =>
                    // H-REFINE-5: invalidate the lesions cache instead of
                    // ``window.location.reload()`` — preserves open modals,
                    // sync-worker handle, and in-memory state.
                    void queryClient.invalidateQueries({
                      queryKey: lesionsQueryKey(analysisId),
                    })
                  }
                  data-testid="lesions-retry-button"
                >
                  {t('common:retry')}
                </EMRButton>
              </Group>
            </Stack>
          </EMRAlert>
        )}

        {/* Main two-column layout */}
        {!error && (
          <Box
            style={{
              display: 'grid',
              gap: 16,
              gridTemplateColumns: 'minmax(0, 1fr)',
              // Desktop: list (40%) + detail (60%). Mobile: single column.
            }}
            data-testid="lesions-layout"
          >
            <Box
              className={lesionsStyles.gridInner}
              style={{
                display: 'grid',
                gap: 16,
                gridTemplateColumns: 'minmax(0, 1fr)',
              }}
            >
              {/* L-REFINE-2: the desktop two-column rule lives in
                  ``LesionsPanelView.module.css`` (``.gridInner``)
                  instead of inline. */}

              {/* Left — list or skeleton */}
              <Box
                style={{
                  background: 'var(--emr-bg-card)',
                  border: '1px solid var(--emr-border-color)',
                  borderRadius: 12,
                  padding: 12,
                  minWidth: 0,
                }}
                data-testid="lesions-left-panel"
              >
                {isLoading ? (
                  <EMRListSkeleton items={6} />
                ) : lesions.length === 0 ? (
                  <EMREmptyState
                    title={t('lesions:list.emptyState.title')}
                    description={t('lesions:list.emptyState.body')}
                    size="md"
                    action={
                      hasOverridePerm || permissions.includes('review.reprompt_lesion')
                        ? {
                            label: t('refine:tools.addLesion'),
                            onClick: handleAddLesion,
                            icon: IconPlus,
                          }
                        : undefined
                    }
                    data-testid="lesions-empty-state"
                  />
                ) : (
                  <LesionList
                    lesions={lesions}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                    data-testid="lesions-list"
                  />
                )}
              </Box>

              {/* Right — detail panel or "select a lesion" prompt */}
              <Box
                style={{
                  background: 'var(--emr-bg-card)',
                  border: '1px solid var(--emr-border-color)',
                  borderRadius: 12,
                  minHeight: 320,
                  minWidth: 0,
                  overflow: 'hidden',
                }}
                data-testid="lesions-right-panel"
              >
                {isLoading ? (
                  <Box p="md">
                    <EMRListSkeleton items={4} />
                  </Box>
                ) : selectedLesion ? (
                  <LesionDetailPanel
                    lesion={selectedLesion}
                    onClose={() => setSelectedId(null)}
                    onOverride={hasOverridePerm ? handleOverrideClick : undefined}
                    data-testid="lesions-detail"
                  />
                ) : (
                  <Box p="lg">
                    <EMREmptyState
                      icon={IconTarget}
                      title={t('lesions:list.heading')}
                      description={t('lesions:list.emptyState.body')}
                      size="md"
                      variant="search"
                      data-testid="lesions-select-prompt"
                    />
                  </Box>
                )}
              </Box>
            </Box>
          </Box>
        )}

        {/* RUO footer */}
        <RUODisclaimerClaimAware
          claimKey="lesion_classification"
          data-testid="lesions-ruo-disclaimer"
        />
      </Stack>

      {/* Override modal — mounted once. Guarded by permission at the
          trigger; double-checked here so stale clicks can't bypass. */}
      <ClassificationOverride
        opened={overrideOpen && hasOverridePerm}
        lesionId={selectedLesion?.id ?? null}
        currentClass={
          selectedLesion?.suggestedClass
            ? UI_TO_OVERRIDE_CLASS[selectedLesion.suggestedClass]
            : null
        }
        onClose={() => setOverrideOpen(false)}
        onSubmit={handleOverrideSubmit}
        data-testid="lesions-override-modal"
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default function LesionsPanelView(): ReactElement {
  return (
    <EMRErrorBoundary componentName="LesionsPanelView">
      <LesionsPanelViewBody />
    </EMRErrorBoundary>
  );
}

/** Exported for tests — keeps the class-order reference local. */
export const __testing = { LESION_CLASS_ORDER };
