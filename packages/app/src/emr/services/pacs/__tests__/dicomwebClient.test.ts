// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDicomWebClient,
  DicomWebAuthError,
  DicomWebError,
  DicomWebNotFoundError,
  DicomWebUnavailableError,
  validateDicomUid,
} from '../dicomwebClient';

// Sentry is pulled in transitively via the PHI-scrubbing pipeline. We mock
// it so tests stay hermetic and don't attempt to reach a real DSN.
vi.mock('../../observability/sentryInit', () => ({
  captureException: vi.fn(),
}));

const BASE = 'http://test/dicom-web';

function makeClient(overrides: Partial<Parameters<typeof createDicomWebClient>[0]> = {}) {
  return createDicomWebClient({
    baseUrl: BASE,
    getAccessToken: () => null,
    getTenantId: () => null,
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/dicom+json' },
    ...init,
  });
}

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateDicomUid', () => {
  it('accepts canonical DICOM UIDs (digits + dots)', () => {
    expect(() => validateDicomUid('1.2.840.10008.1.2.1', 'x')).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateDicomUid('', 'studyInstanceUID')).toThrow(/required/);
  });

  it('rejects path-traversal attempts', () => {
    expect(() => validateDicomUid('1.2/../../etc', 'x')).toThrow(/invalid characters/);
    expect(() => validateDicomUid('1.2/3', 'x')).toThrow(/invalid characters/);
    expect(() => validateDicomUid('1.2\\3', 'x')).toThrow(/invalid characters/);
    expect(() => validateDicomUid('1.2;DROP', 'x')).toThrow(/invalid characters/);
  });

  it('rejects UIDs longer than 64 characters', () => {
    expect(() => validateDicomUid('1.'.repeat(33), 'x')).toThrow(/maximum DICOM UID length/);
  });
});

describe('qidoStudies', () => {
  it('issues a GET with DICOM+JSON Accept and returns the parsed array', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{ '00100020': { vr: 'LO', Value: ['P1'] } }]));
    const client = makeClient();
    const result = await client.qidoStudies({ patientId: 'P1', limit: 10 });

    expect(result).toHaveLength(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/studies?PatientID=P1&limit=10`);
    expect((init?.headers as Record<string, string>).Accept).toBe('application/dicom+json');
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('includes Bearer token when a token is provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const client = makeClient({ getAccessToken: () => 'jwt-123' });
    await client.qidoStudies();
    const init = mockFetch.mock.calls[0][1];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
  });

  it('sends X-LiverRa-Tenant when tenant id is available', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([]));
    const client = makeClient({ getTenantId: () => 'tenant-abc' });
    await client.qidoStudies();
    const init = mockFetch.mock.calls[0][1];
    expect((init?.headers as Record<string, string>)['X-LiverRa-Tenant']).toBe('tenant-abc');
  });

  it('returns [] on empty 200 body', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/dicom+json' } }),
    );
    const client = makeClient();
    expect(await client.qidoStudies()).toEqual([]);
  });

  it('returns [] on 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = makeClient();
    expect(await client.qidoStudies()).toEqual([]);
  });

  it('throws DicomWebAuthError on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    const client = makeClient();
    await expect(client.qidoStudies()).rejects.toBeInstanceOf(DicomWebAuthError);
  });

  it('throws DicomWebNotFoundError on 404', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = makeClient();
    await expect(client.qidoStudies()).rejects.toBeInstanceOf(DicomWebNotFoundError);
  });

  it('throws DicomWebUnavailableError on 503', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    const client = makeClient();
    await expect(client.qidoStudies()).rejects.toBeInstanceOf(DicomWebUnavailableError);
  });

  it('throws DicomWebUnavailableError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('network fail'));
    const client = makeClient();
    await expect(client.qidoStudies()).rejects.toBeInstanceOf(DicomWebUnavailableError);
  });

  it('propagates AbortError when the signal is aborted', async () => {
    const err = new DOMException('Aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(err);
    const client = makeClient();
    const ctrl = new AbortController();
    await expect(client.qidoStudies({}, ctrl.signal)).rejects.toBe(err);
  });

  it('raises a readable error when the server returns HTML instead of JSON', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'application/dicom+json' },
      }),
    );
    const client = makeClient();
    await expect(client.qidoStudies()).rejects.toThrow(DicomWebError);
  });
});

describe('wadoInstance', () => {
  it('produces the wadors: URL Cornerstone3D expects', () => {
    const client = makeClient();
    const url = client.wadoInstance('1.2.840', '1.2.840.1', '1.2.840.1.1');
    expect(url).toBe(
      `wadors:${BASE}/studies/1.2.840/series/1.2.840.1/instances/1.2.840.1.1/frames/1`,
    );
  });

  it('honours an explicit frame number for multi-frame studies', () => {
    const client = makeClient();
    const url = client.wadoInstance('1.2', '1.2.1', '1.2.1.1', 7);
    expect(url).toContain('/frames/7');
  });

  it('rejects UIDs that would allow path traversal', () => {
    const client = makeClient();
    expect(() => client.wadoInstance('../evil', '1.2', '1.3')).toThrow();
  });
});

describe('stowInstance', () => {
  function fakeFile(bytes: number): File {
    return new File([new Uint8Array(bytes)], 'sample.dcm', { type: 'application/dicom' });
  }

  it('POSTs multipart/related with application/dicom body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{}]));
    const client = makeClient();
    const result = await client.stowInstance(fakeFile(256));

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/studies`);
    expect(init?.method).toBe('POST');
    const contentType = (init?.headers as Record<string, string>)['Content-Type'];
    expect(contentType).toMatch(/^multipart\/related; type="application\/dicom"; boundary=----DICOMweb-/);
    // Empty body on 200 → assume success.
    expect(result.successCount).toBeGreaterThanOrEqual(0);
  });

  it('parses FailedSOPSequence and maps reason codes to readable text', async () => {
    const body = [
      {
        '00081199': { vr: 'SQ', Value: [] },
        '00081198': {
          vr: 'SQ',
          Value: [{ '00081197': { vr: 'US', Value: [0x0112] } }],
        },
      },
    ];
    mockFetch.mockResolvedValueOnce(jsonResponse(body));
    const client = makeClient();
    const result = await client.stowInstance(new File([new Uint8Array(10)], 'dup.dcm'));

    expect(result.failedCount).toBe(1);
    expect(result.failures[0]).toMatch(/Duplicate instance/);
  });

  it('throws DicomWebAuthError on 401 so multi-file uploads stop', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    const client = makeClient();
    await expect(client.stowInstance(fakeFile(10))).rejects.toBeInstanceOf(DicomWebAuthError);
  });
});
