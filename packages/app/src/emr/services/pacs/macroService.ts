// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Macro Service — CRUD for Radiology Report Text Macros
// ============================================================================
// Stores text macros as FHIR `Basic` resources. A macro lets a radiologist
// type a shorthand trigger like ".impression" and have it expand into a full
// boilerplate text block — think of it like text-replacement shortcuts on
// your phone, but for radiology report sections.
//
// Storage model:
//   One `Basic` resource per macro.
//   `Basic.code` = "report-macro" (from `PACS_BASIC_TYPES` below).
//   `Basic.subject` = Practitioner reference (the macro owner).
//   Extensions hold the trigger, expansion, and optional category.
//
// Phase-2 status (LiverRa):
//   The FHIR client is the LiverRa stub (`useLiverraFhir` → `fhirClient.ts`),
//   so reads return empty, writes echo back — the UI renders and lets
//   radiologists draft macros, but persistence is wired in Phase 4.
//
// Ported from MediMind (services/pacs/macroService.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient` (kept method surface identical).
//   - `@medplum/fhirtypes` types inlined as local minimal shapes.
//   - `fhir-systems` constants inlined locally under `http://liverra.ai/fhir`
//     namespace — Phase 4 may relocate these into a shared constants module.
//   - `requirePermission(..., 'manage-imaging')` removed (LiverRa permission
//     model is RBAC via Cognito + Guarded, wired in Phase 4).
// ============================================================================

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';

// ============================================================================
// Minimal FHIR shapes (inlined — Phase 4 will swap for the real FHIR types)
// ============================================================================

/** Minimal FHIR Extension shape used for macro metadata. */
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
 * here to persist report macros.
 */
interface Basic extends FhirResourceLike {
  resourceType: 'Basic';
  id?: string;
  code?: CodeableConcept;
  subject?: { reference?: string };
  extension?: Extension[];
}

// ============================================================================
// Inlined URL constants
// ============================================================================
// MediMind centralised these under `constants/fhir-systems.ts`. LiverRa
// doesn't have a full imaging-extension set yet, so we inline the handful
// this service needs. Phase 4 will relocate these into
// `constants/fhir-imaging-extensions.ts` or similar.

/** CodeSystem URL for the `Basic.code` discriminator. */
const BASIC_RESOURCE_TYPE_SYSTEM = `${FHIR_BASE_URL}/CodeSystem/basic-resource-types` as const;

/** `Basic.code.coding.code` value identifying this resource as a report macro. */
const REPORT_MACRO_CODE = 'report-macro' as const;

/** Extension URLs for macro trigger / expansion / category. */
const IMAGING_EXTENSIONS = {
  MACRO_TRIGGER: `${FHIR_BASE_URL}/StructureDefinition/macro-trigger`,
  MACRO_EXPANSION: `${FHIR_BASE_URL}/StructureDefinition/macro-expansion`,
  MACRO_CATEGORY: `${FHIR_BASE_URL}/StructureDefinition/macro-category`,
} as const;

// ============================================================================
// Types
// ============================================================================

/** Valid macro categories for radiology reports. */
export type MacroCategory = 'general' | 'ct' | 'mri' | 'xray' | 'us';

// ============================================================================
// Internal Helpers
// ============================================================================

/** Build the `Basic.code` for a report macro. */
function buildMacroCode(): CodeableConcept {
  return {
    coding: [
      {
        system: BASIC_RESOURCE_TYPE_SYSTEM,
        code: REPORT_MACRO_CODE,
        display: 'Report Macro',
      },
    ],
  };
}

/** Build the extension array for a macro. */
function buildMacroExtensions(
  trigger: string,
  expansion: string,
  category?: string,
): Extension[] {
  const extensions: Extension[] = [
    { url: IMAGING_EXTENSIONS.MACRO_TRIGGER, valueString: trigger },
    { url: IMAGING_EXTENSIONS.MACRO_EXPANSION, valueString: expansion },
  ];
  if (category) {
    extensions.push({ url: IMAGING_EXTENSIONS.MACRO_CATEGORY, valueString: category });
  }
  return extensions;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new report text macro.
 *
 * @param medplum LiverRa FHIR client (stub in Phase 2).
 * @param practitionerId FHIR Practitioner resource ID (macro owner).
 * @param trigger Shorthand trigger (must start with ".").
 * @param expansion Full text the trigger expands to.
 * @param category Optional category (general, ct, mri, xray, us).
 * @returns The created `Basic` resource.
 */
export async function createMacro(
  medplum: LiverRaFhirClient,
  practitionerId: string,
  trigger: string,
  expansion: string,
  category?: MacroCategory,
): Promise<Basic> {
  if (!trigger.startsWith('.')) {
    throw new Error('Macro trigger must start with "."');
  }

  return medplum.createResource<Basic>({
    resourceType: 'Basic',
    code: buildMacroCode(),
    subject: { reference: `Practitioner/${practitionerId}` },
    extension: buildMacroExtensions(trigger, expansion, category),
  });
}

/**
 * Search all macros owned by a practitioner.
 *
 * @param medplum LiverRa FHIR client (stub in Phase 2).
 * @param practitionerId FHIR Practitioner resource ID.
 * @returns Array of `Basic` resources representing macros.
 */
export async function searchMacros(
  medplum: LiverRaFhirClient,
  practitionerId: string,
): Promise<Basic[]> {
  const bundle = await medplum.search('Basic', {
    code: `${BASIC_RESOURCE_TYPE_SYSTEM}|${REPORT_MACRO_CODE}`,
    subject: `Practitioner/${practitionerId}`,
    _count: '100',
  });
  return (bundle.entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is Basic => Boolean(r) && r?.resourceType === 'Basic');
}

/**
 * Update an existing macro's trigger, expansion, or category.
 *
 * @param medplum LiverRa FHIR client (stub in Phase 2).
 * @param macroId FHIR `Basic` resource ID of the macro.
 * @param updates Fields to update (any combination of trigger, expansion, category).
 * @returns The updated `Basic` resource.
 */
export async function updateMacro(
  medplum: LiverRaFhirClient,
  macroId: string,
  updates: { trigger?: string; expansion?: string; category?: string },
): Promise<Basic> {
  const existing = (await medplum.readResource('Basic', macroId)) as Basic | null;
  if (!existing) {
    throw new Error(`Macro not found: Basic/${macroId}`);
  }

  // Start from current extension values, then apply updates
  const currentTrigger = getMacroTrigger(existing);
  const currentExpansion = getMacroExpansion(existing);
  const currentCategory = getMacroCategory(existing);

  const newTrigger = updates.trigger ?? currentTrigger;
  const newExpansion = updates.expansion ?? currentExpansion;
  const newCategory = updates.category ?? currentCategory;

  if (updates.trigger !== undefined && !newTrigger.startsWith('.')) {
    throw new Error('Macro trigger must start with "."');
  }

  return medplum.updateResource<Basic>({
    ...existing,
    extension: buildMacroExtensions(newTrigger, newExpansion, newCategory),
  });
}

/**
 * Delete a macro.
 *
 * @param medplum LiverRa FHIR client (stub in Phase 2).
 * @param macroId FHIR `Basic` resource ID of the macro.
 */
export async function deleteMacro(
  medplum: LiverRaFhirClient,
  macroId: string,
): Promise<void> {
  // C-PACS-5: report macros may carry clinical phrasing that becomes
  // part of the diagnostic record when invoked; soft-delete preserves
  // the audit trail. If the resource is no longer readable we fall back
  // to hard-delete so the UI doesn't get stuck pointing at a row that
  // refuses to update.
  const existing = (await medplum.readResource('Basic', macroId)) as
    | (Basic & { id?: string })
    | null;
  if (existing && existing.resourceType === 'Basic') {
    await medplum.softDeleteResource(existing);
    return;
  }
  await medplum.deleteResource('Basic', macroId);
}

// ============================================================================
// Extension Helpers
// ============================================================================

/**
 * Extract the trigger text from a macro `Basic` resource.
 * @param macro `Basic` resource with report-macro profile.
 * @returns The trigger string (e.g. ".impression").
 */
export function getMacroTrigger(macro: Basic): string {
  return (
    macro.extension?.find((e) => e.url === IMAGING_EXTENSIONS.MACRO_TRIGGER)
      ?.valueString ?? ''
  );
}

/**
 * Extract the expansion text from a macro `Basic` resource.
 */
export function getMacroExpansion(macro: Basic): string {
  return (
    macro.extension?.find((e) => e.url === IMAGING_EXTENSIONS.MACRO_EXPANSION)
      ?.valueString ?? ''
  );
}

/**
 * Extract the category from a macro `Basic` resource.
 * @returns The category string (defaults to 'general').
 */
export function getMacroCategory(macro: Basic): string {
  return (
    macro.extension?.find((e) => e.url === IMAGING_EXTENSIONS.MACRO_CATEGORY)
      ?.valueString ?? 'general'
  );
}
