# Contract — Readout API Surfaces

**Feature**: 002-acr-structured-readout

This contract specifies the HTTP surfaces the readout consumes and emits. One existing endpoint is read; one new endpoint is added; one existing endpoint gains an additive guarantee about its response shape.

---

## 1. `GET /api/v1/analyses/{analysis_id}/report/summary` — read

**Status**: existing endpoint, no breaking change. Additive guarantees imposed by this contract.

**Auth**: existing analysis-detail authorization (inherits tenant boundary).

**Response shape** — the readout consumes the following fields. Endpoint MAY return additional fields without breaking the contract.

```jsonc
{
  "analysis_id": "uuid",
  "tenant_id":   "uuid",
  "status":      "queued | running | completed | partial | failed",
  "updated_at":  "2026-05-13T14:23:01Z",      // used by concurrency gate
  "findings": {
    "hu_stats":                 { /* see data-model.md §1 */ } | null,
    "steatosis":                { ... } | null,
    "spleen":                   { ... } | null,
    "gallbladder":              { ... } | null,
    "calcified_lesions":        [ ... ]     | null,
    "simple_biliary_cysts":     [ ... ]     | null,
    "indeterminate_malignant":  { ... }     | null
  },
  "lesions": [
    {
      "lesion_id":    "L1",
      "segment":      "VIII",                // Couinaud
      "size_mm":      89.6,
      "volume_ml":    151,
      "classification": { "label": "icc", "confidence": 0.88, "probs": { ... } }
    }
  ],
  "flr": {
    "plan_pattern":  "right_hepatectomy",
    "flr_pct":       28.4,
    "flr_ml":        518,
    "safety_class":  "low | borderline | adequate",
    "computed_at":   "2026-05-13T14:18:00Z"
  } | null,
  "stages": [
    {
      "stage_name":  "stage_2_parenchyma",
      "status":      "completed | running | failed",
      "computed_at": "2026-05-13T14:10:00Z"
    }
  ]
}
```

**Required response headers**:
- `ETag: "<opaque token>"` — used by the concurrency gate (D5). If the backend doesn't currently emit ETag for this endpoint, this feature requires it to start.
- `Cache-Control: no-store, must-revalidate` — already standard.

### Computing-state contract

When `status ∈ {queued, running}`, every entry in `findings` MAY be null. The readout interprets this as the "computing" state and renders the localized status line per section (FR-040). It does NOT render an error or empty state.

### Stale-finding contract

A finding is stale iff `findings.<type>.computed_at < max(stages[].computed_at where status = completed)` for the same analysis. The readout computes staleness client-side from the response.

---

## 2. `HEAD /api/v1/analyses/{analysis_id}/report/summary` — freshness probe

**Status**: existing endpoint conventions presume HEAD support; this contract makes it explicit.

Returns the same `ETag` and `Last-Modified` headers as the GET, with no body. Used by the concurrency gate before a clipboard write to detect server-side mutation since panel open.

**Failure behavior**: If HEAD returns 304 against the open-time ETag → state is fresh, proceed with clipboard write. If HEAD returns 200 with a different ETag → block the copy and prompt for refresh.

---

## 3. `POST /api/v1/analyses/{analysis_id}/audit/clipboard-export` — new endpoint

Full specification in `audit-event.md`. Summary:

| Property | Value |
|---|---|
| Method | `POST` |
| Auth | inherits analysis-detail authorization |
| Idempotency | by `client_action_id` in body |
| Success | `200` with `{audit_event_id, sequence_no, outcome, persisted_at}` |
| Failure | `401 / 403` terminal; `4xx-validation` terminal; `5xx` retryable |
| Side effect | appends one row to `audit_event_chain` |

---

## 4. `GET /api/v1/analyses/{analysis_id}/report/pdf` — read (existing)

**Status**: existing endpoint, no breaking change. Additive guarantee:

- The PDF rendered by this endpoint MUST contain a `Heuristic Findings — ACR Structured Readout` section whose six anatomical subsections appear in fixed order matching the screen renderer (FR-014, FR-024a). The subsection structure is server-built by `acr_section_builder.py` from the same `analysis_finding` rows the GET summary returns.
- The PDF MUST end the readout section with the RUO disclaimer line (FR-027).
- The PDF MUST emit the `pdf_readout_section_rendered` telemetry event (FR-036). This event is emitted server-side via the same PostHog channel used by the frontend.

**Failure behavior** (FR-020c): PDF render failures emit a `clipboard_export_audit` event with `outcome=failure, failure_category=audit_chain_unavailable` IF the failure happens during the PDF endpoint serving a download initiated by a user click. Background re-renders (e.g., cron) do not emit user-attributed events.

---

## 5. Telemetry endpoints (PostHog)

Out of band of the REST surface. PostHog client emits the four events defined in research §D10 directly to the PostHog ingestion endpoint. The contract here is event-name + property-shape stability:

| Event | Required properties | Forbidden properties |
|---|---|---|
| `acr_readout_viewed` | `analysisId, locale, status, lesionCount` | actor identity, patient identifiers, copied content |
| `acr_clipboard_copy_succeeded` | `analysisId, locale, lesionCount, durationMs` | same forbidden set |
| `acr_clipboard_copy_failed` | `analysisId, locale, failureCategory, durationMs` | same forbidden set |
| `acr_pdf_section_rendered` | `analysisId, locale, lesionCount, durationMs` | same forbidden set |

`lesionCount` is bucketed (`0 | 1 | 2-5 | 6-10 | 11-20 | 21-50 | 50+`). `analysisId` is a UUID and is permitted because it is not a PHI identifier on its own (no patient link without DB join).

---

## 6. Versioning

All endpoints listed live under `/api/v1`. Breaking change to the readout response shape requires `/api/v2` (constitution §Development Workflow §Deployment Standards). Additive changes are non-breaking by definition.
