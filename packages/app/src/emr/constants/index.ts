// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * LiverRa — FHIR constants barrel.
 *
 * Single import surface for every FHIR-namespaced URL, extension, identifier,
 * and code system. Constitution §IV forbids constructing FHIR URLs outside
 * this barrel.
 */

export * from './fhir-systems';
export * from './fhir-extensions';
export * from './fhir-identifiers';
export * from './fhir-codesystems';
