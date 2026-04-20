/*
 * FHIR CapabilityStatement validation test.
 *
 * Tasks T468 · Constitution §FHIR Conformance.
 *
 * Queries Medplum's `/metadata` and asserts:
 *   (a) Every LiverRa-defined extension URL from fhir-extensions.ts appears
 *       somewhere under `CapabilityStatement.rest.resource.*.extension.url`
 *       or `CapabilityStatement.rest.resource.*.supportedProfile`.
 *   (b) The 6 core resources are declared with the expected interactions.
 *   (c) `supportedProfile` includes our LiverRa StructureDefinition URLs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LIVERRA_EXTENSIONS } from '../../constants/fhir-extensions';

interface CapabilityStatementResource {
  type: string;
  interaction?: { code: string }[];
  supportedProfile?: string[];
  extension?: { url: string; valueString?: string }[];
  searchParam?: { name: string; type: string }[];
}

interface CapabilityStatement {
  resourceType: 'CapabilityStatement';
  rest?: {
    resource?: CapabilityStatementResource[];
  }[];
}

const REQUIRED_RESOURCES: { type: string; interactions: string[] }[] = [
  { type: 'AuditEvent', interactions: ['create', 'read', 'search-type'] },
  { type: 'ImagingStudy', interactions: ['create', 'read', 'update', 'search-type'] },
  { type: 'DiagnosticReport', interactions: ['create', 'read', 'update', 'search-type'] },
  { type: 'Patient', interactions: ['create', 'read', 'update', 'search-type'] },
  { type: 'Practitioner', interactions: ['create', 'read', 'search-type'] },
  { type: 'Observation', interactions: ['create', 'read', 'search-type'] },
];

async function fetchCapability(): Promise<CapabilityStatement> {
  const url = process.env.LIVERRA_MEDPLUM_URL;
  if (!url) throw new Error('LIVERRA_MEDPLUM_URL not set');
  const resp = await fetch(`${url.replace(/\/$/, '')}/fhir/R4/metadata`);
  if (!resp.ok) throw new Error(`metadata fetch failed: HTTP ${resp.status}`);
  return (await resp.json()) as CapabilityStatement;
}

function flattenExtensionUrls(cap: CapabilityStatement): Set<string> {
  const urls = new Set<string>();
  for (const rest of cap.rest ?? []) {
    for (const res of rest.resource ?? []) {
      for (const ext of res.extension ?? []) {
        urls.add(ext.url);
      }
      for (const profile of res.supportedProfile ?? []) {
        urls.add(profile);
      }
    }
  }
  return urls;
}

function resourceInteractions(cap: CapabilityStatement, type: string): Set<string> {
  for (const rest of cap.rest ?? []) {
    for (const res of rest.resource ?? []) {
      if (res.type === type) {
        return new Set((res.interaction ?? []).map((i) => i.code));
      }
    }
  }
  return new Set();
}

describe('FHIR CapabilityStatement conformance', () => {
  let cap: CapabilityStatement;

  beforeAll(async () => {
    if (!process.env.LIVERRA_MEDPLUM_URL) {
      console.warn('LIVERRA_MEDPLUM_URL not set — capability test will skip');
      return;
    }
    cap = await fetchCapability();
  });

  it('declares every LiverRa-defined extension URL', () => {
    if (!cap) return;
    const declared = flattenExtensionUrls(cap);

    const missing: string[] = [];
    for (const url of Object.values(LIVERRA_EXTENSIONS)) {
      // The extension URL may also be referenced only via its parent
      // StructureDefinition URL — accept either form by checking substring.
      const present = Array.from(declared).some((u) => u === url || u.endsWith(url));
      if (!present) missing.push(url);
    }
    expect(
      missing,
      `Extension URLs not declared in CapabilityStatement:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it.each(REQUIRED_RESOURCES)(
    '$type declares interactions $interactions',
    ({ type, interactions }) => {
      if (!cap) return;
      const actual = resourceInteractions(cap, type);
      const missing = interactions.filter((code) => !actual.has(code));
      expect(
        missing,
        `${type} missing interactions: ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('declares at least one LiverRa supportedProfile for AuditEvent + DiagnosticReport', () => {
    if (!cap) return;
    const liverraProfile = /liverra\.ai\/fhir\/StructureDefinition\//;
    for (const type of ['AuditEvent', 'DiagnosticReport']) {
      const resEntry = cap.rest?.[0]?.resource?.find((r) => r.type === type);
      const profiles = resEntry?.supportedProfile ?? [];
      const hasLiverraProfile = profiles.some((p) => liverraProfile.test(p));
      expect(
        hasLiverraProfile,
        `${type} should declare at least one liverra.ai supportedProfile (found: ${JSON.stringify(profiles)})`,
      ).toBe(true);
    }
  });
});
