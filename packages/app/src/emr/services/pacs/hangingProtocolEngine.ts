// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Hanging Protocol Engine
// ============================================================================
// A "hanging protocol" is a recipe that tells the PACS viewer how to
// automatically arrange images when a study is opened. Think of it like a
// desk layout preset — when a radiologist opens a CT Abdomen with liver
// phase, the viewer knows to use a 1x2 layout with liver and bone windows
// side by side.
//
// This engine handles:
//   1. matchProtocol — find the best-matching protocol for a study
//   2. applyProtocol — convert a protocol into a ViewerConfiguration
//   3. System defaults — built-in protocols for common study types
//   4. User overrides — save/load custom protocols via FHIR Basic resources
//   5. Fallback — 1x1 first series if nothing matches
//
// Phase-4 status (LiverRa):
//   Engine matching + applyProtocol are pure logic and port verbatim.
//   User-protocol persistence (loadUserProtocols/saveUserProtocol/
//   deleteUserProtocol) routes through the LiverRa FHIR client stub
//   (`fhirClient.ts`). Once Phase 4 wires Supabase-backed FHIR storage,
//   these calls will persist Basic resources without any signature change.
//
// Ported from MediMind (services/pacs/hangingProtocolEngine.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient` (kept method surface identical).
//   - `@medplum/fhirtypes` Basic type inlined as a local minimal shape.
//   - `fhir-systems` constants inlined locally under `http://liverra.ai/fhir`
//     namespace — Phase 4 may relocate these into the central constants module.
//   - `requirePermission(..., 'manage-imaging')` removed (LiverRa permission
//     model is RBAC via Cognito + Guarded, wired in Phase 4).
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';
import type {
  HangingProtocolRule,
  ViewportLayout,
  ImagingStudyListItem,
  PACSViewerTool,
} from '../../types/pacs';
import { WINDOW_LEVEL_PRESETS } from './cornerstoneInit';

// ============================================================================
// Minimal FHIR shapes (inlined — Phase 4 will swap for real FHIR types)
// ============================================================================

/** Minimal FHIR Extension shape used for hanging-protocol metadata. */
interface Extension {
  url: string;
  valueString?: string;
}

/** Minimal FHIR CodeableConcept shape used for `Basic.code`. */
interface CodeableConcept {
  coding?: Array<{ system?: string; code?: string; display?: string }>;
}

/**
 * Minimal FHIR `Basic` resource shape. `Basic` is FHIR's escape hatch for
 * storing anything that doesn't fit an existing resource type — we use it
 * here to persist user-defined hanging protocols.
 */
interface Basic extends FhirResourceLike {
  resourceType: 'Basic';
  id?: string;
  meta?: { profile?: string[] };
  code?: CodeableConcept;
  extension?: Extension[];
}

// ============================================================================
// Inline FHIR extension URLs + Basic type codes (Phase 4 may centralize)
// ============================================================================

/** StructureDefinition base path for LiverRa-defined extensions. */
const EXT_BASE = `${FHIR_BASE_URL}/StructureDefinition` as const;

/** Code system URL for LiverRa's `Basic.code` values. */
const BASIC_RESOURCE_TYPES_CS = `${FHIR_BASE_URL}/CodeSystem/basic-resource-types` as const;

/** Extension URLs used to persist hanging-protocol fields on a Basic resource. */
const HP = {
  PROFILE: `${FHIR_BASE_URL}/StructureDefinition/hanging-protocol`,
  NAME: `${EXT_BASE}/hanging-protocol-name`,
  LAYOUT: `${EXT_BASE}/hanging-protocol-layout`,
  MODALITIES: `${EXT_BASE}/hanging-protocol-modalities`,
  BODY_PARTS: `${EXT_BASE}/hanging-protocol-body-parts`,
  ASSIGNMENTS: `${EXT_BASE}/hanging-protocol-assignments`,
} as const;

/** Basic.code code for hanging protocols. */
const HANGING_PROTOCOL_CODE = 'hanging-protocol';

// ============================================================================
// Types
// ============================================================================

/** The output of applyProtocol — everything the viewer needs to set up. */
export interface ViewerConfiguration {
  /** Which layout to use (e.g., '1x1', '1x2', '2x2') */
  layout: ViewportLayout;
  /** Assignment for each viewport slot */
  viewportAssignments: ViewportAssignment[];
  /** Name of the protocol that was applied */
  protocolName: string;
  /** Whether to load a prior study for comparison */
  loadPriorStudy: boolean;
  /** If loading a prior, which viewport to put it in */
  priorStudyViewportIndex?: number;
  /** Max age in days for prior study matching */
  priorStudyMaxAgeDays?: number;
}

/** Instructions for a single viewport slot */
export interface ViewportAssignment {
  /** Which viewport index (0-based) */
  viewportIndex: number;
  /** Criteria to pick a series (modality, description, etc.) */
  seriesSelector: {
    modality?: string;
    descriptionPattern?: string;
    seriesNumber?: number;
    preferFirst?: boolean;
  };
  /** Initial tool for this viewport */
  initialTool?: PACSViewerTool;
  /** Window/level preset to apply (e.g., 'liver', 'bone') */
  windowPreset?: string;
  /** Resolved window center from preset */
  windowCenter?: number;
  /** Resolved window width from preset */
  windowWidth?: number;
}

// ============================================================================
// System Default Protocols
// ============================================================================
// These are the built-in protocols that ship with the viewer. They cover
// the most common HPB (hepatobiliary) + abdominal study types used in
// LiverRa's target clinical flow. Users can override with custom ones.

export const SYSTEM_PROTOCOLS: HangingProtocolRule[] = [
  {
    id: 'system-ct-liver',
    name: 'CT Liver',
    isDefault: false,
    matchCriteria: {
      modality: ['CT'],
      bodyPart: ['LIVER'],
    },
    layout: '1x2',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'liver',
      },
      {
        viewportIndex: 1,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'bone',
      },
    ],
  },
  {
    id: 'system-mri-liver',
    name: 'MRI Liver',
    isDefault: false,
    matchCriteria: {
      modality: ['MR'],
      bodyPart: ['LIVER', 'ABDOMEN'],
    },
    layout: '2x2',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { modality: 'MR', description: /t1/i },
        initialTool: 'WindowLevel',
      },
      {
        viewportIndex: 1,
        seriesSelector: { modality: 'MR', description: /t2/i },
        initialTool: 'WindowLevel',
      },
      {
        viewportIndex: 2,
        seriesSelector: { modality: 'MR', description: /dwi|diff/i },
        initialTool: 'WindowLevel',
      },
      {
        viewportIndex: 3,
        seriesSelector: { modality: 'MR', description: /(post|contrast|gad|portal)/i },
        initialTool: 'WindowLevel',
      },
    ],
  },
  {
    id: 'system-ct-abdomen',
    name: 'CT Abdomen',
    isDefault: false,
    matchCriteria: {
      modality: ['CT'],
      bodyPart: ['ABDOMEN', 'PELVIS'],
    },
    layout: '1x2',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'abdomen',
      },
      {
        viewportIndex: 1,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'bone',
      },
    ],
  },
  {
    id: 'system-ct-chest',
    name: 'CT Chest',
    isDefault: false,
    matchCriteria: {
      modality: ['CT'],
      bodyPart: ['CHEST'],
    },
    layout: '1x2',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'lung',
      },
      {
        viewportIndex: 1,
        seriesSelector: { modality: 'CT', preferFirst: true },
        initialTool: 'WindowLevel',
        windowPreset: 'softTissue',
      },
    ],
  },
  {
    id: 'system-xray',
    name: 'X-Ray',
    isDefault: false,
    matchCriteria: {
      modality: ['CR', 'DX', 'XR'],
    },
    layout: '1x1',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { preferFirst: true },
        initialTool: 'WindowLevel',
      },
    ],
  },
  // Fallback — the "catch-all" protocol when nothing else matches
  {
    id: 'system-default',
    name: 'Default',
    isDefault: true,
    matchCriteria: {
      modality: [],
    },
    layout: '1x1',
    viewportAssignments: [
      {
        viewportIndex: 0,
        seriesSelector: { preferFirst: true },
        initialTool: 'WindowLevel',
      },
    ],
  },
];

// ============================================================================
// Protocol Matching
// ============================================================================

/**
 * Score how well a protocol matches a given study.
 * Higher score = better match. Returns 0 if no match at all.
 *
 * Scoring rules:
 *   +10 for each matching modality
 *   +20 for each matching body part
 *   +5 for matching description
 *   isDefault protocols always score 1 (lowest possible match)
 */
function scoreProtocol(protocol: HangingProtocolRule, study: ImagingStudyListItem): number {
  // Default protocol is the fallback — always scores 1
  if (protocol.isDefault) {
    return 1;
  }

  let score = 0;
  const { matchCriteria } = protocol;

  // Modality match — study must contain at least one of the protocol's modalities
  if (matchCriteria.modality.length > 0) {
    const modalityMatch = matchCriteria.modality.some((m) =>
      study.modalities.map((sm) => sm.toUpperCase()).includes(m.toUpperCase())
    );
    if (!modalityMatch) {
      return 0; // Hard filter — no modality overlap means no match
    }
    score += 10;
  }

  // Body part match (optional filter)
  // Three tiers:
  //   Both present + match → full score (+20)
  //   Protocol requires body part but study lacks it → reduced score (+5, can't confirm)
  //   Both present + mismatch → no match (return 0)
  if (matchCriteria.bodyPart && matchCriteria.bodyPart.length > 0) {
    if (study.bodyPart) {
      const bodyPartMatch = matchCriteria.bodyPart.some(
        (bp) => bp.toUpperCase() === study.bodyPart?.toUpperCase()
      );
      if (bodyPartMatch) {
        score += 20; // Full match — confirmed same body area
      } else {
        return 0; // Body parts don't match — wrong protocol
      }
    } else {
      // Study has no body part tag — can't confirm, give reduced score
      // so a proper body-part match always ranks higher
      score += 5;
    }
  }

  // Description match (optional filter)
  if (matchCriteria.description && study.description) {
    if (matchCriteria.description.test(study.description)) {
      score += 5;
    }
  }

  return score;
}

/**
 * Find the best-matching protocol for a study.
 * Checks user protocols first (higher priority), then system defaults.
 *
 * @param study - The imaging study to match against
 * @param userProtocols - User-defined custom protocols (optional)
 * @returns The best matching protocol, or the system default if nothing specific matches
 */
export function matchProtocol(
  study: ImagingStudyListItem,
  userProtocols: HangingProtocolRule[] = []
): HangingProtocolRule {
  // Combine user protocols (higher priority) with system protocols
  const allProtocols = [...userProtocols, ...SYSTEM_PROTOCOLS];

  let bestProtocol: HangingProtocolRule = SYSTEM_PROTOCOLS[SYSTEM_PROTOCOLS.length - 1]; // fallback
  let bestScore = 0;

  for (const protocol of allProtocols) {
    const score = scoreProtocol(protocol, study);
    if (score > bestScore) {
      bestScore = score;
      bestProtocol = protocol;
    }
  }

  return bestProtocol;
}

// ============================================================================
// Protocol Application
// ============================================================================

/**
 * Convert a matched protocol into a ViewerConfiguration.
 * Resolves window/level presets to actual numeric values.
 *
 * @param protocol - The protocol to apply
 * @returns A ViewerConfiguration ready for the viewer to use
 */
export function applyProtocol(protocol: HangingProtocolRule): ViewerConfiguration {
  const viewportAssignments: ViewportAssignment[] = protocol.viewportAssignments.map((va) => {
    const assignment: ViewportAssignment = {
      viewportIndex: va.viewportIndex,
      seriesSelector: {
        modality: va.seriesSelector.modality,
        descriptionPattern: va.seriesSelector.description?.source,
        seriesNumber: va.seriesSelector.seriesNumber,
        preferFirst: va.seriesSelector.preferFirst,
      },
      initialTool: va.initialTool,
      windowPreset: va.windowPreset,
    };

    // Resolve the preset name to actual window center/width values
    if (va.windowPreset && WINDOW_LEVEL_PRESETS[va.windowPreset]) {
      const preset = WINDOW_LEVEL_PRESETS[va.windowPreset];
      assignment.windowCenter = preset.center;
      assignment.windowWidth = preset.width;
    }

    return assignment;
  });

  return {
    layout: protocol.layout,
    viewportAssignments,
    protocolName: protocol.name,
    loadPriorStudy: protocol.priorStudyMatch?.enabled ?? false,
    priorStudyViewportIndex: protocol.priorStudyMatch?.viewportIndex,
    priorStudyMaxAgeDays: protocol.priorStudyMatch?.maxAgeDays,
  };
}

// ============================================================================
// User Protocol Persistence (FHIR Basic Resources — stubbed via fhirClient)
// ============================================================================

/**
 * Load user-defined hanging protocols from the FHIR store.
 * Stored as Basic resources with a specific profile.
 *
 * TODO(phase-4): Phase 4 plan wires this to Supabase FHIR. Today the
 * `fhirClient` stub returns an empty search, so we get system defaults only.
 *
 * @param fhir - LiverRa FHIR client (stubbed; Phase 4 swap for real client)
 * @returns Array of user-defined HangingProtocolRule objects
 */
export async function loadUserProtocols(fhir: LiverRaFhirClient): Promise<HangingProtocolRule[]> {
  try {
    const bundle = await fhir.search('Basic', {
      _profile: HP.PROFILE,
      _count: '100',
    });

    const results = (bundle.entry ?? [])
      .map((entry) => entry.resource)
      .filter((r): r is FhirResourceLike => Boolean(r))
      .map((r) => r as Basic);

    return results.map(basicToProtocol).filter((p): p is HangingProtocolRule => p !== null);
  } catch {
    // If loading fails, just return empty — system defaults will work
    return [];
  }
}

/**
 * Save a user-defined hanging protocol to the FHIR store.
 * Creates a new Basic resource with the protocol data as extensions.
 *
 * TODO(phase-4): Phase 4 plan wires this to Supabase FHIR. The stub echoes
 * back the input, so callers get an id-less resource until the backend
 * lands.
 *
 * @param fhir - LiverRa FHIR client (stubbed; Phase 4 swap for real client)
 * @param protocol - The protocol rule to save
 * @returns The saved Basic resource ID (or empty string from the stub)
 */
export async function saveUserProtocol(
  fhir: LiverRaFhirClient,
  protocol: HangingProtocolRule
): Promise<string> {
  const basic = protocolToBasic(protocol);
  const result = await fhir.createResource(basic);
  return (result.id as string | undefined) ?? '';
}

/**
 * Delete a user-defined hanging protocol from the FHIR store.
 *
 * TODO(phase-4): Phase 4 plan wires this to Supabase FHIR.
 *
 * @param fhir - LiverRa FHIR client (stubbed; Phase 4 swap for real client)
 * @param protocolId - The Basic resource ID to delete
 */
export async function deleteUserProtocol(
  fhir: LiverRaFhirClient,
  protocolId: string
): Promise<void> {
  // C-PACS-5: hanging protocols are part of the clinical reading
  // workflow; per CE MDR retention rules we soft-delete (mark
  // entered-in-error + stamp deleted-at) rather than physically remove.
  // Best-effort: if the read fails or returns null, fall through to
  // hard-delete so the protocolId disappears from the UI (the dev stub
  // returns null today for everything).
  const existing = (await fhir.readResource('Basic', protocolId)) as
    | (Basic & { id?: string })
    | null;
  if (existing && existing.resourceType === 'Basic') {
    // C-LOCK-3: thread the observed versionId as If-Match.
    await fhir.softDeleteResource(existing, {
      ifMatch: (existing.meta as { versionId?: string } | undefined)?.versionId,
    });
    return;
  }
  await fhir.deleteResource('Basic', protocolId);
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/** Convert a Basic resource to a HangingProtocolRule */
function basicToProtocol(basic: Basic): HangingProtocolRule | null {
  try {
    const ext = basic.extension ?? [];

    const name = ext.find((e) => e.url === HP.NAME)?.valueString;
    const layoutStr = ext.find((e) => e.url === HP.LAYOUT)?.valueString;
    const modalitiesStr = ext.find((e) => e.url === HP.MODALITIES)?.valueString;
    const bodyPartsStr = ext.find((e) => e.url === HP.BODY_PARTS)?.valueString;
    const assignmentsJson = ext.find((e) => e.url === HP.ASSIGNMENTS)?.valueString;

    if (!name || !layoutStr) {
      return null;
    }

    const modalities = modalitiesStr ? modalitiesStr.split(',').filter(Boolean) : [];
    const bodyParts = bodyPartsStr ? bodyPartsStr.split(',').filter(Boolean) : undefined;

    const parsedAssignments = assignmentsJson ? JSON.parse(assignmentsJson) : [];

    return {
      id: `user-${basic.id}`,
      name,
      isDefault: false,
      matchCriteria: {
        modality: modalities,
        bodyPart: bodyParts,
      },
      layout: layoutStr as ViewportLayout,
      viewportAssignments: parsedAssignments.map((a: Record<string, unknown>) => ({
        viewportIndex: a.viewportIndex as number,
        seriesSelector: {
          modality: (a.seriesSelector as Record<string, unknown>)?.modality as string | undefined,
          preferFirst: (a.seriesSelector as Record<string, unknown>)?.preferFirst as boolean | undefined,
        },
        initialTool: a.initialTool as PACSViewerTool | undefined,
        windowPreset: a.windowPreset as string | undefined,
      })),
    };
  } catch {
    return null;
  }
}

/** Convert a HangingProtocolRule to a Basic resource for storage */
function protocolToBasic(protocol: HangingProtocolRule): Basic {
  const assignments = protocol.viewportAssignments.map((va) => ({
    viewportIndex: va.viewportIndex,
    seriesSelector: {
      modality: va.seriesSelector.modality,
      preferFirst: va.seriesSelector.preferFirst,
    },
    initialTool: va.initialTool,
    windowPreset: va.windowPreset,
  }));

  return {
    resourceType: 'Basic',
    meta: {
      profile: [HP.PROFILE],
    },
    code: {
      coding: [
        {
          system: BASIC_RESOURCE_TYPES_CS,
          code: HANGING_PROTOCOL_CODE,
          display: 'Hanging Protocol',
        },
      ],
    },
    extension: [
      {
        url: HP.NAME,
        valueString: protocol.name,
      },
      {
        url: HP.LAYOUT,
        valueString: protocol.layout,
      },
      {
        url: HP.MODALITIES,
        valueString: protocol.matchCriteria.modality.join(','),
      },
      {
        url: HP.BODY_PARTS,
        valueString: protocol.matchCriteria.bodyPart?.join(',') ?? '',
      },
      {
        url: HP.ASSIGNMENTS,
        valueString: JSON.stringify(assignments),
      },
    ],
  };
}
