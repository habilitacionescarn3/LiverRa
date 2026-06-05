// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useCalibration Hook — French catheter calibration lifecycle + FHIR storage
// ============================================================================
// Manages the calibration workflow for angiography (XA) images:
//   1. User clicks "Calibrate" → isCalibrating = true
//   2. User draws a line across a catheter → completeCalibration(frenchSize, pixelLength)
//   3. The hook calculates mm/pixel and saves it as a FHIR Basic resource
//   4. Future measurements use convertPixelsToMm() with the stored factor
//
// FHIR storage: One Basic resource per calibrated DICOM acquisition,
// code = "calibration-data". On mount, the hook checks whether the active
// viewport has a matching calibration for its series/image/frame scope.
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLiverraFhir } from '../useLiverraFhir';
import { useTranslation } from '../../contexts/TranslationContext';
import {
  calculateCalibration,
  CalibrationError,
  FRENCH_SIZES,
  saveCalibration as saveCalibrationService,
} from '../../services/pacs/calibrationService';
import type { CalibrationResult } from '../../services/pacs/calibrationService';
import { deleteWithIfMatch } from '../../utils/optimisticLocking';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';

// LiverRa adaptation: MediMind's `Basic` came from the upstream FHIR types
// package. A type ALIAS (not interface) gets an implicit index signature, so
// it stays assignable to the FhirResourceLike-shaped service params
// (calibrationService.saveCalibration, deleteWithIfMatch).
type BasicExtension = {
  url: string;
  valueString?: string;
  valueInteger?: number;
  valueDecimal?: number;
};
type Basic = {
  resourceType: 'Basic';
  id?: string;
  meta?: { versionId?: string; lastUpdated?: string; profile?: string[] };
  code?: { coding?: Array<{ system?: string; code?: string }> };
  subject?: { reference?: string };
  extension?: BasicExtension[];
};

// TODO(phase-4): port the full MediMind `fhir-systems` PACS constant groups.
// Inlined locally (same approach as hangingProtocolEngine — liverra.ai base;
// calibration is a NEW carrier stream in LiverRa, so no medimind.ge
// back-compat is needed) until the constants file grows these groups.
const LAB_PRODUCTION_CODE_SYSTEMS = {
  BASIC_RESOURCE_TYPES: `${FHIR_BASE_URL}/CodeSystem/basic-resource-type`,
} as const;
const PACS_BASIC_TYPES = {
  CALIBRATION_DATA: 'calibration-data',
} as const;
const IMAGING_EXTENSIONS = {
  CALIBRATION_FRENCH_SIZE: `${FHIR_BASE_URL}/StructureDefinition/calibration-french-size`,
  CALIBRATION_MM_PER_PIXEL: `${FHIR_BASE_URL}/StructureDefinition/calibration-mm-per-pixel`,
} as const;

const CALIBRATION_SCOPE_EXTENSIONS = {
  STUDY_INSTANCE_UID: `${FHIR_BASE_URL}/StructureDefinition/calibration-study-instance-uid`,
  SERIES_INSTANCE_UID: `${FHIR_BASE_URL}/StructureDefinition/calibration-series-instance-uid`,
  SOP_INSTANCE_UID: `${FHIR_BASE_URL}/StructureDefinition/calibration-sop-instance-uid`,
  FRAME_NUMBER: `${FHIR_BASE_URL}/StructureDefinition/calibration-frame-number`,
  FRAME_OF_REFERENCE_UID: `${FHIR_BASE_URL}/StructureDefinition/calibration-frame-of-reference-uid`,
  VIEWPORT_ID: `${FHIR_BASE_URL}/StructureDefinition/calibration-viewport-id`,
  ROW_PIXEL_SPACING_MM: `${FHIR_BASE_URL}/StructureDefinition/calibration-row-pixel-spacing-mm`,
  COLUMN_PIXEL_SPACING_MM: `${FHIR_BASE_URL}/StructureDefinition/calibration-column-pixel-spacing-mm`,
} as const;

// ============================================================================
// Types
// ============================================================================

/** Return value of the useCalibration hook */
export interface UseCalibrationReturn {
  /** Current active calibration (null if uncalibrated) */
  calibration: CalibrationResult | null;
  /** Whether the user is in the process of drawing a calibration line */
  isCalibrating: boolean;
  /** Warning message when an XA image has no calibration, or null */
  calibrationWarning: string | null;
  /** Whether the current calibration change has not been persisted to FHIR */
  hasUnsavedCalibration: boolean;
  /** Latest calibration save error, or null */
  calibrationSaveError: string | null;
  /** False while calibration-dependent persisted measurements/reports should be blocked */
  canPersistCalibrationDependentData: boolean;
  /** Begin the calibration workflow (user should draw a line on the catheter) */
  startCalibration: () => void;
  /** Finish calibration with the selected French size and measured pixel length */
  completeCalibration: (frenchSize: number, pixelLength: number) => void;
  /** Remove the current calibration and delete the FHIR resource */
  clearCalibration: () => void;
  /** Check if a modality needs calibration and return a warning or null */
  getCalibrationWarning: (modality: string) => string | null;
}

/** DICOM identity for the active image plane being calibrated. */
export interface CalibrationScope {
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  frameNumber?: number;
  frameOfReferenceUid?: string;
  viewportId?: string;
  rowPixelSpacingMm?: number;
  columnPixelSpacingMm?: number;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to manage pixel-to-mm calibration for PACS viewer.
 *
 * @param studyId - FHIR ImagingStudy resource ID (used for persistence)
 * @param modality - Imaging modality (e.g. 'XA', 'CT'). Used for uncalibrated warning.
 * @param calibrationScope - DICOM image identity for safe XA calibration reuse.
 */
export function useCalibration(
  studyId?: string,
  modality?: string,
  calibrationScope?: CalibrationScope
): UseCalibrationReturn {
  const fhir = useLiverraFhir();
  const { t } = useTranslation();

  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [hasUnsavedCalibration, setHasUnsavedCalibration] = useState(false);
  const [calibrationSaveError, setCalibrationSaveError] = useState<string | null>(null);
  const [hasCalibrationForOtherScope, setHasCalibrationForOtherScope] = useState(false);
  const calibrationRef = useRef<CalibrationResult | null>(null);
  const calibrationScopeKey = getCalibrationScopeKey(calibrationScope);

  // Track the FHIR Basic resource ID for deletion
  const persistedIdRef = useRef<string | null>(null);
  const persistedResourceRef = useRef<Basic | null>(null);
  const localRevisionRef = useRef(0);
  const studyIdRef = useRef<string | undefined>(studyId);
  const calibrationScopeKeyRef = useRef<string | null>(calibrationScopeKey);

  const setCalibrationValue = useCallback((value: CalibrationResult | null): void => {
    calibrationRef.current = value;
    setCalibration(value);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (studyIdRef.current !== studyId || calibrationScopeKeyRef.current !== calibrationScopeKey) {
      studyIdRef.current = studyId;
      calibrationScopeKeyRef.current = calibrationScopeKey;
      localRevisionRef.current += 1;
      persistedIdRef.current = null;
      persistedResourceRef.current = null;
      setHasUnsavedCalibration(false);
      setCalibrationSaveError(null);
      setHasCalibrationForOtherScope(false);
      if (calibrationRef.current !== null) {
        setCalibrationValue(null);
      }
    }
    const loadRevision = localRevisionRef.current;

    if (!studyId || !calibrationScopeKey) {
      persistedIdRef.current = null;
      persistedResourceRef.current = null;
      setHasUnsavedCalibration(false);
      setCalibrationSaveError(null);
      setHasCalibrationForOtherScope(false);
      if (calibrationRef.current !== null) {
        setCalibrationValue(null);
      }
      return () => {
        cancelled = true;
      };
    }

    void (async (): Promise<void> => {
      try {
        // LiverRa: `searchResources` → `search` + Bundle unwrap (recipe).
        const bundle = await fhir.search('Basic', {
          code: `${LAB_PRODUCTION_CODE_SYSTEMS.BASIC_RESOURCE_TYPES}|${PACS_BASIC_TYPES.CALIBRATION_DATA}`,
          subject: `ImagingStudy/${studyId}`,
          _count: '50',
        });
        const candidates = (bundle.entry ?? [])
          .map((entry) => entry.resource)
          .filter((r): r is NonNullable<typeof r> => Boolean(r && r.resourceType === 'Basic'))
          .map((r) => r as Basic);
        if (cancelled || loadRevision !== localRevisionRef.current) {
          return;
        }

        const existing = candidates.find((candidate) =>
          basicMatchesCalibrationScope(candidate, calibrationScopeKey)
        );
        if (!existing?.id) {
          persistedIdRef.current = null;
          persistedResourceRef.current = null;
          setHasUnsavedCalibration(false);
          setCalibrationSaveError(null);
          setHasCalibrationForOtherScope(candidates.length > 0);
          if (calibrationRef.current !== null) {
            setCalibrationValue(null);
          }
          return;
        }

        const restored = calibrationFromBasic(existing);
        persistedIdRef.current = existing.id;
        persistedResourceRef.current = existing;
        setHasUnsavedCalibration(false);
        setCalibrationSaveError(null);
        setHasCalibrationForOtherScope(false);
        setCalibrationValue(restored);
      } catch (err) {
        console.warn('[useCalibration] best-effort PACS operation failed:', err);
        if (!cancelled && loadRevision === localRevisionRef.current) {
          persistedIdRef.current = null;
          persistedResourceRef.current = null;
          setHasUnsavedCalibration(false);
          setCalibrationSaveError(null);
          setHasCalibrationForOtherScope(false);
          if (calibrationRef.current !== null) {
            setCalibrationValue(null);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [studyId, calibrationScopeKey, fhir, setCalibrationValue]);

  // ---- Start calibration workflow ----
  const startCalibration = useCallback(() => {
    setIsCalibrating(true);
  }, []);

  // ---- Complete calibration ----
  const completeCalibration = useCallback(
    (frenchSize: number, pixelLength: number) => {
      try {
        if (!calibrationScopeKey) {
          setIsCalibrating(false);
          throw new CalibrationError('Calibration requires the active DICOM series and image scope');
        }

        const previousCalibration = calibrationRef.current;
        const targetStudyId = studyId;
        const targetScopeKey = calibrationScopeKey;
        const result = calculateCalibration(frenchSize, pixelLength);
        const currentScope = parseCalibrationScopeKey(targetScopeKey);
        localRevisionRef.current += 1;
        const saveRevision = localRevisionRef.current;
        setCalibrationValue(result);
        setIsCalibrating(false);
        setCalibrationSaveError(null);
        setHasUnsavedCalibration(Boolean(targetStudyId));

        // Persist to FHIR as a Basic resource
        if (targetStudyId) {
          const basic: Partial<Basic> = {
            resourceType: 'Basic',
            meta: {
              profile: [`${LAB_PRODUCTION_CODE_SYSTEMS.BASIC_RESOURCE_TYPES}/${PACS_BASIC_TYPES.CALIBRATION_DATA}`],
            },
            code: {
              coding: [
                {
                  system: LAB_PRODUCTION_CODE_SYSTEMS.BASIC_RESOURCE_TYPES,
                  code: PACS_BASIC_TYPES.CALIBRATION_DATA,
                },
              ],
            },
            subject: {
              reference: `ImagingStudy/${targetStudyId}`,
            },
            extension: [
              {
                url: IMAGING_EXTENSIONS.CALIBRATION_FRENCH_SIZE,
                valueInteger: frenchSize,
              },
              {
                url: IMAGING_EXTENSIONS.CALIBRATION_MM_PER_PIXEL,
                valueDecimal: result.mmPerPixel,
              },
              ...calibrationScopeToExtensions(currentScope),
            ],
          };

          const saveCalibration = async (): Promise<void> => {
            try {
              const existing = persistedResourceRef.current;
              const matchingExisting =
                existing?.id &&
                existing.subject?.reference === `ImagingStudy/${targetStudyId}` &&
                basicMatchesCalibrationScope(existing, targetScopeKey)
                  ? existing
                  : null;
              const resource: Basic = matchingExisting
                ? ({ ...matchingExisting, extension: basic.extension } as Basic)
                : (basic as Basic);
              const persisted = (await saveCalibrationService(fhir, resource)) as Basic;
              if (
                studyIdRef.current !== targetStudyId ||
                calibrationScopeKeyRef.current !== targetScopeKey ||
                saveRevision !== localRevisionRef.current
              ) {
                return;
              }
              const persistedSubject = persisted.subject?.reference;
              if (persistedSubject && persistedSubject !== `ImagingStudy/${targetStudyId}`) {
                return;
              }
              persistedIdRef.current = persisted.id ?? matchingExisting?.id ?? null;
              persistedResourceRef.current = persisted;
              setHasCalibrationForOtherScope(false);
              setHasUnsavedCalibration(false);
              setCalibrationSaveError(null);
            } catch (err) {
              if (
                studyIdRef.current !== targetStudyId ||
                calibrationScopeKeyRef.current !== targetScopeKey ||
                saveRevision !== localRevisionRef.current
              ) {
                return;
              }
              console.error('[useCalibration] calibration save failed:', err);
              setCalibrationValue(previousCalibration);
              setHasUnsavedCalibration(true);
              setCalibrationSaveError(t('pacs.calibration.saveFailed'));
            }
          };

          void saveCalibration();
        } else {
          setHasUnsavedCalibration(false);
        }
      } catch (err) {
        console.warn('[useCalibration] PACS fallback path failed:', err);
        if (err instanceof CalibrationError) {
          setIsCalibrating(false);
        }
        throw err;
      }
    },
    [studyId, calibrationScopeKey, fhir, setCalibrationValue, t]
  );

  // ---- Clear calibration ----
  const clearCalibration = useCallback(() => {
    setIsCalibrating(false);
    setHasUnsavedCalibration(false);
    setCalibrationSaveError(null);

    // Delete FHIR resource if persisted
    if (persistedIdRef.current) {
      const idToDelete = persistedIdRef.current;
      const resourceToDelete = persistedResourceRef.current;
      const calibrationToRestore = calibrationRef.current;
      const deleteRevision = localRevisionRef.current;

      const deletePromise = (async () => {
        // LiverRa: readResource returns null when missing (MedplumClient
        // threw) — surface the same failure path via an explicit throw so
        // the .catch below restores the calibration and alerts the user.
        const resource =
          resourceToDelete ?? ((await fhir.readResource('Basic', idToDelete)) as Basic | null);
        if (!resource) {
          throw new Error(`Calibration resource Basic/${idToDelete} not found`);
        }
        await deleteWithIfMatch(fhir, resource);
      })();

      void deletePromise.then(() => {
        if (deleteRevision !== localRevisionRef.current) {
          return;
        }
        localRevisionRef.current += 1;
        persistedIdRef.current = null;
        persistedResourceRef.current = null;
        setHasCalibrationForOtherScope(false);
        setCalibrationValue(null);
      }).catch((err) => {
        console.error('[useCalibration] calibration delete failed:', err);
        if (deleteRevision === localRevisionRef.current) {
          setCalibrationValue(calibrationToRestore);
        }
        if (typeof window !== 'undefined') {
          window.alert(t('errors.deleteFailed'));
        }
      });
      return;
    }

    localRevisionRef.current += 1;
    setHasCalibrationForOtherScope(false);
    setCalibrationValue(null);
  }, [fhir, setCalibrationValue, t]);

  const activeCalibration = studyId && calibrationScopeKey ? calibration : null;

  // ---- Warning for uncalibrated XA ----
  const getCalibrationWarning = useCallback(
    (mod: string): string | null => {
      if (calibrationSaveError) {
        return calibrationSaveError;
      }
      if (mod === 'XA' && !calibrationScopeKey) {
        // LiverRa t() has no default-string second arg — keys live in
        // translations/<locale>/pacs.json.
        return t('pacs.calibration.warningScopeRequired');
      }
      if (mod === 'XA' && hasCalibrationForOtherScope) {
        return t('pacs.calibration.warningWrongScope');
      }
      if (mod === 'XA' && !activeCalibration) {
        return t('pacs.calibration.warningUncalibrated');
      }
      return null;
    },
    [activeCalibration, calibrationSaveError, calibrationScopeKey, hasCalibrationForOtherScope, t]
  );

  // Compute current warning based on the modality prop
  const calibrationWarning = modality ? getCalibrationWarning(modality) : null;

  return {
    calibration: activeCalibration,
    isCalibrating,
    calibrationWarning,
    hasUnsavedCalibration,
    calibrationSaveError,
    canPersistCalibrationDependentData:
      !hasUnsavedCalibration && !calibrationSaveError && (modality !== 'XA' || Boolean(activeCalibration)),
    startCalibration,
    completeCalibration,
    clearCalibration,
    getCalibrationWarning,
  };
}

function getCalibrationExtensionNumber(resource: Basic, url: string): number | null {
  const ext = resource.extension?.find((item) => item.url === url);
  const value = ext?.valueDecimal ?? ext?.valueInteger;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getCalibrationExtensionString(resource: Basic, url: string): string | undefined {
  const value = resource.extension?.find((item) => item.url === url)?.valueString;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeScopeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeScopeNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeCalibrationScope(scope?: CalibrationScope): CalibrationScope | null {
  const normalized: CalibrationScope = {
    studyInstanceUid: normalizeScopeString(scope?.studyInstanceUid),
    seriesInstanceUid: normalizeScopeString(scope?.seriesInstanceUid),
    sopInstanceUid: normalizeScopeString(scope?.sopInstanceUid),
    frameNumber: normalizeScopeNumber(scope?.frameNumber),
    frameOfReferenceUid: normalizeScopeString(scope?.frameOfReferenceUid),
    viewportId: normalizeScopeString(scope?.viewportId),
    rowPixelSpacingMm: normalizeScopeNumber(scope?.rowPixelSpacingMm),
    columnPixelSpacingMm: normalizeScopeNumber(scope?.columnPixelSpacingMm),
  };

  if (!normalized.seriesInstanceUid || !normalized.sopInstanceUid) {
    return null;
  }

  return normalized;
}

function getCalibrationScopeKey(scope?: CalibrationScope): string | null {
  const normalized = normalizeCalibrationScope(scope);
  return normalized ? JSON.stringify(normalized) : null;
}

function parseCalibrationScopeKey(scopeKey: string): CalibrationScope {
  return JSON.parse(scopeKey) as CalibrationScope;
}

function basicMatchesCalibrationScope(resource: Basic, scopeKey: string): boolean {
  const resourceScope = normalizeCalibrationScope({
    studyInstanceUid: getCalibrationExtensionString(resource, CALIBRATION_SCOPE_EXTENSIONS.STUDY_INSTANCE_UID),
    seriesInstanceUid: getCalibrationExtensionString(resource, CALIBRATION_SCOPE_EXTENSIONS.SERIES_INSTANCE_UID),
    sopInstanceUid: getCalibrationExtensionString(resource, CALIBRATION_SCOPE_EXTENSIONS.SOP_INSTANCE_UID),
    frameNumber: getCalibrationExtensionNumber(resource, CALIBRATION_SCOPE_EXTENSIONS.FRAME_NUMBER) ?? undefined,
    frameOfReferenceUid: getCalibrationExtensionString(
      resource,
      CALIBRATION_SCOPE_EXTENSIONS.FRAME_OF_REFERENCE_UID
    ),
    viewportId: getCalibrationExtensionString(resource, CALIBRATION_SCOPE_EXTENSIONS.VIEWPORT_ID),
    rowPixelSpacingMm:
      getCalibrationExtensionNumber(resource, CALIBRATION_SCOPE_EXTENSIONS.ROW_PIXEL_SPACING_MM) ?? undefined,
    columnPixelSpacingMm:
      getCalibrationExtensionNumber(resource, CALIBRATION_SCOPE_EXTENSIONS.COLUMN_PIXEL_SPACING_MM) ?? undefined,
  });

  return Boolean(resourceScope && getCalibrationScopeKey(resourceScope) === scopeKey);
}

function calibrationScopeToExtensions(scope: CalibrationScope): NonNullable<Basic['extension']> {
  const extensions: NonNullable<Basic['extension']> = [
    {
      url: CALIBRATION_SCOPE_EXTENSIONS.SERIES_INSTANCE_UID,
      valueString: scope.seriesInstanceUid,
    },
    {
      url: CALIBRATION_SCOPE_EXTENSIONS.SOP_INSTANCE_UID,
      valueString: scope.sopInstanceUid,
    },
  ];

  if (scope.studyInstanceUid) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.STUDY_INSTANCE_UID,
      valueString: scope.studyInstanceUid,
    });
  }
  if (scope.frameNumber !== undefined) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.FRAME_NUMBER,
      valueInteger: scope.frameNumber,
    });
  }
  if (scope.frameOfReferenceUid) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.FRAME_OF_REFERENCE_UID,
      valueString: scope.frameOfReferenceUid,
    });
  }
  if (scope.viewportId) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.VIEWPORT_ID,
      valueString: scope.viewportId,
    });
  }
  if (scope.rowPixelSpacingMm !== undefined) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.ROW_PIXEL_SPACING_MM,
      valueDecimal: scope.rowPixelSpacingMm,
    });
  }
  if (scope.columnPixelSpacingMm !== undefined) {
    extensions.push({
      url: CALIBRATION_SCOPE_EXTENSIONS.COLUMN_PIXEL_SPACING_MM,
      valueDecimal: scope.columnPixelSpacingMm,
    });
  }

  return extensions;
}

function calibrationFromBasic(resource: Basic): CalibrationResult {
  const frenchSize = getCalibrationExtensionNumber(resource, IMAGING_EXTENSIONS.CALIBRATION_FRENCH_SIZE);
  const mmPerPixel = getCalibrationExtensionNumber(resource, IMAGING_EXTENSIONS.CALIBRATION_MM_PER_PIXEL);

  if (!frenchSize || !mmPerPixel || mmPerPixel <= 0) {
    throw new CalibrationError('Invalid stored calibration data');
  }

  const knownDiameterMm = FRENCH_SIZES[frenchSize] ?? frenchSize / 3;
  return {
    frenchSize,
    knownDiameterMm,
    pixelLength: knownDiameterMm / mmPerPixel,
    mmPerPixel,
    calibratedAt: resource.meta?.lastUpdated ? new Date(resource.meta.lastUpdated) : new Date(),
  };
}
