// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Viewing Presets Service (ported from MediMind, adapted to LiverRaFhirClient)
// ============================================================================
// A "viewing preset" is a per-user, per-view snapshot of the exact zoom,
// window/level, rotation, and flip state that a radiologist wants to recall.
// Think of it like a camera preset on a security console — "go back to the
// 'Hilum' view I set up earlier."
//
// Storage: FHIR Basic resources, mirroring the hanging-protocol pattern
// (see hangingProtocolEngine.ts for the canonical LiverRa adaptation):
//   - Basic.code identifies these resources as viewing presets.
//   - Basic.meta.profile pins the profile URL for searching.
//   - Extensions hold name, owner, modality/bodyPart filters, and a JSON
//     blob with the actual viewport state.
//
// LiverRa adaptation notes:
//   - `MedplumClient` → `LiverRaFhirClient` (persistence currently stubbed —
//     calls log via phaseStubLog and presets degrade to session-only).
//   - MediMind's `requirePermission(medplum, 'view-imaging')` gates dropped;
//     route-level permission guards cover viewer access in LiverRa.
//   - Extension URLs inlined from FHIR_BASE_URL (MediMind kept them in its
//     much larger fhir-systems.ts; Phase 4 may centralize).
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';
import { deleteWithIfMatch } from '../../utils/optimisticLocking';

// ============================================================================
// Inline FHIR shapes + systems (mirrors hangingProtocolEngine.ts)
// ============================================================================

interface Extension {
  url: string;
  valueString?: string;
}

interface Basic extends FhirResourceLike {
  resourceType: 'Basic';
  meta?: { profile?: string[]; versionId?: string; lastUpdated?: string };
  code?: { coding?: Array<{ system?: string; code?: string; display?: string }> };
  extension?: Extension[];
}

const BASIC_RESOURCE_TYPES_CS = `${FHIR_BASE_URL}/CodeSystem/basic-resource-types` as const;

/** Extension + profile URLs for the viewing-preset Basic carrier. */
const VP = {
  VIEWING_PRESET_PROFILE: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset`,
  VIEWING_PRESET_NAME: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset-name`,
  VIEWING_PRESET_OWNER: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset-owner`,
  VIEWING_PRESET_MODALITY: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset-modality`,
  VIEWING_PRESET_BODY_PART: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset-body-part`,
  VIEWING_PRESET_STATE: `${FHIR_BASE_URL}/StructureDefinition/viewing-preset-state`,
} as const;

const VIEWING_PRESET_CODE = 'viewing-preset';

// ============================================================================
// Types
// ============================================================================

/**
 * The viewport state that a preset captures.
 * Camera position is optional — only used for 3D / volume viewports.
 */
export interface ViewingPreset {
  /** Basic resource ID (undefined for unsaved presets) */
  id?: string;
  /** Human-readable name (e.g., "Hilum") */
  name: string;
  /** Practitioner ID who owns this preset (per-user scope) */
  ownerId: string;
  /** Optional modality filter — only show this preset for matching studies */
  modality?: string;
  /** Optional body part filter */
  bodyPart?: string;
  /** Window-level center (HU for CT, raw for MR/XR) */
  windowCenter: number;
  /** Window-level width */
  windowWidth: number;
  /** Zoom factor (1.0 = no zoom) */
  zoom: number;
  /** Rotation in degrees clockwise */
  rotationDegrees: number;
  /** Whether the viewport is mirrored horizontally */
  flipHorizontal: boolean;
  /** Whether the viewport is mirrored vertically */
  flipVertical: boolean;
  /** Optional camera position [x, y, z] for 3D viewports */
  cameraPosition?: number[];
  /** ISO timestamp of preset creation */
  createdAt: string;
}

/**
 * Runtime shape of the JSON viewport-state blob stored on the Basic resource.
 * Kept separate from `ViewingPreset` because name/owner/modality/bodyPart live
 * in sibling FHIR extensions, not inside this blob.
 */
export interface ViewingPresetState {
  windowCenter: number;
  windowWidth: number;
  zoom: number;
  rotationDegrees: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  cameraPosition?: number[];
  createdAt: string;
}

/** Optional filters when listing presets */
export interface ViewingPresetFilters {
  /** Only return presets matching this modality (case-insensitive) */
  modality?: string;
  /** Only return presets matching this body part (case-insensitive) */
  bodyPart?: string;
}

// ============================================================================
// CRUD operations
// ============================================================================

/**
 * Load all viewing presets owned by the given practitioner.
 * Optionally filter by modality / body part — presets with no filter set
 * always match (they're "universal" presets).
 *
 * @param fhir - LiverRa FHIR client
 * @param ownerId - Practitioner ID to scope to
 * @param filters - Optional study-context filters
 * @returns Array of ViewingPreset, sorted newest first
 */
export async function listPresets(
  fhir: LiverRaFhirClient,
  ownerId: string,
  filters: ViewingPresetFilters = {}
): Promise<ViewingPreset[]> {
  try {
    const bundle = await fhir.search('Basic', {
      _profile: VP.VIEWING_PRESET_PROFILE,
      _count: '100',
    });
    const results = (bundle.entry ?? [])
      .map((e) => e.resource)
      .filter((r): r is Basic => !!r && r.resourceType === 'Basic');

    const presets = results
      .map(basicToPreset)
      .filter((p): p is ViewingPreset => p !== null)
      .filter((p) => p.ownerId === ownerId);

    // Filter by modality / body part — empty filter on a preset means "match anything"
    const filtered = presets.filter((p) => {
      if (filters.modality && p.modality && p.modality.toUpperCase() !== filters.modality.toUpperCase()) {
        return false;
      }
      if (filters.bodyPart && p.bodyPart && p.bodyPart.toUpperCase() !== filters.bodyPart.toUpperCase()) {
        return false;
      }
      return true;
    });

    // Sort newest first
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    console.warn('[viewingPresetsService] failed to list PACS viewing presets; returning empty list:', err);
    // Search failure → return empty list (UI will show empty state)
    return [];
  }
}

/**
 * Save a new viewing preset (creates a Basic resource).
 *
 * @param fhir - LiverRa FHIR client
 * @param preset - The preset to save (id is ignored; always creates new)
 * @returns The saved preset including its assigned ID
 */
export async function savePreset(
  fhir: LiverRaFhirClient,
  preset: ViewingPreset
): Promise<ViewingPreset> {
  const basic = presetToBasic(preset);
  const result = await fhir.createResource(basic);
  return { ...preset, id: result.id };
}

/**
 * Delete a viewing preset by ID.
 *
 * @param fhir - LiverRa FHIR client
 * @param id - Basic resource ID
 */
export async function deletePreset(fhir: LiverRaFhirClient, id: string): Promise<void> {
  const existing = await fhir.readResource('Basic', id);
  if (!existing) {
    return;
  }
  await deleteWithIfMatch(fhir, existing as Basic);
}

// ============================================================================
// Serialization
// ============================================================================

type JsonObject = { [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readCameraPosition(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 3) {
    return undefined;
  }
  return value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? [...value]
    : undefined;
}

function readCreatedAt(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return Number.isNaN(Date.parse(value)) ? fallback : value;
}

/** Parse and validate the viewport-state JSON stored in a viewing preset. */
export function parseViewingPresetState(stateJson: string, fallbackCreatedAt: string): ViewingPresetState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch (err) {
    console.warn('[viewingPresetsService] failed to parse PACS viewing preset state; skipping preset:', err);
    return null;
  }

  if (!isJsonObject(parsed)) {
    return null;
  }

  return {
    windowCenter: readFiniteNumber(parsed.windowCenter, 40),
    windowWidth: readFiniteNumber(parsed.windowWidth, 400),
    zoom: readFiniteNumber(parsed.zoom, 1),
    rotationDegrees: readFiniteNumber(parsed.rotationDegrees, 0),
    flipHorizontal: readBoolean(parsed.flipHorizontal),
    flipVertical: readBoolean(parsed.flipVertical),
    cameraPosition: readCameraPosition(parsed.cameraPosition),
    createdAt: readCreatedAt(parsed.createdAt, fallbackCreatedAt),
  };
}

/** Convert a Basic resource to a ViewingPreset (returns null on bad data) */
function basicToPreset(basic: Basic): ViewingPreset | null {
  try {
    const ext = basic.extension ?? [];

    const name = ext.find((e) => e.url === VP.VIEWING_PRESET_NAME)?.valueString;
    const ownerId = ext.find((e) => e.url === VP.VIEWING_PRESET_OWNER)?.valueString;
    const stateJson = ext.find((e) => e.url === VP.VIEWING_PRESET_STATE)?.valueString;

    if (!name || !ownerId || !stateJson) {
      return null;
    }

    const state = parseViewingPresetState(stateJson, basic.meta?.lastUpdated ?? new Date().toISOString());
    if (!state) {
      return null;
    }

    return {
      id: basic.id,
      name,
      ownerId,
      modality: ext.find((e) => e.url === VP.VIEWING_PRESET_MODALITY)?.valueString || undefined,
      bodyPart: ext.find((e) => e.url === VP.VIEWING_PRESET_BODY_PART)?.valueString || undefined,
      windowCenter: state.windowCenter,
      windowWidth: state.windowWidth,
      zoom: state.zoom,
      rotationDegrees: state.rotationDegrees,
      flipHorizontal: state.flipHorizontal,
      flipVertical: state.flipVertical,
      cameraPosition: state.cameraPosition,
      createdAt: state.createdAt,
    };
  } catch (err) {
    console.warn('[viewingPresetsService] best-effort PACS operation failed:', err);
    return null;
  }
}

/** Convert a ViewingPreset to a Basic resource for storage */
function presetToBasic(preset: ViewingPreset): Basic {
  const state = {
    windowCenter: preset.windowCenter,
    windowWidth: preset.windowWidth,
    zoom: preset.zoom,
    rotationDegrees: preset.rotationDegrees,
    flipHorizontal: preset.flipHorizontal,
    flipVertical: preset.flipVertical,
    cameraPosition: preset.cameraPosition,
    createdAt: preset.createdAt,
  };

  const extensions: Extension[] = [
    { url: VP.VIEWING_PRESET_NAME, valueString: preset.name },
    { url: VP.VIEWING_PRESET_OWNER, valueString: preset.ownerId },
    { url: VP.VIEWING_PRESET_STATE, valueString: JSON.stringify(state) },
  ];

  if (preset.modality) {
    extensions.push({ url: VP.VIEWING_PRESET_MODALITY, valueString: preset.modality });
  }
  if (preset.bodyPart) {
    extensions.push({ url: VP.VIEWING_PRESET_BODY_PART, valueString: preset.bodyPart });
  }

  return {
    resourceType: 'Basic',
    meta: {
      profile: [VP.VIEWING_PRESET_PROFILE],
    },
    code: {
      coding: [
        {
          system: BASIC_RESOURCE_TYPES_CS,
          code: VIEWING_PRESET_CODE,
          display: 'Viewing Preset',
        },
      ],
    },
    extension: extensions,
  };
}
