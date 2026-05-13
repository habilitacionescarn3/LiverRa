# Contract — Clipboard Export Audit Event

**Feature**: 002-acr-structured-readout
**Resource**: FHIR R4 `AuditEvent`
**Subtype**: `readout-clipboard-export`

This contract specifies the wire shape of the audit event emitted on every Copy to Clipboard action. It implements FR-017, FR-018, FR-019, FR-020, FR-020a, FR-020b, FR-020c, FR-022a, FR-022b, FR-022c, FR-028, and FR-030.

---

## 1. FHIR AuditEvent shape (success)

```json
{
  "resourceType": "AuditEvent",
  "id": "<server-assigned uuid>",
  "type": {
    "system": "http://terminology.hl7.org/CodeSystem/audit-event-type",
    "code": "rest",
    "display": "RESTful Operation"
  },
  "subtype": [
    {
      "system": "http://liverra.ai/fhir/CodeSystem/audit-subtypes",
      "code": "readout-clipboard-export",
      "display": "Structured readout copied to clipboard"
    }
  ],
  "action": "R",
  "recorded": "2026-05-13T14:23:01.481Z",
  "outcome": "0",
  "agent": [
    {
      "type": {
        "coding": [
          {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
            "code": "AUT",
            "display": "author"
          }
        ]
      },
      "who": { "reference": "Practitioner/<actor uuid>" },
      "role": [
        {
          "coding": [
            {
              "system": "http://liverra.ai/fhir/CodeSystem/clinical-roles",
              "code": "<actor role at action time>",
              "display": "<localized role label>"
            }
          ]
        }
      ],
      "requestor": true
    }
  ],
  "source": {
    "site": "liverra-app",
    "observer": { "display": "LiverRa Web Application" },
    "type": [
      {
        "system": "http://terminology.hl7.org/CodeSystem/security-source-type",
        "code": "4",
        "display": "Application Server"
      }
    ]
  },
  "entity": [
    {
      "what": { "reference": "Analysis/<analysis uuid>" },
      "type": {
        "system": "http://terminology.hl7.org/CodeSystem/audit-entity-type",
        "code": "4",
        "display": "Other"
      },
      "role": {
        "system": "http://terminology.hl7.org/CodeSystem/object-role",
        "code": "4",
        "display": "Domain Resource"
      },
      "description": "Structured readout exported via clipboard"
    }
  ],
  "extension": [
    {
      "url": "http://liverra.ai/fhir/StructureDefinition/audit-locale",
      "valueCode": "en"
    },
    {
      "url": "http://liverra.ai/fhir/StructureDefinition/audit-tenant",
      "valueReference": { "reference": "Organization/<tenant uuid>" }
    },
    {
      "url": "http://liverra.ai/fhir/StructureDefinition/audit-client-action-id",
      "valueUuid": "<client-supplied click uuid>"
    }
  ]
}
```

## 2. Failure variants

Replace `outcome` with `"4"` (minor failure) or `"8"` (serious failure) and add the failure-category extension:

```json
{
  "url": "http://liverra.ai/fhir/StructureDefinition/audit-failure-category",
  "valueCode": "network" 
}
```

Allowed `valueCode` enum: `network` | `clipboard_blocked` | `audit_chain_unavailable` | `auth_denied` | `tenant_violation`.

Mapping to outcome severity:

| Failure category | Outcome code | When |
|---|---|---|
| `network` | `4` | Transient — audit POST timed out or 5xx |
| `clipboard_blocked` | `4` | Browser refused clipboard write |
| `audit_chain_unavailable` | `4` | Chain backend unreachable (queued for retry) |
| `auth_denied` | `8` | Session expired or auth header rejected |
| `tenant_violation` | `8` | Cross-tenant attempt (security event) |

`auth_denied` and `tenant_violation` events are also indexed for the security-event view (Principle VII).

## 3. POST endpoint contract

### `POST /api/v1/analyses/{analysis_id}/audit/clipboard-export`

**Auth**: existing analysis-detail authorization (inherits tenant boundary per FR-022b). Anonymous or session-expired requests → `401`; cross-tenant → `403` AND a `tenant_violation` event is recorded server-side on the actor's authenticated tenant for forensic completeness.

**Idempotency**: keyed on `client_action_id`. Repeated requests with the same UUID return `200` with the original `audit_event_id` and do NOT append a duplicate row to the chain. This makes the durable-retry path (FR-020b) safe.

**Request body** (Pydantic shape, mirrors `ClipboardExportAuditPayload`):

```json
{
  "client_action_id": "5e3cc049-7f3a-4b21-9ce4-7178683c1d4e",
  "actor_role": "attending_radiologist",
  "locale": "en",
  "action_timestamp": "2026-05-13T14:23:01.481Z",
  "outcome": "success",
  "failure_category": null
}
```

Server enriches with `actor_id` (from auth context), `tenant_id` (from analysis), `sequence_no` (from chain), and the chain hashes.

**Response 200 (success or idempotent replay)**:

```json
{
  "audit_event_id": "11111111-2222-3333-4444-555555555555",
  "sequence_no": 84217,
  "outcome": "success",
  "persisted_at": "2026-05-13T14:23:01.612Z"
}
```

**Response 401 (auth required)** — body `{ "error": "unauthenticated" }`. NO audit event recorded (request never authenticated). The frontend transitions to `failed(auth_denied)` and shows the "access revoked — refresh" toast.

**Response 403 (tenant violation or revoked-mid-session)** — body `{ "error": "forbidden" }`. Server records a `tenant_violation` (cross-tenant) or `auth_denied` (revoked) audit event under the authenticated user's home tenant.

**Response 4xx other** (validation) — body `{ "error": "validation", "details": [...] }`. Frontend treats as transient and queues for retry.

**Response 5xx** — frontend treats as `network` failure, queues for retry, shows "audit will retry" toast.

### Retry contract

The frontend retries queued events:
- On next session start (page load).
- On every successful response from any backend endpoint within the active session (piggybacking).
- With exponential backoff capped at 60s, jittered.
- Indefinitely until a `2xx` or a `4xx-non-validation` arrives (which is terminal).

The same `client_action_id` is reused across all retries.

## 4. Persistence — `audit_event_chain` integration

The clipboard-export event is one new `audit_category` enum value (`readout_clipboard_export`) in `packages/core/src/types/audit.ts`. Existing chain mechanisms apply unchanged:

- `prev_leaf_hash` references the immediately prior chain entry per tenant.
- `leaf_hash` = SHA-256 of canonical-JSON payload (the FHIR AuditEvent representation above) || `prev_leaf_hash`.
- `sequence_no` is assigned by the existing trigger.
- The chain row is append-only; the existing tamper-detection trigger fires on UPDATE/DELETE attempts.

## 5. Retention

Per FR-028, audit rows MUST be retained for ≥10 years from `recorded` timestamp. Retention is enforced by:

- Forbidding any DELETE on `audit_event_chain` (existing trigger).
- A scheduled (annual) "retention attestation" job that reports row counts per tenant per year so compliance can confirm no silent purge.

## 6. Export-for-audit format

The existing operator audit surface supports filtering by `subtype.code = readout-clipboard-export`. Date-ranged export delivers a FHIR R4 `Bundle` of type `searchset` containing each AuditEvent, plus the chain integrity metadata (sequence, prev_leaf_hash, leaf_hash) as Bundle extensions for verifiability outside the system.
