# Phase 1 Data Model — Structured ACR-Style Radiologic Readout

**Feature**: 002-acr-structured-readout
**Date**: 2026-05-13

This document defines the shape of every entity the feature reads, derives, or writes. No DB schema changes; one new audit-event subtype.

---

## 1. Existing data (read-only)

### `analysis_finding` table (migration 0013)

```
analysis_finding
├── id              uuid PRIMARY KEY
├── analysis_id     uuid NOT NULL FK → analysis(id)
├── finding_type    text NOT NULL          -- enum: hu_stats, steatosis, spleen, gallbladder,
│                                          --       calcified_lesions, simple_biliary_cysts,
│                                          --       indeterminate_malignant
├── payload         jsonb NOT NULL         -- shape varies per finding_type (see below)
├── computed_at     timestamptz NOT NULL
└── UNIQUE (analysis_id, finding_type)
```

Read-only for this feature. No new finding types, no new columns.

### Finding payload shapes (per type)

| Type | Required keys | Optional keys |
|---|---|---|
| `hu_stats` | `mean, median, p10, p90, std, voxel_count` | — |
| `steatosis` | `grade, liver_mean_hu, spleen_mean_hu, liver_spleen_delta` | `warnings[], spleen_voxels, reference` |
| `spleen` | `volume_ml, splenomegaly, voxels, threshold_ml, reference` | `warning` (degraded) |
| `gallbladder` | `volume_ml, wall_thickness_mm, wall_thickened, stones_detected, stone_voxel_count` | — |
| `calcified_lesions` | List of `{lesion_id, hu_max, pct_calcified, interpretation}` | — |
| `simple_biliary_cysts` | List of `{lesion_id, hu_mean, hu_std, sphericity, wall_thickness_mm, interpretation}` | — |
| `indeterminate_malignant` | `lr_m_count, lesions[], interpretation` | — |

### `analysis` table (read fields used by this feature)

```
analysis
├── id            uuid PRIMARY KEY
├── tenant_id     uuid NOT NULL         -- inherited authorization boundary
├── status        text                  -- enum: queued | running | completed | partial | failed
├── updated_at    timestamptz           -- used by concurrency/freshness gate (D5)
└── flr_plan      jsonb                 -- FLR result already persisted by cascade
```

---

## 2. Derived data (in-memory, not persisted)

### `AnatomicalSection` (TypeScript / Python enum)

```typescript
// packages/app/src/emr/services/report/acrAnatomicalMapping.ts
export const ANATOMICAL_SECTIONS = [
  'liver',
  'lesions',
  'vessels',
  'gallbladder',
  'spleen',
  'flrAssessment',
] as const;
export type AnatomicalSection = typeof ANATOMICAL_SECTIONS[number];
```

```python
# packages/ml-inference/src/services/export/acr_section_builder.py
from enum import Enum

class AnatomicalSection(str, Enum):
    LIVER = "liver"
    LESIONS = "lesions"
    VESSELS = "vessels"
    GALLBLADDER = "gallbladder"
    SPLEEN = "spleen"
    FLR_ASSESSMENT = "flrAssessment"

ANATOMICAL_SECTION_ORDER = [
    AnatomicalSection.LIVER,
    AnatomicalSection.LESIONS,
    AnatomicalSection.VESSELS,
    AnatomicalSection.GALLBLADDER,
    AnatomicalSection.SPLEEN,
    AnatomicalSection.FLR_ASSESSMENT,
]
```

Order is fixed (FR-001, FR-003).

### `AnatomicalSectionMapping` — the canonical finding→section table (FR-024b)

Single source of truth, duplicated in TS and Python by deliberate Complexity-Tracking decision:

| `finding_type` | `AnatomicalSection` |
|---|---|
| `hu_stats` | `liver` |
| `steatosis` | `liver` |
| `calcified_lesions` | `lesions` |
| `simple_biliary_cysts` | `lesions` |
| `indeterminate_malignant` | `lesions` |
| (per-lesion entries from cascade `lesions[]`) | `lesions` |
| (no vessel findings yet — `vessels` section receives an empty container) | `vessels` |
| `gallbladder` | `gallbladder` |
| `spleen` | `spleen` |
| (FLR result from `analysis.flr_plan`) | `flrAssessment` |

### `ReadoutSection` (rendering DTO)

```typescript
export interface ReadoutSection {
  section: AnatomicalSection;
  title: string;                 // localized header (e.g., "LIVER" in en, "ღვიძლი" in ka)
  rows: ReadoutRow[];            // ordered; empty array means "no findings" state
  status: 'present' | 'empty' | 'computing' | 'unavailable';
  emptyMessage?: string;         // localized neutral status line when status != 'present'
}

export interface ReadoutRow {
  label: string;                 // localized field label (e.g., "Volume")
  value: string | null;          // formatted with units (e.g., "1,828 mL"); null → "Not available"
  warning?: string;              // localized degraded-quality warning if payload contained one
  itemId?: string;               // for per-lesion rows: the lesion identifier (e.g., "L1")
  stale?: { computedAt: Date };  // present iff finding is stale (FR-023c)
}
```

### `ReadoutSnapshot` (the value passed into the plain-text renderer + audit-emit)

```typescript
export interface ReadoutSnapshot {
  analysisId: string;
  tenantId: string;
  locale: 'en' | 'ru' | 'ka' | 'de';        // 'de' allowed but always falls back to en for new strings
  capturedAt: Date;                          // freshness reference for concurrency gate
  etag?: string;                             // for FR-023a concurrency check
  status: 'completed' | 'running' | 'partial' | 'failed';
  sections: ReadoutSection[];                // length = 6, in fixed order
  ruoDisclaimer: string;                     // localized
}
```

---

## 3. New persisted data — `ClipboardExportAuditEvent`

This is not a new table. It is a new `AuditCategory` enum member that emits rows into the existing `audit_event_chain` and `audit_event` tables (migration 0005). The chain's tamper-evident properties (Merkle hash, sequence number, append-only) are inherited automatically.

### Audit envelope (Pydantic; what the POST endpoint receives + persists)

```python
# packages/ml-inference/src/services/audit/clipboard_export_event.py
from pydantic import BaseModel, Field
from typing import Literal, Optional
from datetime import datetime
from uuid import UUID

class ClipboardExportAuditPayload(BaseModel):
    # Required (FR-017)
    actor_id: UUID
    actor_role: str                                                    # role-at-action-time
    analysis_id: UUID
    locale: Literal["en", "ru", "ka", "de"]                            # locale actually rendered (after fallback)
    action_timestamp: datetime                                         # MUST be the click time (FR-020a)

    # Outcome
    outcome: Literal["success", "failure"]

    # Optional context
    failure_category: Optional[
        Literal["network", "clipboard_blocked", "audit_chain_unavailable", "auth_denied", "tenant_violation"]
    ] = None

    # Tenancy (inherited; included for forensic completeness)
    tenant_id: UUID

    # Idempotency — client-supplied UUID to make retries idempotent
    client_action_id: UUID = Field(..., description="Stable UUID per click; identical across durable retries")

class ClipboardExportAuditRow(ClipboardExportAuditPayload):
    """The row as it lands in audit_event_chain (extended by chain bookkeeping)."""
    sequence_no: int                                                   # appended by chain trigger
    prev_leaf_hash: str
    leaf_hash: str
    canonical_json: str
    persisted_at: datetime
```

**Idempotency**: `client_action_id` is generated client-side at click time. Durable retries reuse the same UUID. The backend `INSERT ... ON CONFLICT (client_action_id) DO NOTHING` (or equivalent) ensures one chain row per click even under retry storms.

### FHIR R4 AuditEvent representation

Defined in `contracts/audit-event.md`.

---

## 4. Frontend state

```typescript
// packages/app/src/emr/services/report/acrClipboardService.ts state model
type ClipboardOpState =
  | { kind: 'idle' }
  | { kind: 'writing'; clientActionId: string; clickTimestamp: Date }
  | { kind: 'awaitingAudit'; clientActionId: string; clickTimestamp: Date }
  | { kind: 'success' }
  | { kind: 'auditQueued'; reason: 'network' | 'audit_chain_unavailable' }
  | { kind: 'failed'; reason: 'clipboard_blocked' | 'tenant_violation' | 'auth_denied' };
```

Pending events live in IndexedDB store `pendingAcrAuditEvents` keyed by `clientActionId`. The store contains the full `ClipboardExportAuditPayload` JSON; nothing else. (PHI-free per FR-020 / FR-034.)

---

## 5. Translation namespace shape

```jsonc
// packages/app/src/emr/translations/en/reportAcr.json
{
  "ruoDisclaimer": "--- RESEARCH USE ONLY — NOT FOR PRIMARY DIAGNOSTIC USE ---",

  "sections": {
    "liver":        { "title": "LIVER",         "empty": "Not assessed" },
    "lesions":      { "title": "LESIONS",       "empty": "No lesions detected" },
    "vessels":      { "title": "VESSELS",       "empty": "Not assessed" },
    "gallbladder":  { "title": "GALLBLADDER",   "empty": "Not assessed" },
    "spleen":       { "title": "SPLEEN",        "empty": "Not assessed" },
    "flrAssessment":{ "title": "FLR ASSESSMENT","empty": "FLR plan not requested" }
  },

  "status": {
    "computing":           "Computing — results will appear when the cascade completes",
    "awaitingAnalysis":    "Awaiting analysis",
    "computationFailed":   "Computation unavailable",
    "notAvailable":        "Not available"
  },

  "labels": {
    "volume":              "Volume",
    "wallThickness":       "Wall thickness",
    "attenuation":         "Attenuation",
    "huMean":              "Mean HU",
    "huRange":             "HU range",
    "stones":              "Stones detected",
    "splenomegaly":        "Splenomegaly",
    "steatosisGrade":      "Steatosis grade",
    "flrPercent":          "FLR %",
    "flrSafety":           "Safety classification",
    "primaryLesionSize":   "Primary lesion size",
    "primaryLesionClass":  "Primary lesion class"
  },

  "copy": {
    "buttonLabel":         "Copy to Clipboard",
    "successToast":        "Readout copied to clipboard",
    "warningToastAuditPending": "Readout copied; export audit will retry",
    "errorToastBlocked":   "Browser blocked clipboard access — try again",
    "errorToastStale":     "Analysis updated by another reviewer — refresh to copy",
    "errorToastAuthDenied":"Your access to this analysis was revoked — refresh"
  },

  "staleness": {
    "lastComputed":        "Last computed {{time}}"
  }
}
```

`ru/reportAcr.json` and `ka/reportAcr.json` are structural copies with values prefixed `__TODO_TRANSLATE__:` pending medical-CODEOWNERS review (CLAUDE.md i18n rule). `de/reportAcr.json` is the same pattern; English fallback applies until DACH product reactivation.

---

## 6. State transitions

The only state machine in this feature is the clipboard operation (`ClipboardOpState` above). Transitions:

```
idle ──click──▶ writing
writing ──clipboard.writeText() resolves──▶ awaitingAudit
writing ──clipboard.writeText() rejects──▶ failed(clipboard_blocked)

awaitingAudit ──audit POST 2xx──▶ success
awaitingAudit ──audit POST 5xx / timeout──▶ auditQueued(network)
awaitingAudit ──audit POST 403/401──▶ failed(auth_denied) | failed(tenant_violation)

success ──5s timeout──▶ idle
failed  ──user dismiss──▶ idle
auditQueued ──user dismiss──▶ idle  (the queued retry runs on next session)
```

This is the only stateful piece. Section rendering itself is pure-functional given the snapshot.
