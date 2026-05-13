# Operational Monitoring — ACR Structured Readout

Spec ref: 002-acr-structured-readout, tasks T105-T107.

This document is the **deployment runbook** for the monitoring infrastructure
required by the spec. Each item must be configured before paying-customer
launch.

## T105 — Sentry alert: clipboard-export 5xx rate

**Rule**: `POST /api/v1/analyses/*/report/clipboard-export 5xx rate > 1%
over 5 minutes`.

**Action**: PagerDuty page to the on-call backend engineer.

**Sentry configuration** (in `sentry.io` project settings → Alerts → New
Issue Alert):

| Field | Value |
|---|---|
| Environment | `prod` |
| Filter | `transaction:POST_/api/v1/analyses/{analysis_id}/report/clipboard-export` |
| Condition | `Number of errors > 1% of events in last 5 minutes` |
| Action | Send to PagerDuty service `liverra-backend-oncall` |

## T106 — PostHog dashboard tile: clipboard-export reconciliation

**Tile**: `acr_clipboard_copy_succeeded` event count vs server
`audit_event_chain` row count where `canonical_json LIKE '%readout-clipboard-export%'`.

**Alert**: 24h discrepancy > 0.5% fires PagerDuty.

PostHog query:

```
SELECT 
  date_trunc('day', timestamp) AS day,
  count(*) AS frontend_clicks
FROM events
WHERE event = 'acr_clipboard_copy_succeeded'
  AND timestamp >= now() - interval '24 hours'
GROUP BY day
```

Cross-reference against a daily backend export:

```sql
SELECT date_trunc('day', written_at) AS day, count(*)
FROM audit_event_chain
WHERE canonical_json LIKE '%readout-clipboard-export%'
  AND written_at >= now() - interval '24 hours'
GROUP BY day;
```

Discrepancy alert: `|frontend_clicks - backend_rows| / max(frontend_clicks, 1) > 0.005`.

## T107 — Pending queue depth telemetry

The `acr_clipboard_copy_succeeded` event already carries a
`pendingQueueDepth` property emitted by
`packages/app/src/emr/services/report/acrClipboardService.ts`. PostHog
alert: fleet-wide 95th-percentile `pendingQueueDepth > 5` indicates the
audit endpoint is degraded — page the on-call.

PostHog alert config:

| Field | Value |
|---|---|
| Event | `acr_clipboard_copy_succeeded` |
| Aggregate | `percentile(pendingQueueDepth, 95)` |
| Threshold | `> 5` |
| Window | `15 minutes` |
| Action | PagerDuty `liverra-backend-oncall` |
