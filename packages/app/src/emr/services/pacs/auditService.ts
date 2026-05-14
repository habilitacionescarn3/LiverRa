// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACS Audit Service — Log imaging access events as FHIR AuditEvents
// ============================================================================
// Think of this as a security camera for imaging access. Every time someone
// views a study, saves annotations, flags a key image, or downloads images,
// this service quietly writes a log entry (FHIR AuditEvent) in the background.
//
// Key design decisions:
// 1. Fire-and-forget: Logging never blocks the UI. If it fails, we log to
//    console but don't interrupt the user.
// 2. Singleton FHIR client reference: Set once at app init, reused by all helpers.
// 3. Uses FHIR AuditEvent with proper type/action/agent/entity fields per R4.
//
// LiverRa status (Phase 4 scaffold):
//   The AuditEvent *builders* are verbatim ports from MediMind — that's the
//   valuable IP we keep untouched for CE MDR traceability. Writes route
//   through `LiverRaFhirClient.createResource(auditEvent)`, which is currently
//   the stubbed `fhirClient.ts`. Reads return an empty array with a warning
//   log. Phase 4 plan wires both to the Supabase `audit_events` table via an
//   Edge Function; the AuditEvent shape is already CE-MDR-compatible, so the
//   Edge Function is a pure persistence swap — no shape changes downstream.
//
// TODO(phase-4-supabase): Phase 4 plan wires this to Supabase audit_events
// table via Edge Function. See docs/plans/i-have-fully-nifty-corbato.md §4.
//
// Ported from MediMind (services/pacs/auditService.ts) with:
//   - `MedplumClient` → `LiverRaFhirClient` (kept method surface identical).
//   - `@medplum/fhirtypes` AuditEvent/Communication inlined as local shapes.
//   - Standard-system URLs inlined (pending centralization into
//     `constants/fhir-systems.ts` in a future pass).
// ============================================================================

import { openDB, type IDBPDatabase } from 'idb';

import type { LiverRaFhirClient, FhirResourceLike } from '../fhirClient';
import { FHIR_BASE_URL } from '../../constants/fhir-systems';
import { scrubObject } from '../observability/phiScrubber';
import { phaseStubLog } from './phaseStubLog';

// ============================================================================
// Singleton — hold a reference to the FHIR client so callers don't need to pass it
// ============================================================================

let _fhir: LiverRaFhirClient | null = null;
/** Practitioner id (resourceType + id) used when building audit agents. */
let _profileRef: { resourceType?: string; id?: string; displayName?: string } | null = null;

// ============================================================================
// Retry queue (C-PACS-2 + C-AUDIT-1 fix)
// ============================================================================
// Before this block, every `_fhir.createResource(...)` failure was a bare
// `console.warn` — clinical break-glass + key-image flags evaporated on the
// first network blip. We now durably enqueue to IndexedDB, drain on a timer
// when the service is initialised, and only log to console with PHI scrubbed.

const QUEUE_DB_NAME = 'liverra-audit-retry-queue';
const QUEUE_STORE = 'events';
const QUEUE_DRAIN_INTERVAL_MS = 30_000;
const QUEUE_MAX_ATTEMPTS = 8; // ~17 min of jitter at exponential backoff

interface QueuedAudit {
  /** Auto-incrementing IndexedDB primary key. */
  id?: number;
  /** Original FHIR resource to POST. */
  resource: FhirResourceLike;
  /** Number of failed attempts so far. */
  attempts: number;
  /** When the next retry should be permitted (ms since epoch). */
  next_attempt_at: number;
  /** When the event was first enqueued (ms since epoch). */
  enqueued_at: number;
}

let _queueDbPromise: Promise<IDBPDatabase> | null = null;
let _queueDrainTimer: ReturnType<typeof setInterval> | null = null;
let _draining = false;

function _getQueueDb(): Promise<IDBPDatabase> | null {
  if (typeof indexedDB === 'undefined') {
    // SSR / Node test environments don't have IndexedDB — return null and
    // callers fall back to PHI-scrubbed console.warn.
    return null;
  }
  if (_queueDbPromise === null) {
    _queueDbPromise = openDB(QUEUE_DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
      },
    });
  }
  return _queueDbPromise;
}

function _scrubForLog<T>(value: T): T {
  // PHI scrubber may throw (ScrubberFailure on regex breakage); we ABSOLUTELY
  // never want a log statement to take down the request path, so a failure
  // here returns a minimal correlation marker.
  try {
    return scrubObject(value);
  } catch {
    return '[scrub-failed]' as unknown as T;
  }
}

async function _enqueueForRetry(resource: FhirResourceLike): Promise<void> {
  const dbPromise = _getQueueDb();
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    await store.add({
      resource,
      attempts: 0,
      next_attempt_at: Date.now(),
      enqueued_at: Date.now(),
    } as QueuedAudit);
    await tx.done;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[auditService] failed to enqueue audit retry:',
      (err as Error | undefined)?.message ?? '[no-message]',
    );
  }
}

async function _drainQueueOnce(): Promise<void> {
  if (_draining || !_fhir) return;
  const dbPromise = _getQueueDb();
  if (!dbPromise) return;

  _draining = true;
  try {
    const db = await dbPromise;
    const now = Date.now();
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const rows = (await store.getAll()) as QueuedAudit[];

    for (const row of rows) {
      if (!row.id) continue;
      if (row.next_attempt_at > now) continue;
      try {
        await _fhir.createResource(row.resource);
        await store.delete(row.id);
      } catch (err) {
        row.attempts += 1;
        if (row.attempts >= QUEUE_MAX_ATTEMPTS) {
          // eslint-disable-next-line no-console
          console.error(
            `[auditService] audit retry exhausted after ${row.attempts} attempts —`,
            ` SECURITY EVENT LOST. Resource type=${row.resource.resourceType}`,
            ` enqueued_at=${new Date(row.enqueued_at).toISOString()}`,
            ` last_error=${_scrubForLog((err as Error | undefined)?.message ?? '[no-message]')}`,
          );
          await store.delete(row.id);
        } else {
          // Exponential backoff with jitter: 2^attempts seconds + 0..1000ms.
          const backoffMs =
            Math.min(2 ** row.attempts, 60) * 1000 + Math.floor(Math.random() * 1000);
          row.next_attempt_at = Date.now() + backoffMs;
          await store.put(row);
        }
      }
    }
    await tx.done;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[auditService] drain failed:',
      _scrubForLog((err as Error | undefined)?.message ?? '[no-message]'),
    );
  } finally {
    _draining = false;
  }
}

/** Initialise the audit service with a FHIR client. Call once at app startup.
 *
 * Also starts the IndexedDB retry-queue drain interval. Until this is
 * called, every helper below silently returns (no FHIR client) AND every
 * queued event sits durably on disk waiting for init.
 */
export function initAuditService(fhir: LiverRaFhirClient): void {
  _fhir = fhir;
  if (_queueDrainTimer === null && typeof window !== 'undefined') {
    // Drain once immediately to flush anything left over from a prior tab.
    void _drainQueueOnce();
    _queueDrainTimer = setInterval(() => {
      void _drainQueueOnce();
    }, QUEUE_DRAIN_INTERVAL_MS);
  }
}

/** Test/teardown helper — stops the drain timer + resets state. */
export function _resetAuditServiceForTests(): void {
  if (_queueDrainTimer !== null) {
    clearInterval(_queueDrainTimer);
    _queueDrainTimer = null;
  }
  _fhir = null;
  _profileRef = null;
  _queueDbPromise = null;
  _draining = false;
}

/**
 * Set the current profile (practitioner) used to populate the agent block on
 * every AuditEvent. Phase 4 will pull this from the Cognito session; today
 * the UI can push whatever it has available so the audit trail carries
 * non-empty agent identities.
 */
export function setAuditPrincipal(profile: {
  resourceType?: string;
  id?: string;
  displayName?: string;
} | null): void {
  _profileRef = profile;
}

/** Check whether the audit service has been initialised (useful for dev-time assertions). */
export function isAuditServiceInitialized(): boolean {
  return _fhir !== null;
}

// ============================================================================
// Minimal FHIR shapes (inlined — Phase 4 may swap for richer FHIR types)
// ============================================================================

/** Minimal AuditEvent shape — only the fields this service sets. */
export interface AuditEventResource extends FhirResourceLike {
  resourceType: 'AuditEvent';
  id?: string;
  type?: { system?: string; code?: string; display?: string };
  subtype?: Array<{ system?: string; code?: string; display?: string }>;
  action?: AuditAction;
  recorded?: string;
  outcome?: string;
  outcomeDesc?: string;
  agent?: Array<{
    who?: { reference?: string; display?: string };
    requestor?: boolean;
  }>;
  source?: {
    observer?: { reference?: string; display?: string };
  };
  entity?: Array<{
    what?: { reference?: string };
    type?: { system?: string; code?: string; display?: string };
    role?: { system?: string; code?: string; display?: string };
    detail?: Array<{ type?: string; valueString?: string }>;
  }>;
}

/** Minimal Communication shape — used for the break-glass security alert. */
export interface CommunicationResource extends FhirResourceLike {
  resourceType: 'Communication';
  id?: string;
  status?: string;
  priority?: string;
  category?: Array<{
    coding?: Array<{ system?: string; code?: string; display?: string }>;
  }>;
  subject?: { reference?: string };
  payload?: Array<{ contentString?: string }>;
  sent?: string;
}

// ============================================================================
// Types
// ============================================================================

/** FHIR AuditEvent action codes (R4) */
type AuditAction = 'C' | 'R' | 'U' | 'D' | 'E';

/** Internal options shared by all log helpers */
interface AuditOptions {
  /** Human-readable description (e.g. "Viewed study CT Abdomen") */
  description?: string;
  /** ImagingStudy FHIR resource ID */
  studyId?: string;
  /** Patient FHIR resource ID */
  patientId?: string;
}

// ============================================================================
// Inline constants (Phase 4 may centralize into fhir-systems.ts)
// ============================================================================

/** FHIR AuditEvent type CodeSystem (DICOM DCM). */
const AUDIT_EVENT_TYPE_CS = 'http://dicom.nema.org/resources/ontology/DCM';
/** FHIR AuditEvent entity type CodeSystem. */
const AUDIT_ENTITY_TYPE_CS = 'http://terminology.hl7.org/CodeSystem/audit-entity-type';
/** FHIR object role CodeSystem. */
const OBJECT_ROLE_CS = 'http://terminology.hl7.org/CodeSystem/object-role';
/** LiverRa-owned CodeSystem for imaging-specific audit subtypes. */
const AUDIT_SUBTYPE_CS = `${FHIR_BASE_URL}/CodeSystem/audit-subtype` as const;
/** LiverRa-owned CodeSystem for Communication categories (break-glass alert etc.). */
const COMMUNICATION_CATEGORY_CS = `${FHIR_BASE_URL}/CodeSystem/communication-category` as const;
/** Observer device reference used on every AuditEvent.source.observer. */
const AUDIT_OBSERVER_REF = 'Device/liverra-pacs';
const AUDIT_OBSERVER_DISPLAY = 'LiverRa PACS Viewer';

// ============================================================================
// Imaging-specific audit subtype codes
// ============================================================================

const IMAGING_AUDIT_SUBTYPES = {
  STUDY_VIEW: 'imaging-study-view',
  ANNOTATION_SAVE: 'imaging-annotation-save',
  KEY_IMAGE_FLAG: 'imaging-key-image-flag',
  STUDY_DOWNLOAD: 'imaging-study-download',
  STUDY_MODIFY: 'imaging-study-modify',
  STUDY_DELETE: 'imaging-study-delete',
  BREAK_GLASS: 'imaging-break-glass',
} as const;

// ============================================================================
// Internal helpers
// ============================================================================

/** Build the agent (who did it) from the current user profile */
function buildAgent(): AuditEventResource['agent'] {
  if (!_profileRef?.id) {
    return [{ requestor: true }];
  }

  const resourceType = _profileRef.resourceType ?? 'Practitioner';
  return [
    {
      who: {
        reference: `${resourceType}/${_profileRef.id}`,
        display: _profileRef.displayName || undefined,
      },
      requestor: true,
    },
  ];
}

/** Build entity references (what was accessed) */
function buildEntity(opts: AuditOptions): AuditEventResource['entity'] {
  const entities: NonNullable<AuditEventResource['entity']> = [];

  if (opts.studyId) {
    entities.push({
      what: { reference: `ImagingStudy/${opts.studyId}` },
      type: {
        system: AUDIT_ENTITY_TYPE_CS,
        code: '2',
        display: 'System Object',
      },
      role: {
        system: OBJECT_ROLE_CS,
        code: '4',
        display: 'Domain Resource',
      },
    });
  }

  if (opts.patientId) {
    entities.push({
      what: { reference: `Patient/${opts.patientId}` },
      type: {
        system: AUDIT_ENTITY_TYPE_CS,
        code: '1',
        display: 'Person',
      },
      role: {
        system: OBJECT_ROLE_CS,
        code: '1',
        display: 'Patient',
      },
    });
  }

  return entities.length > 0 ? entities : undefined;
}

/**
 * Build an AuditEvent resource for the given subtype + action + options.
 * Extracted so tests and Phase 4 can reuse the builder without writing.
 */
export function buildAuditEvent(
  subtypeCode: string,
  subtypeDisplay: string,
  action: AuditAction,
  opts: AuditOptions
): AuditEventResource {
  const auditEvent: AuditEventResource = {
    resourceType: 'AuditEvent',
    type: {
      system: AUDIT_EVENT_TYPE_CS,
      code: 'rest',
      display: 'RESTful Operation',
    },
    subtype: [
      {
        system: AUDIT_SUBTYPE_CS,
        code: subtypeCode,
        display: subtypeDisplay,
      },
    ],
    action,
    recorded: new Date().toISOString(),
    outcome: '0', // success
    agent: buildAgent(),
    source: {
      observer: {
        reference: AUDIT_OBSERVER_REF,
        display: AUDIT_OBSERVER_DISPLAY,
      },
    },
    entity: buildEntity(opts),
  };

  if (opts.description) {
    auditEvent.outcomeDesc = opts.description;
  }

  return auditEvent;
}

/**
 * Fire-and-forget: create an AuditEvent then silently swallow errors.
 * This is the single internal function all public log* helpers delegate to.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this to the Supabase
 * audit_events table via an Edge Function. The builder above is unchanged
 * so downstream consumers (SIEM, compliance dashboards) see the same shape.
 */
function fireAndForget(
  subtypeCode: string,
  subtypeDisplay: string,
  action: AuditAction,
  opts: AuditOptions
): void {
  const auditEvent = buildAuditEvent(subtypeCode, subtypeDisplay, action, opts);

  if (!_fhir) {
    // C-AUDIT-1 + C-PACS-2 fix: durably enqueue instead of silently no-op'ing
    // when init hasn't run yet. The drain loop runs on init.
    void _enqueueForRetry(auditEvent);
    return;
  }

  _fhir.createResource<AuditEventResource>(auditEvent).catch((error) => {
    // C-AUDIT-4 fix: scrub PHI before logging (previously dumped the full
    // AuditEvent body to console). Then enqueue for retry so a network
    // blip doesn't drop a legally-required audit row.
    // eslint-disable-next-line no-console
    console.warn(
      '[auditService] write failed (enqueued for retry):',
      _scrubForLog((error as Error | undefined)?.message ?? '[no-message]'),
    );
    void _enqueueForRetry(auditEvent);
  });
}

// ============================================================================
// Public API — one function per event type
// ============================================================================

/** Log that a user opened / viewed an imaging study */
export function logStudyView(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.STUDY_VIEW,
    'Imaging Study Viewed',
    'R',
    opts
  );
}

/** Log that a user saved annotations on a study */
export function logAnnotationSave(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.ANNOTATION_SAVE,
    'Imaging Annotation Saved',
    'C',
    opts
  );
}

/** Log that a user flagged a key image */
export function logKeyImageFlag(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.KEY_IMAGE_FLAG,
    'Key Image Flagged',
    'U',
    opts
  );
}

/** Log that a user downloaded / exported a study */
export function logStudyDownload(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.STUDY_DOWNLOAD,
    'Imaging Study Downloaded',
    'R',
    opts
  );
}

/** Log that a user modified study metadata */
export function logStudyModify(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.STUDY_MODIFY,
    'Imaging Study Modified',
    'U',
    opts
  );
}

/** Log that a user deleted a study */
export function logStudyDelete(opts: AuditOptions): void {
  fireAndForget(
    IMAGING_AUDIT_SUBTYPES.STUDY_DELETE,
    'Imaging Study Deleted',
    'D',
    opts
  );
}

/** Log a break-glass access to an imaging study (fire-and-forget with retry).
 *  Break-glass events are legally required, so we retry on failure.
 *
 *  TODO(phase-4-supabase): Phase 4 plan wires this to the Supabase
 *  audit_events table via Edge Function with a durable queue for retries. */
export function logBreakGlass(opts: AuditOptions): void {
  if (!_fhir) {
    return;
  }

  const auditEvent: AuditEventResource = {
    resourceType: 'AuditEvent',
    type: {
      system: AUDIT_EVENT_TYPE_CS,
      code: 'rest',
      display: 'RESTful Operation',
    },
    subtype: [
      {
        system: AUDIT_SUBTYPE_CS,
        code: IMAGING_AUDIT_SUBTYPES.BREAK_GLASS,
        display: 'Break-Glass Imaging Access',
      },
    ],
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: opts.description,
    agent: buildAgent(),
    source: { observer: { reference: AUDIT_OBSERVER_REF, display: AUDIT_OBSERVER_DISPLAY } },
    entity: buildEntity(opts),
  };

  // Break-glass events are legally required — retry up to 3 times with
  // exponential backoff + ±250 ms jitter (M-PACS-5; prevents thundering
  // herd against a recovering audit store), then escalate to the durable
  // IndexedDB queue so a sustained outage doesn't drop the row.
  const maxRetries = 3;
  const attemptCreate = (attempt: number): void => {
    _fhir?.createResource<AuditEventResource>(auditEvent).catch((error) => {
      const safeMsg = _scrubForLog((error as Error | undefined)?.message ?? '[no-message]');
      if (attempt < maxRetries) {
        const base = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        const jitter = Math.floor((Math.random() - 0.5) * 500); // ±250 ms
        const delayMs = Math.max(100, base + jitter);
        // eslint-disable-next-line no-console
        console.error(
          `[auditService] Break-glass write failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms:`,
          safeMsg,
        );
        setTimeout(() => attemptCreate(attempt + 1), delayMs);
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[auditService] Break-glass in-process retries exhausted — enqueuing for durable retry:`,
          safeMsg,
        );
        void _enqueueForRetry(auditEvent);
      }
    });
  };
  attemptCreate(0);
}

// ============================================================================
// Imaging Break-Glass Emergency Access — async API for the modal workflow
// ============================================================================

/** Duration (ms) for which imaging break-glass access is valid — 4 hours */
export const IMAGING_BTG_DURATION_MS = 4 * 60 * 60 * 1000;

/** Options for requesting imaging break-glass access */
export interface ImagingBreakGlassRequest {
  /** Mandatory reason (min 10 chars) */
  reason: string;
  /** Patient FHIR resource ID */
  patientId: string;
  /** ImagingStudy FHIR resource ID (optional — may not have one yet) */
  studyId?: string;
}

/**
 * Create a BTG (Break-The-Glass) AuditEvent for imaging access.
 *
 * Unlike the fire-and-forget `logBreakGlass()`, this version is async and
 * returns the created AuditEvent so the caller can confirm it was persisted.
 * Uses DICOM code 110113 (Emergency Override) to match the standard pattern.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this to Supabase audit_events
 * table. Returns the server-persisted record once Phase 4 lands; the stub
 * currently echoes the input back so callers see `granted: true`.
 */
export async function logImagingBreakGlassAccess(
  request: ImagingBreakGlassRequest
): Promise<AuditEventResource | null> {
  if (!_fhir) {
    return null;
  }

  const auditEvent: AuditEventResource = {
    resourceType: 'AuditEvent',
    type: {
      system: AUDIT_EVENT_TYPE_CS,
      code: '110113',
      display: 'Emergency Override Started',
    },
    subtype: [
      {
        system: AUDIT_SUBTYPE_CS,
        code: IMAGING_AUDIT_SUBTYPES.BREAK_GLASS,
        display: 'Break-Glass Imaging Access',
      },
    ],
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: '0',
    outcomeDesc: `Imaging break-glass: ${request.reason}`,
    agent: buildAgent(),
    source: {
      observer: { display: AUDIT_OBSERVER_DISPLAY },
    },
    entity: buildEntity({
      patientId: request.patientId,
      studyId: request.studyId,
    }),
  };

  // Add the reason as entity detail so it's searchable
  if (auditEvent.entity?.[0]) {
    auditEvent.entity[0].detail = [
      { type: 'reason', valueString: request.reason },
    ];
  }

  return _fhir.createResource<AuditEventResource>(auditEvent);
}

/**
 * Send a Communication alert to the security team about a break-glass event.
 *
 * Think of this like a text message to the security office saying
 * "Heads up — someone just used emergency access to view imaging data."
 * It's fire-and-forget so it won't block the user.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this to Supabase + SNS
 * for pager/email fan-out. The Communication shape stays FHIR-compatible.
 */
export function sendBreakGlassAlert(
  request: ImagingBreakGlassRequest,
  auditEventId?: string
): void {
  if (!_fhir) {
    return;
  }

  const userName = _profileRef?.displayName || 'Unknown user';

  const communication: CommunicationResource = {
    resourceType: 'Communication',
    status: 'completed',
    category: [
      {
        coding: [
          {
            system: COMMUNICATION_CATEGORY_CS,
            code: 'break-glass-alert',
            display: 'Break-Glass Security Alert',
          },
        ],
      },
    ],
    priority: 'urgent',
    subject: { reference: `Patient/${request.patientId}` },
    payload: [
      {
        contentString: [
          `SECURITY ALERT: Imaging Break-Glass Access`,
          `User: ${userName}`,
          `Patient: Patient/${request.patientId}`,
          request.studyId ? `Study: ImagingStudy/${request.studyId}` : '',
          `Reason: ${request.reason}`,
          auditEventId ? `AuditEvent: ${auditEventId}` : '',
          `Time: ${new Date().toISOString()}`,
        ].filter(Boolean).join('\n'),
      },
    ],
    sent: new Date().toISOString(),
  };

  // Fire-and-forget with retry — security alert should never block UI but
  // must be delivered. After in-process retries are exhausted we enqueue to
  // the durable retry queue (alerts are payload-light by design — no PHI).
  const maxRetries = 3;
  const attemptSend = (attempt: number): void => {
    _fhir?.createResource<CommunicationResource>(communication).catch((error) => {
      const safeMsg = _scrubForLog((error as Error | undefined)?.message ?? '[no-message]');
      if (attempt < maxRetries) {
        const base = 1000 * Math.pow(2, attempt);
        const jitter = Math.floor((Math.random() - 0.5) * 500);
        const delayMs = Math.max(100, base + jitter);
        // eslint-disable-next-line no-console
        console.error(
          `[auditService] Break-glass alert failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms:`,
          safeMsg,
        );
        setTimeout(() => attemptSend(attempt + 1), delayMs);
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[auditService] Break-glass alert in-process retries exhausted — enqueuing for durable retry:`,
          safeMsg,
        );
        void _enqueueForRetry(communication);
      }
    });
  };
  attemptSend(0);
}

/**
 * Check if the current user has an active imaging break-glass AuditEvent
 * (recorded within the 4-hour window).
 *
 * Searches for the most recent AuditEvent with our imaging-break-glass subtype
 * and DICOM code 110113, created by this user, with success outcome.
 *
 * TODO(phase-4-supabase): Phase 4 plan wires this to Supabase audit_events
 * table. Today the stub returns `null` because the FHIR client has no reads.
 */
export async function getActiveImagingBreakGlass(
  patientId: string
): Promise<AuditEventResource | null> {
  if (!_fhir || !_profileRef?.id) {
    return null;
  }

  const resourceType = _profileRef.resourceType ?? 'Practitioner';

  const bundle = await _fhir.search('AuditEvent', {
    agent: `${resourceType}/${_profileRef.id}`,
    entity: `Patient/${patientId}`,
    type: `${AUDIT_EVENT_TYPE_CS}|110113`,
    subtype: `${AUDIT_SUBTYPE_CS}|${IMAGING_AUDIT_SUBTYPES.BREAK_GLASS}`,
    _sort: '-date',
    _count: '1',
  });

  const events = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((r): r is FhirResourceLike => Boolean(r))
    .map((r) => r as AuditEventResource);

  if (!events.length) {
    return null;
  }

  const latest = events[0];

  // Must be imaging break-glass with success outcome
  const isBreakGlass =
    latest.type?.code === '110113' &&
    latest.subtype?.[0]?.code === IMAGING_AUDIT_SUBTYPES.BREAK_GLASS &&
    latest.outcome === '0';

  if (!isBreakGlass) {
    return null;
  }

  // Check within 4-hour window
  const recordedAt = latest.recorded ? new Date(latest.recorded).getTime() : 0;
  if (Date.now() - recordedAt > IMAGING_BTG_DURATION_MS) {
    return null; // Expired
  }

  return latest;
}

// ============================================================================
// Read helper (stubbed — Phase 4 backs this with Supabase)
// ============================================================================

/**
 * Query audit events. Phase 4 will route this to the Supabase audit_events
 * table; today it returns `[]` and logs the call so integration code can
 * be developed against the stub.
 *
 * TODO(phase-4-supabase): Wire to Supabase audit_events read endpoint.
 */
export async function queryAuditEvents(
  params?: Record<string, unknown>
): Promise<AuditEventResource[]> {
  // C-AUDIT-4 fix: scrub before logging — query params can contain patient
  // ids / MRNs that surface as PHI in the console history.
  // M-PACS-6: route through shared phaseStubLog so dedupe + Sentry +
  // LIVERRA_STUB_LOGGING toggle apply uniformly with every other stub.
  const scrubbedParams = params ? _scrubForLog(params) : {};
  phaseStubLog('fhir-stub', 'queryAuditEvents', { params: scrubbedParams });
  return [];
}
